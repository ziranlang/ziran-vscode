import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { HIGHLIGHT_SOURCE, activateRun, mainLine, runHtml, runSteps } = require('../run.cjs');

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
  let focus;
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
      onDidChangeActiveTextEditor(listener) { focus = listener; return disposable; },
    },
    workspace: {
      workspaceFolders: [],
      getWorkspaceFolder() { return undefined; },
      onDidSaveTextDocument(listener) { onSave = listener; return disposable; },
        onDidChangeConfiguration() { return disposable; },
      getConfiguration() { return { get(name, fallback) {
        return name === 'command' ? command : name === 'previewTargets' ? ['c', 'rust'] : fallback;
      } }; },
    },
  };
  activateRun({ subscriptions: [] }, vscode);
  return { vscode, commands, states, executed,
    save: (fsPath) => onSave({ uri: { fsPath } }),
    send: (message) => onMessage(message),
    focusOn: (fsPath) => focus({ document: { uri: { scheme: 'file', fsPath } } }),
    panel,
    close: () => closePanel?.() };
}

test('run finds the file\'s main procedure', () => {
  assert.equal(mainLine('// hello\nmain :: () {\n}\n'), 1);
  assert.equal(mainLine('Answer :: () -> s32 { return 42 }\n'), -1);
  assert.equal(mainLine('  main :: () {}\n'), -1);
});

test('run bundles the file\'s main and runs it on the portable runtime', () => {
  assert.deepEqual(runSteps('ziran', '/notes/hello.zi', ['/std'], '/tmp/hello.zx'), [
    { command: 'ziran', args: ['bundle', '--root', '/notes', '--module-path', '/std',
      '--entry', 'hello:main', '-o', '/tmp/hello.zx', '/notes/hello.zi'] },
    { command: 'ziran', args: ['run', '/tmp/hello.zx'] },
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
    await waitFor(() => !fake.states.at(-1)?.codeRunning);
    const state = fake.states.at(-1);
    assert.equal(state.output, 'Hello, World!\n');
    assert.equal(state.title, 'hello.zi');
    assert.deepEqual(state.results.map((result) => [result.id, result.ok]), [['c', true], ['rust', true]]);
    assert.match(state.results[0].files[0].text, /Hello, World!/);
    assert.equal(state.irModules[0].name, 'hello.zir');
    assert.match(state.irModules[0].text, /function main\(\) -> void/);
    await fs.writeFile(file, 'main :: () {\n    print("% + % = %\\n", 40, 2, 40 + 2);\n}\n');
    fake.save(file);
    await waitFor(() => fake.states.at(-1)?.output === '40 + 2 = 42\n');
  } finally {
    fake.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('generated code and inspected IR are highlighted', () => {
  const sandbox = {};
  vm.runInNewContext(HIGHLIGHT_SOURCE + '\nthis.highlight = highlight; this.languageOf = languageOf;', sandbox);
  const c = sandbox.highlight('int32_t main(void) { return 42; } // done <x>\n#include "a.h"', 'c');
  assert.match(c, /<span class="tok-type">int32_t<\/span>/);
  assert.match(c, /<span class="tok-function">main<\/span>\(/);
  assert.match(c, /<span class="tok-keyword">return<\/span>/);
  assert.match(c, /<span class="tok-number">42<\/span>/);
  assert.match(c, /<span class="tok-comment">\/\/ done &lt;x&gt;<\/span>/);
  assert.match(c, /<span class="tok-directive">#include<\/span>/);
  const rust = sandbox.highlight('pub fn main() { let s = "x"; }', 'rust');
  assert.match(rust, /<span class="tok-keyword">fn<\/span>/);
  assert.match(rust, /<span class="tok-string">"x"<\/span>/);
  assert.match(sandbox.highlight('%2 call type=void', 'zir'), /<span class="tok-number">%2<\/span>/);
  assert.equal(sandbox.highlight('<b>', ''), '&lt;b&gt;');
  assert.equal(sandbox.languageOf('src/main.rs'), 'rust');
  assert.equal(sandbox.languageOf('out/__init__.py'), 'py');
  const python = sandbox.highlight('def main():  # start\n    return "x"', 'py');
  assert.match(python, /<span class="tok-keyword">def<\/span>/);
  assert.match(python, /<span class="tok-comment"># start<\/span>/);
  assert.match(python, /<span class="tok-string">"x"<\/span>/);
  assert.equal(sandbox.languageOf('hello.hpp'), 'cpp');
});

test('run pane follows the focused .zi file', { skip: !existsSync(compiler) }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ziran-run-focus-'));
  const hello = path.join(directory, 'hello.zi');
  const greet = path.join(directory, 'greet.zi');
  await fs.writeFile(hello, 'main :: () {\n    print("Hello\\n");\n}\n');
  await fs.writeFile(greet, 'main :: () {\n    print("Greet\\n");\n}\n');
  const fake = fakeVscode(hello, compiler, 'main :: () {}\n');
  try {
    await fake.commands['ziran.run']();
    await waitFor(() => fake.states.at(-1)?.output === 'Hello\n');
    fake.focusOn(greet);
    await waitFor(() => fake.states.at(-1)?.output === 'Greet\n');
    assert.equal(fake.states.at(-1).title, 'greet.zi');
    assert.equal(fake.panel.title, 'Run: greet.zi');
  } finally {
    fake.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
