import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { isKryonProgram, manifestPath, previewBuild, previewHtml, previewLocation,
  projectRoot, safeEnvironment } = require('../preview.cjs');
test('preview discovers projects, artifacts, profiles and package inspectors', async () => {
  const directory = await fs.mkdtemp(path.join(import.meta.dirname, '.runtime-preview-'));
  const targets = require('../targets.cjs');
  const original = targets.ziranCommand;
  try {
    const app = path.join(directory, 'app');
    await fs.mkdir(path.join(app, 'src'), { recursive: true });
    await fs.writeFile(path.join(app, 'kryon.toml'), '[paths]\nziran="../compiler"\n[profiles.tui]\nbackend="terminal"\n');
    await fs.writeFile(path.join(app, 'src/app.zi'), '');
    assert.equal(await projectRoot(path.join(app, 'src/app.zi')), app);
    assert.equal(await manifestPath(app, 'ziran', '../ziran'), path.join(directory, 'compiler'));
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
    const vscode = { Uri: { file: fsPath => ({ fsPath }) }, workspace: {
      workspaceFolders: [], getConfiguration: () => ({ get: (_, fallback) => fallback }) } };
    assert.equal(await original(path.join(pkg, 'entry.zi'), vscode), decoy);
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
  assert.match(html, /<button id="open-window" hidden>Open in window<\/button>/);
  // The target views sit right under the live window; there is no Inspect
  // Targets button and no raw Kryon-profile C or ZIR dump.
  assert.ok(html.indexOf('id="code-section"') > html.indexOf('<iframe id="app"'));
  for (const part of [/id="tabs" role="tablist"/, /id="views" role="tablist"/, /id="hex-scroll"/, /inspector\.render\(data\)/])
    assert.match(html, part);
  for (const removed of [/Inspect Targets|id="inspect"|'inspect'/, /Open in New Window|window-stdout/,
    /Generated C|c-files|c-source/, /ZIR \(inspected\)|ir-files|ir-source/, /caption/])
    assert.doesNotMatch(html, removed);
  assert.doesNotThrow(() => new vm.Script(html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1]));
});
const linux = { id: 'x86_64-linux', label: 'Linux x86-64', arch: 'x86_64', os: 'linux', format: 'elf', emit: 'elf', gap: '' };
const onLinux = (zx2native) => ({ dispose() {}, message: async () => false,
  choosePlatform: async () => ({ platform: linux, tools: { zx2native } }) });
test('Open in window on Linux x86-64 runs the executable its Binary tab shows as one owned process', async () => {
  const { Preview, projectEntry } = require('../preview.cjs');
  const directory = await fs.mkdtemp(path.join(import.meta.dirname, '.runtime-window-'));
  const preview = Object.create(Preview.prototype);
  try {
    const source = path.join(directory, 'window.zi');
    await fs.writeFile(source, 'App :: #import "kryon/app";\nmain :: () -> s32 { return App.Run(App.Window.{}) }\n');
    const started = path.join(directory, 'started');
    const lowered = path.join(directory, 'lowered');
    // A fake compiler writes the bundle; a fake zx2native records how it was
    // asked to lower it and writes an executable that records each start,
    // then waits like a window. Nothing builds C.
    const command = path.join(directory, 'fake-ziran');
    await fs.writeFile(command, `#!/bin/sh
[ "$1" = bundle ] || exit 3
while [ $# -gt 0 ]; do case "$1" in -o) shift; output=$1;; esac; shift; done
echo zx > "$output"
`, { mode: 0o755 });
    const zx2native = path.join(directory, 'zx2native');
    await fs.writeFile(zx2native, `#!/bin/sh
echo "$*" >> ${lowered}
while [ $# -gt 0 ]; do case "$1" in -o) shift; output=$1;; esac; shift; done
printf '#!/bin/sh\\necho "$$ $0" >> ${started}\\nexec sleep 60\\n' > "$output"
`, { mode: 0o755 });
    const vscode = { Uri: { file: fsPath => ({ fsPath }) }, workspace: { workspaceFolders: [],
      getConfiguration: () => ({ get: (key, fallback) => key === 'command' ? command : fallback }) } };
    const posted = [];
    Object.assign(preview, { disposed: false, source, storage: path.join(directory, 'storage'), vscode,
      windowChild: null, windowQueue: Promise.resolve(), inspector: onLinux(zx2native),
      disposables: [], watchers: [], state: { program: true, windowStatus: '', windowOutput: '', windowBuilding: false },
      post() { posted.push({ ...this.state }); } });
    const pids = async (count) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          const lines = (await fs.readFile(started, 'utf8')).trim().split('\n');
          if (lines.length >= count) return lines.map(line => Number(line.split(' ')[0]));
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('the window process did not start');
    };
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    await preview.message({ type: 'openWindow' });
    assert.equal(preview.state.windowStatus, 'Window open · Linux x86-64');
    assert.ok(posted.some(state => state.windowBuilding && /Building/.test(state.windowStatus)));
    const [first] = await pids(1);
    assert.ok(alive(first));
    const launch = (await fs.readFile(started, 'utf8')).split('\n')[0];
    assert.match(launch, /^\d+ .*\/window\.elf$/, 'the native executable, not a player or a C executable');
    assert.match(await fs.readFile(lowered, 'utf8'), /^--target x86_64 --platform linux --emit elf -o .*window\.elf .*window\.zx$/m);
    // Opening again replaces the window rather than adding a second one.
    await preview.message({ type: 'openWindow' });
    const [, second] = await pids(2);
    assert.ok(alive(second));
    for (let attempt = 0; attempt < 40 && alive(first); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(alive(first), false, 'the earlier window ended');
    preview.dispose();
    for (let attempt = 0; attempt < 60 && alive(second); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(alive(second), false, 'closing the preview ends its window');
    // A failed build names its reason instead of opening anything.
    await fs.writeFile(source, 'main :: () { }\n');
    Object.assign(preview, { disposed: false, windowChild: null });
    vscode.workspace.getConfiguration = () => ({ get: (key, fallback) => key === 'command' ? '/bin/false' : fallback });
    await preview.openWindow();
    assert.equal(preview.state.windowStatus, 'ZX build failed');
    assert.equal(preview.state.windowBuilding, false);
    // A project preview opened from its folder inspects the manifest's entry.
    await fs.writeFile(path.join(directory, 'ziran.toml'), '[package]\nname="w"\nentry="window.zi"\n');
    assert.equal(await projectEntry(directory), source);
    assert.equal(await projectEntry(path.join(directory, 'storage')), '');
  } finally {
    preview.dispose?.();
    await fs.rm(directory, { recursive: true, force: true });
  }
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

test('a native build that cannot link a capability shows the named gap and falls back to nothing', async () => {
  const { Preview } = require('../preview.cjs');
  const directory = await fs.mkdtemp(path.join(import.meta.dirname, '.runtime-gap-'));
  const preview = Object.create(Preview.prototype);
  try {
    const source = path.join(directory, 'window.zi');
    await fs.writeFile(source, 'main :: () -> s32 { return 0 }\n');
    const command = path.join(directory, 'fake-ziran');
    await fs.writeFile(command, '#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && { shift; echo zx > "$1"; }; shift; done\n', { mode: 0o755 });
    const zx2native = path.join(directory, 'zx2native');
    await fs.writeFile(zx2native,
      '#!/bin/sh\necho "ziran: assembly.gap.machine-host: machine ELF does not implement host capability OpenWindow: no registered host library defines it; no alternate engine was selected" >&2\nexit 1\n', { mode: 0o755 });
    const vscode = { Uri: { file: fsPath => ({ fsPath }) }, workspace: { workspaceFolders: [],
      getConfiguration: () => ({ get: (key, fallback) => key === 'command' ? command : fallback }) } };
    Object.assign(preview, { disposed: false, source, storage: path.join(directory, 'storage'), vscode,
      windowChild: null, windowQueue: Promise.resolve(), disposables: [], watchers: [], inspector: onLinux(zx2native),
      state: { program: true, windowStatus: '', windowOutput: '', windowBuilding: false }, post() {} });
    await preview.openWindow();
    assert.equal(preview.windowChild, null, 'nothing started');
    assert.equal(preview.state.windowStatus, 'No Linux x86-64 build');
    assert.match(preview.state.windowOutput, /assembly\.gap\.machine-host.*OpenWindow/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('the preview follows the active .zi file and keeps its window and tabs for the same project', () => {
  const { Preview } = require('../preview.cjs');
  const preview = Object.create(Preview.prototype);
  const scheduled = [];
  const titles = [];
  Object.assign(preview, { disposed: false, source: '/p/a.zi', root: '/p', location: { key: '/p', root: '/p', source: '/p/a.zi', standalone: false },
    storage: '/s', windowChild: null, watchers: [], watch() {}, schedule() { scheduled.push(this.source); },
    panel: { set title(value) { titles.push(value); } }, state: { project: 'a', html: '<canvas>' } });
  assert.equal(preview.follow({ key: '/p', root: '/p', source: '/p/b.zi', standalone: false }), true);
  assert.deepEqual([preview.source, preview.state.project, scheduled, titles], ['/p/b.zi', 'b', ['/p/b.zi'], ['Preview: b']]);
  assert.equal(preview.state.html, '<canvas>', 'the live window stays for the same project');
  assert.equal(preview.follow({ key: '/p', root: '/p', source: '/p/b.zi', standalone: false }), false, 'same file: nothing to do');
  assert.equal(preview.follow({ key: '/q', root: '/q', source: '/q/c.zi', standalone: false }), false, 'another project is not this preview');
  // A standalone program moves the whole preview, window included.
  const lone = Object.create(Preview.prototype);
  Object.assign(lone, { disposed: false, source: '/x/a.zi', root: '/s/preview/old', location: { key: '/x/a.zi', source: '/x/a.zi', standalone: true },
    storage: '/s', windowChild: null, watchers: [], watch() { this.watched = true; }, schedule() {},
    panel: {}, state: { project: 'a', html: '<canvas>', windowStatus: 'Window open' } });
  assert.equal(lone.follow({ key: '/y/w.zi', root: null, source: '/y/w.zi', standalone: true }), true);
  assert.deepEqual([lone.source, lone.location.key, lone.state.html, lone.state.windowStatus, lone.watched],
    ['/y/w.zi', '/y/w.zi', '', '', true]);
});

test('the live frame fills its page edge to edge over the editor theme', async () => {
  const { previewAssets, FRAME_STYLE } = require('../preview-assets.cjs');
  const directory = await fs.mkdtemp(path.join(import.meta.dirname, '.runtime-frame-'));
  try {
    const artifact = path.join(directory, 'app.html');
    await fs.writeFile(artifact, '<html><head><style>body{background:#f8fafc}</style></head><body><div id=zx-controls></div></body></html>');
    const html = await previewAssets(artifact);
    assert.ok(html.includes(`<style>${FRAME_STYLE}</style></head>`), 'the frame style follows the page style');
    assert.match(FRAME_STYLE, /body\{[^}]*margin:0[^}]*background:transparent!important/);
    assert.match(FRAME_STYLE, /#zx-controls:empty\{display:none\}#zx-controls:empty\+#canvas-frame\{height:100%\}/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
