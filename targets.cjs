const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { parse } = require('@iarna/toml');
const { manifestPath, projectRoot, runCommand, safeEnvironment } = require('./preview.cjs');

const TARGETS = [
  { id: 'c', label: 'C' },
  { id: 'go', label: 'Go' },
  { id: 'wasm', label: 'Wasm' },
  { id: 'zx', label: 'ZX' },
  { id: 'native', label: 'Native' },
];
const DEFAULT_TARGETS = ['c', 'go', 'wasm', 'zx'];
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

// Another tool of the Ziran toolchain behind COMMAND, such as zi2asm: beside
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
  return TARGETS.map((target) => target.id).filter((id) => configured.includes(id));
}

function moduleName(file) {
  return path.basename(file, '.zi');
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
async function textFiles(directory) {
  const files = [];
  for (const name of await listFiles(directory)) {
    const file = path.join(directory, name);
    if (!(await isBinary(file))) files.push({ name, text: await readText(file) });
  }
  return files;
}

async function binaryFile(file, name = path.basename(file)) {
  return { name, binary: { path: file, size: (await fs.stat(file)).size } };
}

function view(id, label, files, caption = '') {
  return { id, label, ok: true, message: '', caption, files };
}

function failedView(id, label, message) {
  return { id, label, ok: false, message, caption: '', files: [] };
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
  const files = await mapLimit(sources, 4, async (entry) => {
    const name = path.relative(output, path.resolve(entry.directory || cwd, entry.file)).replace(/\.c$/, '.s');
    const assembly = path.join(directory, name);
    await fs.mkdir(path.dirname(assembly), { recursive: true });
    const list = Array.isArray(entry.arguments) ? entry.arguments : String(entry.command || '').split(/\s+/);
    const [compilerCommand, ...args] = assemblyArguments(list, assembly);
    const result = await runCommand(compilerCommand, args, entry.directory || cwd);
    return result.code === 0 ? { name, text: await readText(assembly) } :
      { name, text: `${compilerCommand} failed:\n${problem(result, compilerCommand)}\n` };
  });
  return view('assembly', 'Assembly', files, `${compiler} -S, with the flags ziran compile-commands reports`);
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
  const views = [view('source', 'Source', await textFiles(output)), await cAssembly(context)];
  const program = path.join(output, moduleName(file));
  if (exe?.code === 0 && await exists(program)) {
    views.push(view('binary', 'Binary', [await binaryFile(program)], `${cCompiler()} executable`));
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
  const views = [view('source', 'Source', await textFiles(output))];
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
  views.push(view('assembly', 'Assembly', [{ name: `${name}.s`, text: await readText(listing) }],
    'go build -gcflags=-S: Go assembly'));
  views.push(hasMain && await exists(program) ?
    view('binary', 'Binary', [await binaryFile(program)], 'go build executable') :
    failedView('binary', 'Binary', noMain));
  return { ok: true, message: '', views };
}

async function buildWasm(context) {
  const { command, file, output, paths, project, cwd, hasMain, noMain } = context;
  if (!hasMain) return { ok: false, message: noMain, views: [] };
  const name = moduleName(file);
  const artifact = path.join(output, `${name}.wasm`);
  const built = await runCommand(command, buildArgs('wasm', file, artifact, paths, project), cwd);
  if (built.code !== 0) return { ok: false, message: problem(built, 'ziran build'), views: [] };
  const bytes = await fs.readFile(artifact);
  const wabt = await require('wabt')();
  const module = wabt.readWasm(bytes, { readDebugNames: true });
  let text;
  try {
    module.validate();
    module.generateNames();
    module.applyNames();
    text = module.toText({ foldExprs: false, inlineExport: false });
  } finally { module.destroy(); }
  return { ok: true, message: '', views: [
    view('text', 'WAT', [{ name: `${name}.wat`, text }]),
    view('binary', 'Binary', [await binaryFile(artifact)]),
  ] };
}

// Checked .zir for the program's main, for the direct backend.
async function checkedProgram(context, directory) {
  const { command, file, paths, project, cwd } = context;
  const entry = `${moduleName(file)}:main`;
  await fs.rm(directory, { recursive: true, force: true });
  const saved = await runCommand(command, irArgs(file, paths, directory, project, entry), cwd);
  if (saved.code !== 0) throw new Error(`checked IR: ${problem(saved, 'ziran ir')}`);
  const input = path.join(directory, `${moduleName(file)}.zir`);
  if (!(await exists(input))) throw new Error(`checked IR: ziran ir wrote no ${path.basename(input)}`);
  return { entry, input };
}

async function zi2asmStep(zi2asm, stage, args, cwd) {
  const result = await runCommand(zi2asm, args, cwd);
  if (result.code !== 0) throw new Error(`${stage}: ${problem(result, 'zi2asm')}`);
}

async function buildZx(context) {
  const { command, file, output, paths, project, cwd, hasMain, noMain } = context;
  if (!hasMain) return { ok: false, message: noMain, views: [] };
  const name = moduleName(file);
  const bundle = path.join(output, `${name}.zx`);
  const built = await runCommand(command, bundleArgs(file, paths, bundle, project), cwd);
  if (built.code !== 0) return { ok: false, message: problem(built, 'ziran bundle'), views: [] };
  const listing = path.join(output, `${name}.zx.txt`);
  let inspected = await runToFile(command, ['inspect', bundle], cwd, listing);
  // `inspect` is not a project command, so a project-aware launcher can
  // reach an installed Ziran older than the pinned toolchain that bundled it.
  const inspector = inspected.code === 0 ? null : await ziranTool(command, 'zi-inspect', file, context.folders);
  if (inspector) inspected = await runToFile(inspector, [bundle], cwd, listing);
  const views = [inspected.code === 0 ?
    view('listing', 'Listing', [{ name: `${name}.zx.txt`, text: await readText(listing) }],
      'ziran inspect: entry, linked modules and checked code') :
    failedView('listing', 'Listing', problem(inspected, 'ziran inspect'))];
  views.push(await zxInstructions(context));
  views.push(view('binary', 'Binary', [await binaryFile(bundle)]));
  return { ok: true, message: '', views };
}

// Lowered instructions of the executable ZX container (revision 28) when the
// experimental direct backend supports the program.
async function zxInstructions(context) {
  const { command, file, output } = context;
  const zi2asm = await ziranTool(command, 'zi2asm', file, context.folders);
  const unsupported = 'The installed .zx carries checked .zir (see Listing). Lowered instructions come from ' +
    'the experimental revision-28 container written by zi2asm';
  if (!zi2asm) return failedView('instructions', 'Instructions', `${unsupported}, which was not found.`);
  try {
    const { entry, input } = await checkedProgram(context, path.join(output, 'checked'));
    const container = path.join(output, `${moduleName(file)}.r28.zx`);
    const listing = path.join(output, `${moduleName(file)}.zx.lir`);
    await zi2asmStep(zi2asm, 'executable ZX', ['--root', path.dirname(input), '--entry', entry,
      '--emit', 'zx', '-o', container, input], output);
    await zi2asmStep(zi2asm, 'instruction listing', ['--input', 'zx', '--emit', 'lir', '-o', listing,
      container], output);
    return view('instructions', 'Instructions', [
      { name: path.basename(listing), text: await readText(listing) },
      await binaryFile(container),
    ], 'zi2asm --input zx --emit lir: revision-28 executable container');
  } catch (error) {
    return failedView('instructions', 'Instructions', `${unsupported}; it does not support this program.\n${error.message}`);
  }
}

// Ziran's direct-assembly inspection pipeline (ASSEMBLY/vscode-inspection.md):
// checked .zir -> lowered/optimized listings -> final ELF and map -> objdump.
async function buildNative(context) {
  const { command, file, output, hasMain, noMain } = context;
  if (!hasMain) return { ok: false, message: noMain, views: [] };
  const zi2asm = await ziranTool(command, 'zi2asm', file, context.folders);
  if (!zi2asm) {
    return { ok: false, message: 'zi2asm was not found beside the ziran command or in a Ziran checkout; build it there with `make assembly`.', views: [] };
  }
  try {
    const { entry, input } = await checkedProgram(context, path.join(output, 'checked'));
    const at = (name) => path.join(output, name);
    const lirb = at('lowered.lirb');
    await zi2asmStep(zi2asm, 'lowered instruction binary', ['--root', path.dirname(input), '--entry', entry,
      '--emit', 'exec', '-o', lirb, input], output);
    for (const [stage, args] of [
      ['lowered instruction listing', ['--emit', 'lir', '-o', at('lowered.lir')]],
      ['optimized instruction listing', ['--opt', '--emit', 'lir', '-o', at('optimized.lir')]],
      ['optimization counters', ['--opt', '--emit', 'opt-report', '-o', at('optimization.json')]],
      ['final native map', ['--opt', '--emit', 'map', '-o', at('final.map.json')]],
      ['final ELF', ['--opt', '--emit', 'elf', '-o', at('final.elf')]],
    ]) await zi2asmStep(zi2asm, stage, ['--input', 'exec', ...args, lirb], output);
    const map = JSON.parse(await fs.readFile(at('final.map.json'), 'utf8'));
    const address = map.image?.text_virtual_address;
    if (!Number.isInteger(address) || address < 0) throw new Error('final native map: image.text_virtual_address is missing');
    const adjustment = `-0x${address.toString(16)}`;
    const body = at('final.objdump');
    const disassembled = await runToFile('objdump', ['-d', `--adjust-vma=${adjustment}`, 'final.elf'], output, body);
    if (disassembled.code !== 0) throw new Error(`final disassembly: ${problem(disassembled, 'objdump')}`);
    const disassembly = `# Ziran direct-assembly final disassembly\n` +
      `# map identity: ${map.identity?.algorithm || ''} ${map.identity?.scope || ''} ${map.identity?.digest || ''}\n` +
      `# image.text_virtual_address: 0x${address.toString(16)} (${address})\n` +
      `# command: objdump -d --adjust-vma=${adjustment} final.elf\n\n` + await readText(body);
    return { ok: true, message: '', views: [
      view('lowered', 'Lowered', [{ name: 'lowered.lir', text: await readText(at('lowered.lir')) }]),
      view('optimized', 'Optimized', [
        { name: 'optimized.lir', text: await readText(at('optimized.lir')) },
        { name: 'optimization.json', text: await readText(at('optimization.json')) }]),
      view('disassembly', 'Disassembly', [{ name: 'final.disasm', text: disassembly }],
        'objdump of the ELF zi2asm encoded'),
      view('binary', 'Binary', [await binaryFile(at('final.elf')), await binaryFile(lirb)]),
    ] };
  } catch (error) {
    return { ok: false, message: `Native inspection failed during ${error.message}`, views: [] };
  }
}

// Any other target: the generated source only.
async function buildSource(context, target) {
  const { command, file, output, paths, project, cwd } = context;
  const built = await runCommand(command, buildArgs(target, file, output, paths, project), cwd);
  if (built.code !== 0) return { ok: false, message: problem(built, 'ziran build'), views: [] };
  return { ok: true, message: '', views: [view('source', 'Source', await textFiles(output))] };
}

const BUILDERS = { c: buildC, go: buildGo, wasm: buildWasm, zx: buildZx, native: buildNative };

// Build FILE for TARGET under WORKDIRECTORY and return its views: generated
// source, assembly and the binary it produces, each a list of files.
async function buildTarget(command, target, file, workDirectory, paths, options = {}) {
  const output = path.join(workDirectory, target);
  const work = path.join(workDirectory, `${target}.inspect`);
  await cleanDirectory(output);
  await fs.mkdir(work, { recursive: true });
  const project = await packageRoot(file);
  let hasMain = options.hasMain;
  if (hasMain === undefined) {
    try { hasMain = mainLine(await fs.readFile(file, 'utf8')) >= 0; } catch { hasMain = false; }
  }
  const noMain = options.noMain || noMainMessage(file, hasMain ? [] : await importingPrograms(file));
  const context = { command, file, output, work, paths, project: Boolean(project),
    cwd: project || path.dirname(file), hasMain, noMain, folders: options.folders || [] };
  try {
    const builder = BUILDERS[target];
    return { id: target, ...(builder ? await builder(context) : await buildSource(context, target)) };
  } catch (error) {
    return { id: target, ok: false, message: error.message, views: [] };
  }
}

module.exports = {
  DEFAULT_TARGETS, TARGETS, assemblyArguments, buildArgs, buildTarget, bundleArgs, cCompiler,
  commandStd, enabledTargets, importedPackages, importingPrograms, irArgs, listFiles, mainLine,
  modulePaths, noMainMessage, packageModulePaths, packageRoot, sourceArgs, ziranCommand, ziranTool };
