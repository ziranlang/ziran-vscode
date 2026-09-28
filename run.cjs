const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const { projectRoot, runCommand, safeEnvironment } = require('./preview.cjs');
const { TARGETS, buildTarget, enabledTargets, modulePaths, ziranCommand } =
  require('./targets.cjs');

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

function irArgs(file, paths, output) {
  const args = ['ir', '--root', path.dirname(file)];
  for (const entry of paths) args.push('--module-path', entry);
  args.push('-o', output, file);
  return args;
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

// Highlighting runs inside the webview. It is plain source so the page needs
// no external script, and tests can execute it directly.
const HIGHLIGHT_SOURCE = String.raw`
const KEYWORDS = {
  c: 'auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while bool true false NULL',
  cpp: 'auto break case char const constexpr continue default delete do double else enum explicit extern false float for friend goto if inline int long namespace new noexcept nullptr operator private protected public return short signed sizeof static static_cast struct switch template this true typedef typename union unsigned using virtual void volatile while bool',
  go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil',
  rust: 'as break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while',
  zir: 'module function stmt expr global type define import from',
};
const TYPES = /^(u?int(8|16|32|64)_t|size_t|String|Slice|u8|u16|u32|u64|usize|i8|i16|i32|i64|isize|f32|f64|s8|s16|s32|s64|float32|float64|string|bool|int8|int16|int32|int64|uint8|uint16|uint32|uint64|float|double|byte|rune|str)$/;
function escapeHtml(text) {
  return text.replace(/[&<>]/g, (c) => c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;');
}
function languageOf(name) {
  if (/\.zir$/.test(name)) return 'zir';
  if (/\.(cpp|hpp)$/.test(name)) return 'cpp';
  if (/\.go$/.test(name)) return 'go';
  if (/\.rs$/.test(name)) return 'rust';
  if (/\.(c|h)$/.test(name)) return 'c';
  return '';
}
function highlight(text, language) {
  if (!KEYWORDS[language]) return escapeHtml(text);
  const keywords = new Set(KEYWORDS[language].split(' '));
  const token = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.){1,8}')|(^[ \t]*#[a-z]+)|(%\d+|\b0[xX][0-9a-fA-F]+[uUlL]*\b|\b\d+(?:\.\d+)?(?:[eE][-+]?\d+)?[uUlLf]*\b)|([A-Za-z_][A-Za-z0-9_]*)(\s*\()?/gm;
  let html = '';
  let last = 0;
  for (const match of text.matchAll(token)) {
    html += escapeHtml(text.slice(last, match.index));
    last = match.index + match[0].length;
    let kind = '';
    let word = match[0];
    let rest = '';
    if (match[1]) kind = 'comment';
    else if (match[2]) kind = 'string';
    else if (match[3]) kind = 'directive';
    else if (match[4]) kind = 'number';
    else {
      word = match[5];
      rest = match[6] || '';
      kind = keywords.has(word) ? 'keyword' : TYPES.test(word) ? 'type' :
        rest ? 'function' : /^[A-Z][A-Za-z0-9]*_?[A-Za-z0-9_]*$/.test(word) && /[a-z]/.test(word) ? 'type' : '';
    }
    html += kind ? '<span class="tok-' + kind + '">' + escapeHtml(word) + '</span>' + escapeHtml(rest) :
      escapeHtml(match[0]);
  }
  return html + escapeHtml(text.slice(last));
}
`;

function runHtml(nonce) {
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 12px; }
  header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
  h1 { font-size: 1.1rem; margin: 0; }
  h2 { font-size: 0.95rem; }
  button, select { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; padding: 5px 9px; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  select { max-width: 100%; }
  #status { color: var(--vscode-descriptionForeground); }
  #status.failed { color: var(--vscode-errorForeground); }
  .window { border: 1px solid var(--vscode-panel-border); border-radius: 8px; overflow: hidden; background: var(--vscode-terminal-background, #10141a); }
  .window-bar { display: flex; align-items: center; gap: 6px; padding: 7px 10px; background: var(--vscode-titleBar-activeBackground, #252526); border-bottom: 1px solid var(--vscode-panel-border); }
  .window-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--vscode-descriptionForeground); opacity: .55; }
  #window-title { margin-left: 8px; font-size: .85rem; }
  #time { margin-left: auto; font-size: .8rem; color: var(--vscode-descriptionForeground); }
  #screen { box-sizing: border-box; min-height: 8em; margin: 0; padding: 12px 14px; overflow: auto; white-space: pre-wrap; word-break: break-word; color: var(--vscode-terminal-foreground, #d4d4d4); font-family: var(--vscode-editor-font-family), monospace; font-size: var(--vscode-editor-font-size); line-height: 1.4; border: 0; }
  #screen.empty { color: var(--vscode-descriptionForeground); font-style: italic; }
  .problems:empty { display: none; }
  .problems { margin: 12px 0 0; padding: 10px; border: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground)); white-space: pre-wrap; color: var(--vscode-errorForeground); }
  pre { box-sizing: border-box; overflow: auto; white-space: pre; font-family: var(--vscode-editor-font-family), monospace; font-size: var(--vscode-editor-font-size); line-height: 1.35; border: 1px solid var(--vscode-panel-border); padding: 10px; margin: 0; background: var(--vscode-textCodeBlock-background, transparent); }
  details { margin-top: 16px; }
  summary { cursor: pointer; font-weight: bold; margin-bottom: 8px; }
  .targets { display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 8px; color: var(--vscode-descriptionForeground); }
  .tabs { display: flex; gap: 2px; flex-wrap: wrap; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 8px; }
  .tab { background: transparent; color: var(--vscode-foreground); border-bottom: 2px solid transparent; }
  .tab:hover { background: var(--vscode-toolbar-hoverBackground, transparent); }
  .tab[aria-selected="true"] { border-bottom-color: var(--vscode-focusBorder); font-weight: bold; }
  .tab.failed { color: var(--vscode-errorForeground); }
  .file-row { margin-bottom: 8px; }
  .file-row:empty { display: none; }
  .tok-keyword { color: #569cd6; }
  .tok-type { color: #4ec9b0; }
  .tok-function { color: #dcdcaa; }
  .tok-string { color: #ce9178; }
  .tok-number { color: #b5cea8; }
  .tok-comment { color: #6a9955; font-style: italic; }
  .tok-directive { color: #c586c0; }
  body.vscode-light .tok-keyword { color: #0000ff; }
  body.vscode-light .tok-type { color: #267f99; }
  body.vscode-light .tok-function { color: #795e26; }
  body.vscode-light .tok-string { color: #a31515; }
  body.vscode-light .tok-number { color: #098658; }
  body.vscode-light .tok-comment { color: #008000; }
  body.vscode-light .tok-directive { color: #af00db; }
</style></head><body>
<header><h1>Ziran Run</h1><button id="run">Run again</button><span id="status">Starting…</span></header>
<div class="window"><div class="window-bar"><span class="window-dot"></span><span class="window-dot"></span><span class="window-dot"></span><span id="window-title"></span><span id="time"></span></div><pre id="screen" role="log" aria-live="polite"></pre></div>
<pre class="problems" id="problems"></pre>
<details id="code-section" open><summary>Generated code</summary>
<div class="targets" id="targets"></div>
<div class="tabs" id="tabs" role="tablist"></div>
<div class="file-row" id="file-row"></div>
<pre id="code"></pre></details>
<details id="ir-section"><summary>Checked .zir (inspected)</summary>
<div class="file-row"><select id="ir-files" aria-label="Checked Ziran module"></select></div>
<pre id="ir"></pre></details>
<script nonce="${nonce}">
${HIGHLIGHT_SOURCE}
  const api = acquireVsCodeApi();
  const byId = (id) => document.getElementById(id);
  const saved = api.getState() || {};
  let state = null;
  let selected = saved.selected || '';
  const files = saved.files || {};
  let irFile = saved.irFile || '';
  const remember = () => api.setState({ selected, files, irFile,
    codeOpen: byId('code-section').open, irOpen: byId('ir-section').open });
  if (saved.codeOpen === false) byId('code-section').open = false;
  if (saved.irOpen) byId('ir-section').open = true;
  byId('code-section').addEventListener('toggle', remember);
  byId('ir-section').addEventListener('toggle', remember);
  const renderCode = () => {
    const boxes = byId('targets');
    boxes.replaceChildren();
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
      tab.addEventListener('click', () => { selected = result.id; remember(); renderCode(); });
      tabs.append(tab);
    }
    const result = results.find((item) => item.id === selected);
    const row = byId('file-row');
    row.replaceChildren();
    const code = byId('code');
    if (!result) {
      code.textContent = state.enabled.length ? (state.codeRunning ? 'Generating…' : '') : 'Choose at least one target.';
      return;
    }
    if (result.files.length > 1) {
      const select = document.createElement('select');
      select.setAttribute('aria-label', 'Generated file');
      for (const file of result.files) {
        const option = document.createElement('option');
        option.value = option.textContent = file.name;
        select.append(option);
      }
      select.addEventListener('change', () => { files[result.id] = select.value; remember(); renderCode(); });
      row.append(select);
    }
    const chosen = result.files.find((file) => file.name === files[result.id]) || result.files[0];
    if (row.firstChild && chosen) row.firstChild.value = chosen.name;
    if (!result.ok) { code.className = 'problems'; code.textContent = result.message; return; }
    code.className = '';
    code.innerHTML = chosen ? highlight(chosen.text, languageOf(chosen.name)) : '';
  };
  const renderIr = () => {
    const select = byId('ir-files');
    select.replaceChildren();
    for (const module of state.irModules) {
      const option = document.createElement('option');
      option.value = option.textContent = module.name;
      select.append(option);
    }
    const chosen = state.irModules.find((module) => module.name === irFile) || state.irModules[0];
    select.disabled = state.irModules.length < 2;
    const ir = byId('ir');
    if (state.irError) { ir.className = 'problems'; ir.textContent = state.irError; return; }
    ir.className = '';
    if (chosen) { select.value = chosen.name; ir.innerHTML = highlight(chosen.text, 'zir'); }
    else ir.textContent = state.codeRunning ? 'Checking…' : '';
  };
  byId('ir-files').addEventListener('change', (event) => { irFile = event.target.value; remember(); renderIr(); });
  window.addEventListener('message', ({ data }) => {
    if (data.type !== 'state') return;
    state = data;
    byId('window-title').textContent = state.title;
    byId('status').textContent = state.status;
    byId('status').className = state.failed ? 'failed' : '';
    byId('time').textContent = state.time;
    const screen = byId('screen');
    screen.textContent = state.output || (state.running ? '' : state.hasMain ? 'No output.' : 'No main :: () procedure; nothing to run.');
    screen.className = state.output ? '' : 'empty';
    byId('problems').textContent = state.problems;
    renderCode();
    renderIr();
  });
  byId('run').addEventListener('click', () => api.postMessage({ type: 'run' }));
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
    this.workDirectory = path.join(os.tmpdir(), 'ziran-run-' +
      createHash('sha256').update(file).digest('hex').slice(0, 16));
    this.state = { type: 'state', title: path.basename(file), status: 'Starting…',
      output: '', problems: '', time: '', failed: false, running: true, hasMain: true,
      targets: TARGETS, enabled: enabledTargets(file, vscode), results: [],
      irModules: [], irError: '', codeRunning: true };
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
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration('ziran', vscode.Uri.file(file))) return;
        this.state.enabled = enabledTargets(file, vscode);
        this.schedule();
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

  async runProgram(command, paths) {
    let source = '';
    try { source = await fs.readFile(this.file, 'utf8'); } catch {}
    this.state.hasMain = mainLine(source) >= 0;
    if (!this.state.hasMain) {
      Object.assign(this.state, { output: '', problems: '', time: '', failed: false,
        status: 'Up to date · no main to run' });
      return;
    }
    const bundle = path.join(this.workDirectory, 'program.zib');
    const [bundleStep, runStep] = runSteps(command, this.file, paths, bundle);
    const started = Date.now();
    const built = await execute(bundleStep.command, bundleStep.args, path.dirname(this.file),
      RUN_TIMEOUT_MS);
    if (built.code !== 0) {
      Object.assign(this.state, { output: '', time: '', failed: true,
        problems: (built.stderr || built.stdout).trim() ||
          (built.code === null ? `Could not start ${command}` : `ziran bundle exited with ${built.code}`),
        status: 'Build failed' });
      return;
    }
    const ran = await execute(runStep.command, runStep.args, path.dirname(this.file),
      RUN_TIMEOUT_MS);
    const failed = ran.code !== 0 || ran.timedOut;
    Object.assign(this.state, {
      output: ran.stdout,
      problems: ran.stderr.trim(),
      time: `${((Date.now() - started) / 1000).toFixed(2)}s`,
      failed,
      status: ran.timedOut ? `Stopped after ${RUN_TIMEOUT_MS / 1000}s` :
        failed ? `Exited with ${ran.code}` : 'Up to date · reruns on save',
    });
  }

  async inspectIr(command, paths) {
    const output = path.join(this.workDirectory, 'ir');
    await fs.rm(output, { recursive: true, force: true });
    const saved = await runCommand(command, irArgs(this.file, paths, output), path.dirname(this.file));
    if (saved.code !== 0) {
      this.state.irModules = [];
      this.state.irError = (saved.stderr || saved.stdout).trim() || `ziran ir exited with ${saved.code}`;
      return;
    }
    let names = [];
    try { names = (await fs.readdir(output)).filter((name) => name.endsWith('.zir')).sort(); } catch {}
    const own = `${path.basename(this.file, '.zi')}.zir`;
    names.sort((left, right) => (right === own) - (left === own));
    const modules = [];
    for (const name of names) {
      const inspected = await runCommand(command, ['inspect', path.join(output, name)],
        path.dirname(this.file));
      modules.push({ name, text: inspected.code === 0 ? inspected.stdout : inspected.stderr });
    }
    this.state.irModules = modules;
    this.state.irError = '';
  }

  async run() {
    if (this.disposed) return;
    if (this.running) { this.rerun = true; return; }
    this.running = true;
    Object.assign(this.state, { status: 'Building and running…', running: true,
      failed: false, codeRunning: true });
    this.post();
    try {
      const command = await ziranCommand(this.file, this.vscode);
      const paths = await modulePaths(this.file, command, this.vscode);
      await fs.mkdir(this.workDirectory, { recursive: true });
      const program = this.runProgram(command, paths).then(() => {
        this.state.running = false;
        this.post();
      });
      const [results] = await Promise.all([
        Promise.all(this.state.enabled.map((target) =>
          buildTarget(command, target, this.file, path.join(this.workDirectory, 'targets'), paths))),
        this.inspectIr(command, paths),
        program,
      ]);
      this.state.results = results;
    } catch (error) {
      Object.assign(this.state, { status: 'Run failed', problems: error.message, failed: true });
    } finally {
      this.running = false;
      Object.assign(this.state, { running: false, codeRunning: false });
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

module.exports = { HIGHLIGHT_SOURCE, activateRun, execute, irArgs, mainLine, runHtml, runSteps };
