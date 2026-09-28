const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { manifestPath, projectRoot, runCommand } = require('./preview.cjs');

const TARGETS = [
  { id: 'c', label: 'C' },
  { id: 'cpp', label: 'C++' },
  { id: 'plan9-c', label: '9c' },
  { id: 'go', label: 'Go' },
  { id: 'rust', label: 'Rust' },
];

async function exists(file) {
  try { await fs.access(file); return true; }
  catch { return false; }
}

// The ziran command for a source file: the setting, a Kryon project's
// Ziran checkout, a checkout above the file, a sibling checkout of an open
// folder, the user install, then PATH.
async function ziranCommand(file, vscode) {
  const configured = vscode.workspace.getConfiguration('ziran', vscode.Uri.file(file))
    .get('command', '');
  if (configured) return configured;
  const root = await projectRoot(file);
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

// Standard modules that belong to a checkout's build/bin/ziran.
function commandStd(command) {
  const bin = path.dirname(command);
  if (path.basename(bin) !== 'bin' || path.basename(path.dirname(bin)) !== 'build') return null;
  return path.join(path.dirname(path.dirname(bin)), 'std');
}

async function modulePaths(file, command, vscode) {
  const folder = vscode.workspace.getWorkspaceFolder?.(vscode.Uri.file(file));
  const base = folder ? folder.uri.fsPath : path.dirname(file);
  const configured = vscode.workspace.getConfiguration('ziran', vscode.Uri.file(file))
    .get('modulePaths', []);
  const candidates = [commandStd(command), ...configured.map((entry) => path.resolve(base, entry))];
  const paths = [];
  for (const candidate of candidates) {
    if (candidate && !paths.includes(candidate) && await exists(candidate)) paths.push(candidate);
  }
  return paths;
}

function enabledTargets(file, vscode) {
  const configured = vscode.workspace.getConfiguration('ziran', vscode.Uri.file(file))
    .get('previewTargets', TARGETS.map((target) => target.id));
  return TARGETS.map((target) => target.id).filter((id) => configured.includes(id));
}

// A single file builds with its own directory as root, so its module name
// is its filename, exactly as `ziran build --root . file.zi` would.
function buildArgs(target, file, output, paths) {
  const args = ['build', `--target=${target}`, '--root', path.dirname(file)];
  for (const entry of paths) args.push('--module-path', entry);
  args.push('-o', output, file);
  return args;
}

async function listFiles(directory, prefix = '') {
  let entries;
  try { entries = await fs.readdir(path.join(directory, prefix), { withFileTypes: true }); }
  catch { return []; }
  const files = [];
  for (const entry of entries) {
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
  if (/\.(c|cpp|go|rs)$/.test(file) && !/runtime/.test(file)) return 0;
  if (/\.(h|hpp)$/.test(file) && !/runtime/.test(file)) return 1;
  return 2;
}

async function buildTarget(command, target, file, workDirectory, paths) {
  const output = path.join(workDirectory, target);
  await fs.rm(output, { recursive: true, force: true });
  const result = await runCommand(command, buildArgs(target, file, output, paths),
    path.dirname(file));
  const message = (result.stderr || result.stdout).trim();
  if (result.code !== 0) {
    return { id: target, ok: false, message: message || `ziran exited with ${result.code}`, files: [] };
  }
  const files = [];
  for (const name of await listFiles(output)) {
    files.push({ name, text: await fs.readFile(path.join(output, name), 'utf8') });
  }
  return { id: target, ok: true, message, files };
}

module.exports = { TARGETS, buildArgs, buildTarget, commandStd, enabledTargets,
  listFiles, modulePaths, ziranCommand };
