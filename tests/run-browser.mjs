// Actual installed/development extension, private Xvfb display and owned process.
import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { editor } from './editor.mjs';
import assert from 'node:assert/strict';

const repo = path.resolve(import.meta.dirname, '..');
const runtime = await fs.mkdtemp(path.join(import.meta.dirname, '.runtime-run-'));
const real = Boolean(process.env.ZIRAN_PREVIEW_PROJECT);
const project = process.env.ZIRAN_PREVIEW_PROJECT || path.join(runtime, 'hello');
const entry = process.env.ZIRAN_PREVIEW_ENTRY || 'hello.zi';
const installed = process.env.ZIRAN_INSTALLED_EXTENSION;
const nativeOnly = process.env.ZIRAN_RUN_NATIVE === '1';
let child, browser;
try {
  if (nativeOnly) {
    assert.ok(real, 'Native inspection uses an existing project and example');
    const user = path.join(runtime, 'profile/User');
    await fs.mkdir(user, { recursive: true });
    await fs.writeFile(path.join(user, 'settings.json'), JSON.stringify({
      'ziran.command': path.resolve(repo, '../ziran/build/bin/ziran'),
      'ziran.previewTargets': ['native'],
    }));
  }
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
  child = spawn(editor, ['--no-sandbox', '--disable-gpu',
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
  if (nativeOnly) {
    await run.waitForFunction(() => document.querySelector('#screen').textContent === 'Hello, World!\n',
      null, { timeout: 180000 });
    const native = run.locator('#tabs').getByRole('tab', { name: 'Native', exact: true });
    await native.click({ timeout: 180000 });
    assert.deepEqual(await run.locator('#views').getByRole('tab').allTextContents(),
      ['Source', 'ZIR', 'LIR', 'Optimized', 'ZX', 'Assembly', 'Binary']);
    const view = name => run.locator('#views').getByRole('tab', { name, exact: true });
    await view('LIR').click();
    assert.match(await run.locator('#code').textContent(), /^lir \d+ entry/);
    await view('ZX').click();
    await run.waitForFunction(() => document.querySelector('#hex-title').textContent.startsWith('final.zx'));
    await view('Assembly').click();
    await run.locator('#program-only').uncheck();
    assert.match(await run.locator('#code').textContent(), /^ELF header\n[\s\S]*<hello:main>:[\s\S]*syscall/);
    await run.locator('#program-only').check();
    assert.match(await run.locator('#code').textContent(), /^<hello:main>:\n/);
    assert.doesNotMatch(await run.locator('#code').textContent(), /ELF header|<runtime/);
    await run.locator('#program-only').uncheck();
    await view('Binary').click();
    await run.waitForFunction(() => /^── ELF header · 0x0–0x40 · 64 bytes\n00000000  7f 45 4c 46 /
      .test(document.querySelector('#hex-rows').textContent));
    await run.locator('#program-only').check();
    await run.waitForFunction(() => /^── hello:main · 0x/.test(document.querySelector('#hex-rows').textContent));
    assert.equal(await fs.readFile(path.join(runtime, 'activated'), 'utf8'), installed || repo);
    await fs.writeFile(path.join(runtime, 'done'), '');
    console.log(`Local installed VS Code Native test: ${entry}; Source, ZIR, LIR, Optimized, ZX, full and program-only Assembly and Binary views passed.`);
  } else if (real) {
    await run.waitForFunction(() => document.querySelector('[role=tab]'), null, {timeout:180000});
    for (const tab of ['C', 'Go']) {
      await run.locator('#tabs').getByRole('tab', {name: tab, exact: true}).click({timeout:180000});
      await run.locator('#views').getByRole('tab', {name: tab, exact: true}).click({timeout:180000});
      const extension = {C:'c', Go:'go'}[tab];
      await run.locator('#code').filter({hasText: /function|#include|package/}).waitFor({timeout:180000});
      // The program's own module is shown first; dependencies sit in their own picker.
      const own = run.locator('#own-files');
      if (await own.count()) assert.equal(await own.inputValue(), `${path.basename(entry, '.zi')}.${extension}`);
      assert.doesNotMatch(await run.locator('#code').textContent(), /cannot find imported module/);
    }
    // The program's bundle and run use one toolchain: a project bundle is
    // never read by a different install that rejects its ZIR.
    await run.waitForFunction(() => !/…/.test(document.querySelector('#status').textContent), null, { timeout: 180000 });
    const status = await run.locator('#status').textContent();
    const problems = await run.locator('#problems').textContent();
    assert.doesNotMatch(problems, /unsupported ZIR version|invalid embedded ZIR/, problems);
    assert.match(status, /^Up to date/, `${status}\n${problems}`);
    assert.equal(await fs.readFile(path.join(runtime, 'activated'), 'utf8'), installed || repo);
    await fs.writeFile(path.join(runtime, 'done'), '');
    console.log(`Local VS Code test: ${entry} ran (${status.trim()}); C and Go resolved with real project dependencies; workspace ${process.env.ZIRAN_PREVIEW_WORKSPACE || project}.`);
  } else {
    const tab = (name) => run.locator('#tabs').getByRole('tab', { name, exact: true });
    const view = (name) => run.locator('#views').getByRole('tab', { name, exact: true });
    const code = () => run.locator('#code').textContent();
    const rows = () => run.locator('#hex-rows').textContent();
    // Rows are drawn once their page of bytes arrives from the extension.
    const firstRow = async (pattern) => run.waitForFunction((source) =>
      new RegExp(source).test(document.querySelector('#hex-rows').textContent.split('\n')[0]),
      pattern.source, { timeout: 60000 });
    const secondRow = async (pattern) => run.waitForFunction((source) =>
      new RegExp(source).test(document.querySelector('#hex-rows').textContent.split('\n')[1] || ''),
      pattern.source, { timeout: 60000 });
    // One chain for every target: C and Go stop after ZIR; Wasm and Native go through ZX.
    const zirChain = ['Source', 'ZIR'];
    const pipeline = [...zirChain, 'LIR', 'Optimized', 'ZX'];
    await run.waitForFunction(() => document.querySelector('#screen').textContent === 'Hello, World!\n');
    await tab('Native').waitFor({ timeout: 180000 });
    await run.waitForFunction(() => !document.querySelector('#status').textContent.includes('…'), null, { timeout: 180000 });
    assert.deepEqual(await run.locator('#tabs').getByRole('tab').allTextContents(), ['C', 'Go', 'Wasm', 'Native']);
    assert.deepEqual(await run.locator('#targets input').count(), 4);
    assert.equal(await run.locator('#caption').count(), 0);

    await tab('C').click();
    assert.deepEqual(await run.locator('#views').getByRole('tab').allTextContents(), [...zirChain, 'C', 'Assembly', 'Binary']);
    assert.match(await code(), /Hello, World!/);
    await view('ZIR').click();
    assert.match(await code(), /module hello from hello\.zi/);
    await view('C').click();
    assert.match(await code(), /Hello, World!/);
    await view('Assembly').click();
    assert.match(await code(), /\.text|\.section/);
    await view('Binary').click();
    // The whole file, each region under its label; the toggle keeps only code and data.
    await firstRow(/^── ELF header · 0x0–0x40 · 64 bytes$/);
    await secondRow(/^00000000  7f 45 4c 46 /);
    assert.equal(await run.locator('#program-only').isChecked(), false);
    assert.match(await run.locator('#hex-title').textContent(), /^hello · [\d,.]+ bytes$/);
    await run.locator('#program-only').check();
    await firstRow(/^── \.[a-z_.]+ · 0x[0-9a-f]+–0x[0-9a-f]+ · \d+ bytes$/);
    assert.doesNotMatch(await rows(), /ELF header|program headers/);
    await run.locator('#program-only').uncheck();

    await tab('Go').click();
    await view('Assembly').click();
    assert.match(await code(), /STEXT/);
    await view('Binary').click();
    await firstRow(/^── ELF header · 0x0–0x40 · 64 bytes$/);
    // A megabyte-sized binary scrolls without drawing every row.
    const total = await run.evaluate(() => document.querySelector('#hex-spacer').style.height);
    assert.ok(parseFloat(total) > 100000, total);
    assert.ok((await rows()).split('\n').length < 200);
    await run.locator('#hex-scroll').evaluate((box) => { box.scrollTop = box.scrollHeight; });
    await run.waitForFunction(() => {
      const lines = document.querySelector('#hex-rows').textContent.split('\n');
      return parseInt(lines[0], 16) > 0x100000 && !lines.some((line) => line.includes('··'));
    }, null, { timeout: 60000 });
    // Going to an offset the filter hides shows the whole file again.
    await run.locator('#program-only').check();
    await run.locator('#hex-goto').fill('40');
    await run.locator('#hex-goto').press('Enter');
    await firstRow(/^00000040  /);
    assert.equal(await run.locator('#program-only').isChecked(), false);

    await tab('Wasm').click();
    assert.deepEqual(await run.locator('#views').getByRole('tab').allTextContents(), [...pipeline, 'WAT', 'Binary']);
    await view('WAT').click();
    assert.match(await code(), /\(module/);
    await view('Binary').click();
    await firstRow(/^── Wasm header · 0x0–0x8 · 8 bytes$/);
    await secondRow(/^00000000  00 61 73 6d /);
    await run.locator('#program-only').check();
    await firstRow(/^── code section · 0x/);
    await tab('Native').click();
    assert.deepEqual(await run.locator('#views').getByRole('tab').allTextContents(), [...pipeline, 'Assembly', 'Binary']);
    await view('Source').click();
    assert.match(await code(), /Hello, World!/);
    await view('Assembly').click();
    assert.match(await code(), /^<hello:main>:\n[\s\S]*\tret/);
    await run.locator('#program-only').uncheck();
    assert.match(await code(), /^ELF header\n[\s\S]*\nProgram headers\n[\s\S]*<hello:main>:[\s\S]*\tsyscall/);
    assert.doesNotMatch(await code(), /^#|objdump of the ELF|map identity/m);
    await view('Binary').click();
    await firstRow(/^── ELF header · 0x0–0x40 · 64 bytes$/);
    await secondRow(/^00000000  7f 45 4c 46 /);
    await run.locator('#program-only').check();
    await firstRow(/^── hello:main · 0x/);

    await tab('Wasm').click();
    await fs.writeFile(path.join(runtime, 'edit'), 'main :: () { print("Saved!\\n"); }\n');
    await run.waitForFunction(() => document.querySelector('#screen').textContent === 'Saved!\n');
    assert.equal(await tab('Wasm').getAttribute('aria-selected'), 'true');
    await tab('C').click();
    await view('Source').click();
    await run.waitForFunction(() => document.querySelector('#code').textContent.includes('Saved!'),
      null, { timeout: 180000 });
    await tab('Wasm').click();
    await view('Binary').click();
    assert.equal(await run.locator('#program-only').isChecked(), true);
    await firstRow(/^── code section · 0x/);

    // A module without main: a clear message naming its importing program.
    const noMain = "frame.zi has no main; it's a module. Run a program that imports it, such as desktop_frame.zi.";
    const openRequest = path.join(runtime, 'open');
    await fs.writeFile(openRequest, path.join(project, 'frame.zi'));
    try {
      await run.waitForFunction((text) => document.querySelector('#screen').textContent === text,
        noMain, { timeout: 180000 });
    } catch (error) {
      let pending = false;
      try { await fs.access(openRequest); pending = true; } catch {}
      throw new Error(`${error.message}; extension host exited=${child.exitCode}; open request pending=${pending}; ${errors}`);
    }
    assert.equal(await run.locator('#status').textContent(), 'No main to run');
    await run.waitForFunction(() => document.querySelector('#tabs').textContent.includes('Wasm ✕'), null, { timeout: 180000 });
    await tab('Wasm ✕').click();
    assert.equal(await code(), noMain);
    await tab('C').click();
    await view('Assembly').click();
    assert.match(await code(), /Frame/);

    assert.equal(await fs.readFile(path.join(runtime, 'activated'), 'utf8'), installed || repo);
    await fs.writeFile(path.join(runtime, 'done'), '');
    console.log('Local VS Code test: hello-world execution; C, Go, Wasm and Native tabs each with Source and ZIR (plus LIR, Optimized and ZX for Wasm and Native); full and program-only Assembly and Binary; legacy ZX setting migration; paged hex scrolling; save/rebuild; no-main module message passed.');
  }
} finally {
  await browser?.close().catch(() => {});
  if (child?.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
  }
  await fs.rm(runtime, { recursive: true, force: true });
}
