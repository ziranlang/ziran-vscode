const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { parse } = require('@iarna/toml');
const { manifestPath, projectRoot, runCommand: spawnCommand, safeEnvironment } = require('./preview.cjs');
const { binaryListing } = require('./disassembly.cjs');
const { DEFAULT_PLATFORM, platformArtifact, platformList, platformStages, selectedPlatform } = require('./platforms.cjs');

const TARGETS = [
  { id: 'c', label: 'C' },
  { id: 'go', label: 'Go' },
  { id: 'wasm', label: 'Wasm' },
  { id: 'native', label: 'Native' },
];
const DEFAULT_TARGETS = ['c', 'go', 'wasm', 'native'];

// The one table behind every tab list and every build. All targets share one
// chain, Source -> ZIR -> LIR -> Optimized -> ZX; a target shows its first
// SHARED stages of it, then its own output. Builds run only the steps for
// stages some enabled target shows, so no tab appears without its step and no
// step runs without a tab.
const CHAIN = [['source', 'Source'], ['zir', 'ZIR'], ['lowered', 'LIR'], ['optimized', 'Optimized'], ['zx', 'ZX']];
const TARGET_STAGES = {
  c: { shared: 2, own: [['generated', 'C'], ['assembly', 'Assembly'], ['binary', 'Binary']] },
  go: { shared: 2, own: [['generated', 'Go'], ['assembly', 'Assembly'], ['binary', 'Binary']] },
  wasm: { shared: 5, own: [['text', 'WAT'], ['binary', 'Binary']] },
  native: { shared: 5, own: [['assembly', 'Assembly'], ['binary', 'Binary']] },
};
// Source code generators other than the four above stop after ZIR too.
// Native ends in its PLATFORM's output: Assembly and Binary for a machine
// format, WAT and Binary for Wasm; the shared chain is the same on all.
function stagesOf(target, platform = null) {
  const entry = TARGET_STAGES[target] ||
    { shared: 2, own: [['generated', TARGETS.find((item) => item.id === target)?.label || target]] };
  const own = target === 'native' && platform ? platformStages(platform) : entry.own;
  return [...CHAIN.slice(0, entry.shared), ...own];
}
function chainFor(targets) {
  const depth = Math.max(2, ...targets.map((target) => (TARGET_STAGES[target] || { shared: 2 }).shared));
  return CHAIN.slice(0, depth).map(([id]) => id);
}

// Every external command a build runs is reported to the observer, so tests
// can check each target's tabs against what its build actually executed.
const observer = { listener: null };
function observeCommands(listener) { observer.listener = listener; }
function runCommand(tool, args, cwd) {
  observer.listener?.(path.basename(tool), args);
  return spawnCommand(tool, args, cwd);
}
// Listings larger than this are cut; the hex view pages binaries instead.
const VIEW_TEXT_LIMIT = 4 * 1024 * 1024;

async function exists(file) {
  try { await fs.access(file); return true; }
  catch { return false; }
}

async function executable(file) {
  try { await fs.access(file, fsSync.constants.X_OK); return (await fs.stat(file)).isFile(); }
  catch { return false; }
}

// Resolve from an existing source or manifest resource: explicit setting first;
// current Kryon packages use the installed project-aware wrapper (or PATH) so
// their toolchain and local overrides select the compiler. Legacy Kryon apps
// use paths.ziran, then ancestor/sibling checkouts, user install, and PATH.
async function ziranCommand(file, vscode) {
  const configured = vscode.workspace.getConfiguration('ziran', vscode.Uri.file(file))
    .get('command', '');
  if (configured) return configured;
  const root = await projectRoot(file);
  if (root && await exists(path.join(root, 'ziran.toml'))) {
    const wrapper = path.join(os.homedir(), '.local', 'bin', 'ziran');
    return await exists(wrapper) ? wrapper : 'ziran';
  }
  if (root) {
    const ziran = await manifestPath(root, 'ziran', '../ziran');
    const command = path.join(ziran, 'build', 'bin', 'ziran');
    if (await exists(command)) return command;
  }
  let directory = path.dirname(file);
  while (true) {
    const command = path.join(directory, 'build', 'bin', 'ziran');
    if (await exists(command)) return command;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  for (const folder of vscode.workspace.workspaceFolders || []) {
    const command = path.resolve(folder.uri.fsPath, '../ziran/build/bin/ziran');
    if (await exists(command)) return command;
  }
  const local = path.join(os.homedir(), '.local', 'bin', 'ziran');
  return await exists(local) ? local : 'ziran';
}

// Another tool of the Ziran toolchain behind COMMAND, such as zi2zx: beside
// the command, in a checkout above the file, in the toolchain a project pins,
// or in a checkout beside an open folder.
async function ziranTool(command, name, file, folders = []) {
  const candidates = [];
  if (path.isAbsolute(command)) candidates.push(path.join(path.dirname(command), name));
  let directory = path.dirname(file);
  while (true) {
    candidates.push(path.join(directory, 'build', 'bin', name));
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  for (const folder of folders) candidates.push(path.resolve(folder, '../ziran/build/bin', name));
  for (const candidate of candidates) if (await executable(candidate)) return candidate;
  const project = await packageRoot(file);
  if (project) {
    const located = await runCommand(command, ['pkg', 'path', 'ziran'], project);
    const checkout = located.code === 0 ? located.stdout.trim().split(/\r?\n/).pop() : '';
    if (checkout && await executable(path.join(checkout, 'build', 'bin', name))) {
      return path.join(checkout, 'build', 'bin', name);
    }
  }
  const local = path.join(os.homedir(), '.local', 'bin', name);
  return await executable(local) ? local : null;
}

// The Ziran package a file belongs to: the nearest directory with a
// ziran.toml, or null for a lone file.
async function packageRoot(file) {
  let directory = path.dirname(file);
  while (true) {
    if (await exists(path.join(directory, 'ziran.toml'))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

// Standard modules that belong to a checkout's build/bin/ziran.
function commandStd(command) {
  const bin = path.dirname(command);
  if (path.basename(bin) !== 'bin' || path.basename(path.dirname(bin)) !== 'build') return null;
  return path.join(path.dirname(path.dirname(bin)), 'std');
}

// The packages a source imports by qualified name, as in `#import "kryon/text"`
// or `Text :: #import "kryon/text";`. The standard library is not a package.
function importedPackages(source) {
  const names = new Set();
  const pattern = /^[ \t]*(?:using[ \t]+)?(?:[A-Za-z_]\w*[ \t]*::[ \t]*)?#import[ \t]+"([A-Za-z_][\w-]*)\/[^"]+"/gm;
  for (const match of source.matchAll(pattern)) if (match[1] !== 'std') names.add(match[1]);
  return names;
}

async function readManifest(directory) {
  try { return parse(await fs.readFile(path.join(directory, 'ziran.toml'), 'utf8')); }
  catch { return null; }
}

// A checkout of package NAME: NAME/ or ORG/NAME/ beside the file or one of
// its ancestors, or beside an open folder, whose ziran.toml names NAME.
const packageCache = new Map();
async function findPackage(name, starts) {
  const key = `${name}\0${starts.join('\0')}`;
  const cached = packageCache.get(key);
  if (cached && Date.now() - cached.time < 30000) return cached.result;
  const result = (async () => {
    const seen = new Set();
    for (const start of starts) {
      let directory = start;
      while (true) {
        if (!seen.has(directory)) {
          seen.add(directory);
          const candidates = [path.join(directory, name)];
          try {
            for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
              if (entry.isDirectory() && !entry.name.startsWith('.') &&
                  !['build', 'node_modules', 'proc', 'sys', 'dev'].includes(entry.name)) {
                candidates.push(path.join(directory, entry.name, name));
              }
            }
          } catch {}
          for (const candidate of candidates) {
            const manifest = await readManifest(candidate);
            if (manifest?.package?.name === name) return { root: candidate, manifest };
          }
        }
        const parent = path.dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
    return null;
  })();
  packageCache.set(key, { time: Date.now(), result });
  return result;
}

// The directories that serve a package's `NAME/MODULE` imports outside a
// project: its module roots and the folders of its exported modules.
async function packageDirectories(root, manifest) {
  const roots = Array.isArray(manifest.package?.module_roots) ? manifest.package.module_roots :
    await exists(path.join(root, 'src')) ? ['src'] : ['.'];
  const directories = roots.map((entry) => path.resolve(root, entry));
  for (const file of Object.values(manifest.exports || {})) {
    if (typeof file === 'string') directories.push(path.dirname(path.resolve(root, file)));
  }
  const found = [];
  for (const directory of directories) {
    if (!found.includes(directory) && await exists(directory)) found.push(directory);
  }
  return found;
}

// `NAME=DIR` module paths for the packages a lone file (or a file beside it)
// imports by qualified name: `ziran.packagePaths` first, then a checkout found
// beside the file or an open folder.
async function packageModulePaths(file, vscode) {
  const directory = path.dirname(file);
  const names = new Set();
  let entries = [];
  try { entries = await fs.readdir(directory); } catch {}
  for (const entry of entries.filter((name) => name.endsWith('.zi'))) {
    try {
      for (const name of importedPackages(await fs.readFile(path.join(directory, entry), 'utf8'))) {
        names.add(name);
      }
    } catch {}
  }
  if (!names.size) return [];
  const uri = vscode.Uri.file(file);
  const folder = vscode.workspace.getWorkspaceFolder?.(uri);
  const base = folder ? folder.uri.fsPath : directory;
  const configured = vscode.workspace.getConfiguration('ziran', uri).get('packagePaths', {}) || {};
  const starts = [directory, ...(vscode.workspace.workspaceFolders || []).map((item) => item.uri.fsPath)];
  const paths = [];
  for (const name of [...names].sort()) {
    let found = null;
    if (typeof configured[name] === 'string') {
      const root = path.resolve(base, configured[name]);
      const manifest = await readManifest(root);
      found = { root, manifest: manifest || { package: { module_roots: ['.'] } } };
    }
    found ||= await findPackage(name, starts);
    if (!found) continue;
    for (const entry of await packageDirectories(found.root, found.manifest)) {
      paths.push(`${name}=${entry}`);
    }
  }
  return paths;
}

function resolveModulePath(base, entry) {
  const named = /^([A-Za-z_][\w-]*)=(.+)$/.exec(entry);
  return named ? `${named[1]}=${path.resolve(base, named[2])}` : path.resolve(base, entry);
}

async function modulePaths(file, command, vscode) {
  const folder = vscode.workspace.getWorkspaceFolder?.(vscode.Uri.file(file));
  const base = folder ? folder.uri.fsPath : path.dirname(file);
  const configured = vscode.workspace.getConfiguration('ziran', vscode.Uri.file(file))
    .get('modulePaths', []);
  const candidates = [commandStd(command), ...configured.map((entry) => resolveModulePath(base, entry))];
  const paths = [];
  for (const candidate of candidates) {
    const directory = candidate && candidate.replace(/^[A-Za-z_][\w-]*=/, '');
    if (candidate && !paths.includes(candidate) && await exists(directory)) paths.push(candidate);
  }
  // A project resolves packages through its lock and refuses NAME=DIR.
  if (!(await packageRoot(file))) {
    for (const entry of await packageModulePaths(file, vscode)) {
      if (!paths.includes(entry)) paths.push(entry);
    }
  }
  return paths;
}

function enabledTargets(file, vscode) {
  const configured = vscode.workspace.getConfiguration('ziran', vscode.Uri.file(file))
    .get('previewTargets', DEFAULT_TARGETS);
  const selected = configured.map(id => id === 'zx' ? 'native' : id);
  return TARGETS.map((target) => target.id).filter((id) => selected.includes(id));
}

// The platform the Native target and Run use, from `ziran.previewPlatform`.
function configuredPlatform(file, vscode) {
  return vscode.workspace.getConfiguration('ziran', vscode.Uri.file(file)).get('previewPlatform', DEFAULT_PLATFORM) ||
    DEFAULT_PLATFORM;
}

function moduleName(file) {
  return path.basename(file, '.zi');
}

// The program's own modules: the file's module and the .zi modules beside it.
// Everything else a build writes, such as Kryon, std and runtime support, is
// a dependency: listed, but loaded and shown only on request.
async function ownModules(file) {
  const names = new Set([moduleName(file)]);
  try {
    for (const entry of await fs.readdir(path.dirname(file))) {
      if (entry.endsWith('.zi')) names.add(entry.slice(0, -3));
    }
  } catch {}
  return names;
}

function ownFile(name, own) {
  return own.has(path.basename(name).replace(/\..*$/, ''));
}

// Own files first, the entry module's before its siblings; then dependencies.
// A build whose files match no own module shows them all as its own.
function splitOwn(entries, file, own, nameOf = (entry) => entry.name) {
  const mine = entries.filter((entry) => ownFile(nameOf(entry), own));
  if (!mine.length) return { mine: entries, dependencies: [] };
  const entry = moduleName(file);
  const first = (item) => path.basename(nameOf(item)).replace(/\..*$/, '') === entry ? 0 : 1;
  mine.sort((left, right) => first(left) - first(right));
  return { mine, dependencies: entries.filter((item) => !mine.includes(item)) };
}

// A dependency file: its name, and LOAD, which reads its text on request.
function dependencyFile(name, load, size) {
  return { name, dependency: true, ...(Number.isSafeInteger(size) ? { size } : {}), load };
}

// The line of the file's `main :: (` declaration, or -1. A program runs only
// through its main; a file without one is a module for programs to import.
function mainLine(source) {
  const lines = source.split(/\r?\n/);
  return lines.findIndex((line) => /^main\s*::\s*\(/.test(line));
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Programs beside FILE that import it and declare main.
async function importingPrograms(file) {
  const directory = path.dirname(file);
  let entries = [];
  try { entries = await fs.readdir(directory); } catch { return []; }
  const importer = new RegExp(
    `^[ \\t]*(?:using[ \\t]+)?(?:[A-Za-z_]\\w*[ \\t]*::[ \\t]*)?#import[ \\t]+"(?:[^"/]+/)*${escapeRegExp(moduleName(file))}"`, 'm');
  const found = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.zi') || entry === path.basename(file)) continue;
    try {
      const source = await fs.readFile(path.join(directory, entry), 'utf8');
      if (mainLine(source) >= 0 && importer.test(source)) found.push(entry);
    } catch {}
  }
  return found;
}

function noMainMessage(file, importers = []) {
  const text = `${path.basename(file)} has no main; it's a module. Run a program that imports it`;
  return importers.length ? `${text}, such as ${importers.slice(0, 3).join(', ')}.` : `${text}.`;
}

// Keep the selected module's filename as its identity while the package CLI
// supplies manifest roots, exports, dependencies and local toolchain overrides.
function sourceArgs(file, paths, project = false) {
  const args = project ? ['--project'] : [];
  args.push('--root', path.dirname(file));
  for (const entry of paths) args.push('--module-path', entry);
  return args;
}

// A program's only entry is its main: Wasm and executables start there.
function buildArgs(target, file, output, paths, project = false, { exe = false } = {}) {
  const args = ['build', `--target=${target}`, ...sourceArgs(file, paths, project)];
  if (exe && target === 'go') args.push('--pkg', 'main');
  if (exe && target !== 'wasm') args.push('--exe');
  if (exe || target === 'wasm') args.push('--entry', `${moduleName(file)}:main`);
  args.push('-o', output, file);
  return args;
}

function bundleArgs(file, paths, bundle, project = false) {
  return ['bundle', ...sourceArgs(file, paths, project),
    '--entry', `${moduleName(file)}:main`, '-o', bundle, file];
}

function irArgs(file, paths, output, project = false, entry = '') {
  const args = ['ir', ...sourceArgs(file, paths, project)];
  if (entry) args.push('--entry', entry);
  args.push('-o', output, file);
  return args;
}

async function listFiles(directory, prefix = '') {
  let entries;
  try { entries = await fs.readdir(path.join(directory, prefix), { withFileTypes: true }); }
  catch { return []; }
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'target') files.push(...await listFiles(directory, relative));
    } else if (entry.isFile() && entry.name !== 'Cargo.lock') {
      files.push(relative);
    }
  }
  return files.sort((left, right) => rank(left) - rank(right) || left.localeCompare(right));
}

// Put the module's own source first, then headers, then runtime support.
function rank(file) {
  if (/\.(c|cpp|go|rs|py|s)$/.test(file) && !/runtime|ziran_exe_main|ziran_entry/.test(file)) return 0;
  if (/\.(h|hpp)$/.test(file) && !/runtime/.test(file)) return 1;
  return 2;
}

function cut(text, binary) {
  return text.length > VIEW_TEXT_LIMIT ? `${text.slice(0, VIEW_TEXT_LIMIT)}\n… ${text.length - VIEW_TEXT_LIMIT} more characters not shown; the file is ${binary}\n` : text;
}

async function readText(file, limit = VIEW_TEXT_LIMIT) {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, limit);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    let text = buffer.toString('utf8');
    if (size > limit) text += `\n… ${size - limit} more bytes not shown; the full file is ${file}\n`;
    return text;
  } finally { await handle.close(); }
}

async function isBinary(file) {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally { await handle.close(); }
}

// Text files a build wrote; executables and objects belong to the hex view.
// With the program's FILE, only its own modules are read now; dependency
// files are read when the view asks for them.
async function textFiles(directory, file = '') {
  const names = [];
  for (const name of await listFiles(directory)) {
    if (!(await isBinary(path.join(directory, name)))) names.push(name);
  }
  const { mine, dependencies } = file ? splitOwn(names, file, await ownModules(file), (name) => name) :
    { mine: names, dependencies: [] };
  const files = [];
  for (const name of mine) files.push({ name, text: await readText(path.join(directory, name)) });
  for (const name of dependencies) {
    const full = path.join(directory, name);
    files.push(dependencyFile(name, () => readText(full), (await fs.stat(full)).size));
  }
  return files;
}

async function binaryFile(file, name = path.basename(file)) {
  return { name, binary: { path: file, size: (await fs.stat(file)).size } };
}

function view(id, label, files) {
  return { id, label, ok: true, message: '', files };
}

function failedView(id, label, message) {
  return { id, label, ok: false, message, files: [] };
}

function problem(result, what) {
  return (result.stderr || result.stdout || result.message || '').trim() ||
    (result.code === null ? `Could not start ${what}` : `${what} exited with ${result.code}`);
}

// Clear a build directory but keep the C object cache between runs.
async function cleanDirectory(directory, keep = ['.objects']) {
  await fs.mkdir(directory, { recursive: true });
  for (const entry of await fs.readdir(directory)) {
    if (!keep.includes(entry)) await fs.rm(path.join(directory, entry), { recursive: true, force: true });
  }
}

// Run COMMAND with one output stream written straight to FILE, so long
// listings are never held in memory; the other stream is kept for messages.
async function runToFile(command, args, cwd, file, stream = 'stdout') {
  observer.listener?.(path.basename(command), args);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const descriptor = fsSync.openSync(file, 'w');
  try {
    return await new Promise((resolve) => {
      const stdio = stream === 'stderr' ? ['ignore', 'pipe', descriptor] : ['ignore', descriptor, 'pipe'];
      const child = spawn(command, args, { cwd, env: safeEnvironment(), stdio, windowsHide: true });
      let message = '';
      (stream === 'stderr' ? child.stdout : child.stderr).on('data', (data) => {
        message = (message + data.toString()).slice(-65536);
      });
      child.on('error', (error) => resolve({ code: null, message: error.message }));
      child.on('close', (code) => resolve({ code, message }));
    });
  } finally { fsSync.closeSync(descriptor); }
}

async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// The same compiler invocation with `-S -o OUTPUT` in place of `-c`/`-o`.
function assemblyArguments(list, output) {
  const args = [];
  for (let index = 0; index < list.length; index++) {
    if (list[index] === '-c') continue;
    if (list[index] === '-o') { index++; continue; }
    args.push(list[index]);
  }
  args.push('-S', '-o', output);
  return args;
}

function cCompiler(environment = process.env) {
  return `${environment.CC || 'cc'} ${environment.CFLAGS ?? '-O3'}`.trim();
}

// Assembly for each generated C file, compiled with the flags
// `ziran compile-commands` reports for the real build.
async function cAssembly(context) {
  const { command, output, project, cwd, work } = context;
  const list = path.join(work, 'c-compile-commands.json');
  const compiler = cCompiler();
  const listed = await runCommand(command, ['compile-commands', ...(project ? ['--project'] : []),
    '--compiler', compiler, '-o', list, output], cwd);
  if (listed.code !== 0) return failedView('assembly', 'Assembly', problem(listed, 'ziran compile-commands'));
  let entries;
  try { entries = JSON.parse(await fs.readFile(list, 'utf8')); }
  catch (error) { return failedView('assembly', 'Assembly', error.message); }
  const directory = path.join(work, 'c-assembly');
  await fs.rm(directory, { recursive: true, force: true });
  const sources = entries.filter((entry) => /\.c$/.test(entry.file || ''))
    .sort((left, right) => rank(path.basename(left.file)) - rank(path.basename(right.file)) ||
      left.file.localeCompare(right.file));
  const nameOf = (entry) => path.relative(output, path.resolve(entry.directory || cwd, entry.file)).replace(/\.c$/, '.s');
  const compile = async (entry) => {
    const assembly = path.join(directory, nameOf(entry));
    await fs.mkdir(path.dirname(assembly), { recursive: true });
    const list = Array.isArray(entry.arguments) ? entry.arguments : String(entry.command || '').split(/\s+/);
    const [compilerCommand, ...args] = assemblyArguments(list, assembly);
    const result = await runCommand(compilerCommand, args, entry.directory || cwd);
    return result.code === 0 ? readText(assembly) :
      `${compilerCommand} failed:\n${problem(result, compilerCommand)}\n`;
  };
  const { mine, dependencies } = splitOwn(sources, context.file, await ownModules(context.file), nameOf);
  const files = await mapLimit(mine, 4, async (entry) => ({ name: nameOf(entry), text: await compile(entry) }));
  for (const entry of dependencies) files.push(dependencyFile(nameOf(entry), () => compile(entry)));
  return view('assembly', 'Assembly', files);
}

async function buildC(context) {
  const { command, file, output, paths, project, cwd, hasMain, noMain } = context;
  let exe = null;
  if (hasMain) exe = await runCommand(command, buildArgs('c', file, output, paths, project, { exe: true }), cwd);
  if (!exe || exe.code !== 0) {
    await cleanDirectory(output);
    const built = await runCommand(command, buildArgs('c', file, output, paths, project), cwd);
    if (built.code !== 0) return { ok: false, message: problem(built, 'ziran build'), views: [] };
  }
  const views = [...await pipelineViews(context), view('generated', 'C', await textFiles(output, file)),
    await cAssembly(context)];
  const program = path.join(output, moduleName(file));
  if (exe?.code === 0 && await exists(program)) {
    views.push(view('binary', 'Binary', [await binaryFile(program)]));
  } else {
    views.push(failedView('binary', 'Binary', hasMain ? problem(exe, 'ziran build --exe') : noMain));
  }
  return { ok: true, message: '', views };
}

async function buildGo(context) {
  const { command, file, output, paths, project, cwd, hasMain, noMain, work } = context;
  const name = moduleName(file);
  const built = await runCommand(command, buildArgs('go', file, output, paths, project, { exe: hasMain }), cwd);
  if (built.code !== 0) return { ok: false, message: problem(built, 'ziran build'), views: [] };
  const views = [...await pipelineViews(context), view('generated', 'Go', await textFiles(output, file))];
  if (!(await exists(path.join(output, 'go.mod')))) {
    await fs.writeFile(path.join(output, 'go.mod'), 'module ziranrun\n\ngo 1.21\n');
  }
  // -S prints the compiler's Go (Plan 9) assembly for this package.
  const listing = path.join(work, 'go-assembly', `${name}.s`);
  const program = path.join(work, 'go-binary', name);
  await fs.rm(path.dirname(program), { recursive: true, force: true });
  await fs.mkdir(path.dirname(program), { recursive: true });
  const args = ['build', '-buildvcs=false', '-trimpath', '-gcflags=-S', ...(hasMain ? ['-o', program] : []), '.'];
  const compiled = await runToFile('go', args, output, listing, 'stderr');
  if (compiled.code !== 0) {
    let text = '';
    try { text = (await readText(listing, 65536)).trim(); } catch {}
    const message = text || problem(compiled, 'go build');
    views.push(failedView('assembly', 'Assembly', message),
      failedView('binary', 'Binary', message));
    return { ok: true, message: '', views };
  }
  views.push(view('assembly', 'Assembly', [{ name: `${name}.s`, text: await readText(listing) }]));
  views.push(hasMain && await exists(program) ?
    view('binary', 'Binary', [await binaryFile(program)]) :
    failedView('binary', 'Binary', noMain));
  return { ok: true, message: '', views };
}

// A .wasm module as WebAssembly text.
async function watText(artifact) {
  const bytes = await fs.readFile(artifact);
  const wabt = await require('wabt')();
  const module = wabt.readWasm(bytes, { readDebugNames: true });
  try {
    module.validate();
    module.generateNames();
    module.applyNames();
    return module.toText({ foldExprs: false, inlineExport: false });
  } finally { module.destroy(); }
}

async function buildWasm(context) {
  const { command, file, output, paths, project, cwd, hasMain, noMain } = context;
  if (!hasMain) return { ok: false, message: noMain, views: [] };
  const name = moduleName(file);
  const artifact = path.join(output, `${name}.wasm`);
  const built = await runCommand(command, buildArgs('wasm', file, artifact, paths, project), cwd);
  if (built.code !== 0) return { ok: false, message: problem(built, 'ziran build'), views: [] };
  const text = await watText(artifact);
  return { ok: true, message: '', views: [...await pipelineViews(context),
    view('text', 'WAT', [{ name: `${name}.wat`, text }]),
    view('binary', 'Binary', [await binaryFile(artifact)]),
  ] };
}

// The checked program's .zir files. A program is checked from its main; a
// module without one is checked as it is.
async function checkedProgram(context, directory) {
  const { command, file, paths, project, cwd, hasMain } = context;
  const entry = hasMain ? `${moduleName(file)}:main` : '';
  await fs.rm(directory, { recursive: true, force: true });
  const saved = await runCommand(command, irArgs(file, paths, directory, project, entry), cwd);
  if (saved.code !== 0) throw new Error(`checked IR: ${problem(saved, 'ziran ir')}`);
  const input = path.join(directory, `${moduleName(file)}.zir`);
  if (!(await exists(input))) throw new Error(`checked IR: ziran ir wrote no ${path.basename(input)}`);
  return { entry, input, names: (await listFiles(directory)).filter((name) => name.endsWith('.zir')) };
}

async function toolStep(tool, label, stage, args, cwd) {
  const result = await runCommand(tool, args, cwd);
  if (result.code !== 0) throw new Error(`${stage}: ${problem(result, label)}`);
}

function missingTools(names) {
  const missing = names.join(' and ');
  const plural = names.length > 1;
  return `${missing} ${plural ? 'were' : 'was'} not found beside the ziran command or in a Ziran checkout; build ${plural ? 'them' : 'it'} there with \`make\`.`;
}

// The direct-assembly tools: zi2zx lowers checked ZIR to LIR and linked ZX
// and lists verified ZX; zx2native lowers ZX to its map and ELF. Each is
// found on its own; old tool names are not fallbacks.
async function nativeTools(command, file, folders) {
  const zx2native = await ziranTool(command, 'zx2native', file, folders);
  // One checkout's tools agree on the ZX revision; prefer those beside zx2native.
  const beside = async (name) => {
    const candidate = zx2native && path.join(path.dirname(zx2native), name);
    return candidate && await executable(candidate) ? candidate : ziranTool(command, name, file, folders);
  };
  return { zi2zx: await beside('zi2zx'), zx2native, zx2wasm: await beside('zx2wasm') };
}

// Every platform the toolchain lists, with the one `ziran.previewPlatform`
// selects: { list, platform, tools }.
async function platformChoice(command, file, folders, vscode) {
  const tools = await nativeTools(command, file, folders);
  const list = await platformList({ command, zx2native: tools.zx2native, zx2wasm: tools.zx2wasm });
  return { list, platform: selectedPlatform(list, configuredPlatform(file, vscode)), tools };
}

// Directories a module's source can be in: beside the program, the module
// paths, and the project's module roots.
async function sourceRoots(context) {
  const roots = [path.dirname(context.file), ...context.paths.map((entry) => entry.replace(/^[A-Za-z_][\w-]*=/, ''))];
  if (context.project) {
    const manifest = await readManifest(context.cwd);
    const declared = Array.isArray(manifest?.package?.module_roots) ? manifest.package.module_roots : [];
    for (const entry of declared) roots.push(path.resolve(context.cwd, entry));
  }
  return [...new Set(roots)];
}

// The source behind a checked module's name: `std_math` is std/math.zi.
async function findSource(module, roots) {
  const std = module.startsWith('std_');
  for (const root of roots) {
    const candidate = std ? (path.basename(root) === 'std' ? path.join(root, `${module.slice(4)}.zi`) : '') :
      path.join(root, `${module}.zi`);
    if (candidate && await exists(candidate)) return { path: candidate, name: std ? `std/${module.slice(4)}.zi` : `${module}.zi` };
  }
  return null;
}

// The Source stage: the program's own modules, then the sources of the modules
// it imports, read only when picked.
async function sourceView(context, names) {
  const { file } = context;
  const own = await ownModules(file);
  const modules = names.map((name) => name.replace(/\.zir$/, '')).filter((name) => name !== moduleName(file));
  const files = [{ name: path.basename(file), text: await readText(file) }];
  const dependencies = [];
  const roots = await sourceRoots(context);
  for (const module of modules) {
    if (own.has(module)) {
      files.push({ name: `${module}.zi`, text: await readText(path.join(path.dirname(file), `${module}.zi`)) });
      continue;
    }
    const found = await findSource(module, roots);
    if (found) dependencies.push(dependencyFile(found.name, () => readText(found.path), (await fs.stat(found.path)).size));
  }
  return view('source', 'Source', [...files, ...dependencies]);
}

// The ZIR stage: `ziran inspect` listings of the checked modules.
async function zirView(context, directory, names) {
  const { command, file, cwd, output } = context;
  // The tool of the toolchain that wrote the ZIR, which a project may pin.
  const tool = await ziranTool(command, 'zi-inspect', file, context.folders);
  const inspect = async (name) => {
    const listing = path.join(output, 'zir', `${name}.txt`);
    const inspected = await runToFile(tool || command, [...(tool ? [] : ['inspect']), path.join(directory, name)], cwd, listing);
    if (inspected.code !== 0) throw new Error(`ZIR listing: ${problem(inspected, 'ziran inspect')}`);
    return readText(listing);
  };
  const { mine, dependencies } = splitOwn(names, file, await ownModules(file), (name) => name);
  const files = [];
  for (const name of mine) files.push({ name, text: await inspect(name) });
  for (const name of dependencies) {
    files.push(dependencyFile(name, () => inspect(name).catch((error) => error.message),
      (await fs.stat(path.join(directory, name))).size));
  }
  return view('zir', 'ZIR', files);
}

// The stages every target shares, built once for all enabled targets:
// CONTEXT.stages is the chain they need, and each step runs only for a stage
// in it. The stage that fails and those after it show its reason.
async function buildPipeline(context) {
  const { file, output, hasMain, noMain } = context;
  const wanted = context.stages;
  const views = [];
  const finish = (message, zx = null) => {
    for (const id of wanted.slice(views.length)) views.push(failedView(id, CHAIN.find(([item]) => item === id)[1], message));
    return { views, zx, message };
  };
  const at = (name) => path.join(output, name);
  let checked;
  try {
    await cleanDirectory(output, []);
    checked = await checkedProgram(context, at('checked'));
  } catch (error) {
    views.push(await sourceView(context, []));
    return finish(error.message);
  }
  views.push(await sourceView(context, checked.names));
  try { views.push(await zirView(context, path.dirname(checked.input), checked.names)); }
  catch (error) { return finish(error.message); }
  if (!wanted.includes('lowered')) return { views, zx: null, message: '' };
  if (!hasMain) return finish(noMain);
  const { zi2zx } = await nativeTools(context.command, file, context.folders);
  if (!zi2zx) return finish(missingTools(['zi2zx']));
  try {
    const args = ['--root', path.dirname(checked.input), '--entry', checked.entry];
    const zx = at('final.zx');
    await toolStep(zi2zx, 'zi2zx', 'lowered instruction listing', [...args,
      '--emit', 'lir', '-o', at('lowered.lir'), checked.input], output);
    views.push(view('lowered', 'LIR', [{ name: 'lowered.lir', text: await readText(at('lowered.lir')) }]));
    await toolStep(zi2zx, 'zi2zx', 'optimization counters', [...args, '--opt',
      '--emit', 'opt-report', '-o', at('optimization.json'), checked.input], output);
    await toolStep(zi2zx, 'zi2zx', 'linked ZX instructions', [...args, '--emit', 'zx', '-o', zx, checked.input], output);
    await toolStep(zi2zx, 'zi2zx', 'verified ZX instruction listing',
      ['--emit', 'lir', '-o', at('optimized.lir'), zx], output);
    views.push(view('optimized', 'Optimized', [
      { name: 'optimized.lir', text: await readText(at('optimized.lir')) },
      { name: 'optimization.json', text: await readText(at('optimization.json')) }]));
    views.push(view('zx', 'ZX', [await binaryFile(zx)]));
    return { views, zx, message: '' };
  } catch (error) {
    return finish(error.message);
  }
}

// Each target's own copy of the shared stages it shows.
async function pipelineViews(context) {
  const { views } = await context.pipeline();
  const shown = stagesOf(context.target).map(([id]) => id);
  return views.filter((item) => shown.includes(item.id)).map((item) => ({ ...item, files: item.files.map((file) =>
    file.binary ? { ...file, binary: { ...file.binary } } : { ...file }) }));
}

// The direct native backend on CONTEXT.platform: zx2native lowers the
// pipeline's ZX to the platform's map and ELF or PE, whose Assembly lists the
// whole file and whose Binary shows its bytes; for Wasm, zx2wasm lowers it to
// a module shown as WAT and bytes. A platform the toolchain lists as a gap
// shows that gap on its own stages.
async function buildNative(context) {
  const { command, file, output, hasMain, noMain } = context;
  if (!hasMain) return { ok: false, message: noMain, views: [] };
  const platform = context.platform || { id: DEFAULT_PLATFORM, label: 'Linux x86-64', arch: 'x86_64', os: 'linux',
    format: 'elf', emit: 'elf', gap: '' };
  const tools = await nativeTools(command, file, context.folders);
  const lowerer = platform.format === 'wasm' ? 'zx2wasm' : 'zx2native';
  const missing = [tools.zi2zx ? '' : 'zi2zx', tools[lowerer] ? '' : lowerer].filter(Boolean);
  if (missing.length) return { ok: false, message: missingTools(missing), views: [] };
  const views = await pipelineViews(context);
  const own = platformStages(platform);
  const failed = (message) => ({ ok: true, message: '', views: [...views, ...own.map(([id, label]) => failedView(id, label, message))] });
  const { zx, message } = await context.pipeline();
  if (!zx) return failed(message);
  const at = (name) => path.join(output, name);
  try {
    const built = await platformArtifact(platform, zx, output, 'final', tools, runCommand);
    if (built.problem) return failed(built.problem);
    if (platform.format === 'wasm') {
      views.push(view('text', 'WAT', [{ name: 'final.wat', text: await watText(built.file) }]),
        view('binary', 'Binary', [await binaryFile(built.file)]));
      return { ok: true, message: '', views };
    }
    await toolStep(tools.zx2native, 'zx2native', 'final native map', ['--target', platform.arch, '--platform', platform.os,
      '--emit', 'map', '-o', at('final.map.json'), zx], output);
    const map = JSON.parse(await fs.readFile(at('final.map.json'), 'utf8'));
    const listing = await binaryListing(built.file, map, await ownModules(file), output);
    const binary = await binaryFile(built.file);
    binary.binary.regions = listing.regions;
    binary.binary.filterLabel = listing.filterLabel;
    views.push(view('assembly', 'Assembly', [{ name: 'final.disasm', text: cut(listing.text, built.file),
      filtered: cut(listing.program, built.file), filterLabel: listing.filterLabel }]),
    view('binary', 'Binary', [binary]));
  } catch (error) {
    return failed(error.message);
  }
  return { ok: true, message: '', views };
}

// Any other source generator: the shared stages up to ZIR, then the generated source.
async function buildSource(context, target) {
  const { command, file, output, paths, project, cwd } = context;
  const built = await runCommand(command, buildArgs(target, file, output, paths, project), cwd);
  if (built.code !== 0) return { ok: false, message: problem(built, 'ziran build'), views: [] };
  const label = TARGETS.find((item) => item.id === target)?.label || target;
  return { ok: true, message: '', views: [...await pipelineViews(context),
    view('generated', label, await textFiles(output, file))] };
}

const BUILDERS = { c: buildC, go: buildGo, wasm: buildWasm, native: buildNative };

async function targetContext(command, file, output, paths, options = {}) {
  const project = await packageRoot(file);
  let hasMain = options.hasMain;
  if (hasMain === undefined) {
    try { hasMain = mainLine(await fs.readFile(file, 'utf8')) >= 0; } catch { hasMain = false; }
  }
  const noMain = options.noMain || noMainMessage(file, hasMain ? [] : await importingPrograms(file));
  return { command, file, output, paths, project: Boolean(project),
    cwd: project || path.dirname(file), hasMain, noMain, folders: options.folders || [] };
}

// The shared stages for FILE, built once under DIRECTORY for the TARGETS
// that show them.
async function startPipeline(command, file, directory, paths, options = {}) {
  const context = await targetContext(command, file, directory, paths, options);
  return buildPipeline({ ...context, stages: chainFor(options.targets || []) });
}

// Build FILE for TARGET under WORKDIRECTORY and return its views: the shared
// stages, then the target's generated code, assembly and binary. OPTIONS.pipeline
// is a shared startPipeline result; without one the target builds its own.
async function buildTarget(command, target, file, workDirectory, paths, options = {}) {
  const output = path.join(workDirectory, target);
  const work = path.join(workDirectory, `${target}.inspect`);
  await cleanDirectory(output);
  await fs.mkdir(work, { recursive: true });
  const context = { ...await targetContext(command, file, output, paths, options), work, target,
    platform: options.platform || null };
  let pipeline = options.pipeline;
  context.pipeline = () => (pipeline ||= startPipeline(command, file,
    path.join(workDirectory, `${target}.pipeline`), paths, { ...context, targets: [target] }));
  try {
    const builder = BUILDERS[target];
    const result = builder ? await builder(context) : await buildSource(context, target);
    // The table, not the builder, decides the tabs and their order.
    const order = stagesOf(target, target === 'native' ? options.platform : null);
    const views = order.map(([id, label]) => {
      const found = result.views.find((item) => item.id === id);
      return found && { ...found, label };
    }).filter(Boolean);
    return { id: target, ...result, views };
  } catch (error) {
    return { id: target, ok: false, message: error.message, views: [] };
  }
}

module.exports = {
  DEFAULT_TARGETS, TARGETS, assemblyArguments, buildArgs, buildTarget, bundleArgs, cCompiler,
  chainFor, commandStd, configuredPlatform, enabledTargets, nativeTools, platformChoice, importedPackages, importingPrograms, irArgs, listFiles, mainLine,
  modulePaths, noMainMessage, ownModules, packageModulePaths, packageRoot, sourceArgs, splitOwn,
  observeCommands, stagesOf, startPipeline, ziranCommand, ziranTool };
