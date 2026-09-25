import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { activatePreview, generatedFiles, manifestPath, previewHtml,
  projectRoot, safeEnvironment } =
  require('../preview.cjs');

const disposable = { dispose() {} };

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('preview did not update');
}

test('preview finds the app and its normal generated artifacts', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kryon-preview-'));
  try {
    const root = path.join(directory, 'app');
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.mkdir(path.join(root, 'build', 'generated', 'c'), { recursive: true });
    await fs.mkdir(path.join(root, 'build', 'generated', 'ir'), { recursive: true });
    await fs.writeFile(path.join(root, 'kryon.toml'),
      '[paths]\nziran = "../compiler"\n[profiles.tui]\nbackend = "terminal"\n');
    await fs.writeFile(path.join(root, 'src', 'app.zi'), '');
    await fs.writeFile(path.join(root, 'build', 'generated', 'c', 'app.c'), '');
    await fs.writeFile(path.join(root, 'build', 'generated', 'c', 'app.h'), '');
    await fs.writeFile(path.join(root, 'build', 'generated', 'ir', 'app.zir'), '');
    assert.equal(await projectRoot(path.join(root, 'src', 'app.zi')), root);
    assert.equal(await manifestPath(root, 'ziran', '../ziran'),
      path.join(directory, 'compiler'));
    assert.deepEqual(await generatedFiles(root, 'c'), ['app.c']);
    assert.deepEqual(await generatedFiles(root, 'ir'), ['app.zir']);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('preview child processes cannot inherit the desktop display', () => {
  const environment = safeEnvironment();
  assert.equal(Object.hasOwn(environment, 'DISPLAY'), false);
  assert.equal(Object.hasOwn(environment, 'WAYLAND_DISPLAY'), false);
});

test('canvas preview webview script is valid', () => {
  const html = previewHtml('nonce');
  assert.match(html, /<canvas id="screen"/);
  const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(script));
});

test('preview runs the normal command and reloads generated views after save', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kryon-preview-live-'));
  let closePanel;
  try {
    const root = path.join(directory, 'app');
    const source = path.join(root, 'src', 'app.zi');
    const commandPath = path.join(directory, 'kryon');
    const inspector = path.join(directory, 'ziran', 'build', 'bin', 'ziran');
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.mkdir(path.dirname(inspector), { recursive: true });
    await fs.writeFile(path.join(root, 'kryon.toml'), '[profiles.tui]\nbackend = "terminal"\n');
    await fs.writeFile(source, 'first frame\n');
    await fs.writeFile(commandPath, `#!/bin/sh
mkdir -p build/generated/c build/generated/ir
cp src/app.zi build/generated/c/app.c
printf 'checked' > build/generated/ir/app.zir
cat src/app.zi
`, { mode: 0o755 });
    await fs.writeFile(inspector, '#!/bin/sh\nprintf "inspected IR\\n"\n', { mode: 0o755 });

    let previewCommand;
    let onSave;
    let codeLensProvider;
    let runButtonVisible = false;
    const states = [];
    const panel = {
      webview: {
        postMessage(state) { states.push(structuredClone(state)); },
        onDidReceiveMessage() { return disposable; },
      },
      onDidDispose(listener) { closePanel = listener; return disposable; },
      reveal() {},
    };
    const watcher = {
      ...disposable,
      onDidChange() { return disposable; },
      onDidCreate() { return disposable; },
      onDidDelete() { return disposable; },
    };
    const vscode = {
      ViewColumn: { Beside: 2 },
      StatusBarAlignment: { Left: 1 },
      CodeLens: class { constructor(range, command) { this.range = range; this.command = command; } },
      Range: class {},
      Uri: { file(fsPath) { return { fsPath }; } },
      RelativePattern: class {},
      languages: { registerCodeLensProvider(selector, provider) {
        assert.deepEqual(selector, { language: 'ziran', scheme: 'file' });
        codeLensProvider = provider;
        return disposable;
      } },
      commands: { registerCommand(name, listener) {
        assert.equal(name, 'kryon.preview');
        previewCommand = listener;
        return disposable;
      } },
      window: {
        activeTextEditor: { document: { uri: { scheme: 'file', fsPath: source } } },
        createWebviewPanel() { return panel; },
        createStatusBarItem() { return {
          ...disposable,
          show() { runButtonVisible = true; },
          hide() { runButtonVisible = false; },
        }; },
        onDidChangeActiveTextEditor() { return disposable; },
      },
      workspace: {
        workspaceFolders: [{ uri: { fsPath: root } }],
        createFileSystemWatcher() { return watcher; },
        onDidChangeWorkspaceFolders() { return disposable; },
        onDidSaveTextDocument(listener) { onSave = listener; return disposable; },
        getConfiguration() { return { get(name, fallback) {
          return name === 'kryonCommand' ? commandPath : fallback;
        } }; },
      },
    };
    activatePreview({ subscriptions: [] }, vscode);
    await waitFor(() => runButtonVisible);
    const lenses = await codeLensProvider.provideCodeLenses({ uri: { fsPath: source } });
    assert.equal(lenses[0].command.command, 'kryon.preview');
    await previewCommand();
    await waitFor(() => states.some((state) => state.status.startsWith('Up to date')));
    let state = states.at(-1);
    assert.equal(state.output, 'first frame');
    assert.equal(state.frame, 'first frame\n');
    assert.equal(state.cSource, 'first frame\n');
    assert.equal(state.irSource, 'inspected IR\n');

    await fs.writeFile(source, 'second frame\n');
    onSave({ uri: { fsPath: source } });
    await waitFor(() => states.at(-1)?.output === 'second frame');
    state = states.at(-1);
    assert.equal(state.cSource, 'second frame\n');
    assert.equal(state.frame, 'second frame\n');
    assert.deepEqual(state.cFiles, ['app.c']);
    assert.deepEqual(state.irFiles, ['app.zir']);
  } finally {
    closePanel?.();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
