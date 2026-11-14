import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { generatedFiles, isKryonProgram, manifestPath, previewBuild, previewHtml, previewLocation,
  projectRoot, safeEnvironment } = require('../preview.cjs');
test('preview discovers projects, artifacts, profiles and package inspectors', async () => {
  const directory = await fs.mkdtemp(path.join(import.meta.dirname, '.runtime-preview-'));
  const targets = require('../targets.cjs');
  const original = targets.ziranCommand;
  try {
    const app = path.join(directory, 'app');
    await fs.mkdir(path.join(app, 'src'), { recursive: true });
    for (const kind of ['c', 'ir']) await fs.mkdir(path.join(app, 'build/generated', kind), { recursive: true });
    await fs.writeFile(path.join(app, 'kryon.toml'), '[paths]\nziran="../compiler"\n[profiles.tui]\nbackend="terminal"\n');
    await fs.writeFile(path.join(app, 'src/app.zi'), '');
    for (const file of ['c/app.c', 'c/app.h', 'ir/app.zir']) await fs.writeFile(path.join(app, 'build/generated', file), '');
    assert.equal(await projectRoot(path.join(app, 'src/app.zi')), app);
    assert.equal(await manifestPath(app, 'ziran', '../ziran'), path.join(directory, 'compiler'));
    assert.deepEqual(await generatedFiles(app, 'c'), ['app.c']);
    assert.deepEqual(await generatedFiles(app, 'ir'), ['app.zir']);
    const pkg = path.join(directory, 'button'); await fs.mkdir(pkg);
    const manifest = path.join(pkg, 'ziran.toml');
    await fs.writeFile(manifest, '[package]\nname="button"\n');
    assert.equal(await projectRoot(pkg), null);
    await fs.writeFile(manifest, '[package]\nname="button"\nentry="button.zi"\ntool="kryon"\n' +
      '[tool.kryon.profiles.desktop]\nbackend="desktop"\n' +
      '[tool.kryon.profiles.portable_web]\nbackend="canvas"\ncodegen="zx"\n');
    await fs.writeFile(path.join(pkg, 'button.zi'), '');
    assert.equal(await projectRoot(path.join(pkg, 'button.zi')), pkg);
    assert.equal((await previewBuild(pkg)).profile, 'portable_web');
    await assert.rejects(previewBuild(pkg, 'desktop'), /canvas profile/);
    const provider = path.join(directory, 'kryon');
    await fs.mkdir(path.join(provider, 'examples'), { recursive: true });
    await fs.writeFile(path.join(provider, 'ziran.toml'),
      '[package]\nname="kryon"\n[tool]\nproject="build/bin/kryon"\n');
    const standalone = path.join(provider, 'examples/window.zi');
    await fs.writeFile(standalone,
      'App :: #import "kryon/app";\nmain :: () -> s32 { return App.Run(App.Window.{}) }\n');
    assert.equal(await projectRoot(standalone), null);
    assert.equal(await isKryonProgram(standalone), true);
    assert.deepEqual(await previewLocation(standalone),
      { key: standalone, root: null, source: standalone, standalone: true });
    const decoy = path.join(directory, 'build/bin/ziran');
    await fs.mkdir(path.dirname(decoy), { recursive: true });
    await fs.writeFile(decoy, '#!/bin/sh\necho DECOY\n', { mode: 0o755 });
    const inspector = path.join(directory, 'inspector');
    await fs.writeFile(inspector, '#!/bin/sh\necho package-inspector\n', { mode: 0o755 });
    const vscode = { Uri: { file: fsPath => ({ fsPath }) }, workspace: {
      workspaceFolders: [], getConfiguration: () => ({ get: (_, fallback) => fallback }) } };
    assert.equal(await original(path.join(pkg, 'entry.zi'), vscode), decoy);
    let lookup;
    targets.ziranCommand = async (resource, api) => {
      lookup = { resource, command: await original(resource, api) }; return inspector;
    };
    const preview = { root: pkg, vscode, profile: 'portable_web', state: { selectedIr: 'button.zir' } };
    await require('../preview.cjs').Preview.prototype.loadIr.call(preview);
    assert.equal(lookup.resource, manifest);
    assert.notEqual(lookup.command, decoy);
    assert.equal(preview.state.irSource, 'package-inspector\n');
  } finally {
    targets.ziranCommand = original;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
test('preview keeps child environments, webviews and rebuild inputs safe', () => {
  const environment = safeEnvironment({ DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', XAUTHORITY: 'secret',
    DBUS_SESSION_BUS_ADDRESS: 'bus', GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'safe.directory',
    GIT_CONFIG_KEY_1: 'safe.directory', GIT_CONFIG_VALUE_1: '/workspace',
    GIT_CONFIG_KEY_2: 'test.empty', GIT_CONFIG_VALUE_2: '' });
  for (const key of ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS'])
    assert.equal(Object.hasOwn(environment, key), false);
  assert.equal(environment.HARMONY_DESKTOP_RECOVERY, '0');
  assert.equal(environment.GIT_CONFIG_VALUE_0, '');
  assert.equal(environment.GIT_CONFIG_VALUE_1, '/workspace');
  for (const count of ['', 'bad', '-1', '1.5', '1e2', 'Infinity', '9007199254740992'])
    assert.equal(Object.hasOwn(safeEnvironment({ GIT_CONFIG_COUNT: count, GIT_CONFIG_KEY_0: 'x' }), 'GIT_CONFIG_VALUE_0'), false);
  const { previewInput } = require('../preview.cjs');
  const root = path.resolve('/workspace');
  for (const file of ['examples/button/button.zi', 'src/ui/button.zi', 'examples/button/ziran.toml', 'ziran.local.toml', 'ziran.lock'])
    assert.equal(previewInput(root, path.join(root, file)), true, file);
  for (const file of ['examples/button/build/generated/entry.zi', 'node_modules/test.zi', '.git/test.zi',
    '.ziran/test.zi', 'examples/button/README.md', '../other/source.zi'])
    assert.equal(previewInput(root, path.join(root, file)), false, file);
  const html = previewHtml('nonce');
  assert.match(html, /<iframe id="app"/);
  assert.match(html, />Open in New Window<.*id="window-status"/s);
  assert.match(html, /id="inspect">Inspect Targets</);
  assert.match(html, /id="window-stdout".*id="window-stderr".*id="window-exit"/s);
  assert.doesNotThrow(() => new vm.Script(html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1]));
});
test('preview assets refresh embedded files and reject paths outside the build', async () => {
  const { previewAssets } = require('../preview-assets.cjs');
  const root = await fs.mkdtemp(path.join(import.meta.dirname, '.runtime-assets-'));
  const artifact = path.join(root, 'app.html');
  try {
    const loader = '<script async src=app.js></script>';
    await fs.writeFile(artifact, loader);
    await fs.writeFile(path.join(root, 'app.js'), 'globalThis.version=1;');
    await fs.writeFile(path.join(root, 'app.wasm'), Buffer.from([0, 97, 115, 109]));
    const first = await previewAssets(artifact);
    assert.doesNotMatch(first, /src=app.js/);
    assert.match(first, /data:application\/wasm;base64,/);
    await fs.writeFile(path.join(root, 'app.js'), 'globalThis.version=2;');
    const second = await previewAssets(artifact); assert.notEqual(second, first);
    await fs.writeFile(path.join(root, 'app.wasm'), Buffer.from([0, 97, 115, 109, 1]));
    const third = await previewAssets(artifact); assert.notEqual(third, second);
    await fs.writeFile(path.join(root, 'app.data'), Buffer.from([42]));
    const fourth = await previewAssets(artifact); assert.notEqual(fourth, third);
    assert.match(fourth, /data:application\/octet-stream;base64,/);
    await fs.writeFile(path.join(root, 'app.data'), Buffer.from([43]));
    assert.notEqual(await previewAssets(artifact), fourth);
    assert.equal(await fs.readFile(artifact, 'utf8'), loader);
    for (const source of ['../secret.js', 'https://example.com/script.js', '/absolute.js']) {
      await fs.writeFile(artifact, `<script src=${source}></script>`);
      await assert.rejects(previewAssets(artifact), /inside the build directory/);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
