// Every platform: the registry's list, its stage table, its disassembly and
// its run route. Runs use no display: Wine and Linux programs get the
// scrubbed environment, and Wine a private prefix under tests/.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { adbInvocation, emitFor, pushInvocation, findDevice, gapName, platformArtifact, platformList, platformStages, runRoute,
  selectedPlatform, usageChoices } = require('../platforms.cjs');
const { binaryListing, codeObject, instructionLine, llvmObjdumps } = require('../disassembly.cjs');
const { buildTarget, nativeTools, stagesOf } = require('../targets.cjs');
const { execute } = require('../run.cjs');

const bin = path.resolve('../ziran/build/bin');
const compiler = path.join(bin, 'ziran');
const hello = path.resolve('../ziran/examples/hello.zi');
const toolchain = ['ziran', 'zi2zx', 'zx2native', 'zx2wasm'].every(tool => existsSync(path.join(bin, tool))) && existsSync(hello);
const runtime = path.join(import.meta.dirname, '.runtime-platforms');
const chain = [['source', 'Source'], ['zir', 'ZIR'], ['lowered', 'LIR'], ['optimized', 'Optimized'], ['zx', 'ZX']];
const onPath = name => spawnSync('sh', ['-c', `command -v ${name}`]).status === 0;
const mingw = onPath('x86_64-w64-mingw32-gcc');
const wine = onPath('wine') && process.platform === 'linux' && process.arch === 'x64';
const ndk = llvmObjdumps().filter(tool => tool !== 'llvm-objdump').map(tool => path.dirname(tool))[0] || '';
const adbCommands = JSON.parse(process.env.ZIRAN_TEST_ADB_COMMANDS || '["adb"]');

// A console PE importing only what it uses from kernel32, as zx2native's
// Windows writer does: GetStdHandle, WriteFile and ExitProcess.
async function windowsProgram() {
  const directory = path.join(runtime, 'pe');
  const program = path.join(directory, 'hello.exe');
  if (existsSync(program)) return program;
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'hello.c'), `typedef void *HANDLE; typedef unsigned long DWORD;
__declspec(dllimport) HANDLE __stdcall GetStdHandle(DWORD);
__declspec(dllimport) int __stdcall WriteFile(HANDLE, const void *, DWORD, DWORD *, void *);
__declspec(dllimport) void __stdcall ExitProcess(unsigned);
void start(void) { DWORD n; WriteFile(GetStdHandle((DWORD)-11), "Hello from PE\\n", 14, &n, 0); ExitProcess(0); }
`);
  const built = spawnSync('x86_64-w64-mingw32-gcc', ['-Os', '-nostdlib', '-s', '-e', 'start', '-o', program,
    path.join(directory, 'hello.c'), '-lkernel32'], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  return program;
}

// The real toolchain behind wrappers, with a zx2native that also accepts
// --platform windows and writes PROGRAM for it, as the PE writer will.
async function windowsToolchain(program) {
  const directory = path.join(runtime, 'toolchain/build/bin');
  await fs.mkdir(directory, { recursive: true });
  for (const tool of ['ziran', 'zi2zx', 'zi-inspect', 'zx2wasm']) {
    await fs.writeFile(path.join(directory, tool), `#!/bin/sh\nexec ${path.join(bin, tool)} "$@"\n`, { mode: 0o755 });
  }
  const map = JSON.stringify({ format: 'ziran-native-map', version: 1, target: 'x86_64-windows',
    image: { text_file_offset: 0x400, text_size: 0x60, text_virtual_address: 0x140001000 },
    functions: [{ id: 0, module: 'hello', name: 'main', begin: 0, end: 0x40 }] });
  await fs.writeFile(path.join(directory, 'zx2native'), `#!/bin/sh
case " $* " in *" --help "*) echo "usage: zx2native [--target x86_64|aarch64|armv7] [--platform linux|android|windows] [--emit elf|map|exe|image] -o FILE INPUT.zx" >&2; exit 1;; esac
case " $* " in *" --platform windows "*) ;; *) exec ${path.join(bin, 'zx2native')} "$@";; esac
while [ $# -gt 0 ]; do case "$1" in --emit) shift; emit=$1;; -o) shift; out=$1;; esac; shift; done
if [ "$emit" = map ]; then echo '${map}' > "$out"; else cp ${program} "$out"; fi
`, { mode: 0o755 });
  return path.join(directory, 'ziran');
}

test('zx2native\'s usage, probes and emit names decide each platform', () => {
  const usage = usageChoices('usage: zx2native [--target x86_64|aarch64|armv7] [--platform linux|android] [--emit elf|map|image] -o FILE');
  assert.deepEqual(usage, { targets: ['x86_64', 'aarch64', 'armv7'], platforms: ['linux', 'android'], emits: ['elf', 'map', 'image'] });
  assert.equal(emitFor('windows', ['elf', 'map', 'exe']), 'exe');
  assert.equal(emitFor('windows', ['elf', 'map']), 'elf');
  assert.equal(emitFor('linux', ['elf', 'exe']), 'elf');
  assert.equal(gapName('ziran: assembly.gap.machine-platform-service-unavailable: selected target'), 'assembly.gap.machine-platform-service-unavailable');
  assert.equal(gapName('ziran: cannot read bounded instruction input'), '');
  const list = [{ id: 'x86_64-linux', gap: '' }, { id: 'x86_64-windows', gap: 'assembly.gap.target-unimplemented' }];
  // A configured gap stays selected, so its tabs say why; an unknown id picks the default.
  assert.equal(selectedPlatform(list, 'x86_64-windows').id, 'x86_64-windows');
  assert.equal(selectedPlatform(list, 'riscv64-linux').id, 'x86_64-linux');
  // adb through ssh quotes its arguments once for the remote shell.
  assert.deepEqual(adbInvocation('ssh user@host adb', ['-s', 'S1', 'shell', 'chmod 755 /x && /x']),
    { command: 'ssh', args: ['user@host', 'adb', '-s', 'S1', 'shell', "'chmod 755 /x && /x'"] });
  assert.deepEqual(adbInvocation('adb', ['devices']), { command: 'adb', args: ['devices'] });
  assert.deepEqual(pushInvocation({ line: 'adb', serial: 'S1' }, '/w/hello.elf', '/data/local/tmp/x'),
    { command: 'adb', args: ['-s', 'S1', 'push', '/w/hello.elf', '/data/local/tmp/x'] });
  const remote = pushInvocation({ line: 'ssh user@host adb', serial: 'S1' }, '/w/hello.elf', '/data/local/tmp/x');
  assert.deepEqual([remote.command, remote.args.slice(0, 1), remote.input], ['ssh', ['user@host'], true]);
  assert.match(remote.args[1], /cat > "\$t" && adb -s S1 push "\$t" \/data\/local\/tmp\/x; s=\$\?; rm -f "\$t"; exit \$s$/);
});

test('device choice prefers a primary ABI and names what is missing', async () => {
  const devices = { adb: 'List of devices attached\nARM64\tdevice\nARMV7\tdevice\nOFF\toffline\n' };
  const abis = { ARM64: 'arm64-v8a,armeabi-v7a,armeabi', ARMV7: 'armeabi-v7a,armeabi' };
  const fake = async ({ args }) => args[0] === 'devices' ? { code: 0, stdout: devices.adb } :
    { code: 0, stdout: `${abis[args[1]]}\n` };
  assert.deepEqual(await findDevice('armv7', ['adb'], fake), { line: 'adb', serial: 'ARMV7' });
  assert.deepEqual(await findDevice('aarch64', ['adb'], fake), { line: 'adb', serial: 'ARM64' });
  const none = await findDevice('aarch64', ['adb'], async () => ({ code: 0, stdout: 'List of devices attached\n' }));
  assert.match(none.missing, /No arm64-v8a device answered through adb \(adb: no device attached\)/);
  assert.match(none.missing, /ziran\.adbCommands/);
});

test('the registry lists every platform with each gap by name', { skip: !toolchain }, async () => {
  const list = await platformList({ command: compiler, zx2native: path.join(bin, 'zx2native'), zx2wasm: path.join(bin, 'zx2wasm') });
  const ids = list.map(item => item.id);
  const capabilities = JSON.parse(spawnSync(compiler, ['capabilities', '--json'], { encoding: 'utf8' }).stdout);
  for (const row of capabilities.assembly_targets.rows.filter(row => row.arch !== 'wasm32')) assert.ok(ids.includes(row.id), row.id);
  assert.ok(ids.includes('wasm32'));
  const by = id => list.find(item => item.id === id);
  assert.equal(by('x86_64-linux').gap, '');
  assert.equal(by('x86_64-linux').label, 'Linux x86-64');
  assert.equal(by('wasm32').gap, '');
  for (const item of list.filter(entry => entry.gap)) assert.match(item.gap, /^(assembly\.gap\.[\w.-]+|zx2\w+ was not found)/, item.id);
  // Buildable platforms come first.
  const firstGap = list.findIndex(item => item.gap);
  assert.ok(firstGap < 0 || list.slice(firstGap).every(item => item.gap));
  // Windows lights up once zx2native accepts it; until then the gap names the flag.
  const windows = by('x86_64-windows');
  assert.equal(windows.label, 'Windows x86-64');
  assert.equal(windows.format, 'pe');
  if (windows.gap) assert.match(windows.gap, /assembly\.gap\.[\w.-]+/);
});

test('each platform\'s stage table is the shared chain, then its own output', { skip: !toolchain }, async () => {
  const list = await platformList({ command: compiler, zx2native: path.join(bin, 'zx2native'), zx2wasm: path.join(bin, 'zx2wasm') });
  for (const platform of list) {
    const stages = stagesOf('native', platform);
    assert.deepEqual(stages.slice(0, 5), chain, `${platform.id} shares the chain`);
    assert.deepEqual(stages.slice(5), platform.format === 'wasm' ? [['text', 'WAT'], ['binary', 'Binary']] :
      [['assembly', 'Assembly'], ['binary', 'Binary']], platform.id);
    assert.deepEqual(stages.slice(5), platformStages(platform));
  }
  // Other targets never change with the platform.
  for (const target of ['c', 'go', 'wasm']) assert.deepEqual(stagesOf(target, list[0]), stagesOf(target));
});

test('a gap platform shows its gap on its own stages and runs nothing for it', { skip: !toolchain }, async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'ziran-gap-'));
  try {
    const platform = { id: 'aarch64-android', label: 'Android AArch64', arch: 'aarch64', os: 'android', format: 'elf',
      emit: 'elf', gap: 'assembly.gap.machine-platform-service-unavailable' };
    const result = await buildTarget(compiler, 'native', hello, work, [], { platform });
    assert.deepEqual(result.views.map(item => item.label), ['Source', 'ZIR', 'LIR', 'Optimized', 'ZX', 'Assembly', 'Binary']);
    for (const id of ['source', 'zir', 'lowered', 'optimized', 'zx']) assert.equal(result.views.find(item => item.id === id).ok, true, id);
    for (const id of ['assembly', 'binary']) {
      const item = result.views.find(entry => entry.id === id);
      assert.equal(item.ok, false);
      assert.match(item.message, /^Android AArch64 is not available: assembly\.gap\.machine-platform-service-unavailable$/);
    }
    assert.match((await runRoute(platform, '/nowhere')).missing, /Android AArch64 is not available: assembly\.gap/);
  } finally { await fs.rm(work, { recursive: true, force: true }); }
});

test('Wasm ends in WAT and Binary from zx2wasm', { skip: !toolchain }, async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'ziran-wasm-platform-'));
  try {
    const platform = { id: 'wasm32', label: 'Wasm', arch: 'wasm32', os: 'wasm', format: 'wasm', emit: 'wasm', gap: '' };
    const result = await buildTarget(compiler, 'native', hello, work, [], { platform });
    assert.equal(result.ok, true, result.message);
    assert.deepEqual(result.views.map(item => item.label), ['Source', 'ZIR', 'LIR', 'Optimized', 'ZX', 'WAT', 'Binary']);
    const wat = result.views.find(item => item.id === 'text');
    assert.equal(wat.ok, true, wat.message);
    assert.match(wat.files[0].text, /^\(module/);
    assert.match(wat.files[0].text, /\(import "zx" "host_i64"/);
    const binary = result.views.find(item => item.id === 'binary').files[0].binary;
    assert.deepEqual([...(await fs.readFile(binary.path)).subarray(0, 4)], [0, 0x61, 0x73, 0x6d]);
  } finally { await fs.rm(work, { recursive: true, force: true }); }
});

test('Windows x86-64: the PE lists its headers, imports and code, hides its PE parts and runs under Wine',
  { skip: !toolchain || !mingw }, async () => {
  const program = await windowsProgram();
  const command = await windowsToolchain(program);
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'ziran-pe-'));
  try {
    const tools = await nativeTools(command, hello, []);
    const list = await platformList({ command, zx2native: tools.zx2native, zx2wasm: tools.zx2wasm });
    const platform = list.find(item => item.id === 'x86_64-windows');
    assert.deepEqual([platform.gap, platform.emit, platform.format], ['', 'exe', 'pe']);
    const result = await buildTarget(command, 'native', hello, work, [], { platform });
    assert.equal(result.ok, true, result.message);
    assert.deepEqual(result.views.map(item => item.label), ['Source', 'ZIR', 'LIR', 'Optimized', 'ZX', 'Assembly', 'Binary']);
    const assembly = result.views.find(item => item.id === 'assembly');
    assert.equal(assembly.ok, true, assembly.message);
    const listing = assembly.files[0];
    assert.equal(listing.filterLabel, 'Hide PE parts');
    for (const line of [/^PE header$/m, /^  PE32\+, machine x86-64, Windows console, entry 0x140001000, image base 0x140000000$/m,
      /^Sections$/m, /^  0 +\.text +0x400 /m, /^Imports$/m, /^  KERNEL32\.dll: ExitProcess, GetStdHandle, WriteFile$/m,
      /^file 0x0–0x40  DOS header · 64 bytes$/m, /^file 0x40–0x80  DOS stub · 64 bytes$/m, /^file 0x[0-9a-f]+–0x[0-9a-f]+  PE headers /m,
      /^file 0x[0-9a-f]+–0x[0-9a-f]+  import table /m, /^<hello:main>:$/m, /^<runtime>:$/m,
      /\tcall +\*0x[0-9a-f]+\(%rip\) +# 0x[0-9a-f]+ <KERNEL32\.dll!WriteFile>$/m, /\tret$/m])
      assert.match(listing.text, line);
    // Hiding the PE parts leaves only the program's own code.
    assert.match(listing.filtered, /^<hello:main>:\n  140001000:\t48 83 ec 48 +\tsub +\$0x48,%rsp$/m);
    assert.doesNotMatch(listing.filtered, /PE header|DOS|import table|padding|<runtime>|^file /m);
    const binary = result.views.find(item => item.id === 'binary').files[0].binary;
    assert.equal(binary.filterLabel, 'Hide PE parts');
    const kinds = binary.regions.map(region => `${region.label}:${region.kind}`);
    for (const part of ['DOS header:header', 'DOS stub:header', 'PE headers:header', 'section headers (5):header',
      'import table:header', 'padding:padding', 'hello:main:code', 'runtime:runtime', '.rdata:data'])
      assert.ok(kinds.includes(part), part);
    assert.equal(binary.regions.at(-1).end, binary.size);
    for (let index = 1; index < binary.regions.length; index++)
      assert.equal(binary.regions[index].start, binary.regions[index - 1].end, 'regions cover the file in order');
    if (!wine) return;
    // The Native build's own .exe runs under Wine with a private prefix and no display.
    const route = await runRoute(platform, binary.path, { storage: runtime });
    assert.equal(route.missing, undefined, route.missing);
    assert.equal(route.label, 'Wine');
    assert.equal(route.env.WINEPREFIX, path.join(runtime, 'wine'));
    assert.equal(route.env.WINEDEBUG, '-all');
    assert.equal(route.env.DISPLAY, undefined);
    const ran = await execute(route.command, route.args, work, 60000, route.env);
    assert.deepEqual([ran.code, ran.stdout], [0, 'Hello from PE\n'], ran.stderr);
  } finally { await fs.rm(work, { recursive: true, force: true }); }
});

for (const [platform, output] of [
  [{ id: 'x86_64-linux', label: 'Linux x86-64', arch: 'x86_64', os: 'linux', format: 'elf', emit: 'elf', gap: '' }, 'this machine'],
  [{ id: 'wasm32', label: 'Wasm', arch: 'wasm32', os: 'wasm', format: 'wasm', emit: 'wasm', gap: '' }, 'Node'],
]) {
  test(`${platform.label} runs hello its own way`, { skip: !toolchain || (platform.os === 'linux' && process.arch !== 'x64') }, async () => {
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'ziran-run-platform-'));
    try {
      const bundle = path.join(work, 'hello.zx');
      const bundled = spawnSync(compiler, ['bundle', '--root', path.dirname(hello), '--entry', 'hello:main', '-o', bundle, hello], { encoding: 'utf8' });
      assert.equal(bundled.status, 0, bundled.stderr);
      const tools = await nativeTools(compiler, hello, []);
      const artifact = await platformArtifact(platform, bundle, work, 'hello', tools);
      assert.equal(artifact.problem, undefined, artifact.problem);
      const route = await runRoute(platform, artifact.file, { storage: runtime });
      assert.equal(route.label, output);
      const ran = await execute(route.command, route.args, work, 20000, route.env);
      assert.deepEqual([ran.code, ran.stdout], [0, 'Hello, World!\n'], ran.stderr);
    } finally { await fs.rm(work, { recursive: true, force: true }); }
  });
}

// Static programs that print through Linux syscalls, as zx2native's ARM
// rows will once their veneers land; built with the Android NDK.
const ARM_PROGRAMS = {
  aarch64: { clang: 'aarch64-linux-android21-clang', source: `.globl _start
_start: mov x0, #1
  adr x1, text
  mov x2, #12
  mov x8, #64
  svc #0
  mov x0, #0
  mov x8, #93
  svc #0
text: .ascii "Hello, ARM!\\n"
` },
  armv7: { clang: 'armv7a-linux-androideabi21-clang', source: `.globl _start
.arm
_start: mov r0, #1
  adr r1, text
  mov r2, #12
  mov r7, #4
  svc #0
  mov r0, #0
  mov r7, #1
  svc #0
text: .ascii "Hello, ARM!\\n"
` },
};
for (const [arch, { clang, source }] of Object.entries(ARM_PROGRAMS)) {
  const label = arch === 'aarch64' ? 'Android AArch64' : 'Android ARMv7';
  test(`${label}: the ELF disassembles with the NDK's llvm-objdump and runs on a device through adb`,
    { skip: !ndk || !existsSync(path.join(ndk, clang)) }, async (t) => {
    const work = await fs.mkdtemp(path.join(os.tmpdir(), `ziran-${arch}-`));
    try {
      await fs.writeFile(path.join(work, 'hello.S'), source);
      const program = path.join(work, 'hello.elf');
      const built = spawnSync(path.join(ndk, clang), ['-nostdlib', '-static', '-Wl,--build-id=none', '-o', program,
        path.join(work, 'hello.S')], { encoding: 'utf8' });
      assert.equal(built.status, 0, built.stderr);
      const listing = await binaryListing(program, null, new Set(), work);
      assert.match(listing.text, new RegExp(`machine ${arch === 'aarch64' ? 'AArch64' : 'ARM'}, entry 0x[0-9a-f]+`));
      assert.match(listing.text, /\tsvc\t#0(x0)?$/m);
      assert.match(listing.text, arch === 'aarch64' ? /\tmov\tx8, #0x40$/m : /\tmov\tr7, #4$/m);
      assert.doesNotMatch(listing.text, /\/\/ =|@ imm|<\.text\+/);
      const platform = { id: `${arch}-android`, label, arch, os: 'android', format: 'elf', emit: 'elf', gap: '' };
      const route = await runRoute(platform, program, { storage: runtime, adbCommands });
      if (route.missing) {
        assert.match(route.missing, /No (arm64-v8a|armeabi-v7a) device answered/);
        t.diagnostic(`${label} analyzes only: ${route.missing}`);
        return;
      }
      assert.match(route.label, /^device /);
      t.diagnostic(`${label} runs on ${route.label} through ${route.command}`);
      const ran = await execute(route.command, route.args, work, 30000, route.env);
      assert.deepEqual([ran.code, ran.stdout.replace(/\r\n/g, '\n')], [0, 'Hello, ARM!\n'], ran.stderr);
    } finally { await fs.rm(work, { recursive: true, force: true }); }
  });
}

test('llvm-objdump lines and code objects carry every architecture\'s bytes', () => {
  assert.deepEqual(instructionLine('  401000: d503201f     \tnop'), { address: 0x401000, size: 4, bytes: ['1f', '20', '03', 'd5'], text: 'nop' });
  assert.deepEqual(instructionLine('   10008: ebfffffe     \tbl\t0x10008 <.text+0x8>     @ imm = #-0x8'),
    { address: 0x10008, size: 4, bytes: ['fe', 'ff', 'ff', 'eb'], text: 'bl\t0x10008' });
  assert.deepEqual(instructionLine('  401000:\t48 83 ec 48          \tsub    $0x48,%rsp').bytes, ['48', '83', 'ec', '48']);
  for (const machine of [183, 40]) {
    const object = codeObject(Buffer.from([1, 2, 3, 4]), 0x1000, machine);
    assert.deepEqual([...object.subarray(0, 4)], [0x7f, 0x45, 0x4c, 0x46]);
    assert.equal(object.readUInt16LE(18), machine);
  }
});
