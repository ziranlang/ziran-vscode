// Run with a scrubbed environment under private xvfb-run; never the owner display.
import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { editor } from './editor.mjs';
import assert from 'node:assert/strict';
const repo = path.resolve(import.meta.dirname, '..');
const runtime = await fs.mkdtemp(path.join(import.meta.dirname, '.runtime-electron-'));
let fixture;
let project;
const real = Boolean(process.env.ZIRAN_PREVIEW_FIXTURE || process.env.ZIRAN_PREVIEW_PROJECT);
const windowExample = process.env.ZIRAN_PREVIEW_WINDOW === '1';
let browser;
let child;
let windowProcess;
const installed = process.env.ZIRAN_INSTALLED_EXTENSION;
try {
  fixture = process.env.ZIRAN_PREVIEW_FIXTURE ? await (await import('./preview-fixture.cjs')).default.createFixture(runtime, repo) : null;
  project = fixture?.project || process.env.ZIRAN_PREVIEW_PROJECT || path.join(runtime, 'button');
  if (!real) {
    await fs.mkdir(project);
    await fs.writeFile(path.join(project, 'ziran.toml'), '[package]\nname="button"\nentry="button.zi"\ntool="kryon"\n[tool.kryon.profiles.portable_web]\nbackend="canvas"\n');
    await fs.writeFile(path.join(project, 'button.zi'), '<button onclick="this.textContent=Number(this.textContent)+1">0</button>');
    const launcher = path.join(runtime, 'kryon');
    await fs.writeFile(launcher, '#!/bin/sh\nif grep -q BROKEN button.zi; then echo invalid-source >&2; exit 1; fi\nmkdir -p build\ncp button.zi build/button-portable_web.html\n', {mode:0o755});
    await fs.mkdir(path.join(project, '.vscode'));
    await fs.writeFile(path.join(project, '.vscode/settings.json'), JSON.stringify({'ziran.kryonCommand':launcher}));
  }
  // ZIRAN_PREVIEW_THEME picks the editor's color theme, for light and dark
  // checks, and ZIRAN_PREVIEW_COMMAND the ziran command, whose toolchain
  // tools beside it the targets use.
  const settings = {
    ...(process.env.ZIRAN_PREVIEW_THEME ? { 'workbench.colorTheme': process.env.ZIRAN_PREVIEW_THEME } : {}),
    ...(process.env.ZIRAN_PREVIEW_COMMAND ? { 'ziran.command': process.env.ZIRAN_PREVIEW_COMMAND } : {}),
  };
  if (Object.keys(settings).length) {
    await fs.mkdir(path.join(runtime, 'profile/User'), { recursive: true });
    await fs.writeFile(path.join(runtime, 'profile/User/settings.json'), JSON.stringify(settings));
  }
  const net = await import('node:net');
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  child = spawn(editor, ['--no-sandbox', '--disable-gpu', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--user-data-dir', path.join(runtime,'profile'), '--extensions-dir', installed ? path.dirname(installed) : path.join(runtime,'extensions'), `--extensionDevelopmentPath=${installed || repo}`, `--extensionTestsPath=${path.join(repo,'tests/extension-host.cjs')}`, `--remote-debugging-port=${port}`, project], {env:{...process.env, ZIRAN_PREVIEW_PROJECT:project, ZIRAN_PREVIEW_RUNTIME:runtime, HARMONY_DESKTOP_RECOVERY:'0'}, stdio:['ignore','ignore','pipe']});
  let errors = '';
  child.stderr.on('data', chunk => {errors = (errors + chunk).slice(-4000);});
  for(let attempt=0; attempt<600; attempt++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); break; } catch {}
    if (child.exitCode !== null) throw new Error(`VSCode exited ${child.exitCode}: ${errors}`);
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(browser, 'VSCode debugging endpoint did not start');
  for (const context of browser.contexts()) for (const page of context.pages()) {
    page.on('console', message => { if (message.type() === 'error') console.error('Webview:', message.text().slice(0,1500)); });
    page.on('pageerror', error => console.error('Webview error:', error.message.slice(0,1500)));
    await page.setViewportSize({width:1400,height:1100});
  }
  let preview;
  for(let attempt=0; attempt<(real ? 3000 : 300); attempt++) {
    if (child.exitCode !== null) throw new Error(`VSCode test host exited ${child.exitCode}: ${errors}`);
    for(const context of browser.contexts()) for(const page of context.pages()) for(const frame of page.frames()) {
      if (await frame.locator('#status').count()) {
        const status = await frame.locator('#status').textContent();
        if (/failed/i.test(status)) throw new Error(`${status}: ${await frame.locator('#build-output').textContent()}`);
        if (status.startsWith('Up to date')) preview=frame;
      }
    }
    if(preview) break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(preview, `Preview did not build: ${errors}`);
  const activation = await fs.readFile(path.join(runtime,'activated'),'utf8');
  assert.equal(activation,installed || repo);
  const app = preview.childFrames().find(frame=>frame.url()==='about:srcdoc');
  assert.ok(app, 'Interactive iframe missing');
  if (!real) {
    await app.locator('button').click();
    assert.equal(await app.locator('button').textContent(),'1');
    await fs.writeFile(path.join(runtime,'edit'), '<button onclick="this.textContent=Number(this.textContent)+1">8</button>');
    try { await preview.locator('#app').contentFrame().locator('button').filter({hasText:'8'}).waitFor({timeout:15000}); } catch(error) { console.error('Preview state:', await preview.locator('#status').textContent(), await preview.locator('#build-output').textContent()); throw error; }
    await preview.locator('#app').contentFrame().locator('button').click();
    assert.equal(await preview.locator('#app').contentFrame().locator('button').textContent(),'9');
    await fs.writeFile(path.join(runtime,'edit'), 'BROKEN');
    await preview.waitForFunction(()=>document.querySelector('#status').textContent.startsWith('Build or run failed'));
    assert.match(await preview.locator('#build-output').textContent(), /invalid-source/);
    await fs.writeFile(path.join(runtime,'edit'), '<button>Recovered</button>');
    await preview.locator('#app').contentFrame().getByRole('button',{name:'Recovered'}).waitFor();
  } else if (windowExample) {
    assert.equal(await preview.locator('#screen').count(), 0,
      'Kryon entries must not open the portable scalar-output Run pane');
    assert.equal(await preview.locator('#inspect').count(), 0, 'the targets show under the window, not behind a button');
    assert.equal(await preview.locator('#c-files, #ir-files, #window-output').count(), 0,
      'the preview shows no raw Kryon-profile C or ZIR dumps');
    await app.locator('canvas').waitFor({ timeout: 180000 });
    // The program's own main runs in the page: it paints the whole canvas.
    const painted = () => app.locator('canvas').first().evaluate(canvas => {
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let index = 3; index < data.length; index += 4) if (data[index]) count += 1;
      return { width: canvas.width, height: canvas.height, painted: count };
    });
    let pixels = await painted();
    for (let attempt = 0; attempt < 600 && pixels.painted === 0; attempt++) {
      await app.waitForTimeout(100);
      pixels = await painted();
    }
    assert.ok(pixels.painted > 0 && pixels.painted === pixels.width * pixels.height, JSON.stringify(pixels));
    assert.notEqual((await app.locator('body').textContent()).trim(), '1');
    // The canvas fills its frame edge to edge with no padding or controls strip,
    // and is drawn at device pixels, not scaled by CSS.
    const geometry = await app.locator('canvas').first().evaluate(canvas => {
      const box = canvas.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height, frameWidth: innerWidth, frameHeight: innerHeight,
        pixelWidth: canvas.width, pixelHeight: canvas.height, ratio: devicePixelRatio,
        corner: [...canvas.getContext('2d').getImageData(0, 0, 1, 1).data] };
    });
    // The app keeps its own width (window.zi asks for 320) from the frame's corner.
    assert.deepEqual([geometry.x, geometry.y, geometry.height], [0, 0, geometry.frameHeight], JSON.stringify(geometry));
    assert.ok(geometry.width > 0 && geometry.width <= geometry.frameWidth, JSON.stringify(geometry));
    assert.equal(geometry.pixelWidth, Math.round(geometry.width * geometry.ratio), JSON.stringify(geometry));
    assert.equal(geometry.pixelHeight, Math.round(geometry.height * geometry.ratio), JSON.stringify(geometry));
    console.log('Live frame geometry:', JSON.stringify(geometry));
    if (process.env.ZIRAN_PREVIEW_SHOTS) {
      await preview.locator('#window').screenshot({ path: path.join(process.env.ZIRAN_PREVIEW_SHOTS, `window-${process.env.ZIRAN_PREVIEW_THEME ? 'light' : 'dark'}.png`) });
    }
    console.log('Real window.zi runs as an embedded Kryon canvas, not portable scalar output:', pixels);
    // Open in window runs the native executable the Binary tab shows as one
    // owned process, with no C executable and no engine fallback; it links
    // window.zi's capabilities from the registered host library. A program
    // that cannot build or run shows its named gap in the pane instead.
    const owned = () => {
      try { return execFileSync('pgrep', ['-f', `${runtime}/profile/.*/window-zx/.*/window\\.elf`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean); }
      catch { return []; }
    };
    // Another installed extension may leave a quick input open over the pane.
    const dismiss = () => preview.page().keyboard.press('Escape');
    assert.equal(await preview.locator('#open-window').textContent(), 'Open in window');
    for (const round of [1, 2]) {
      await dismiss();
      await preview.locator('#open-window').click();
      await preview.waitForFunction(() => /^(Window open|Window closed|.+ run failed|No .+ build|Can.t run on .+)/.test(document.querySelector('#window-status').textContent), null, { timeout: 180000 });
      assert.ok(owned().length <= 1, `round ${round}: never more than one owned native process`);
    }
    await preview.waitForFunction(() => !document.querySelector('#open-window').disabled &&
      /^(Window open|Window closed|.+ run failed|No .+ build|Can.t run on .+)/.test(document.querySelector('#window-status').textContent), null, { timeout: 180000 });
    const outcome = await preview.locator('#window-status').textContent();
    assert.equal(execFileSync('sh', ['-c', `find ${runtime}/profile -type d -name window-c | wc -l`], { encoding: 'utf8' }).trim(), '0', 'no C window build');
    // With Kryon's desktop host library registered (make install-user, or
    // ZIRAN_HOST_PATH), the executable shows window.zi's one window.
    assert.equal(outcome, 'Window open · Linux x86-64', await preview.locator('#build-output').textContent());
    let windows = '';
    for (let attempt = 0; attempt < 100 && !/"Window": .* 320x160\+/.test(windows); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      windows = execFileSync('xwininfo', ['-root', '-tree'], { encoding: 'utf8' });
    }
    assert.match(windows, /"Window": .* 320x160\+/, 'one 320x160 window titled Window');
    console.log('Open in window ran window.zi\'s native executable (no C build, no player); outcome:', outcome);
    // The target views sit under the live window in the same pane.
    await preview.waitForFunction(() => document.querySelectorAll('#tabs [role=tab]').length === 4 &&
      !document.querySelector('#tabs').textContent.includes('…'), null, { timeout: 600000 });
    assert.deepEqual((await preview.locator('#tabs').getByRole('tab').allTextContents()).map(name => name.replace(' ✕', '')),
      ['C', 'Go', 'Wasm', 'Native']);
    await preview.locator('#tabs').getByRole('tab', { name: 'C', exact: true }).click();
    assert.deepEqual(await preview.locator('#views').getByRole('tab').allTextContents(),
      ['Source', 'ZIR', 'C', 'Assembly', 'Binary']);
    assert.match(await preview.locator('#code').textContent(), /App\.Run|main ::/);
    await preview.locator('#views').getByRole('tab', { name: 'C', exact: true }).click();
    // window.c comes first; a picker appears only when the program has more own files.
    if (await preview.locator('#own-files').count()) assert.equal(await preview.locator('#own-files').inputValue(), 'window.c');
    const own = await preview.locator('#code').textContent();
    assert.match(own, /from window\.zi[\s\S]*\bmain\b/);
    // A dependency module is read only when picked.
    const picker = preview.locator('#dependency-files');
    assert.match(await picker.locator('option').first().textContent(), /^Dependencies \(\d+ files · /);
    const names = await picker.locator('option').allTextContents();
    await picker.selectOption(names.includes('app.c') ? 'app.c' : names[1]);
    await preview.waitForFunction((text) => {
      const shown = document.querySelector('#code').textContent;
      return shown !== text && !shown.startsWith('Loading ') && /Generated by zi2c from/.test(shown);
    }, own, { timeout: 60000 });
    await picker.selectOption('');
    assert.equal(await preview.locator('#code').textContent(), own);
    // Native's Assembly lists the executable Open in window runs.
    await preview.locator('#tabs').getByRole('tab', { name: 'Native', exact: true }).click();
    assert.deepEqual(await preview.locator('#views').getByRole('tab').allTextContents(),
      ['Source', 'ZIR', 'LIR', 'Optimized', 'ZX', 'Assembly', 'Binary']);
    await preview.locator('#views').getByRole('tab', { name: 'Assembly', exact: true }).click();
    await preview.waitForFunction(() => /<window:main>:/.test(document.querySelector('#code').textContent), null, { timeout: 60000 });
    assert.doesNotMatch(await preview.locator('#code').textContent(), /assembly\.gap/);
    // On the Wasm platform Native ends in WAT and Binary, and Open in window
    // runs the program's ZX in the page: Kryon's canvas player lowers it to
    // Wasm there, and its main clears the page's canvas as its window.
    await preview.locator('#platform').selectOption('wasm32');
    await preview.waitForFunction(() => [...document.querySelectorAll('#views [role=tab]')].some(tab => tab.textContent === 'WAT'),
      null, { timeout: 600000 });
    await preview.locator('#views').getByRole('tab', { name: 'WAT', exact: true }).click();
    await preview.waitForFunction(() => /\(module/.test(document.querySelector('#code').textContent), null, { timeout: 60000 });
    await dismiss();
    await preview.locator('#open-window').click();
    await preview.waitForFunction(() => /^(Window open · Wasm|No Wasm page|Wasm page build failed)/.test(document.querySelector('#window-status').textContent),
      null, { timeout: 600000 });
    assert.equal(await preview.locator('#window-status').textContent(), 'Window open · Wasm',
      await preview.locator('#build-output').textContent());
    const page = preview.locator('#app').contentFrame();
    await page.locator('canvas').first().waitFor({ timeout: 180000 });
    let filled = {};
    for (let attempt = 0; attempt < 600 && !(filled.width > 0 && filled.same === filled.width * filled.height); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      filled = await page.locator('canvas').first().evaluate(canvas => {
        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let same = 0;
        for (let index = 0; index < data.length; index += 4) {
          if (data[index] === 248 && data[index + 1] === 250 && data[index + 2] === 252 && data[index + 3] === 255) same += 1;
        }
        return { width: canvas.width, height: canvas.height, same };
      });
    }
    assert.ok(filled.width > 0 && filled.same === filled.width * filled.height, JSON.stringify(filled));
    console.log('Open in window on Wasm ran window.zi\'s ZX in the page, its canvas in the frame colour:', JSON.stringify(filled));
    console.log('Under the window: C, Go, Wasm and Native with Source and ZIR (and LIR, Optimized, ZX for Wasm and Native), window.c first, Kryon modules under Dependencies and Native\'s Assembly of the linked executable.');
  } else {
    await app.locator('canvas').waitFor();
    const pixels = await app.locator('canvas').first().evaluate(canvas=>({width:canvas.width,height:canvas.height}));
    assert.ok(pixels.width>0 && pixels.height>0);
    const canvas = preview.locator('#app').contentFrame().locator('canvas').first();
    const signature = () => canvas.evaluate(canvas => {
      const scale = canvas.width / canvas.clientWidth;
      const data = canvas.getContext('2d').getImageData(20*scale, 420*scale, 100*scale, 36*scale).data;
      let hash = 0; for (const value of data) hash = (hash*31+value)|0; return hash;
    });
    for (let attempt=0; attempt<600 && await signature()===0; attempt++) await new Promise(resolve=>setTimeout(resolve,100));
    const before = await signature();
    assert.notEqual(before,0,'The actual counter must render before input');
    await canvas.click({position:{x:80,y:90}});
    await app.waitForTimeout(200);
    const after = await signature();
    assert.notEqual(after,before,'Button click must change its rendered counter');
    console.log('Real compiled canvas rendered; Button counter changed after pointer click:',pixels);
    if (fixture) {
      const saved = fixture.source.replace('Continue', 'Saved').replace('clicks += 1', 'clicks += 2');
      await fs.writeFile(path.join(runtime,'edit'), saved);
      await preview.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Building'), null, {timeout:180000});
      await preview.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Up to date'), null, {timeout:180000});
      await canvas.waitFor();
      for (let attempt=0; attempt<600 && await signature()!==before; attempt++) await new Promise(resolve=>setTimeout(resolve,100));
      assert.equal(await signature(), before, 'Successful rebuild resets the application counter');
      await canvas.click({position:{x:80,y:90}});
      await app.waitForTimeout(200);
      assert.notEqual(await signature(),before,'Edited source still responds to clicks');
      assert.notEqual(await signature(),after,'Edited source increments by two rather than the original one');

      await fs.writeFile(path.join(runtime,'edit'), 'Frame :: ( -> malformed source');
      await preview.waitForFunction(() => document.querySelector('#status').textContent.includes('failed'), null, {timeout:180000});
      assert.match(await preview.locator('#build-output').textContent(), /error|button[.]zi|failed/i);
      await fs.writeFile(path.join(runtime,'edit'), saved.replace('Saved','Recovered'));
      await canvas.waitFor({timeout:180000});
      for (let attempt=0; attempt<600 && await signature()!==before; attempt++) await new Promise(resolve=>setTimeout(resolve,100));
      const repaired = await signature();
      assert.equal(repaired,before,'Repaired app renders its initial counter');
      await canvas.click({position:{x:80,y:90}});
      await app.waitForTimeout(200);
      assert.notEqual(await signature(),repaired, 'Repaired real source must restore interactive counter');
      console.log('Real Ziran edit/save rebuild, malformed-source diagnostic and repaired interactive preview passed.');
    }
  }
  console.log(real ? 'Real Kryon compiler-to-preview integration passed in fresh VSCode.' : 'Fresh VSCode extension activated; interactive HTML rendered; pointer events verified; saved editor changes refreshed; build failure and recovery verified.');
  await fs.writeFile(path.join(runtime,'done'),'ok');
} finally {
  await browser?.close();
  if(child && child.exitCode===null) {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
  }
  if (windowProcess) {
    // Closing VS Code ends the window it opened.
    let alive = true;
    for (let attempt = 0; attempt < 50 && alive; attempt++) {
      try { process.kill(Number(windowProcess), 0); await new Promise(resolve => setTimeout(resolve, 100)); }
      catch { alive = false; }
    }
    if (alive) { try { process.kill(Number(windowProcess), 'SIGKILL'); } catch {} }
    assert.equal(alive, false, 'the owned window process must not outlive VS Code');
    console.log('The owned window process ended with VS Code.');
  }
  await fs.rm(runtime,{recursive:true,force:true});
}
