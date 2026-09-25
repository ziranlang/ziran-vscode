const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');

function safeEnvironment() {
  const { DISPLAY, WAYLAND_DISPLAY, ...environment } = process.env;
  return environment;
}

function runCommand(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: safeEnvironment(), windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.on('error', (error) => resolve({ code: null, stdout, stderr: error.message }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function exists(file) {
  try { await fs.access(file); return true; }
  catch { return false; }
}

async function projectRoot(start) {
  let directory = start;
  try {
    if (!(await fs.stat(directory)).isDirectory()) directory = path.dirname(directory);
  } catch { return null; }
  while (true) {
    if (await exists(path.join(directory, 'kryon.toml'))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

async function manifestPath(root, name, fallback) {
  let source;
  try { source = await fs.readFile(path.join(root, 'kryon.toml'), 'utf8'); }
  catch { return path.resolve(root, fallback); }
  let section = '';
  for (const line of source.split(/\r?\n/)) {
    const heading = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (heading) { section = heading[1]; continue; }
    const setting = line.match(/^\s*([A-Za-z_][\w-]*)\s*=\s*"([^"\\]*)"\s*(?:#.*)?$/);
    if (section === 'paths' && setting?.[1] === name) {
      return path.resolve(root, setting[2]);
    }
  }
  return path.resolve(root, fallback);
}

async function generatedFiles(root, kind) {
  const directory = path.join(root, 'build', 'generated', kind);
  try {
    const files = await fs.readdir(directory);
    return files.filter((file) => file.endsWith(kind === 'c' ? '.c' : '.zir')).sort();
  } catch { return []; }
}

function previewHtml(nonce) {
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 12px; }
  header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  h1 { font-size: 1.1rem; margin: 0; }
  h2 { font-size: 0.95rem; }
  button, select { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; padding: 5px 9px; }
  select { max-width: 100%; }
  #status { color: var(--vscode-descriptionForeground); }
  pre { box-sizing: border-box; overflow: auto; white-space: pre; font-family: var(--vscode-editor-font-family), monospace; font-size: var(--vscode-editor-font-size); line-height: 1.3; border: 1px solid var(--vscode-panel-border); padding: 10px; }
  #output { min-height: 5em; }
  details { margin-top: 16px; }
  summary { cursor: pointer; font-weight: bold; margin-bottom: 8px; }
</style></head><body>
<header><h1>Kryon Preview</h1><button id="run">Run again</button><span id="status">Starting…</span></header>
<h2>Rendered output</h2><pre id="output"></pre>
<details><summary>Generated C</summary><select id="c-files" aria-label="Generated C module"></select><pre id="c-source"></pre></details>
<details><summary>Checked .zir (inspected)</summary><select id="ir-files" aria-label="Checked Ziran module"></select><pre id="ir-source"></pre></details>
<script nonce="${nonce}">
  const api = acquireVsCodeApi();
  const byId = (id) => document.getElementById(id);
  const fill = (id, files, selected) => {
    const select = byId(id);
    select.replaceChildren();
    for (const file of files) {
      const option = document.createElement('option');
      option.value = file;
      option.textContent = file;
      select.append(option);
    }
    select.value = selected || '';
    select.disabled = files.length === 0;
  };
  window.addEventListener('message', ({ data }) => {
    if (data.type !== 'state') return;
    byId('status').textContent = data.status;
    byId('output').textContent = data.output;
    fill('c-files', data.cFiles, data.selectedC);
    fill('ir-files', data.irFiles, data.selectedIr);
    byId('c-source').textContent = data.cSource;
    byId('ir-source').textContent = data.irSource;
  });
  byId('run').addEventListener('click', () => api.postMessage({ type: 'run' }));
  byId('c-files').addEventListener('change', (event) => api.postMessage({ type: 'c', file: event.target.value }));
  byId('ir-files').addEventListener('change', (event) => api.postMessage({ type: 'ir', file: event.target.value }));
  api.postMessage({ type: 'ready' });
</script></body></html>`;
}

class Preview {
  constructor(root, context, vscode) {
    this.root = root;
    this.vscode = vscode;
    this.disposed = false;
    this.running = false;
    this.rerun = false;
    this.state = {
      type: 'state', status: 'Starting…', output: '', cFiles: [], irFiles: [],
      selectedC: '', selectedIr: '', cSource: '', irSource: '',
    };
    this.panel = vscode.window.createWebviewPanel('kryonPreview',
      `Preview: ${path.basename(root)}`, vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true });
    this.panel.webview.html = previewHtml(randomBytes(16).toString('hex'));
    this.disposables = [
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((message) => this.message(message)),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document.uri.fsPath === path.join(root, 'kryon.toml') ||
            document.uri.fsPath.startsWith(path.join(root, 'src') + path.sep)) {
          this.schedule();
        }
      }),
    ];
    for (const pattern of ['src/**/*.zi', 'kryon.toml']) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(root), pattern));
      this.disposables.push(watcher, watcher.onDidChange(() => this.schedule()),
        watcher.onDidCreate(() => this.schedule()),
        watcher.onDidDelete(() => this.schedule()));
    }
    context.subscriptions.push(this);
    this.run();
  }

  reveal() { this.panel.reveal(this.vscode.ViewColumn.Beside); }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    for (const disposable of this.disposables) disposable.dispose();
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
    if (message.type === 'c' && this.state.cFiles.includes(message.file)) {
      this.state.selectedC = message.file;
      await this.loadC();
      this.post();
    }
    if (message.type === 'ir' && this.state.irFiles.includes(message.file)) {
      this.state.selectedIr = message.file;
      await this.loadIr();
      this.post();
    }
  }

  async loadC() {
    try {
      this.state.cSource = await fs.readFile(path.join(this.root, 'build', 'generated',
        'c', this.state.selectedC), 'utf8');
    } catch (error) { this.state.cSource = error.message; }
  }

  async loadIr() {
    const ziran = await manifestPath(this.root, 'ziran', '../ziran');
    const file = path.join(this.root, 'build', 'generated', 'ir', this.state.selectedIr);
    const result = await runCommand(path.join(ziran, 'build', 'bin', 'ziran'),
      ['inspect', file], this.root);
    this.state.irSource = result.code === 0 ? result.stdout : result.stderr;
  }

  async run() {
    if (this.disposed) return;
    if (this.running) { this.rerun = true; return; }
    this.running = true;
    this.state.status = 'Building and running…';
    this.post();
    try {
      const configured = this.vscode.workspace.getConfiguration('ziran',
        this.vscode.Uri.file(this.root));
      let command = configured.get('kryonCommand', '');
      const local = path.join(os.homedir(), '.local', 'bin', 'kryon');
      if (!command) command = await exists(local) ? local : 'kryon';
      const profile = configured.get('previewProfile', '');
      const args = ['run'];
      if (profile) args.push('--profile', profile);
      const result = await runCommand(command, args, this.root);
      if (this.disposed) return;
      this.state.output = (result.stdout + result.stderr).trimEnd();
      this.state.status = result.code === 0 ? 'Up to date · reloads on save' :
        `Build or run failed${result.code === null ? '' : ` (exit ${result.code})`}`;
      if (result.code === 0) {
        this.state.cFiles = await generatedFiles(this.root, 'c');
        this.state.irFiles = await generatedFiles(this.root, 'ir');
        if (!this.state.cFiles.includes(this.state.selectedC)) {
          this.state.selectedC = this.state.cFiles.includes('app.c') ? 'app.c' : this.state.cFiles[0] || '';
        }
        if (!this.state.irFiles.includes(this.state.selectedIr)) {
          this.state.selectedIr = this.state.irFiles.includes('app.zir') ? 'app.zir' : this.state.irFiles[0] || '';
        }
        this.state.cSource = this.state.selectedC ? (await fs.readFile(path.join(
          this.root, 'build', 'generated', 'c', this.state.selectedC), 'utf8')) : '';
        if (this.state.selectedIr) await this.loadIr();
      } else {
        Object.assign(this.state, { cFiles: [], irFiles: [], selectedC: '',
          selectedIr: '', cSource: '', irSource: '' });
      }
      this.post();
    } catch (error) {
      this.state.status = 'Preview failed';
      this.state.output = error.message;
      this.post();
    } finally {
      this.running = false;
      if (this.rerun && !this.disposed) { this.rerun = false; this.schedule(); }
    }
  }
}

function activatePreview(context, vscode) {
  const previews = new Map();
  const runButton = vscode.window.createStatusBarItem('kryon.run',
    vscode.StatusBarAlignment.Left, 1000);
  runButton.name = 'Run Kryon';
  runButton.text = '$(play) Run Kryon';
  runButton.tooltip = 'Run and preview this Kryon project beside the editor';
  runButton.command = 'kryon.preview';
  context.subscriptions.push(runButton);

  const updateRunButton = async () => {
    const locations = [];
    if (vscode.window.activeTextEditor?.document.uri.scheme === 'file') {
      locations.push(vscode.window.activeTextEditor.document.uri.fsPath);
    }
    for (const folder of vscode.workspace.workspaceFolders || []) locations.push(folder.uri.fsPath);
    for (const location of locations) {
      if (await projectRoot(location)) { runButton.show(); return; }
    }
    runButton.hide();
  };
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(updateRunButton),
    vscode.workspace.onDidChangeWorkspaceFolders(updateRunButton),
    vscode.languages.registerCodeLensProvider({ language: 'ziran', scheme: 'file' }, {
      async provideCodeLenses(document) {
        if (!(await projectRoot(document.uri.fsPath))) return [];
        return [new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
          title: '▶ Run Kryon Preview', command: 'kryon.preview',
        })];
      },
    }),
  );
  updateRunButton();

  context.subscriptions.push(vscode.commands.registerCommand('kryon.preview', async () => {
    const locations = [];
    if (vscode.window.activeTextEditor?.document.uri.scheme === 'file') {
      locations.push(vscode.window.activeTextEditor.document.uri.fsPath);
    }
    for (const folder of vscode.workspace.workspaceFolders || []) locations.push(folder.uri.fsPath);
    let root = null;
    for (const location of locations) {
      root = await projectRoot(location);
      if (root) break;
    }
    if (!root) {
      vscode.window.showErrorMessage('Open a folder containing kryon.toml to preview a Kryon project.');
      return;
    }
    if (previews.has(root)) { previews.get(root).reveal(); return; }
    const preview = new Preview(root, context, vscode);
    previews.set(root, preview);
    preview.panel.onDidDispose(() => previews.delete(root));
  }));
}

module.exports = { activatePreview, generatedFiles, manifestPath, projectRoot, safeEnvironment };
