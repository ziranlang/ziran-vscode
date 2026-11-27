// `Name :: #import "pkg/mod"` with `Name.Decl` uses, through the real
// extension providers and the checkout's ziran: a lone file gets
// `--module-path pkg=DIR` from a discovered checkout; a project resolves the
// package through its lock.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Module, { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const disposable = { dispose() {} };
const compiler = path.resolve('../ziran/build/bin/ziran');
const wrapper = path.join(os.homedir(), '.local/bin/ziran');

const LABEL = '// Labels.\nPadding :: 1\n\n// Label width in cells.\nWidth :: (text: string) -> s64 { return text.count }\n';
const HELLO = 'Label :: #import "widgets/label";\n\nmain :: () {\n    print("%\\n", Label.Width("hi"))\n}\n';

async function writePackage(root) {
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'ziran.toml'),
    '[package]\nname = "widgets"\nmodule_roots = ["src"]\n\n' +
    '[toolchain]\ngit = "https://github.com/ziranlang/ziran.git"\nref = "master"\n\n' +
    '[exports]\nlabel = "src/label.zi"\n');
  await fs.writeFile(path.join(root, 'src', 'label.zi'), LABEL);
}

function activate(command) {
  const providers = {};
  const listeners = {};
  const commands = {};
  const diagnostics = new Map();
  class Position { constructor(line, character) { this.line = line; this.character = character; } }
  class Range { constructor(...args) { this.args = args; } }
  class Location { constructor(uri, position) { this.uri = uri; this.range = position; } }
  class MarkdownString {
    constructor() { this.value = ''; }
    appendCodeblock(code) { this.value += `\n${code}\n`; }
    appendMarkdown(text) { this.value += text; }
  }
  const vscode = {
    ViewColumn: { Beside: 2 },
    StatusBarAlignment: { Left: 1 },
    CodeLens: class {},
    CompletionItem: class { constructor(label, kind) { this.label = label; this.kind = kind; } },
    CompletionItemKind: { Module: 8, Function: 2, Struct: 21, Constant: 20, Variable: 5 },
    CodeActionKind: { QuickFix: 'quickfix' },
    DiagnosticSeverity: { Error: 0, Warning: 1 },
    Diagnostic: class { constructor(range, message) { this.range = range; this.message = message; } },
    DiagnosticRelatedInformation: class {},
    Hover: class { constructor(contents) { this.contents = contents; } },
    MarkdownString, Position, Range, Location,
    Uri: { file(fsPath) { return { fsPath, scheme: 'file' }; } },
    RelativePattern: class {},
    EventEmitter: class { constructor() { this.event = () => disposable; } fire() {} dispose() {} },
    commands: { registerCommand(name, handler) { commands[name] = handler; return disposable; },
      executeCommand(name, ...args) { return commands[name]?.(...args); } },
    languages: {
      createDiagnosticCollection() {
        return { ...disposable, set(uri, list) { diagnostics.set(uri.fsPath, list); },
          delete(uri) { diagnostics.delete(uri.fsPath); } };
      },
      registerCodeLensProvider() { return disposable; },
      registerDocumentSymbolProvider() { return disposable; },
      registerCompletionItemProvider(_, provider) { providers.completion = provider; return disposable; },
      registerDefinitionProvider(_, provider) { providers.definition = provider; return disposable; },
      registerHoverProvider(_, provider) { providers.hover = provider; return disposable; },
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
      getWorkspaceFolder() { return undefined; },
      findFiles: async () => [],
      registerTextDocumentContentProvider() { return disposable; },
      createFileSystemWatcher() {
        return { ...disposable, onDidCreate() { return disposable; },
          onDidDelete() { return disposable; }, onDidChange() { return disposable; } };
      },
      getConfiguration() { return { get(name, fallback) { return name === 'command' ? command : fallback; } }; },
      onDidChangeWorkspaceFolders() { return disposable; },
      onDidChangeConfiguration() { return disposable; },
      onDidOpenTextDocument(listener) { listeners.open = listener; return disposable; },
      onDidSaveTextDocument() { return disposable; },
      onDidCloseTextDocument() { return disposable; },
    },
  };
  const load = Module._load;
  Module._load = function (request, ...rest) {
    return request === 'vscode' ? vscode : load.call(this, request, ...rest);
  };
  try {
    delete require.cache[require.resolve('../extension.cjs')];
    require('../extension.cjs').activate({ subscriptions: [] });
  } finally { Module._load = load; }
  return { vscode, providers, listeners, diagnostics, commands, Position };
}

function documentFor(file, text) {
  const lines = text.split('\n');
  return { uri: { fsPath: file, scheme: 'file' }, version: 1, languageId: 'ziran',
    getText: () => text, lineAt: (line) => ({ text: lines[line] }) };
}

async function checkProviders(extension, file, expectedLabel) {
  const document = documentFor(file, HELLO);
  extension.vscode.workspace.openTextDocument = async () => document;
  assert.equal(extension.listeners.open, undefined, 'opening a file never starts compiler analysis');
  const before = new extension.Position(3, HELLO.split('\n')[3].indexOf('Width') + 2);
  assert.equal(await extension.providers.hover.provideHover(document, before), null);
  assert.equal(await extension.providers.completion.provideCompletionItems(document, before), null);
  await extension.commands['ziran.check'](document.uri);
  assert.deepEqual((extension.diagnostics.get(file) || []).map((item) => item.message), []);
  // Go to Definition on the import string opens the package module.
  const [imported] = await extension.providers.definition.provideDefinition(document,
    new extension.Position(0, 22));
  assert.equal(await fs.realpath(imported.uri.fsPath), await fs.realpath(expectedLabel));
  // Label.Width reaches the declaration through the alias.
  const at = new extension.Position(3, HELLO.split('\n')[3].indexOf('Width') + 2);
  const [declaration] = [await extension.providers.definition.provideDefinition(document, at)];
  assert.equal(await fs.realpath(declaration.uri.fsPath), await fs.realpath(expectedLabel));
  assert.equal(declaration.range.line, 4);
  const hover = await extension.providers.hover.provideHover(document, at);
  assert.match(hover.contents.value, /Width :: \(text: string\) -> s64/);
  assert.match(hover.contents.value, /Label width in cells\./);
  // After `Label.` only the module's declarations complete.
  const line = HELLO.split('\n')[3];
  const items = await extension.providers.completion.provideCompletionItems(document,
    new extension.Position(3, line.indexOf('Label.') + 'Label.'.length));
  assert.deepEqual(items.map((item) => item.label).sort(), ['Padding', 'Width']);
  document.version++;
  assert.equal(await extension.providers.hover.provideHover(document, at), null, 'edits never refresh compiler analysis');
  assert.equal(await extension.providers.completion.provideCompletionItems(document, at), null);
}

test('a lone file finds a package checkout for its qualified imports', { skip: !existsSync(compiler) }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ziran-qualified-'));
  try {
    await writePackage(path.join(directory, 'widgetslab', 'widgets'));
    const file = path.join(directory, 'notes', 'hello.zi');
    await fs.mkdir(path.dirname(file));
    await fs.writeFile(file, HELLO);
    const { modulePaths, buildTarget, importedPackages } = require('../targets.cjs');
    assert.deepEqual([...importedPackages(HELLO)], ['widgets']);
    const extension = activate(compiler);
    const paths = await modulePaths(file, compiler, extension.vscode);
    assert.ok(paths.includes(`widgets=${path.join(directory, 'widgetslab', 'widgets', 'src')}`), paths.join(' '));
    await checkProviders(extension, file, path.join(directory, 'widgetslab', 'widgets', 'src', 'label.zi'));
    // Run pane builds use the same module paths.
    const built = await buildTarget(compiler, 'c', file, path.join(directory, 'generated'), paths);
    assert.equal(built.ok, true, built.message);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('a project resolves qualified imports through its lock', {
  skip: !existsSync(compiler) || !existsSync(wrapper) }, async () => {
  const directory = await fs.mkdtemp(path.join(import.meta.dirname, '.runtime-qualified-'));
  try {
    const widgets = path.join(directory, 'widgets');
    await writePackage(widgets);
    const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
      { cwd: widgets, stdio: 'ignore' });
    git('init', '-q');
    git('add', '-A');
    git('commit', '-qm', 'widgets');
    const app = path.join(directory, 'app');
    await fs.mkdir(path.join(app, 'src'), { recursive: true });
    await fs.writeFile(path.join(app, 'ziran.toml'),
      '[package]\nname = "app"\nentry = "src/hello.zi"\nmodule_roots = ["src"]\n\n' +
      '[toolchain]\ngit = "https://github.com/ziranlang/ziran.git"\nref = "master"\n\n' +
      '[dependencies.widgets]\ngit = "https://github.com/example/widgets.git"\nref = "master"\n');
    await fs.writeFile(path.join(app, 'ziran.local.toml'),
      `[overrides]\nziran = ${JSON.stringify(path.resolve('../ziran'))}\nwidgets = ${JSON.stringify(widgets)}\n`);
    const file = path.join(app, 'src', 'hello.zi');
    await fs.writeFile(file, HELLO);
    execFileSync(wrapper, ['lock'], { cwd: app, stdio: 'ignore' });
    const extension = activate(wrapper);
    const { modulePaths } = require('../targets.cjs');
    assert.deepEqual((await modulePaths(file, wrapper, extension.vscode)).filter((entry) => entry.includes('=')), []);
    await checkProviders(extension, file, path.join(widgets, 'src', 'label.zi'));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
