const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const { projectRoot, safeEnvironment } = require('./preview.cjs');
const { modulePaths, ziranCommand } = require('./targets.cjs');

const RUN_TIMEOUT_MS = 10000;

// The line of the file's `main :: (` declaration, or -1.
function mainLine(source) {
  const lines = source.split(/\r?\n/);
  return lines.findIndex((line) => /^main\s*::\s*\(/.test(line));
}

// `ziran bundle --root . --entry hello:main -o hello.zib hello.zi`, then
// `ziran run hello.zib`: the file's main on the portable runtime.
function runSteps(command, file, paths, bundle) {
  const args = ['bundle', '--root', path.dirname(file)];
  for (const entry of paths) args.push('--module-path', entry);
  args.push('--entry', `${path.basename(file, '.zi')}:main`, '-o', bundle, file);
  return [{ command, args }, { command, args: ['run', bundle] }];
}

function execute(command, args, cwd, timeout) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: safeEnvironment(), windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: error.message, timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
}

function runHtml(nonce) {
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 12px; }
  header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
  h1 { font-size: 1.1rem; margin: 0; }
  button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; padding: 5px 9px; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  #status { color: var(--vscode-descriptionForeground); }
  #status.failed { color: var(--vscode-errorForeground); }
  .window { border: 1px solid var(--vscode-panel-border); border-radius: 8px; overflow: hidden; background: var(--vscode-terminal-background, #10141a); }
  .window-bar { display: flex; align-items: center; gap: 6px; padding: 7px 10px; background: var(--vscode-titleBar-activeBackground, #252526); border-bottom: 1px solid var(--vscode-panel-border); }
  .window-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--vscode-descriptionForeground); opacity: .55; }
  #window-title { margin-left: 8px; font-size: .85rem; }
  #time { margin-left: auto; font-size: .8rem; color: var(--vscode-descriptionForeground); }
  #screen { box-sizing: border-box; min-height: 12em; margin: 0; padding: 12px 14px; overflow: auto; white-space: pre-wrap; word-break: break-word; color: var(--vscode-terminal-foreground, #d4d4d4); font-family: var(--vscode-editor-font-family), monospace; font-size: var(--vscode-editor-font-size); line-height: 1.4; }
  #screen.empty { color: var(--vscode-descriptionForeground); font-style: italic; }
  #problems:empty { display: none; }
  #problems { margin: 12px 0 0; padding: 10px; border: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground)); white-space: pre-wrap; color: var(--vscode-errorForeground); font-family: var(--vscode-editor-font-family), monospace; font-size: var(--vscode-editor-font-size); }
</style></head><body>
<header><h1>Ziran Run</h1><button id="run">Run again</button><button id="code">Generated code</button><span id="status">Starting…</span></header>
<div class="window"><div class="window-bar"><span class="window-dot"></span><span class="window-dot"></span><span class="window-dot"></span><span id="window-title"></span><span id="time"></span></div><pre id="screen" role="log" aria-live="polite"></pre></div>
<pre id="problems"></pre>
<script nonce="${nonce}">
  const api = acquireVsCodeApi();
  const byId = (id) => document.getElementById(id);
  window.addEventListener('message', ({ data }) => {
    if (data.type !== 'state') return;
    byId('window-title').textContent = data.title;
    byId('status').textContent = data.status;
    byId('status').className = data.failed ? 'failed' : '';
    byId('time').textContent = data.time;
    const screen = byId('screen');
    screen.textContent = data.output || (data.running ? '' : 'No output.');
    screen.className = data.output ? '' : 'empty';
    byId('problems').textContent = data.problems;
  });
  byId('run').addEventListener('click', () => api.postMessage({ type: 'run' }));
  byId('code').addEventListener('click', () => api.postMessage({ type: 'code' }));
  api.postMessage({ type: 'ready' });
</script></body></html>`;
}

class RunPreview {
  constructor(file, context, vscode) {
    this.file = file;
    this.vscode = vscode;
    this.disposed = false;
    this.running = false;
    this.rerun = false;
    this.bundle = path.join(os.tmpdir(), 'ziran-run-' +
      createHash('sha256').update(file).digest('hex').slice(0, 16) + '.zib');
    this.state = { type: 'state', title: path.basename(file), status: 'Starting…',
      output: '', problems: '', time: '', failed: false, running: true };
    this.panel = vscode.window.createWebviewPanel('ziranRun',
      `Run: ${path.basename(file)}`, vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true });
    this.panel.webview.html = runHtml(randomBytes(16).toString('hex'));
    this.disposables = [
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((message) => this.message(message)),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document.uri.fsPath.endsWith('.zi') &&
            path.dirname(document.uri.fsPath) === path.dirname(file)) this.schedule();
      }),
    ];
    context.subscriptions.push(this);
    this.run();
  }

  reveal() { this.panel.reveal(this.vscode.ViewColumn.Beside, true); }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    for (const disposable of this.disposables) disposable.dispose();
    fs.rm(this.bundle, { force: true }).catch(() => {});
  }

  post() { if (!this.disposed) this.panel.webview.postMessage(this.state); }

  schedule() {
    if (this.disposed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(), 250);
  }

  message(message) {
    if (message.type === 'ready') this.post();
    if (message.type === 'run') this.schedule();
    if (message.type === 'code') {
      this.vscode.commands.executeCommand('ziran.previewTargets', this.vscode.Uri.file(this.file));
    }
  }

  async run() {
    if (this.disposed) return;
    if (this.running) { this.rerun = true; return; }
    this.running = true;
    Object.assign(this.state, { status: 'Building and running…', running: true, failed: false });
    this.post();
    try {
      const command = await ziranCommand(this.file, this.vscode);
      const paths = await modulePaths(this.file, command, this.vscode);
      const [bundleStep, runStep] = runSteps(command, this.file, paths, this.bundle);
      const started = Date.now();
      const built = await execute(bundleStep.command, bundleStep.args, path.dirname(this.file),
        RUN_TIMEOUT_MS);
      if (this.disposed) return;
      if (built.code !== 0) {
        Object.assign(this.state, { output: '', time: '', failed: true,
          problems: (built.stderr || built.stdout).trim() ||
            (built.code === null ? `Could not start ${command}` : `ziran bundle exited with ${built.code}`),
          status: 'Build failed' });
        return;
      }
      const ran = await execute(runStep.command, runStep.args, path.dirname(this.file),
        RUN_TIMEOUT_MS);
      if (this.disposed) return;
      const seconds = ((Date.now() - started) / 1000).toFixed(2);
      const failed = ran.code !== 0 || ran.timedOut;
      Object.assign(this.state, {
        output: ran.stdout,
        problems: ran.stderr.trim(),
        time: `${seconds}s`,
        failed,
        status: ran.timedOut ? `Stopped after ${RUN_TIMEOUT_MS / 1000}s` :
          failed ? `Exited with ${ran.code}` : 'Up to date · reruns on save',
      });
    } catch (error) {
      Object.assign(this.state, { status: 'Run failed', problems: error.message, failed: true });
    } finally {
      this.running = false;
      this.state.running = false;
      this.post();
      if (this.rerun && !this.disposed) { this.rerun = false; this.schedule(); }
    }
  }
}

function activateRun(context, vscode) {
  const previews = new Map();
  context.subscriptions.push(
    vscode.commands.registerCommand('ziran.run', async (uri) => {
      const document = uri ? await vscode.workspace.openTextDocument(uri) :
        vscode.window.activeTextEditor?.document;
      if (!document || !document.uri.fsPath.endsWith('.zi')) {
        vscode.window.showErrorMessage('Open a .zi file to run it.');
        return;
      }
      if (mainLine(document.getText()) < 0) {
        vscode.window.showErrorMessage(`${path.basename(document.uri.fsPath)} has no main :: () procedure to run.`);
        return;
      }
      if (document.isDirty) await document.save();
      const file = document.uri.fsPath;
      if (previews.has(file)) {
        const preview = previews.get(file);
        preview.reveal();
        preview.schedule();
        return;
      }
      const preview = new RunPreview(file, context, vscode);
      previews.set(file, preview);
      preview.panel.onDidDispose(() => previews.delete(file));
    }),
    vscode.languages.registerCodeLensProvider({ language: 'ziran', scheme: 'file' }, {
      async provideCodeLenses(document) {
        const line = mainLine(document.getText());
        if (line < 0 || await projectRoot(document.uri.fsPath)) return [];
        return [new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
          title: '▶ Run', command: 'ziran.run', arguments: [document.uri],
        })];
      },
    }),
  );
}

module.exports = { activateRun, execute, mainLine, runHtml, runSteps };
