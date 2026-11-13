import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { HEX_VIEW_SOURCE, HIGHLIGHT_SOURCE, activateRun, binaryContentStart, elfCodeStart,
  mainLine, runHtml, runSteps } = require('../run.cjs');

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
        return name === 'command' ? command : name === 'previewTargets' ? ['c', 'go'] : fallback;
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

function elf64WithText(main = true) {
  const data = Buffer.alloc(0x500);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(data);
  data.writeUInt16LE(2, 16);
  data.writeUInt16LE(0x3e, 18);
  data.writeUInt32LE(1, 20);
  data.writeBigUInt64LE(0x401000n, 24);
  data.writeBigUInt64LE(0n, 32);
  data.writeBigUInt64LE(0x300n, 40);
  data.writeUInt16LE(64, 52);
  data.writeUInt16LE(56, 54);
  data.writeUInt16LE(0, 56);
  data.writeUInt16LE(64, 58);
  data.writeUInt16LE(5, 60);
  data.writeUInt16LE(1, 62);
  Buffer.from('\0.shstrtab\0.strtab\0.symtab\0.text\0').copy(data, 0x200);
  Buffer.from(main ? '\0main\0' : '\0other\0').copy(data, 0x240);
  const strings = 0x300 + 64;
  data.writeUInt32LE(1, strings);
  data.writeUInt32LE(3, strings + 4);
  data.writeBigUInt64LE(0x200n, strings + 24);
  data.writeBigUInt64LE(33n, strings + 32);
  const names = 0x300 + 128;
  data.writeUInt32LE(11, names);
  data.writeUInt32LE(3, names + 4);
  data.writeBigUInt64LE(0x240n, names + 24);
  data.writeBigUInt64LE(BigInt(main ? 6 : 7), names + 32);
  const symbols = 0x300 + 192;
  data.writeUInt32LE(19, symbols);
  data.writeUInt32LE(2, symbols + 4);
  data.writeBigUInt64LE(0x280n, symbols + 24);
  data.writeBigUInt64LE(48n, symbols + 32);
  data.writeUInt32LE(2, symbols + 40);
  data.writeBigUInt64LE(24n, symbols + 56);
  const symbol = 0x280 + 24;
  data.writeUInt32LE(1, symbol);
  data[symbol + 4] = 0x12;
  data.writeUInt16LE(4, symbol + 6);
  data.writeBigUInt64LE(0x401010n, symbol + 8);
  data.writeBigUInt64LE(16n, symbol + 16);
  const text = 0x300 + 256;
  data.writeUInt32LE(27, text);
  data.writeUInt32LE(1, text + 4);
  data.writeBigUInt64LE(6n, text + 8);
  data.writeBigUInt64LE(0x401000n, text + 16);
  data.writeBigUInt64LE(0x180n, text + 24);
  data.writeBigUInt64LE(64n, text + 32);
  return data;
}

function elf64NativeWithoutSections() {
  const data = Buffer.alloc(0x200);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(data);
  data.writeUInt16LE(2, 16);
  data.writeUInt16LE(0x3e, 18);
  data.writeUInt32LE(1, 20);
  data.writeBigUInt64LE(0x401020n, 24);
  data.writeBigUInt64LE(64n, 32);
  data.writeBigUInt64LE(0n, 40);
  data.writeUInt16LE(64, 52);
  data.writeUInt16LE(56, 54);
  data.writeUInt16LE(1, 56);
  data.writeUInt16LE(64, 58);
  data.writeUInt16LE(0, 60);
  data.writeUInt16LE(0, 62);
  data.writeUInt32LE(1, 64);
  data.writeUInt32LE(5, 68);
  data.writeBigUInt64LE(0x100n, 72);
  data.writeBigUInt64LE(0x401000n, 80);
  data.writeBigUInt64LE(0x401000n, 88);
  data.writeBigUInt64LE(0x80n, 96);
  data.writeBigUInt64LE(0x80n, 104);
  data.writeBigUInt64LE(0x1000n, 112);
  return data;
}

function elf32BigEndianWithoutSections() {
  const data = Buffer.alloc(0x100);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 1]).copy(data);
  data.writeUInt16BE(2, 16);
  data.writeUInt16BE(3, 18);
  data.writeUInt32BE(1, 20);
  data.writeUInt32BE(0x1010, 24);
  data.writeUInt32BE(52, 28);
  data.writeUInt32BE(0, 32);
  data.writeUInt16BE(52, 40);
  data.writeUInt16BE(32, 42);
  data.writeUInt16BE(1, 44);
  data.writeUInt16BE(40, 46);
  data.writeUInt16BE(0, 48);
  data.writeUInt16BE(0, 50);
  data.writeUInt32BE(1, 52);
  data.writeUInt32BE(0x80, 56);
  data.writeUInt32BE(0x1000, 60);
  data.writeUInt32BE(0x1000, 64);
  data.writeUInt32BE(0x40, 68);
  data.writeUInt32BE(0x40, 72);
  data.writeUInt32BE(5, 76);
  data.writeUInt32BE(0x10, 80);
  return data;
}

function wasmWithCodeSection() {
  return Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    1, 1, 0x60, 10, 4, 1, 2, 0, 0]);
}

function zxWithInstructionSection() {
  const data = Buffer.alloc(300);
  Buffer.from([0x5a, 0x58, 0, 0]).copy(data);
  data.writeUInt32LE(28, 4);
  data.writeUInt32LE(64, 8);
  data.writeUInt32LE(32, 12);
  data.writeBigUInt64LE(1n, 16);
  data.writeUInt32LE(3, 32);
  data.writeBigUInt64LE(BigInt(data.length), 40);
  data.writeBigUInt64LE(64n, 48);
  data.writeUInt32LE(1, 56);
  for (const [index, kind, offset, length] of [[0, 1, 160, 128], [1, 2, 288, 8], [2, 3, 296, 4]]) {
    const record = 64 + index * 32;
    data.writeUInt32LE(kind, record);
    data.writeUInt32LE(1, record + 4);
    data.writeBigUInt64LE(BigInt(offset), record + 8);
    data.writeBigUInt64LE(BigInt(length), record + 16);
    data.writeUInt32LE(8, record + 24);
  }
  data[288] = 3;
  return data;
}

test('ELF64 little-endian binaries start at a main symbol instead of startup code', () => {
  assert.deepEqual(elfCodeStart(elf64WithText()), {
    offset: 0x190, label: 'main at 0x190 (.text)', toggleLabel: 'Show ELF headers',
  });
});

test('an ELF without a main symbol falls back to its executable .text section', () => {
  assert.deepEqual(elfCodeStart(elf64WithText(false)), {
    offset: 0x180, label: 'code starts at 0x180 (.text)', toggleLabel: 'Show ELF headers',
  });
});

test('a program-header-only native ELF starts at the executable entry segment', () => {
  assert.deepEqual(elfCodeStart(elf64NativeWithoutSections()), {
    offset: 0x100, label: 'code starts at 0x100 (entry segment)',
    toggleLabel: 'Show ELF headers',
  });
});

test('ELF32 big-endian headers use the same entry-segment fallback', () => {
  assert.deepEqual(elfCodeStart(elf32BigEndianWithoutSections()),
    { offset: 0x80, label: 'code starts at 0x80 (entry segment)',
      toggleLabel: 'Show ELF headers' });
});

test('Wasm and executable ZX binaries start at their instruction sections', () => {
  assert.deepEqual(binaryContentStart(wasmWithCodeSection()), {
    offset: 13, label: 'code starts at 0xd (Wasm code section)', toggleLabel: 'Show full file',
  });
  assert.deepEqual(binaryContentStart(zxWithInstructionSection()), {
    offset: 288, label: 'instructions start at 0x120 (ZX program section)',
    toggleLabel: 'Show full file',
  });
});

test('unknown, truncated and malformed binaries show the whole file', () => {
  assert.equal(binaryContentStart(Buffer.from('not a known binary')), null);
  assert.equal(binaryContentStart(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])), null);
  const malformed = elf64WithText();
  malformed.writeBigUInt64LE(0x100000n, 40);
  assert.equal(binaryContentStart(malformed), null);
  assert.equal(binaryContentStart(Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 10, 127])), null);
});

test('going to an offset inside hidden ELF headers reveals the full file', () => {
  const sandbox = {};
  vm.runInNewContext(HEX_VIEW_SOURCE + '\nthis.hexWindow = hexWindow;', sandbox);
  assert.equal(sandbox.hexWindow(0x1040, false).start, 0x1040);
  const revealed = sandbox.hexWindow(0x1040, false, 0x40);
  assert.equal(revealed.showFullFile, true);
  assert.equal(revealed.start, 0);
});

test('run pane webview script is valid', () => {
  const html = runHtml('nonce');
  assert.match(html, /class="window"/);
  assert.match(html, /label: 'ZIR'/);
  assert.doesNotMatch(html, /label: 'ZX'/);
  assert.doesNotMatch(html, /id="ir-section"/);
  assert.match(html, /id="views" role="tablist"/);
  assert.match(html, /id="hex-scroll"/);
  assert.match(html, /Show full file/);
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
    assert.deepEqual(state.results.map((result) => [result.id, result.ok]), [['c', true], ['go', true]]);
    assert.match(state.results[0].views[0].files[0].text, /Hello, World!/);
    // Binaries reach the webview as a key and size; it reads pages by key.
    const binary = state.results[0].views.find((view) => view.id === 'binary').files[0];
    assert.equal(binary.name, 'hello');
    assert.equal(binary.binary.path, undefined);
    assert.ok(binary.binary.size > 1000);
    assert.ok(binary.binary.contentStart > 0);
    assert.match(binary.binary.contentLabel, /^main at 0x[0-9a-f]+ \(\.text\)$/);
    assert.equal(binary.binary.toggleLabel, 'Show ELF headers');
    await fake.send({ type: 'bytes', key: binary.binary.key, offset: 0, length: 4 });
    const page = fake.states.at(-1);
    assert.equal(page.type, 'bytes');
    assert.deepEqual([...Buffer.from(page.data, 'base64')], [0x7f, 0x45, 0x4c, 0x46]);
    await fake.send({ type: 'bytes', key: 'unknown', offset: 0, length: 4 });
    assert.equal(fake.states.at(-1), page);
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

test('a module without main says so and names a program that imports it', { skip: !existsSync(compiler) }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ziran-run-module-'));
  const file = path.join(directory, 'hello.zi');
  await fs.writeFile(file, '#program_export\nFrame :: () -> s32 { return 7 }\n');
  await fs.writeFile(path.join(directory, 'desktop_hello.zi'), '#import "hello"\nmain :: () -> s32 { return Frame() }\n');
  const fake = fakeVscode(file, compiler, '');
  try {
    await fake.commands['ziran.run']();
    await waitFor(() => fake.states.at(-1)?.status === 'No main to run' && !fake.states.at(-1)?.codeRunning);
    const state = fake.states.at(-1);
    assert.equal(state.hasMain, false);
    assert.equal(state.failed, false);
    assert.equal(state.noMain,
      "hello.zi has no main; it's a module. Run a program that imports it, such as desktop_hello.zi.");
    assert.equal(state.results[0].ok, true);
    assert.equal(state.results[0].views.find((view) => view.id === 'binary').message, state.noMain);
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
