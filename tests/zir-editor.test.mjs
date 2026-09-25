import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { activateZirEditor, editorHtml, inspectZir, outlineEntries } =
  require('../zir-editor.cjs');

const disposable = { dispose() {} };

test('checked module view exposes its full inspect and hex output', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zir-editor-'));
  try {
    const root = path.join(directory, 'app');
    const file = path.join(root, 'build', 'generated', 'ir', 'app.zir');
    const command = path.join(directory, 'ziran', 'build', 'bin', 'ziran');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.mkdir(path.dirname(command), { recursive: true });
    await fs.writeFile(path.join(root, 'kryon.toml'), '[profiles.tui]\nbackend = "terminal"\n');
    await fs.writeFile(file, 'binary');
    await fs.writeFile(command, '#!/bin/sh\nif [ "$2" = "--hex" ]; then printf "bytes 00 ff\\n"; else printf "  function Frame()\\n    stmt 0\\n"; fi\n',
      { mode: 0o755 });
    const vscode = {
      Uri: { file(fsPath) { return { fsPath }; } },
      workspace: {
        workspaceFolders: [{ uri: { fsPath: root } }],
        getConfiguration() { return { get(name, fallback) { return fallback; } }; },
      },
    };
    const inspected = await inspectZir(file, 'inspect', vscode);
    assert.equal(inspected, '  function Frame()\n    stmt 0\n');
    assert.deepEqual(outlineEntries(inspected),
      [{ kind: 'function', name: 'Frame', line: 0 }]);
    assert.equal(await inspectZir(file, 'hex', vscode), 'bytes 00 ff\n');

    let provider;
    let receive;
    const messages = [];
    const watcher = {
      ...disposable,
      onDidCreate() { return disposable; },
      onDidChange() { return disposable; },
      onDidDelete() { return disposable; },
    };
    vscode.EventEmitter = class {
      constructor() { this.event = () => disposable; }
      fire() {}
      dispose() {}
    };
    vscode.RelativePattern = class {};
    vscode.workspace.createFileSystemWatcher = () => watcher;
    vscode.workspace.registerTextDocumentContentProvider = () => disposable;
    vscode.languages = { registerDocumentSymbolProvider() { return disposable; } };
    vscode.window = { registerCustomEditorProvider(viewType, value) {
      assert.equal(viewType, 'ziran.zirViewer');
      provider = value;
      return disposable;
    } };
    activateZirEditor({ subscriptions: [] }, vscode);
    const document = provider.openCustomDocument({ fsPath: file });
    const panel = {
      webview: {
        postMessage(message) { messages.push(message); },
        onDidReceiveMessage(callback) { receive = callback; return disposable; },
      },
      onDidDispose() { return disposable; },
    };
    await provider.resolveCustomEditor(document, panel);
    assert.match(panel.webview.html, /Find in module/);
    await receive({ type: 'ready' });
    assert.equal(messages.at(-1).content, inspected);
    await receive({ type: 'mode', mode: 'hex' });
    assert.equal(messages.at(-1).content, 'bytes 00 ff\n');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('checked module webview script is valid', () => {
  const html = editorHtml('nonce', 'app.zir');
  const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(script));
});
