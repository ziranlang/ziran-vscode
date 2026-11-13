const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const { projectRoot, runCommand, safeEnvironment } = require('./preview.cjs');
const { TARGETS, buildTarget, bundleArgs, enabledTargets, importingPrograms, irArgs, mainLine,
  modulePaths, noMainMessage, packageRoot, ziranCommand } = require('./targets.cjs');

const RUN_TIMEOUT_MS = 10000;
// The most one hex view request reads from a binary.
const HEX_REQUEST_LIMIT = 1024 * 1024;

// `ziran bundle --root . --entry hello:main -o hello.zx hello.zi`, then
// `ziran run hello.zx`: the file's main on the portable runtime.
function runSteps(command, file, paths, bundle, project = false) {
  return [{ command, args: bundleArgs(file, paths, bundle, project) },
    { command, args: ['run', bundle] }];
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
  py: 'and as assert break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield None True False',
  wat: 'module type func param result local global memory table export import data elem call return block loop if else end br br_if unreachable drop select',
  zir: 'module function stmt expr global type define import from',
};
const TYPES = /^(u?int(8|16|32|64)_t|size_t|String|Slice|u8|u16|u32|u64|usize|i8|i16|i32|i64|isize|f32|f64|s8|s16|s32|s64|float32|float64|string|bool|int8|int16|int32|int64|uint8|uint16|uint32|uint64|float|double|byte|rune|str)$/;
function escapeHtml(text) {
  return text.replace(/[&<>]/g, (c) => c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;');
}
function languageOf(name) {
  if (/\.(zir|zx)(\.txt)?$|\.lir$/.test(name)) return 'zir';
  if (/\.(cpp|hpp)$/.test(name)) return 'cpp';
  if (/\.wat$/.test(name)) return 'wat';
  if (/\.go$/.test(name)) return 'go';
  if (/\.rs$/.test(name)) return 'rust';
  if (/\.py$/.test(name)) return 'py';
  if (/\.(c|h)$/.test(name)) return 'c';
  return '';
}
function highlight(text, language) {
  if (!KEYWORDS[language]) return escapeHtml(text);
  const keywords = new Set(KEYWORDS[language].split(' '));
  // Python comments start with #, and its strings can be triple-quoted.
  const python = language === 'py';
  const token = python ?
    /(#[^\n]*)|("""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|(a^)|(\b0[xX][0-9a-fA-F]+\b|\b\d+(?:\.\d+)?(?:[eE][-+]?\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)(\s*\()?/gm :
    /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.){1,8}')|(^[ \t]*#[a-z]+)|(%\d+|\b0[xX][0-9a-fA-F]+[uUlL]*\b|\b\d+(?:\.\d+)?(?:[eE][-+]?\d+)?[uUlLf]*\b)|([A-Za-z_][A-Za-z0-9_]*)(\s*\()?/gm;
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
  .views:empty { display: none; }
  .views .tab { font-size: .9em; }
  .caption { color: var(--vscode-descriptionForeground); font-size: .85em; margin-bottom: 6px; }
  .caption:empty { display: none; }
  [hidden] { display: none !important; }
  .hex-bar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 6px; color: var(--vscode-descriptionForeground); }
  .hex-bar input { color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); padding: 3px 6px; width: 14em; }
  .hex-scroll { position: relative; height: 60vh; overflow: auto; border: 1px solid var(--vscode-panel-border); background: var(--vscode-textCodeBlock-background, transparent); }
  #hex-spacer { width: 1px; }
  #hex-rows { position: absolute; left: 0; top: 0; margin: 0; border: 0; padding: 0 10px; line-height: 18px; overflow: visible; background: transparent; }
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
<div class="tabs" id="tabs" role="tablist" aria-label="Target"></div>
<div class="tabs views" id="views" role="tablist" aria-label="View"></div>
<div class="file-row" id="file-row"></div>
<div class="caption" id="caption"></div>
<pre id="code"></pre>
<div id="hex" hidden><div class="hex-bar"><span id="hex-title"></span><input id="hex-goto" placeholder="Go to offset (hex)" aria-label="Go to offset"></div>
<div class="hex-scroll" id="hex-scroll" tabindex="0" role="region" aria-label="Hex view"><div id="hex-spacer"></div><pre id="hex-rows"></pre></div></div></details>
<script nonce="${nonce}">
${HIGHLIGHT_SOURCE}
  const api = acquireVsCodeApi();
  const byId = (id) => document.getElementById(id);
  const saved = api.getState() || {};
  let state = null;
  let selected = saved.selected || '';
  const files = saved.files || {};
  const views = saved.views || {};
  const remember = () => api.setState({ selected, files, views, codeOpen: byId('code-section').open });
  if (saved.codeOpen === false) byId('code-section').open = false;
  byId('code-section').addEventListener('toggle', () => { remember(); renderHex(); });

  // Hex view: rows are drawn only for the visible window, and the bytes come
  // from the extension in pages as they scroll into view.
  const HEX_ROW = 18;
  const HEX_PAGE = 65536;
  const HEX_MAX_HEIGHT = 8000000;
  const hexPages = new Map();
  let hex = null;
  const hexRows = () => Math.max(1, Math.ceil(hex.size / 16));
  const hexScaled = () => hexRows() * HEX_ROW > HEX_MAX_HEIGHT;
  const hexVisible = () => Math.max(1, Math.ceil(byId('hex-scroll').clientHeight / HEX_ROW));
  const hexFirst = () => {
    const box = byId('hex-scroll');
    if (!hexScaled()) return Math.floor(box.scrollTop / HEX_ROW);
    const last = Math.max(0, hexRows() - hexVisible());
    const range = Math.max(1, HEX_MAX_HEIGHT - box.clientHeight);
    return Math.min(last, Math.round(box.scrollTop / range * last));
  };
  const hexByte = (offset) => {
    const page = Math.floor(offset / HEX_PAGE);
    const id = hex.key + ':' + page;
    if (!hexPages.has(id)) {
      hexPages.set(id, null);
      api.postMessage({ type: 'bytes', key: hex.key, offset: page * HEX_PAGE, length: HEX_PAGE });
    }
    const data = hexPages.get(id);
    const at = offset - page * HEX_PAGE;
    return data && at < data.length ? data[at] : -1;
  };
  const hexLine = (offset, digits) => {
    let bytes = '';
    let text = '';
    for (let index = 0; index < 16; index++) {
      if (index === 8) bytes += ' ';
      if (offset + index >= hex.size) { bytes += '   '; continue; }
      const value = hexByte(offset + index);
      bytes += (value < 0 ? '··' : value.toString(16).padStart(2, '0')) + ' ';
      text += value < 0 ? ' ' : value >= 32 && value < 127 ? String.fromCharCode(value) : '.';
    }
    return offset.toString(16).padStart(digits, '0') + '  ' + bytes + ' |' + text + '|';
  };
  function renderHex() {
    if (!hex || byId('hex').hidden) return;
    const box = byId('hex-scroll');
    const first = hexFirst();
    const digits = Math.max(8, Math.max(0, hex.size - 1).toString(16).length);
    const lines = [];
    for (let row = first; row < first + hexVisible() + 2 && row * 16 < hex.size; row++) {
      lines.push(hexLine(row * 16, digits));
    }
    const rows = byId('hex-rows');
    rows.textContent = lines.join('\\n');
    rows.style.top = (hexScaled() ? box.scrollTop : first * HEX_ROW) + 'px';
  }
  const showHex = (file) => {
    byId('code').hidden = true;
    byId('hex').hidden = false;
    if (!hex || hex.key !== file.binary.key) {
      hex = { key: file.binary.key, size: file.binary.size };
      byId('hex-title').textContent = file.name + ' · ' + file.binary.size.toLocaleString() + ' bytes';
      byId('hex-spacer').style.height = Math.min(hexRows() * HEX_ROW, HEX_MAX_HEIGHT) + 'px';
      byId('hex-scroll').scrollTop = 0;
    }
    renderHex();
  };
  const hideHex = () => { byId('hex').hidden = true; byId('code').hidden = false; };
  let hexFrame = 0;
  const scheduleHex = () => {
    if (hexFrame) return;
    hexFrame = requestAnimationFrame(() => { hexFrame = 0; renderHex(); });
  };
  byId('hex-scroll').addEventListener('scroll', scheduleHex);
  window.addEventListener('resize', scheduleHex);
  byId('hex-goto').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !hex) return;
    const offset = parseInt(event.target.value.trim().replace(/^0x/i, ''), 16);
    if (!Number.isFinite(offset) || offset < 0) return;
    const row = Math.min(hexRows() - 1, Math.floor(offset / 16));
    const box = byId('hex-scroll');
    const last = Math.max(1, hexRows() - hexVisible());
    box.scrollTop = hexScaled() ? row / last * (HEX_MAX_HEIGHT - box.clientHeight) : row * HEX_ROW;
    renderHex();
  });
  const decode = (text) => {
    const raw = atob(text || '');
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
    return bytes;
  };

  const tab = (label, chosen, failed, select) => {
    const button = document.createElement('button');
    button.className = 'tab' + (failed ? ' failed' : '');
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(chosen));
    button.textContent = label + (failed ? ' ✕' : '');
    button.addEventListener('click', select);
    return button;
  };
  const showProblem = (message) => {
    hideHex();
    const code = byId('code');
    code.className = 'problems';
    code.textContent = message;
  };
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
    const zir = { id: 'zir', label: 'ZIR', ok: !state.irError, message: state.irError,
      views: [{ id: 'checked', label: 'Checked', ok: true, caption: '',
        files: state.irModules.map((module) => ({ name: module.name, text: module.text })) }] };
    const native = (result) => result.id === 'c' || result.id === 'go';
    const results = [...state.results.filter(native), zir,
      ...state.results.filter((result) => !native(result))];
    if (!results.some((result) => result.id === selected)) selected = results[0] ? results[0].id : '';
    const tabs = byId('tabs');
    tabs.replaceChildren();
    for (const result of results) {
      const target = state.targets.find((item) => item.id === result.id);
      tabs.append(tab(result.label || (target ? target.label : result.id), result.id === selected, !result.ok,
        () => { selected = result.id; remember(); renderCode(); }));
    }
    const result = results.find((item) => item.id === selected);
    const viewTabs = byId('views');
    viewTabs.replaceChildren();
    const row = byId('file-row');
    row.replaceChildren();
    byId('caption').textContent = '';
    const code = byId('code');
    code.className = '';
    if (!result) {
      hideHex();
      code.textContent = state.enabled.length ? (state.codeRunning ? 'Generating…' : '') : 'Choose at least one target.';
      return;
    }
    if (!result.ok) { showProblem(result.message); return; }
    const available = result.views || [];
    if (!available.some((item) => item.id === views[result.id])) {
      views[result.id] = available[0] ? available[0].id : '';
    }
    if (available.length > 1) {
      for (const item of available) {
        viewTabs.append(tab(item.label, item.id === views[result.id], !item.ok,
          () => { views[result.id] = item.id; remember(); renderCode(); }));
      }
    }
    const current = available.find((item) => item.id === views[result.id]);
    if (!current) { hideHex(); code.textContent = ''; return; }
    if (!current.ok) { showProblem(current.message); return; }
    byId('caption').textContent = current.caption || '';
    const fileKey = result.id + '/' + current.id;
    if (current.files.length > 1) {
      const select = document.createElement('select');
      select.setAttribute('aria-label', 'Generated file');
      for (const file of current.files) {
        const option = document.createElement('option');
        option.value = option.textContent = file.name;
        select.append(option);
      }
      select.addEventListener('change', () => { files[fileKey] = select.value; remember(); renderCode(); });
      row.append(select);
    }
    const chosen = current.files.find((file) => file.name === files[fileKey]) || current.files[0];
    if (row.firstChild && chosen) row.firstChild.value = chosen.name;
    if (!chosen) { hideHex(); code.textContent = 'No files.'; return; }
    if (chosen.binary) { showHex(chosen); return; }
    hideHex();
    code.innerHTML = chosen.text.length > 400000 ? escapeHtml(chosen.text) :
      highlight(chosen.text, languageOf(chosen.name));
  };
  window.addEventListener('message', ({ data }) => {
    if (data.type === 'bytes') {
      hexPages.set(data.key + ':' + Math.floor(data.offset / HEX_PAGE), decode(data.data));
      if (hex && hex.key === data.key) renderHex();
      return;
    }
    if (data.type !== 'state') return;
    state = data;
    byId('window-title').textContent = state.title;
    byId('status').textContent = state.status;
    byId('status').className = state.failed ? 'failed' : '';
    byId('time').textContent = state.time;
    const screen = byId('screen');
    screen.textContent = state.output || (state.running ? '' : state.hasMain ? 'No output.' : state.noMain);
    screen.className = state.output ? '' : 'empty';
    byId('problems').textContent = state.problems;
    renderCode();
  });
  byId('run').addEventListener('click', () => api.postMessage({ type: 'run' }));
  api.postMessage({ type: 'ready' });
</script></body></html>`;
}

function workDirectoryFor(file) {
  return path.join(os.tmpdir(), 'ziran-run-' +
    createHash('sha256').update(file).digest('hex').slice(0, 16));
}

class RunPreview {
  constructor(file, context, vscode) {
    this.file = file;
    this.vscode = vscode;
    this.disposed = false;
    this.running = false;
    this.rerun = false;
    this.workDirectory = workDirectoryFor(file);
    this.state = { type: 'state', title: path.basename(file), status: 'Starting…',
      output: '', problems: '', time: '', failed: false, running: true, hasMain: true,
      noMain: '', targets: TARGETS, enabled: enabledTargets(file, vscode), results: [],
      irModules: [], irError: '', codeRunning: true };
    this.generation = 0;
    this.binaries = new Map();
    this.panel = vscode.window.createWebviewPanel('ziranRun',
      `Run: ${path.basename(file)}`, vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true });
    this.panel.webview.html = runHtml(randomBytes(16).toString('hex'));
    this.disposables = [
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((message) => this.message(message)),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document.uri.fsPath.endsWith('.zi') &&
            path.dirname(document.uri.fsPath) === path.dirname(this.file)) this.schedule();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration('ziran', vscode.Uri.file(this.file))) return;
        this.state.enabled = enabledTargets(this.file, vscode);
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
    this.workDirectory = workDirectoryFor(file);
    this.panel.title = `Run: ${path.basename(file)}`;
    Object.assign(this.state, { title: path.basename(file), status: 'Starting…',
      output: '', problems: '', time: '', failed: false, running: true,
      enabled: enabledTargets(file, this.vscode), results: [], irModules: [],
      irError: '', codeRunning: true });
    this.post();
    this.schedule();
  }

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
    if (message.type === 'bytes') await this.sendBytes(message);
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

  // One page of a binary the hex view shows, read only from files this
  // run's results listed.
  async sendBytes(message) {
    const file = this.binaries.get(message.key);
    const offset = Number(message.offset);
    if (!file || !Number.isSafeInteger(offset) || offset < 0) return;
    const length = Math.min(Math.max(0, Number(message.length) || 0), HEX_REQUEST_LIMIT);
    let data = '';
    try {
      const handle = await fs.open(file, 'r');
      try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        data = buffer.subarray(0, bytesRead).toString('base64');
      } finally { await handle.close(); }
    } catch {}
    if (!this.disposed) this.panel.webview.postMessage({ type: 'bytes', key: message.key, offset, data });
  }

  // Binaries stay on disk; the webview receives a key and size and asks for
  // pages of bytes by key.
  register(results) {
    this.generation++;
    this.binaries = new Map();
    for (const result of results) {
      for (const item of result.views || []) {
        for (const file of item.files || []) {
          if (!file.binary?.path) continue;
          const key = `${this.generation}:${result.id}:${item.id}:${file.name}`;
          this.binaries.set(key, file.binary.path);
          file.binary = { key, size: file.binary.size };
        }
      }
    }
    return results;
  }

  async runProgram(command, paths) {
    if (!this.state.hasMain) {
      Object.assign(this.state, { output: '', problems: '', time: '', failed: false,
        status: 'No main to run' });
      return;
    }
    const bundle = path.join(this.workDirectory, 'program.zx');
    const project = await packageRoot(this.file);
    const cwd = project || path.dirname(this.file);
    const [bundleStep, runStep] = runSteps(command, this.file, paths, bundle, Boolean(project));
    const started = Date.now();
    const built = await execute(bundleStep.command, bundleStep.args, cwd,
      RUN_TIMEOUT_MS);
    if (built.code !== 0) {
      Object.assign(this.state, { output: '', time: '', failed: true,
        problems: (built.stderr || built.stdout).trim() ||
          (built.code === null ? `Could not start ${command}` : `ziran bundle exited with ${built.code}`),
        status: 'Build failed' });
      return;
    }
    const ran = await execute(runStep.command, runStep.args, cwd,
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
    const project = await packageRoot(this.file);
    const saved = await runCommand(command, irArgs(this.file, paths, output, Boolean(project)),
      project || path.dirname(this.file));
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
      let source = '';
      try { source = await fs.readFile(this.file, 'utf8'); } catch {}
      const hasMain = mainLine(source) >= 0;
      const noMain = hasMain ? '' : noMainMessage(this.file, await importingPrograms(this.file));
      Object.assign(this.state, { hasMain, noMain });
      const folders = (this.vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath);
      const program = this.runProgram(command, paths).then(() => {
        this.state.running = false;
        this.post();
      });
      const [results] = await Promise.all([
        Promise.all(this.state.enabled.map((target) =>
          buildTarget(command, target, this.file, path.join(this.workDirectory, 'targets'), paths,
            { hasMain, noMain, folders }))),
        this.inspectIr(command, paths),
        program,
      ]);
      this.state.results = this.register(results);
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
  /* One Run pane, showing whichever .zi file has focus. */
  let pane = null;
  const isZiran = (document) => document?.uri.scheme === 'file' &&
    document.uri.fsPath.endsWith('.zi');
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
      if (pane) {
        pane.retarget(file);
        pane.reveal();
        pane.schedule();
        return;
      }
      pane = new RunPreview(file, context, vscode);
      const opened = pane;
      pane.panel.onDidDispose(() => { if (pane === opened) pane = null; });
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (pane && isZiran(editor?.document)) pane.retarget(editor.document.uri.fsPath);
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
