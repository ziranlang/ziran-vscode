const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const { previewLocation, projectRoot, safeEnvironment } = require('./preview.cjs');
const { bundleArgs, importingPrograms, mainLine, modulePaths, noMainMessage, packageRoot,
  ziranCommand, ziranTool } = require('./targets.cjs');
const { sourceStem: moduleName } = require('./module-index.cjs');
const nativeSource = file => /\.(zi|tsx?)$/.test(file);
const { INSPECTOR_MARKUP, INSPECTOR_SCRIPT, INSPECTOR_STYLE, TargetInspector } = require('./inspector.cjs');
const { platformArtifact, runRoute } = require('./platforms.cjs');

const RUN_TIMEOUT_MS = 10000;

// `ziran bundle --root . --entry hello:main -o hello.zx hello.zi`: the
// file's main as ZX, which the selected platform's lowering turns into its
// program, run there.
function bundleStep(command, file, paths, bundle, project = false) {
  return { command, args: bundleArgs(file, paths, bundle, project) };
}

function versionMismatchProblem(message, ziran, zi2zx) {
  if (!/(?:unsupported ZIR version|invalid embedded ZIR)/i.test(message)) return message;
  return `${message}\n\nToolchain paths:\n  ziran: ${ziran}\n  zi2zx: ${zi2zx || 'not found'}`;
}

async function commandPath(command, cwd, environment = process.env) {
  if (path.isAbsolute(command)) return command;
  if (command.includes('/') || command.includes('\\')) return path.resolve(cwd, command);
  for (const directory of (environment.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch {}
  }
  return command;
}

function execute(command, args, cwd, timeout, env = safeEnvironment()) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true });
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
  header button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; padding: 5px 9px; cursor: pointer; }
  header button:hover { background: var(--vscode-button-hoverBackground); }
  #status { color: var(--vscode-descriptionForeground); }
  #status.failed { color: var(--vscode-errorForeground); }
  .window { border: 1px solid var(--vscode-panel-border); border-radius: 8px; overflow: hidden; background: var(--vscode-terminal-background, #10141a); }
  .window-bar { display: flex; align-items: center; gap: 6px; padding: 7px 10px; background: var(--vscode-titleBar-activeBackground, #252526); border-bottom: 1px solid var(--vscode-panel-border); }
  .window-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--vscode-descriptionForeground); opacity: .55; }
  #window-title { margin-left: 8px; font-size: .85rem; }
  #time { margin-left: auto; font-size: .8rem; color: var(--vscode-descriptionForeground); }
  #screen { box-sizing: border-box; min-height: 8em; margin: 0; padding: 12px 14px; overflow: auto; white-space: pre-wrap; word-break: break-word; color: var(--vscode-terminal-foreground, #d4d4d4); font-family: var(--vscode-editor-font-family), monospace; font-size: var(--vscode-editor-font-size); line-height: 1.4; border: 0; }
  #screen.empty { color: var(--vscode-descriptionForeground); font-style: italic; }
  #problems:empty { display: none; }
  #problems { margin: 12px 0 0; padding: 10px; border: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground)); white-space: pre-wrap; color: var(--vscode-errorForeground); font-family: var(--vscode-editor-font-family), monospace; }
${INSPECTOR_STYLE}
</style></head><body>
<header><h1>Ziran Run</h1><button id="run">Run again</button><span id="status">Starting…</span></header>
<div class="window"><div class="window-bar"><span class="window-dot"></span><span class="window-dot"></span><span class="window-dot"></span><span id="window-title"></span><span id="time"></span></div><pre id="screen" role="log" aria-live="polite"></pre></div>
<pre id="problems"></pre>
${INSPECTOR_MARKUP}
<script nonce="${nonce}">
  const api = acquireVsCodeApi();
  const byId = (id) => document.getElementById(id);
${INSPECTOR_SCRIPT}
  window.addEventListener('message', ({ data }) => {
    if (inspector.receive(data) || data.type !== 'state') return;
    byId('window-title').textContent = data.title;
    byId('status').textContent = data.status;
    byId('status').className = data.failed ? 'failed' : '';
    byId('time').textContent = data.time;
    const screen = byId('screen');
    screen.textContent = data.output || (data.running ? '' : data.hasMain ? 'No output.' : data.noMain);
    screen.className = data.output ? '' : 'empty';
    byId('problems').textContent = data.problems;
    inspector.render(data);
  });
  byId('run').addEventListener('click', () => api.postMessage({ type: 'run' }));
  api.postMessage({ type: 'ready' });
</script></body></html>`;
}

function workDirectoryFor(file, buildRoot) {
  return path.join(buildRoot,
    createHash('sha256').update(file).digest('hex').slice(0, 16));
}

class RunPreview {
  constructor(file, context, vscode, onBuild = async () => {}) {
    this.onBuild = onBuild;
    this.file = file;
    this.vscode = vscode;
    this.disposed = false;
    this.running = false;
    this.rerun = false;
    this.storage = context.globalStorageUri.fsPath;
    this.buildRoot = path.join(context.globalStorageUri.fsPath, 'run',
      `${process.pid}-${randomBytes(6).toString('hex')}`);
    this.workDirectory = workDirectoryFor(file, this.buildRoot);
    this.state = { type: 'state', title: path.basename(file), status: 'Starting…',
      output: '', problems: '', time: '', failed: false, running: true, hasMain: true, noMain: '' };
    this.panel = vscode.window.createWebviewPanel('ziranRun',
      `Run: ${path.basename(file)}`, vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true });
    this.inspector = new TargetInspector({ vscode, state: this.state, post: () => this.post(),
      send: (message) => { if (!this.disposed) this.panel.webview.postMessage(message); },
      storage: context.globalStorageUri.fsPath, rerun: () => this.schedule() });
    this.inspector.retarget(file);
    this.panel.webview.html = runHtml(randomBytes(16).toString('hex'));
    this.disposables = [
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((message) => this.message(message)),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration('ziran', vscode.Uri.file(this.file))) return;
        this.inspector.refreshTargets();
        this.schedule();
      }),
    ];
    context.subscriptions.push(this);
    this.run();
  }

  reveal() { this.panel.reveal(this.vscode.ViewColumn.Beside, true); }

  /* The pane follows the focused .zi file: it switches and reruns. */
  retarget(file) {
    if (this.disposed || file === this.file) return;
    fs.rm(this.workDirectory, { recursive: true, force: true }).catch(() => {});
    this.file = file;
    this.workDirectory = workDirectoryFor(file, this.buildRoot);
    this.panel.title = `Run: ${path.basename(file)}`;
    Object.assign(this.state, { title: path.basename(file), status: 'Starting…',
      output: '', problems: '', time: '', failed: false, running: true });
    this.inspector.retarget(file);
    this.post();
    this.schedule();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    for (const disposable of this.disposables) disposable.dispose();
    this.inspector.dispose();
    fs.rm(this.buildRoot, { recursive: true, force: true }).catch(() => {});
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
    // A choice that cannot be saved says why instead of being dropped.
    try { await this.inspector.message(message); }
    catch (error) { Object.assign(this.state, { problems: error.message, failed: true }); this.post(); }
  }

  async runProgram(command, paths, folders) {
    if (!this.state.hasMain) {
      Object.assign(this.state, { output: '', problems: '', time: '', failed: false,
        status: 'No main to run' });
      return;
    }
    const bundle = path.join(this.workDirectory, 'program.zx');
    const project = await packageRoot(this.file);
    const cwd = project || path.dirname(this.file);
    const step = bundleStep(command, this.file, paths, bundle, Boolean(project));
    const started = Date.now();
    const built = await execute(step.command, step.args, cwd, RUN_TIMEOUT_MS);
    const fail = (status, problems) => Object.assign(this.state, { output: '', time: '', failed: true, problems, status });
    if (built.code !== 0) {
      let problem = (built.stderr || built.stdout).trim() ||
        (built.code === null ? `Could not start ${command}` : `ziran bundle exited with ${built.code}`);
      if (/(?:unsupported ZIR version|invalid embedded ZIR)/i.test(problem)) {
        const resolved = await commandPath(command, cwd);
        const zi2zx = await ziranTool(resolved, 'zi2zx', this.file, folders);
        problem = versionMismatchProblem(problem, resolved, zi2zx);
      }
      return fail('Build failed', problem);
    }
    // The program runs on the selected platform, its own way, or not at all.
    const { platform, tools } = await this.inspector.choosePlatform({ command, folders });
    if (!platform) return fail('No platform to run on', 'The toolchain lists no platforms.');
    this.state.title = `${path.basename(this.file)} · ${platform.label}`;
    const artifact = await platformArtifact(platform, bundle, this.workDirectory, moduleName(this.file), tools);
    if (artifact.problem) return fail(`No ${platform.label} build`, artifact.problem);
    this.state.status = `Starting on ${platform.label}…`;
    this.post();
    const adbCommands = this.vscode.workspace.getConfiguration('ziran', this.vscode.Uri.file(this.file))
      .get('adbCommands', ['adb']);
    const route = await runRoute(platform, artifact.file, { storage: this.storage, adbCommands });
    if (route.missing) return fail(`Can't run on ${platform.label}`, route.missing);
    const ran = await execute(route.command, route.args, cwd, RUN_TIMEOUT_MS, route.env);
    const failed = ran.code !== 0 || ran.timedOut;
    Object.assign(this.state, {
      output: ran.stdout,
      problems: ran.stderr.trim(),
      time: `${((Date.now() - started) / 1000).toFixed(2)}s`,
      failed,
      status: ran.timedOut ? `Stopped after ${RUN_TIMEOUT_MS / 1000}s` :
        failed ? `Exited with ${ran.code} on ${platform.label}` : `Up to date · ${platform.label} via ${route.label}`,
    });
  }

  async run() {
    if (this.disposed) return;
    if (this.running) { this.rerun = true; return; }
    this.running = true;
    Object.assign(this.state, { status: 'Building and running…', running: true, failed: false });
    this.post();
    try {
      await this.onBuild(this.file);
      const command = await ziranCommand(this.file, this.vscode);
      const paths = await modulePaths(this.file, command, this.vscode);
      await fs.mkdir(this.workDirectory, { recursive: true });
      let source = '';
      try { source = await fs.readFile(this.file, 'utf8'); } catch {}
      const hasMain = mainLine(source) >= 0;
      const noMain = hasMain ? '' : noMainMessage(this.file, await importingPrograms(this.file));
      Object.assign(this.state, { hasMain, noMain });
      const folders = (this.vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath);
      const program = this.runProgram(command, paths, folders).then(() => {
        this.state.running = false;
        this.post();
      });
      await Promise.all([this.inspector.inspect({ command, paths, hasMain, noMain, folders }), program]);
    } catch (error) {
      Object.assign(this.state, { status: 'Run failed', problems: error.message, failed: true });
    } finally {
      this.running = false;
      Object.assign(this.state, { running: false, codeRunning: false });
      this.post();
      if (this.disposed) await fs.rm(this.buildRoot, { recursive: true, force: true }).catch(() => {});
      if (this.rerun && !this.disposed) { this.rerun = false; this.schedule(); }
    }
  }
}

function activateRun(context, vscode, onBuild = async () => {}) {
  /* One Run pane, showing whichever .zi file has focus. */
  let pane = null;
  const isZiran = (document) => document?.uri.scheme === 'file' &&
    nativeSource(document.uri.fsPath);
  const openPane = (file) => {
    if (pane) {
      pane.retarget(file);
      pane.reveal();
      pane.schedule();
      return;
    }
    pane = new RunPreview(file, context, vscode, onBuild);
    const opened = pane;
    pane.panel.onDidDispose(() => { if (pane === opened) pane = null; });
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('ziran.run', async (uri) => {
      const document = uri ? await vscode.workspace.openTextDocument(uri) :
        vscode.window.activeTextEditor?.document;
      if (!document || !nativeSource(document.uri.fsPath) ||
          (!document.uri.fsPath.endsWith('.zi') && !await packageRoot(document.uri.fsPath))) {
        vscode.window.showErrorMessage('Open a Ziran .zi or native .ts/.tsx file to run it.');
        return;
      }
      if (document.isDirty) await document.save();
      const file = document.uri.fsPath;
      // A Kryon program or project runs live in the Kryon preview.
      if (await previewLocation(file)) {
        await vscode.commands.executeCommand('kryon.preview', document.uri);
        return;
      }
      openPane(file);
    }),
    vscode.languages.registerCodeLensProvider(['ziran', 'typescript', 'typescriptreact'].map(language => ({ language, scheme: 'file' })), {
      async provideCodeLenses(document) {
        if (!document.uri.fsPath.endsWith('.zi') && !await packageRoot(document.uri.fsPath)) return [];
        const line = mainLine(document.getText());
        if (line < 0 || await projectRoot(document.uri.fsPath)) return [];
        return [new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
          title: '▶ Run', command: 'ziran.run', arguments: [document.uri],
        })];
      },
    }),
  );
}

module.exports = { RunPreview, activateRun, bundleStep, commandPath, execute, mainLine,
  runHtml, versionMismatchProblem, workDirectoryFor };
