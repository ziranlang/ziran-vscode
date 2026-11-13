// Actual installed/development extension, private Xvfb display and owned process.
import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const repo = path.resolve(import.meta.dirname, '..');
const runtime = await fs.mkdtemp(path.join(import.meta.dirname, '.runtime-run-'));
const real = Boolean(process.env.ZIRAN_PREVIEW_PROJECT);
const project = process.env.ZIRAN_PREVIEW_PROJECT || path.join(runtime, 'hello');
const entry = process.env.ZIRAN_PREVIEW_ENTRY || 'hello.zi';
const installed = process.env.ZIRAN_INSTALLED_EXTENSION;
let child, browser;
try {
  if (!real) {
    await fs.mkdir(path.join(project, '.vscode'), { recursive: true });
    await fs.writeFile(path.join(project, 'hello.zi'), 'main :: () { print("Hello, World!\\n"); }\n');
    // A module without main, and the program that imports it.
    await fs.writeFile(path.join(project, 'frame.zi'), '#program_export\nFrame :: () -> s32 { return 7 }\n');
    await fs.writeFile(path.join(project, 'desktop_frame.zi'), '#import "frame"\nmain :: () -> s32 { return Frame() }\n');
    await fs.writeFile(path.join(project, '.vscode/settings.json'), JSON.stringify({
      'ziran.command': path.resolve(repo, '../ziran/build/bin/ziran'),
      'ziran.previewTargets': ['c', 'go', 'wasm', 'zx'],
    }));
  }
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  child = spawn('/usr/share/code/code', ['--no-sandbox', '--disable-gpu',
    '--disable-workspace-trust', '--disable-extensions', '--skip-welcome', '--skip-release-notes',
    '--user-data-dir', path.join(runtime, 'profile'), '--extensions-dir',
    installed ? path.dirname(installed) : path.join(runtime, 'extensions'),
    `--extensionDevelopmentPath=${installed || repo}`,
    `--extensionTestsPath=${path.join(repo, 'tests/extension-host.cjs')}`,
    `--remote-debugging-port=${port}`, process.env.ZIRAN_PREVIEW_WORKSPACE || project], {
    env: { ...process.env, ZIRAN_PREVIEW_PROJECT: project,
      ZIRAN_PREVIEW_ENTRY: entry, ZIRAN_PREVIEW_RUNTIME: runtime,
      ZIRAN_RUN_TEST: '1', HARMONY_DESKTOP_RECOVERY: '0' }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let errors = '';
  child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4000); });
  for (let attempt = 0; attempt < 600; attempt++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); break; } catch {}
    if (child.exitCode !== null) throw Error(`Owned VS Code exited ${child.exitCode}: ${errors}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(browser, errors);
  let run;
  for (let attempt = 0; attempt < 600 && !run; attempt++) {
    for (const context of browser.contexts()) for (const page of context.pages()) for (const frame of page.frames()) {
      if (await frame.locator('#screen').count()) run = frame;
    }
    if (!run) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(run, `Ziran Run webview must open: ${errors}`);
  if (real) {
    await run.waitForFunction(() => document.querySelector('[role=tab]'), null, {timeout:180000});
    for (const tab of ['C', 'Go', 'ZIR']) {
      await run.getByRole('tab', {name: tab, exact: true}).click({timeout:180000});
      const extension = {C:'c', Go:'go', ZIR:'zir'}[tab];
      await run.locator('#file-row select').selectOption(`${path.basename(entry, '.zi')}.${extension}`);
      await run.locator('#code').filter({hasText: /function|#include|package/}).waitFor({timeout:180000});
      assert.doesNotMatch(await run.locator('#code').textContent(), /cannot find imported module/);
    }
    assert.equal(await fs.readFile(path.join(runtime, 'activated'), 'utf8'), installed || repo);
    await fs.writeFile(path.join(runtime, 'done'), '');
    console.log(`Local VS Code test: ${entry} C, Go and checked IR resolved with real project dependencies; workspace ${process.env.ZIRAN_PREVIEW_WORKSPACE || project}.`);
  } else {
    const tab = (name) => run.locator('#tabs').getByRole('tab', { name, exact: true });
    const view = (name) => run.locator('#views').getByRole('tab', { name, exact: true });
    const code = () => run.locator('#code').textContent();
    const rows = () => run.locator('#hex-rows').textContent();
    // Rows are drawn once their page of bytes arrives from the extension.
    const firstRow = async (pattern) => run.waitForFunction((source) =>
      new RegExp(source).test(document.querySelector('#hex-rows').textContent.split('\n')[0]),
      pattern.source, { timeout: 60000 });
    await run.waitForFunction(() => document.querySelector('#screen').textContent === 'Hello, World!\n');
    await tab('ZX').waitFor({ timeout: 180000 });
    await run.waitForFunction(() => !document.querySelector('#status').textContent.includes('…'), null, { timeout: 180000 });
    assert.deepEqual(await run.locator('#tabs').getByRole('tab').allTextContents(), ['C', 'Go', 'ZIR', 'Wasm', 'ZX']);

    await tab('C').click();
    assert.deepEqual(await run.locator('#views').getByRole('tab').allTextContents(), ['Source', 'Assembly', 'Binary']);
    assert.match(await code(), /Hello, World!/);
    await view('Assembly').click();
    assert.match(await code(), /\.text|\.section/);
    assert.match(await run.locator('#caption').textContent(), /-S, with the flags ziran compile-commands reports/);
    await view('Binary').click();
    await firstRow(/^00000000  7f 45 4c 46 /);
    assert.match(await run.locator('#hex-title').textContent(), /^hello · [\d,.]+ bytes$/);

    await tab('Go').click();
    await view('Assembly').click();
    assert.match(await code(), /STEXT/);
    await view('Binary').click();
    await firstRow(/^00000000  7f 45 4c 46 /);
    // A megabyte-sized binary scrolls without drawing every row.
    const total = await run.evaluate(() => document.querySelector('#hex-spacer').style.height);
    assert.ok(parseInt(total) > 100000, total);
    assert.ok((await rows()).split('\n').length < 200);
    await run.locator('#hex-scroll').evaluate((box) => { box.scrollTop = box.scrollHeight; });
    await run.waitForFunction(() => {
      const lines = document.querySelector('#hex-rows').textContent.split('\n');
      return parseInt(lines[0], 16) > 0x100000 && !lines.some((line) => line.includes('··'));
    }, null, { timeout: 60000 });
    await run.locator('#hex-goto').fill('40');
    await run.locator('#hex-goto').press('Enter');
    await firstRow(/^00000040  /);

    await tab('ZIR').click();
    assert.match(await code(), /function main/);
    await tab('Wasm').click();
    assert.match(await code(), /\(module/);
    await view('Binary').click();
    await firstRow(/^00000000  00 61 73 6d /);
    await tab('ZX').click();
    assert.deepEqual(await run.locator('#views').getByRole('tab').allTextContents(), ['Listing', 'Instructions ✕', 'Binary']);
    assert.match(await code(), /bundle entry hello:main/);
    await view('Instructions ✕').click();
    assert.match(await code(), /zi2asm/);
    await view('Binary').click();
    await firstRow(/^00000000  /);

    await tab('Wasm').click();
    await fs.writeFile(path.join(runtime, 'edit'), 'main :: () { print("Saved!\\n"); }\n');
    await run.waitForFunction(() => document.querySelector('#screen').textContent === 'Saved!\n');
    assert.equal(await tab('Wasm').getAttribute('aria-selected'), 'true');

    // A module without main: a clear message naming its importing program.
    const noMain = "frame.zi has no main; it's a module. Run a program that imports it, such as desktop_frame.zi.";
    await fs.writeFile(path.join(runtime, 'open'), path.join(project, 'frame.zi'));
    await run.waitForFunction((text) => document.querySelector('#screen').textContent === text, noMain, { timeout: 180000 });
    assert.equal(await run.locator('#status').textContent(), 'No main to run');
    await run.waitForFunction(() => document.querySelector('#tabs').textContent.includes('Wasm ✕'), null, { timeout: 180000 });
    await tab('Wasm ✕').click();
    assert.equal(await code(), noMain);
    await tab('C').click();
    await view('Assembly').click();
    assert.match(await code(), /Frame/);

    assert.equal(await fs.readFile(path.join(runtime, 'activated'), 'utf8'), installed || repo);
    await fs.writeFile(path.join(runtime, 'done'), '');
    console.log('Local VS Code test: hello-world execution; C, Go, ZIR, Wasm and ZX source/assembly/binary views; paged hex scrolling; save/rebuild; no-main module message passed.');
  }
} finally {
  await browser?.close().catch(() => {});
  if (child?.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
  }
  await fs.rm(runtime, { recursive: true, force: true });
}
