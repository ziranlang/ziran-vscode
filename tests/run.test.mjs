import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { activateRun, mainLine, runHtml, runSteps } = require('../run.cjs');

const disposable = { dispose() {} };
const compiler = path.resolve('../ziran/build/bin/ziran');

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('run pane did not update');
}

function fakeVscode(file, command, source) {
  const states = [];
  const executed = [];
  let onSave;
  let onMessage;
  let closePanel;
  const panel = {
    webview: {
      postMessage(state) { states.push(structuredClone(state)); },
      onDidReceiveMessage(listener) { onMessage = listener; return disposable; },
    },
    onDidDispose(listener) { closePanel = listener; return disposable; },
    reveal() {},
  };
  const commands = {};
  const vscode = {
    ViewColumn: { Beside: 2 },
    CodeLens: class {},
    Range: class {},
    Uri: { file(fsPath) { return { fsPath }; } },
    commands: {
      registerCommand(name, listener) { commands[name] = listener; return disposable; },
      executeCommand(...args) { executed.push(args); },
    },
    languages: { registerCodeLensProvider() { return disposable; } },
    window: {
      activeTextEditor: { document: { uri: { fsPath: file }, isDirty: false,
        getText: () => source, save: async () => true } },
      createWebviewPanel() { return panel; },
      showErrorMessage(message) { executed.push(['error', message]); },
    },
    workspace: {
      workspaceFolders: [],
      getWorkspaceFolder() { return undefined; },
      onDidSaveTextDocument(listener) { onSave = listener; return disposable; },
      getConfiguration() { return { get(name, fallback) {
        return name === 'command' ? command : fallback;
      } }; },
    },
  };
  activateRun({ subscriptions: [] }, vscode);
  return { vscode, commands, states, executed,
    save: (fsPath) => onSave({ uri: { fsPath } }),
    send: (message) => onMessage(message),
    close: () => closePanel?.() };
}

test('run finds the file\'s main procedure', () => {
  assert.equal(mainLine('// hello\nmain :: () {\n}\n'), 1);
  assert.equal(mainLine('Answer :: () -> s32 { return 42 }\n'), -1);
  assert.equal(mainLine('  main :: () {}\n'), -1);
});

test('run bundles the file\'s main and runs it on the portable runtime', () => {
  assert.deepEqual(runSteps('ziran', '/notes/hello.zi', ['/std'], '/tmp/hello.zib'), [
    { command: 'ziran', args: ['bundle', '--root', '/notes', '--module-path', '/std',
      '--entry', 'hello:main', '-o', '/tmp/hello.zib', '/notes/hello.zi'] },
    { command: 'ziran', args: ['run', '/tmp/hello.zib'] },
  ]);
});

test('run pane webview script is valid', () => {
  const html = runHtml('nonce');
  assert.match(html, /class="window"/);
  const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(script));
});

test('run pane shows a build failure instead of output', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ziran-run-fail-'));
  const file = path.join(directory, 'hello.zi');
  const command = path.join(directory, 'fake-ziran');
  await fs.writeFile(file, 'main :: () {}\n');
  await fs.writeFile(command, '#!/bin/sh\necho "hello.zi:1:1: broken" >&2\nexit 1\n', { mode: 0o755 });
  const fake = fakeVscode(file, command, 'main :: () {}\n');
  try {
    await fake.commands['ziran.run']();
    await waitFor(() => fake.states.at(-1)?.status === 'Build failed');
    const state = fake.states.at(-1);
    assert.equal(state.failed, true);
    assert.equal(state.output, '');
    assert.match(state.problems, /broken/);
    fake.send({ type: 'code' });
    assert.deepEqual(fake.executed.at(-1), ['ziran.previewTargets', { fsPath: file }]);
  } finally {
    fake.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('run pane shows hello world output and reruns on save', { skip: !existsSync(compiler) }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ziran-run-'));
  const file = path.join(directory, 'hello.zi');
  await fs.writeFile(file, 'main :: () {\n    print("Hello, World!\\n");\n}\n');
  const fake = fakeVscode(file, compiler, 'main :: () {}\n');
  try {
    await fake.commands['ziran.run']();
    await waitFor(() => fake.states.at(-1)?.status.startsWith('Up to date'));
    assert.equal(fake.states.at(-1).output, 'Hello, World!\n');
    assert.equal(fake.states.at(-1).title, 'hello.zi');
    await fs.writeFile(file, 'main :: () {\n    print("% + % = %\\n", 40, 2, 40 + 2);\n}\n');
    fake.save(file);
    await waitFor(() => fake.states.at(-1)?.output === '40 + 2 = 42\n');
  } finally {
    fake.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
