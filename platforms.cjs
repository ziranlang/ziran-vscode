// Platforms: what the Native target lowers ZX to, and how a program runs
// there. The list comes from the toolchain itself: `ziran capabilities --json`
// names every architecture and OS row, and zx2native's usage and a probe of
// each row say which ones it can build today. A row it refuses is a gap,
// shown by its diagnostic name; nothing falls back to another platform.
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { runCommand, safeEnvironment } = require('./preview.cjs');
const { deployPeLibraries } = require('./native-hosts.cjs');

const ARCH_LABELS = { x86_64: 'x86-64', aarch64: 'AArch64', armv7: 'ARMv7', wasm32: 'Wasm' };
const OS_LABELS = { linux: 'Linux', android: 'Android', windows: 'Windows', macos: 'macOS' };
// The Android ABI a device reports for each architecture.
const DEVICE_ABIS = { aarch64: 'arm64-v8a', armv7: 'armeabi-v7a' };
const DEFAULT_PLATFORM = 'x86_64-linux';
const WASM = 'wasm32';
const DEVICE_DIRECTORY = '/data/local/tmp';
const PROBE_CACHE_MS = 60000;

function platformLabel(arch, system) {
  return `${OS_LABELS[system] || system} ${ARCH_LABELS[arch] || arch}`;
}

// The --target, --platform and --emit choices zx2native's usage lists.
function usageChoices(text) {
  const choice = (flag) => {
    const match = new RegExp(`\\[${flag} ([A-Za-z0-9_|-]+)\\]`).exec(text || '');
    return match ? match[1].split('|') : [];
  };
  return { targets: choice('--target'), platforms: choice('--platform'), emits: choice('--emit') };
}

// What zx2native writes for a platform: a PE for Windows, an ELF otherwise.
function emitFor(system, emits) {
  if (system === 'windows') return ['exe', 'pe'].find((name) => emits.includes(name)) || 'elf';
  return 'elf';
}

function gapName(text) {
  return /assembly\.gap\.[A-Za-z0-9_.-]+/.exec(text || '')?.[0] || '';
}

// The registry's rows: from `ziran capabilities --json`, or the usage's
// target and platform pairs when the compiler does not list them.
async function registryRows(command, choices) {
  const listed = command ? await runCommand(command, ['capabilities', '--json'], os.tmpdir()) : null;
  try {
    const rows = JSON.parse(listed.stdout).assembly_targets.rows;
    if (Array.isArray(rows) && rows.length) return rows;
  } catch {}
  return choices.targets.flatMap((arch) => choices.platforms.map((system) =>
    ({ id: `${arch}-${system}`, arch, os: system, diagnostic: 'assembly.gap.target-unimplemented' })));
}

const cache = new Map();
async function mtime(file) {
  try { return (await fs.stat(file)).mtimeMs; } catch { return 0; }
}

// Every platform, in registry order, then Wasm: { id, label, arch, os,
// format, emit, gap }. A row with a gap names it and cannot be built.
async function platformList({ command = '', zx2native = null, zx2wasm = null } = {}) {
  const key = [command, zx2native, await mtime(zx2native), zx2wasm].join('\0');
  const cached = cache.get(key);
  if (cached && Date.now() - cached.time < PROBE_CACHE_MS) return cached.list;
  const list = (async () => {
    const usage = zx2native ? await runCommand(zx2native, ['--help'], os.tmpdir()) : null;
    const choices = usageChoices(usage ? `${usage.stdout}\n${usage.stderr}` : '');
    const rows = (await registryRows(command, choices)).filter((row) => row.arch !== WASM);
    const missing = path.join(os.tmpdir(), `ziran-platform-probe-${process.pid}-missing.zx`);
    const platforms = await Promise.all(rows.map(async (row) => {
      const platform = { id: `${row.arch}-${row.os}`, label: platformLabel(row.arch, row.os), arch: row.arch,
        os: row.os, format: row.os === 'windows' ? 'pe' : 'elf', emit: emitFor(row.os, choices.emits), gap: '' };
      if (!zx2native) return { ...platform, gap: 'zx2native was not found' };
      if (!choices.targets.includes(row.arch) || !choices.platforms.includes(row.os)) {
        const refused = !choices.targets.includes(row.arch) ? `--target ${row.arch}` : `--platform ${row.os}`;
        return { ...platform, gap: `${row.diagnostic || 'assembly.gap.target-unimplemented'}: zx2native has no ${refused}` };
      }
      // The target check runs before the input is read, so a missing input
      // shows whether the row itself is accepted.
      const probe = await runCommand(zx2native, ['--target', row.arch, '--platform', row.os,
        '--emit', platform.emit, '-o', `${missing}.out`, missing], os.tmpdir());
      const gap = gapName(probe.stderr || probe.stdout);
      return gap ? { ...platform, gap } : platform;
    }));
    platforms.push({ id: WASM, label: 'Wasm', arch: WASM, os: 'wasm', format: 'wasm', emit: 'wasm',
      gap: zx2wasm ? '' : 'zx2wasm was not found' });
    // Platforms that build come first, each group in registry order.
    return [...platforms.filter((item) => !item.gap), ...platforms.filter((item) => item.gap)];
  })();
  cache.set(key, { time: Date.now(), list });
  return list;
}

// The configured platform, kept even when it is a gap so its tabs say why.
function selectedPlatform(list, id) {
  return list.find((item) => item.id === id) || list.find((item) => item.id === DEFAULT_PLATFORM) ||
    list.find((item) => !item.gap) || list[0] || null;
}

// The Native target's own stages on PLATFORM; the shared chain never changes.
function platformStages(platform) {
  return platform?.format === 'wasm' ? [['text', 'WAT'], ['binary', 'Binary']] :
    [['assembly', 'Assembly'], ['binary', 'Binary']];
}

function artifactName(platform, name) {
  return `${name}.${platform.format === 'pe' ? 'exe' : platform.format === 'wasm' ? 'wasm' : 'elf'}`;
}

// The program for PLATFORM, lowered from the ZX bundle ZX into DIRECTORY:
// { file } or { problem } with the tool's own message.
async function platformArtifact(platform, zx, directory, name, tools, run = runCommand) {
  if (platform.gap) return { problem: `${platform.label} is not available: ${platform.gap}` };
  const file = path.join(directory, artifactName(platform, name));
  const tool = platform.format === 'wasm' ? tools.zx2wasm : tools.zx2native;
  if (!tool) return { problem: `${platform.format === 'wasm' ? 'zx2wasm' : 'zx2native'} was not found` };
  const args = platform.format === 'wasm' ? ['-o', file, zx] :
    ['--target', platform.arch, '--platform', platform.os, '--emit', platform.emit, '-o', file, zx];
  const built = await run(tool, args, directory);
  if (built.code !== 0) {
    return { problem: (built.stderr || built.stdout || '').trim() || `${path.basename(tool)} exited with ${built.code}` };
  }
  if (platform.format === 'pe') {
    try { await deployPeLibraries(file); }
    catch (error) { return { problem: `Could not deploy Windows host libraries: ${error.message}` }; }
  }
  return { file };
}

function onPath(name, environment = process.env) {
  for (const directory of (environment.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try { fsSync.accessSync(candidate, fsSync.constants.X_OK); return candidate; } catch {}
  }
  return null;
}

function shellQuote(text) {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(text) ? text : `'${String(text).replace(/'/g, `'\\''`)}'`;
}

// An adb command line from the `ziran.adbCommands` setting, such as `adb`
// or `ssh user@host adb`: through ssh, adb's arguments are quoted once for
// the remote shell.
function adbInvocation(line, args) {
  const words = String(line).trim().split(/\s+/).filter(Boolean);
  const remote = path.basename(words[0] || '') === 'ssh';
  return { command: words[0], args: [...words.slice(1), ...(remote ? args.map(shellQuote) : args)] };
}

// `adb push FILE REMOTE`, which every adb device supports. Through ssh the
// file goes over ssh's input to a temporary file on that host, which its
// adb pushes and then removes.
function pushInvocation(device, file, remote) {
  const words = String(device.line).trim().split(/\s+/).filter(Boolean);
  if (path.basename(words[0] || '') !== 'ssh') {
    return adbInvocation(device.line, ['-s', device.serial, 'push', file, remote]);
  }
  const adb = words[words.length - 1];
  const script = `t=$(mktemp) && cat > "$t" && ${shellQuote(adb)} -s ${shellQuote(device.serial)} push "$t" ${shellQuote(remote)}; ` +
    's=$?; rm -f "$t"; exit $s';
  return { command: words[0], args: [...words.slice(1, -1), script], input: true };
}

function shortRun(invocation, timeout = 8000) {
  return new Promise((resolve) => {
    const child = spawn(invocation.command, invocation.args, { env: safeEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: error.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

// An attached device for ARCH on any of LINES: one whose primary ABI is
// ARCH's comes first (an ARMv7 phone over an arm64 one that also runs
// 32-bit code), then any whose ABI list has it.
async function findDevice(arch, lines, run = shortRun) {
  const abi = DEVICE_ABIS[arch];
  const tried = [];
  const secondary = [];
  for (const line of lines) {
    const listed = await run(adbInvocation(line, ['devices']));
    if (listed.code !== 0) { tried.push(`${line}: ${(listed.stderr || 'no answer').trim().split('\n')[0]}`); continue; }
    const serials = listed.stdout.split('\n').map((row) => row.trim().split(/\s+/))
      .filter((row) => row.length === 2 && row[1] === 'device').map((row) => row[0]);
    for (const serial of serials) {
      const props = await run(adbInvocation(line, ['-s', serial, 'shell', 'getprop', 'ro.product.cpu.abilist']));
      const abis = props.code === 0 ? props.stdout.trim().split(',') : [];
      if (abis[0] === abi) return { line, serial };
      if (abis.includes(abi)) secondary.push({ line, serial });
    }
    tried.push(`${line}: ${serials.length ? `no ${abi} device among ${serials.join(', ')}` : 'no device attached'}`);
  }
  if (secondary.length) return secondary[0];
  return { missing: `No ${abi} device answered through adb (${tried.join('; ') || 'no adb command configured'}). ` +
    'Attach one, or list how to reach it in the ziran.adbCommands setting, such as "ssh user@host adb".' };
}

// A private Wine prefix in the extension's storage, set up once.
async function winePrefix(storage, wine, timeout = 180000) {
  const prefix = path.join(storage, 'wine');
  try { await fs.access(path.join(prefix, 'system.reg')); return { prefix }; } catch {}
  await fs.mkdir(prefix, { recursive: true });
  const env = { ...safeEnvironment(), ...wineVariables(prefix) };
  const booted = await new Promise((resolve) => {
    const child = spawn(wine, ['wineboot', '--init'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-8192); });
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: null, stderr: error.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stderr }); });
  });
  if (booted.code !== 0) return { missing: `Wine could not set up its prefix in ${prefix}: ${booted.stderr.trim() || `exit ${booted.code}`}` };
  return { prefix };
}

function wineVariables(prefix) {
  return { WINEPREFIX: prefix, WINEDEBUG: '-all', WINEDLLOVERRIDES: 'mscoree,mshtml=' };
}

const RUNNER = path.join(__dirname, 'wasm-run.cjs');

// How to start FILE on PLATFORM: { command, args, env, label } or
// { missing } naming exactly what this machine lacks. WINDOW keeps the
// editor's display for a program with its own window. A device run copies
// FILE to the device first, then runs and removes it there.
async function runRoute(platform, file, { storage, adbCommands = ['adb'], window = false, find = findDevice } = {}) {
  const base = window ? { ...process.env } : safeEnvironment();
  if (platform.gap) return { missing: `${platform.label} is not available: ${platform.gap}` };
  if (platform.format === 'wasm') {
    const node = onPath('node');
    if (!node) return { missing: 'node was not found on PATH; Wasm runs in Node.' };
    return { command: node, args: [RUNNER, file], env: base, label: 'Node' };
  }
  if (platform.os === 'windows') {
    if (platform.arch !== 'x86_64' || process.platform !== 'linux' || process.arch !== 'x64') {
      return { missing: `Wine on this machine runs only Windows x86-64; ${platform.label} has no run route here.` };
    }
    const wine = onPath('wine');
    if (!wine) return { missing: 'wine was not found on PATH; Windows x86-64 programs run under Wine.' };
    const prepared = await winePrefix(storage, wine);
    if (prepared.missing) return prepared;
    return { command: wine, args: [file], env: { ...base, ...wineVariables(prepared.prefix) }, label: 'Wine' };
  }
  if (platform.arch === 'x86_64' && platform.os === 'linux') {
    if (process.platform !== 'linux' || process.arch !== 'x64') {
      return { missing: `This machine is ${process.platform} ${process.arch}, not Linux x86-64.` };
    }
    await fs.chmod(file, 0o755);
    return { command: file, args: [], env: base, label: 'this machine' };
  }
  if (DEVICE_ABIS[platform.arch]) {
    const device = await find(platform.arch, adbCommands);
    if (device.missing) return device;
    const remote = `${DEVICE_DIRECTORY}/ziran-${process.pid}-${path.basename(file)}`;
    const copied = await new Promise((resolve) => {
      const copy = pushInvocation(device, file, remote);
      const child = spawn(copy.command, copy.args, { env: safeEnvironment(), stdio: [copy.input ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (data) => { stderr += data; });
      child.on('error', (error) => resolve({ code: null, stderr: error.message }));
      child.on('close', (code) => resolve({ code, stderr }));
      if (copy.input) fsSync.createReadStream(file).pipe(child.stdin);
    });
    if (copied.code !== 0) return { missing: `Could not copy the program to ${device.serial}: ${copied.stderr.trim() || `exit ${copied.code}`}` };
    const run = adbInvocation(device.line, ['-s', device.serial, 'shell',
      `chmod 755 ${remote} && ${remote}; status=$?; rm -f ${remote}; exit $status`]);
    return { ...run, env: safeEnvironment(), label: `device ${device.serial}` };
  }
  return { missing: `${platform.label} has no run route on this machine.` };
}

module.exports = { DEFAULT_PLATFORM, DEVICE_ABIS, adbInvocation, pushInvocation, artifactName, emitFor, findDevice, gapName,
  platformArtifact, platformLabel, platformList, platformStages, runRoute, selectedPlatform, usageChoices, winePrefix };
