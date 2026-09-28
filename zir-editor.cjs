const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { runCommand } = require('./preview.cjs');
const { ziranCommand } = require('./targets.cjs');

async function inspectZir(file, mode, vscode) {
  const command = await ziranCommand(file, vscode);
  const args = mode === 'hex' ? ['inspect', '--hex', file] : ['inspect', file];
  const result = await runCommand(command, args, path.dirname(file));
  return result.code === 0 ? result.stdout :
    `Could not inspect ${file}\n${result.stderr || result.stdout}`;
}

function outlineEntries(source) {
  const entries = [];
  const lines = source.split(/\r?\n/);
  for (let line = 0; line < lines.length; line++) {
    const match = lines[line].match(/^  (function|type|global|constant)\s+([^\s(:]+)/);
    if (match) entries.push({ kind: match[1], name: match[2], line });
  }
  return entries;
}

function editorHtml(nonce, title) {
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  * { box-sizing: border-box; }
  body { margin: 0; height: 100vh; overflow: hidden; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); display: flex; flex-direction: column; }
  header { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; padding: 9px; border-bottom: 1px solid var(--vscode-panel-border); }
  #title { font-weight: bold; margin-right: auto; }
  button, input { color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); padding: 4px 7px; }
  button { cursor: pointer; }
  button.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  main { display: flex; min-height: 0; flex: 1; }
  nav { width: 220px; min-width: 160px; max-width: 35%; overflow: auto; border-right: 1px solid var(--vscode-panel-border); padding: 8px; }
  nav button { display: block; width: 100%; text-align: left; margin-bottom: 3px; border: 0; background: transparent; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  nav button:hover { background: var(--vscode-list-hoverBackground); }
  pre { flex: 1; min-width: 0; margin: 0; overflow: auto; padding: 12px; white-space: pre; font-family: var(--vscode-editor-font-family), monospace; font-size: var(--vscode-editor-font-size); line-height: 1.4; }
</style></head><body>
<header><span id="title"></span><button id="inspect" class="active">Inspect</button><button id="hex">Hex</button><button id="refresh">Refresh</button><button id="text">Open as Text</button><input id="search" type="search" placeholder="Find in module" aria-label="Find in module"><button id="next">Next</button></header>
<main><nav id="outline" aria-label="Module outline"></nav><pre id="content"></pre></main>
<script nonce="${nonce}">
  const api = acquireVsCodeApi();
  const byId = (id) => document.getElementById(id);
  let mode = 'inspect';
  let content = '';
  let searchAfter = 0;
  byId('title').textContent = ${JSON.stringify(title)};
  const scrollToLine = (line) => {
    const pre = byId('content');
    const lineHeight = parseFloat(getComputedStyle(pre).lineHeight) || 20;
    pre.scrollTop = Math.max(0, line * lineHeight - pre.clientHeight / 4);
  };
  const findNext = () => {
    const query = byId('search').value;
    if (!query) return;
    let at = content.toLowerCase().indexOf(query.toLowerCase(), searchAfter);
    if (at < 0) at = content.toLowerCase().indexOf(query.toLowerCase());
    if (at < 0) return;
    searchAfter = at + query.length;
    const line = content.slice(0, at).split('\\n').length - 1;
    scrollToLine(line);
    const node = byId('content').firstChild;
    if (node) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + query.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
  };
  window.addEventListener('message', ({ data }) => {
    if (data.type !== 'content') return;
    content = data.content;
    mode = data.mode;
    byId('content').textContent = content;
    byId('inspect').classList.toggle('active', mode === 'inspect');
    byId('hex').classList.toggle('active', mode === 'hex');
    const outline = byId('outline');
    outline.replaceChildren();
    for (const entry of data.outline) {
      const button = document.createElement('button');
      button.textContent = entry.name;
      button.title = entry.kind + ' ' + entry.name;
      button.addEventListener('click', () => scrollToLine(entry.line));
      outline.append(button);
    }
    searchAfter = 0;
  });
  for (const value of ['inspect', 'hex']) byId(value).addEventListener('click', () => api.postMessage({ type: 'mode', mode: value }));
  byId('refresh').addEventListener('click', () => api.postMessage({ type: 'refresh' }));
  byId('text').addEventListener('click', () => api.postMessage({ type: 'text', mode }));
  byId('next').addEventListener('click', findNext);
  byId('search').addEventListener('keydown', (event) => { if (event.key === 'Enter') findNext(); });
  api.postMessage({ type: 'ready' });
</script></body></html>`;
}

function activateZirEditor(context, vscode) {
  const changes = new vscode.EventEmitter();
  const virtualDocuments = new Map();
  context.subscriptions.push(changes);
  const refreshVirtualDocuments = (changed) => {
    for (const uri of virtualDocuments.values()) {
      if (uri.path === changed.fsPath) changes.fire(uri);
    }
  };
  const virtualWatcher = vscode.workspace.createFileSystemWatcher('**/*.zir');
  context.subscriptions.push(virtualWatcher,
    virtualWatcher.onDidCreate(refreshVirtualDocuments),
    virtualWatcher.onDidChange(refreshVirtualDocuments),
    virtualWatcher.onDidDelete(refreshVirtualDocuments));
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(
    'ziran-inspect', {
      onDidChange: changes.event,
      provideTextDocumentContent(uri) {
        return inspectZir(uri.path, uri.query === 'hex' ? 'hex' : 'inspect', vscode);
      },
    }));
  context.subscriptions.push(vscode.languages.registerDocumentSymbolProvider(
    { scheme: 'ziran-inspect' }, {
      provideDocumentSymbols(document) {
        return outlineEntries(document.getText()).map((entry) => {
          const range = document.lineAt(entry.line).range;
          const kind = entry.kind === 'function' ? vscode.SymbolKind.Function :
            entry.kind === 'type' ? vscode.SymbolKind.Struct : vscode.SymbolKind.Variable;
          return new vscode.DocumentSymbol(entry.name, entry.kind, kind, range, range);
        });
      },
    }));
  context.subscriptions.push(vscode.window.registerCustomEditorProvider(
    'ziran.zirViewer', {
      openCustomDocument(uri) { return { uri, dispose() {} }; },
      async resolveCustomEditor(document, panel) {
        const file = document.uri.fsPath;
        let mode = 'inspect';
        let disposed = false;
        let revision = 0;
        const render = async () => {
          const current = ++revision;
          const content = await inspectZir(file, mode, vscode);
          if (!disposed && current === revision) panel.webview.postMessage({ type: 'content', mode, content,
            outline: mode === 'inspect' ? outlineEntries(content) : [] });
        };
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(vscode.Uri.file(path.dirname(file)), path.basename(file)));
        const disposables = [watcher, watcher.onDidCreate(render),
          watcher.onDidChange(render),
          watcher.onDidDelete(render),
          panel.webview.onDidReceiveMessage(async (message) => {
            if (message.type === 'mode' && ['inspect', 'hex'].includes(message.mode)) {
              mode = message.mode;
              await render();
            } else if (message.type === 'ready' || message.type === 'refresh') {
              await render();
            } else if (message.type === 'text') {
              const view = message.mode === 'hex' ? 'hex' : 'inspect';
              const uri = vscode.Uri.from({ scheme: 'ziran-inspect', path: file, query: view });
              virtualDocuments.set(uri.toString(), uri);
              const text = await vscode.workspace.openTextDocument(uri);
              await vscode.window.showTextDocument(text, {
                viewColumn: vscode.ViewColumn.Beside, preview: false,
              });
            }
          })];
        panel.onDidDispose(() => {
          disposed = true;
          for (const item of disposables) item.dispose();
        });
        panel.webview.options = { enableScripts: true };
        panel.webview.html = editorHtml(randomBytes(16).toString('hex'), path.basename(file));
      },
    }, { supportsMultipleEditorsPerDocument: true,
      webviewOptions: { enableScripts: true } }));
}

module.exports = { activateZirEditor, editorHtml, inspectZir, outlineEntries };
