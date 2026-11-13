import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { activatePreview, generatedFiles, manifestPath, previewHtml,
  projectRoot, safeEnvironment, previewBuild } =
  require('../preview.cjs');

const disposable = { dispose() {} };

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 3000; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('preview did not update');
}

test('preview finds the app and its normal generated artifacts', async () => {
  const directory = await fs.mkdtemp(path.join(import.meta.dirname, '.runtime-preview-'));
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
  assert.equal(Object.hasOwn(environment, 'XAUTHORITY'), false);
  assert.equal(Object.hasOwn(environment, 'DBUS_SESSION_BUS_ADDRESS'), false);
  assert.equal(environment.HARMONY_DESKTOP_RECOVERY, '0');
});

test('canvas preview webview script is valid', () => {
  const html = previewHtml('nonce');
  assert.match(html, /<iframe id="app"/);
  const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(script));
});

test('preview runs the normal command and reloads generated views after save', async () => {
  const directory = await fs.mkdtemp(path.join(import.meta.dirname, '.runtime-live-'));
  let closePanel;
  try {
    const root = path.join(directory, 'app');
    const source = path.join(root, 'src', 'app.zi');
    const commandPath = path.join(directory, 'kryon');
    const inspector = path.join(directory, 'ziran', 'build', 'bin', 'ziran');
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.mkdir(path.dirname(inspector), { recursive: true });
    await fs.writeFile(path.join(root, 'kryon.toml'), '[project]\nname = "app"\n[profiles.web]\nbackend = "canvas"\n');
    await fs.writeFile(source, 'first frame\n');
    await fs.writeFile(commandPath, `#!/bin/sh
if test "$(cat src/app.zi)" = "BROKEN"; then echo "invalid source" >&2; exit 1; fi
mkdir -p build/generated/web/c build/generated/web/ir
cp src/app.zi build/generated/web/c/app.c
cp src/app.zi build/app-web.html
printf 'checked' > build/generated/web/ir/app.zir
cat src/app.zi
`, { mode: 0o755 });
    await fs.writeFile(inspector, '#!/bin/sh\nprintf "inspected IR\\n"\n', { mode: 0o755 });

    let previewCommand;
    let onSave;
    let codeLensProvider;
    let runButtonVisible = false;
    const contexts = {};
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
      commands: {
        registerCommand(name, listener) {
          assert.equal(name, 'kryon.preview');
          previewCommand = listener;
          return disposable;
        },
        executeCommand(name, key, value) {
          if (name === 'setContext') contexts[key] = value;
        },
      },
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
    assert.equal(contexts['ziran.kryonProject'], true);
    const lenses = await codeLensProvider.provideCodeLenses({ uri: { fsPath: source } });
    assert.equal(lenses[0].command.command, 'kryon.preview');
    await previewCommand();
    await waitFor(() => states.some((state) => state.status.startsWith('Up to date')));
    let state = states.at(-1);
    assert.equal(state.output, 'first frame');
    assert.equal(state.html, 'first frame\n');
    assert.equal(state.cSource, 'first frame\n');
    assert.equal(state.irSource, 'inspected IR\n');

    await fs.writeFile(source, 'second frame\n');
    onSave({ uri: { scheme: 'file', fsPath: source } });
    await waitFor(() => states.at(-1)?.output === 'second frame');
    state = states.at(-1);
    assert.equal(state.cSource, 'second frame\n');
    assert.equal(state.html, 'second frame\n');
    assert.deepEqual(state.cFiles, ['app.c']);
    assert.deepEqual(state.irFiles, ['app.zir']);
    await fs.writeFile(source, 'BROKEN');
    onSave({ uri: { scheme: 'file', fsPath: source } });
    await waitFor(() => states.at(-1)?.status.startsWith('Build or run failed'));
    assert.equal(states.at(-1).html, '');
    await fs.writeFile(source, 'recovered');
    onSave({ uri: { scheme: 'file', fsPath: source } });
    await waitFor(() => states.at(-1)?.html === 'recovered');
  } finally {
    closePanel?.();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('direct entries select canvas profiles and ignore libraries', async () => {
  const root = await fs.mkdtemp(path.join(import.meta.dirname, '.runtime-discovery-'));
  try {
    const manifest = path.join(root, 'ziran.toml');
    await fs.writeFile(manifest, '[package]\nname = "button"\n');
    assert.equal(await projectRoot(root), null);
    await fs.writeFile(manifest, '[package]\nname = "button"\nentry = "button.zi"\ntool = "kryon"\n[tool.kryon.profiles.desktop]\nbackend = "desktop"\n[tool.kryon.profiles.portable_web]\nbackend = "canvas"\ncodegen = "zx"\n');
    await fs.writeFile(path.join(root, 'button.zi'), '');
    assert.equal(await projectRoot(path.join(root, 'button.zi')), root);
    assert.equal((await previewBuild(root)).profile, 'portable_web');
    await assert.rejects(previewBuild(root, 'desktop'), /canvas profile/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('IR inspection uses the package wrapper when no synthetic entry exists', async () => {
  const directory = await fs.mkdtemp(path.join(import.meta.dirname, '.runtime-inspector-'));
  const targets = require('../targets.cjs');
  const original = targets.ziranCommand;
  try {
    const root = path.join(directory, 'button');
    await fs.mkdir(root);
    const manifest = path.join(root, 'ziran.toml');
    await fs.writeFile(manifest, '[package]\nname="button"\nentry="button.zi"\ntool="kryon"\n');
    await fs.writeFile(path.join(root, 'button.zi'), '');
    const decoy = path.join(directory, 'build/bin/ziran');
    await fs.mkdir(path.dirname(decoy), { recursive: true });
    await fs.writeFile(decoy, '#!/bin/sh\necho DECOY\n', { mode: 0o755 });
    const inspector = path.join(directory, 'inspector');
    await fs.writeFile(inspector, '#!/bin/sh\necho package-inspector\n', { mode: 0o755 });
    const vscode = {
      Uri: { file: fsPath => ({fsPath}) },
      workspace: { workspaceFolders: [], getConfiguration: () => ({get: (_, fallback) => fallback}) },
    };
    assert.equal(await projectRoot(path.join(root, 'entry.zi')), null);
    assert.equal(await original(path.join(root, 'entry.zi'), vscode), decoy);
    let lookup;
    targets.ziranCommand = async (resource, api) => {
      lookup = {resource, command: await original(resource, api)};
      return inspector;
    };
    const preview = {root, vscode, profile:'portable_web', state:{selectedIr:'button.zir'}};
    await require('../preview.cjs').Preview.prototype.loadIr.call(preview);
    assert.equal(lookup.resource, manifest);
    const wrapper = path.join(os.homedir(), '.local/bin/ziran');
    let expected = 'ziran';
    try { await fs.access(wrapper); expected = wrapper; } catch {}
    assert.equal(lookup.command, expected);
    assert.notEqual(lookup.command, decoy);
    assert.equal(preview.state.irSource, 'package-inspector\n');
  } finally {
    targets.ziranCommand = original;
    await fs.rm(directory, {recursive:true, force:true});
  }
});

// Generated entry sources must not turn a save into a build/change/build loop.
test('preview rebuild inputs exclude generated files and unrelated saves', () => {
  const { previewInput } = require('../preview.cjs');
  const root = path.resolve('/workspace');
  for (const file of ['examples/button/button.zi', 'src/ui/button.zi',
    'examples/button/ziran.toml', 'ziran.local.toml', 'ziran.lock']) {
    assert.equal(previewInput(root, path.join(root, file)), true, file);
  }
  for (const file of ['examples/button/build/generated/entry.zi',
    'node_modules/test.zi', '.git/test.zi', '.ziran/test.zi',
    'examples/button/README.md', '../other/source.zi']) {
    assert.equal(previewInput(root, path.join(root, file)), false, file);
  }
});

test('preview restores missing empty Git config values without changing present settings', () => {
  const source = {GIT_CONFIG_COUNT:'3',GIT_CONFIG_KEY_0:'safe.directory',
    GIT_CONFIG_KEY_1:'safe.directory',GIT_CONFIG_VALUE_1:'/workspace',
    GIT_CONFIG_KEY_2:'test.empty',GIT_CONFIG_VALUE_2:'',GIT_CONFIG_KEY_3:'test.outside'};
  const result = safeEnvironment(source);
  assert.equal(result.GIT_CONFIG_VALUE_0,'');
  assert.equal(result.GIT_CONFIG_VALUE_1,'/workspace');
  assert.equal(result.GIT_CONFIG_VALUE_2,'');
  assert.equal(Object.hasOwn(result,'GIT_CONFIG_VALUE_3'),false);
  for (const key of Object.keys(source)) assert.equal(result[key],source[key]);
  assert.equal(Object.hasOwn(source,'GIT_CONFIG_VALUE_0'),false);
  for (const count of ['', 'bad', '-1', '1.5', '1e2', 'Infinity', '9007199254740992']) {
    assert.equal(Object.hasOwn(safeEnvironment({GIT_CONFIG_COUNT:count,GIT_CONFIG_KEY_0:'test.key'}),'GIT_CONFIG_VALUE_0'),false,count);
  }
});

test('unchanged loader HTML embeds changed JavaScript and WebAssembly on save', async () => {
  const {previewAssets} = require('../preview-assets.cjs');
  const root = await fs.mkdtemp(path.join(import.meta.dirname,'.runtime-assets-'));
  try {
    const artifact=path.join(root,'app.html');
    const loader='<html><head></head><body><script async src=app.js></script></body></html>';
    await fs.writeFile(artifact,loader);
    await fs.writeFile(path.join(root,'app.js'),'globalThis.version=1;');
    await fs.writeFile(path.join(root,'app.wasm'),new Uint8Array([0,97,115,109]));
    const first=await previewAssets(artifact);
    assert.equal(first.includes('src=app.js'),false);
    assert.equal(first.includes('data:application/wasm;base64,'),true);
    await fs.writeFile(path.join(root,'app.js'),'globalThis.version=2;');
    const second=await previewAssets(artifact);
    assert.notEqual(second,first);
    await fs.writeFile(path.join(root,'app.wasm'),new Uint8Array([0,97,115,109,1]));
    assert.notEqual(await previewAssets(artifact),second);
    const third=await previewAssets(artifact);
    await fs.writeFile(path.join(root,'app.data'),new Uint8Array([42]));
    const fourth=await previewAssets(artifact);
    assert.notEqual(fourth,third);
    assert.equal(fourth.includes('data:application/octet-stream;base64,'),true);
    await fs.writeFile(path.join(root,'app.data'),new Uint8Array([43]));
    assert.notEqual(await previewAssets(artifact),fourth);
    assert.equal(await fs.readFile(artifact,'utf8'),loader);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test('preview refuses runtime scripts outside its build directory', async () => {
  const {previewAssets} = require('../preview-assets.cjs');
  const root=await fs.mkdtemp(path.join(import.meta.dirname,'.runtime-assets-'));
  try {
    const artifact=path.join(root,'app.html');
    for (const source of ['../secret.js','https://example.com/script.js','/absolute.js']) {
      await fs.writeFile(artifact,`<script src=${source}></script>`);
      await assert.rejects(previewAssets(artifact),/inside the build directory/);
    }
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});
