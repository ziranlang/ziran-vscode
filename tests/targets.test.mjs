import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { TARGETS, activateTargets, buildArgs, commandStd, targetsHtml, ziranCommand } =
  require('../targets.cjs');

const disposable = { dispose() {} };

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('target preview did not update');
}

test('a single file builds with its own directory as root', () => {
  assert.deepEqual(buildArgs('go', '/notes/hello.zi', '/tmp/out/go', ['/ziran/std']),
    ['build', '--target=go', '--root', '/notes', '--module-path', '/ziran/std',
      '-o', '/tmp/out/go', '/notes/hello.zi']);
  assert.equal(commandStd('/work/ziran/build/bin/ziran'), '/work/ziran/std');
  assert.equal(commandStd('/home/me/.local/bin/ziran'), null);
  assert.deepEqual(TARGETS.map((target) => target.id), ['c', 'cpp', 'go', 'rust', 'plan9-c']);
});

test('target preview webview script is valid', () => {
  const script = targetsHtml('nonce').match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(script));
});

test('a file outside any Kryon project finds the Ziran checkout above it', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ziran-targets-find-'));
  try {
    const command = path.join(directory, 'build', 'bin', 'ziran');
    const file = path.join(directory, 'site', 'examples', 'hello.zi');
    await fs.mkdir(path.dirname(command), { recursive: true });
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(command, '#!/bin/sh\n', { mode: 0o755 });
    await fs.writeFile(file, '');
    const vscode = {
      Uri: { file(fsPath) { return { fsPath }; } },
      workspace: { workspaceFolders: [], getConfiguration() { return { get(_, fallback) { return fallback; } }; } },
    };
    assert.equal(await ziranCommand(file, vscode), command);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('preview builds the chosen targets for one file and rebuilds on save', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ziran-targets-'));
  let closePanel;
  try {
    const file = path.join(directory, 'hello.zi');
    const command = path.join(directory, 'fake-ziran');
    await fs.writeFile(file, 'first\n');
    // Writes one file named after the target, or fails for plan9-c.
    await fs.writeFile(command, `#!/bin/sh
target=
output=
while [ $# -gt 0 ]; do
  case "$1" in
    --target=*) target=\${1#--target=} ;;
    -o) shift; output=$1 ;;
  esac
  source=$1
  shift
done
if [ "$target" = plan9-c ]; then echo "hello.zi:1:1: unsupported" >&2; exit 1; fi
mkdir -p "$output/src"
cp "$source" "$output/hello.$target"
echo runtime > "$output/runtime.h"
mkdir -p "$output/target" && echo skip > "$output/target/ignored"
`, { mode: 0o755 });

    let targetsCommand;
    let onSave;
    let onMessage;
    const updates = [];
    const states = [];
    let enabled = ['c', 'go', 'plan9-c'];
    const panel = {
      webview: {
        postMessage(state) { states.push(structuredClone(state)); },
        onDidReceiveMessage(listener) { onMessage = listener; return disposable; },
      },
      onDidDispose(listener) { closePanel = listener; return disposable; },
      reveal() {},
    };
    const vscode = {
      ViewColumn: { Beside: 2 },
      ConfigurationTarget: { Global: 1, WorkspaceFolder: 3 },
      Uri: { file(fsPath) { return { fsPath }; } },
      commands: { registerCommand(name, listener) {
        assert.equal(name, 'ziran.previewTargets');
        targetsCommand = listener;
        return disposable;
      } },
      window: {
        activeTextEditor: { document: { uri: { fsPath: file } } },
        createWebviewPanel() { return panel; },
      },
      workspace: {
        workspaceFolders: [],
        getWorkspaceFolder() { return undefined; },
        onDidSaveTextDocument(listener) { onSave = listener; return disposable; },
        onDidChangeConfiguration() { return disposable; },
        getConfiguration() { return {
          get(name, fallback) {
            if (name === 'command') return command;
            if (name === 'previewTargets') return enabled;
            return fallback;
          },
          async update(name, value, scope) { updates.push({ name, value, scope }); enabled = value; },
        }; },
      },
    };
    activateTargets({ subscriptions: [] }, vscode);
    await targetsCommand();
    await waitFor(() => states.at(-1)?.status.includes('failed'));
    let state = states.at(-1);
    assert.deepEqual(state.enabled, ['c', 'go', 'plan9-c']);
    assert.deepEqual(state.results.map((result) => [result.id, result.ok]),
      [['c', true], ['go', true], ['plan9-c', false]]);
    assert.equal(state.status, '1 of 3 targets failed');
    assert.deepEqual(state.results[0].files.map((item) => item.name), ['hello.c', 'runtime.h']);
    assert.equal(state.results[0].files[0].text, 'first\n');
    assert.match(state.results[2].message, /unsupported/);

    await onMessage({ type: 'targets', enabled: ['rust', 'c'] });
    assert.deepEqual(updates, [{ name: 'previewTargets', value: ['c', 'rust'], scope: 1 }]);
    await fs.writeFile(file, 'second\n');
    onSave({ uri: { fsPath: file } });
    await waitFor(() => states.at(-1)?.results.map((result) => result.id).join() === 'c,rust' &&
      states.at(-1).status.startsWith('Up to date'));
    state = states.at(-1);
    assert.equal(state.results[0].files[0].text, 'second\n');
  } finally {
    closePanel?.();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
