const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { manifestPath, projectRoot, runCommand } = require('./preview.cjs');

const TARGETS = [
  { id: 'c', label: 'C' },
  { id: 'cpp', label: 'C++' },
  { id: 'go', label: 'Go' },
  { id: 'rust', label: 'Rust' },
  { id: 'plan9-c', label: 'Plan 9 C' },
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

function targetsHtml(nonce) {
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 12px; }
  header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
  h1 { font-size: 1.1rem; margin: 0; }
  #status { color: var(--vscode-descriptionForeground); }
  button, select { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; padding: 5px 9px; }
  fieldset { border: 1px solid var(--vscode-panel-border); display: flex; gap: 14px; flex-wrap: wrap; padding: 6px 10px; margin: 0 0 10px; }
  legend { color: var(--vscode-descriptionForeground); font-size: .85rem; }
  .tabs { display: flex; gap: 2px; flex-wrap: wrap; border-bottom: 1px solid var(--vscode-panel-border); }
  .tab { background: transparent; color: var(--vscode-foreground); border-bottom: 2px solid transparent; }
  .tab[aria-selected="true"] { border-bottom-color: var(--vscode-focusBorder); font-weight: bold; }
  .tab.failed { color: var(--vscode-errorForeground); }
  .files { margin: 8px 0; }
  pre { box-sizing: border-box; overflow: auto; white-space: pre; font-family: var(--vscode-editor-font-family), monospace; font-size: var(--vscode-editor-font-size); line-height: 1.35; border: 1px solid var(--vscode-panel-border); padding: 10px; margin: 0; }
  .error { color: var(--vscode-errorForeground); white-space: pre-wrap; }
  #empty { color: var(--vscode-descriptionForeground); }
</style></head><body>
<header><h1 id="title">Generated code</h1><button id="run">Rebuild</button><span id="status">Starting…</span></header>
<fieldset id="targets"><legend>Targets</legend></fieldset>
<div class="tabs" id="tabs" role="tablist"></div>
<div class="files"><select id="files" aria-label="Generated file"></select></div>
<pre id="source"></pre>
<p id="empty"></p>
<script nonce="${nonce}">
  const api = acquireVsCodeApi();
  const byId = (id) => document.getElementById(id);
  let state = null;
  let selected = '';
  let files = {};
  const render = () => {
    if (!state) return;
    byId('title').textContent = state.title;
    byId('status').textContent = state.status;
    const boxes = byId('targets');
    boxes.querySelectorAll('label').forEach((label) => label.remove());
    for (const target of state.targets) {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = state.enabled.includes(target.id);
      box.addEventListener('change', () => {
        const enabled = state.targets.map((item) => item.id)
          .filter((id) => id === target.id ? box.checked : state.enabled.includes(id));
        api.postMessage({ type: 'targets', enabled });
      });
      label.append(box, ' ' + target.label);
      boxes.append(label);
    }
    const results = state.results;
    if (!results.some((result) => result.id === selected)) selected = results[0] ? results[0].id : '';
    const tabs = byId('tabs');
    tabs.replaceChildren();
    for (const result of results) {
      const tab = document.createElement('button');
      tab.className = 'tab' + (result.ok ? '' : ' failed');
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(result.id === selected));
      tab.textContent = state.targets.find((item) => item.id === result.id).label + (result.ok ? '' : ' ✕');
      tab.addEventListener('click', () => { selected = result.id; render(); });
      tabs.append(tab);
    }
    const result = results.find((item) => item.id === selected);
    const select = byId('files');
    select.replaceChildren();
    byId('empty').textContent = results.length ? '' :
      (state.enabled.length ? '' : 'Choose at least one target.');
    if (!result) { byId('source').textContent = ''; select.disabled = true; return; }
    for (const file of result.files) {
      const option = document.createElement('option');
      option.value = file.name;
      option.textContent = file.name;
      select.append(option);
    }
    select.disabled = result.files.length < 2;
    const chosen = result.files.find((file) => file.name === files[result.id]) || result.files[0];
    if (chosen) select.value = chosen.name;
    const source = byId('source');
    source.className = result.ok ? '' : 'error';
    source.textContent = result.ok ? (chosen ? chosen.text : '') : result.message;
  };
  window.addEventListener('message', ({ data }) => {
    if (data.type !== 'state') return;
    state = data;
    render();
  });
  byId('files').addEventListener('change', (event) => { files[selected] = event.target.value; render(); });
  byId('run').addEventListener('click', () => api.postMessage({ type: 'run' }));
  api.postMessage({ type: 'ready' });
</script></body></html>`;
}

class TargetPreview {
  constructor(file, context, vscode) {
    this.file = file;
    this.vscode = vscode;
    this.disposed = false;
    this.running = false;
    this.rerun = false;
    this.workDirectory = path.join(os.tmpdir(), 'ziran-targets-' +
      createHash('sha256').update(file).digest('hex').slice(0, 16));
    this.state = { type: 'state', title: path.basename(file), status: 'Starting…',
      targets: TARGETS, enabled: enabledTargets(file, vscode), results: [] };
    this.panel = vscode.window.createWebviewPanel('ziranTargets',
      `Targets: ${path.basename(file)}`, vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true });
    this.panel.webview.html = targetsHtml(randomBytes(16).toString('hex'));
    this.disposables = [
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((message) => this.message(message)),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document.uri.fsPath.endsWith('.zi') &&
            path.dirname(document.uri.fsPath) === path.dirname(file)) this.schedule();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration('ziran', vscode.Uri.file(file))) return;
        this.state.enabled = enabledTargets(file, vscode);
        this.schedule();
      }),
    ];
    context.subscriptions.push(this);
    this.run();
  }

  reveal() { this.panel.reveal(this.vscode.ViewColumn.Beside); }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    for (const disposable of this.disposables) disposable.dispose();
    fs.rm(this.workDirectory, { recursive: true, force: true }).catch(() => {});
  }

  post() { if (!this.disposed) this.panel.webview.postMessage(this.state); }

  schedule() {
    if (this.disposed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(), 250);
  }

  async message(message) {
    if (message.type === 'ready') this.post();
    if (message.type === 'run') this.schedule();
    if (message.type === 'targets' && Array.isArray(message.enabled)) {
      const enabled = TARGETS.map((target) => target.id)
        .filter((id) => message.enabled.includes(id));
      const uri = this.vscode.Uri.file(this.file);
      const scope = this.vscode.workspace.getWorkspaceFolder?.(uri) ?
        this.vscode.ConfigurationTarget.WorkspaceFolder :
        this.vscode.ConfigurationTarget.Global;
      this.state.enabled = enabled;
      await this.vscode.workspace.getConfiguration('ziran', uri)
        .update('previewTargets', enabled, scope);
      this.schedule();
    }
  }

  async run() {
    if (this.disposed) return;
    if (this.running) { this.rerun = true; return; }
    this.running = true;
    this.state.status = 'Building…';
    this.post();
    try {
      const command = await ziranCommand(this.file, this.vscode);
      const paths = await modulePaths(this.file, command, this.vscode);
      await fs.mkdir(this.workDirectory, { recursive: true });
      const results = await Promise.all(this.state.enabled.map((target) =>
        buildTarget(command, target, this.file, this.workDirectory, paths)));
      if (this.disposed) return;
      const failed = results.filter((result) => !result.ok).length;
      this.state.results = results;
      this.state.status = failed ?
        `${failed} of ${results.length} target${results.length === 1 ? '' : 's'} failed` :
        'Up to date · rebuilds on save';
      this.post();
    } catch (error) {
      this.state.status = `Preview failed: ${error.message}`;
      this.post();
    } finally {
      this.running = false;
      if (this.rerun && !this.disposed) { this.rerun = false; this.schedule(); }
    }
  }
}

function activateTargets(context, vscode) {
  const previews = new Map();
  context.subscriptions.push(vscode.commands.registerCommand('ziran.previewTargets', async (uri) => {
    const file = uri?.fsPath || vscode.window.activeTextEditor?.document.uri.fsPath;
    if (!file || !file.endsWith('.zi')) {
      vscode.window.showErrorMessage('Open a .zi file to preview its generated code.');
      return;
    }
    if (previews.has(file)) { previews.get(file).reveal(); return; }
    const preview = new TargetPreview(file, context, vscode);
    previews.set(file, preview);
    preview.panel.onDidDispose(() => previews.delete(file));
  }));
}

module.exports = { TARGETS, activateTargets, buildArgs, buildTarget, commandStd, enabledTargets,
  listFiles, modulePaths, targetsHtml, ziranCommand };
