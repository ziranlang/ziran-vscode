import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const disposable = { dispose() {} };

test('the extension activates and registers every contributed command', () => {
  const registered = [];
  const vscode = {
    ViewColumn: { Beside: 2 },
    StatusBarAlignment: { Left: 1 },
    CodeLens: class {},
    EventEmitter: class { constructor() { this.event = () => disposable; } fire() {} dispose() {} },
    SymbolKind: { Function: 11, Struct: 22, Variable: 12 },
    CompletionItem: class {},
    CompletionItemKind: { Module: 8 },
    CodeActionKind: { QuickFix: 'quickfix' },
    Range: class {},
    Position: class {},
    Location: class {},
    Uri: { file(fsPath) { return { fsPath }; } },
    commands: {
      registerCommand(name) { registered.push(name); return disposable; },
      executeCommand() {},
    },
    languages: {
      createDiagnosticCollection() { return { ...disposable, set() {}, delete() {} }; },
      registerCodeLensProvider() { return disposable; },
      registerDocumentSymbolProvider() { return disposable; },
      registerCompletionItemProvider() { return disposable; },
      registerDefinitionProvider() { return disposable; },
      registerHoverProvider() { return disposable; },
      registerCodeActionsProvider() { return disposable; },
    },
    window: {
      createStatusBarItem() { return { ...disposable, show() {}, hide() {} }; },
      onDidChangeActiveTextEditor() { return disposable; },
      onDidCloseTerminal() { return disposable; },
      registerCustomEditorProvider() { return disposable; },
    },
    workspace: {
      workspaceFolders: [],
      textDocuments: [],
      registerTextDocumentContentProvider() { return disposable; },
      createFileSystemWatcher() {
        return { ...disposable, onDidCreate() { return disposable; },
          onDidDelete() { return disposable; }, onDidChange() { return disposable; } };
      },
      getConfiguration() { return { get(_, fallback) { return fallback; } }; },
      onDidChangeWorkspaceFolders() { return disposable; },
      onDidChangeConfiguration() { return disposable; },
      onDidOpenTextDocument() { return disposable; },
      onDidSaveTextDocument() { return disposable; },
      onDidCloseTextDocument() { return disposable; },
    },
  };
  const load = Module._load;
  Module._load = function (request, ...rest) {
    return request === 'vscode' ? vscode : load.call(this, request, ...rest);
  };
  try {
    require('../extension.cjs').activate({ subscriptions: [] });
  } finally {
    Module._load = load;
  }
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  for (const { command } of manifest.contributes.commands) {
    assert.ok(registered.includes(command), `${command} is not registered`);
  }
});

test('.zi, .zir, and .zx files and the extension itself have icons', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const exists = (file) => readFileSync(new URL(`../${file}`, import.meta.url)).length > 0;
  assert.ok(exists(manifest.icon));
  for (const extension of ['.zi', '.zir', '.zx']) {
    const language = manifest.contributes.languages.find((entry) => entry.extensions.includes(extension));
    assert.ok(language?.icon, `${extension} has no icon`);
    assert.ok(exists(language.icon.light) && exists(language.icon.dark));
  }
});
