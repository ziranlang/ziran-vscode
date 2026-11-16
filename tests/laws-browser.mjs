// Run with scrubbed desktop variables and recovery disabled under private Xvfb.
import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { editor } from './editor.mjs';
import assert from 'node:assert/strict';
const repo = path.resolve(import.meta.dirname, '..');
assert.equal(process.env.HARMONY_DESKTOP_RECOVERY, '0', 'Use the private-display test command');
const runtime = await fs.mkdtemp(path.join(import.meta.dirname, '.runtime-laws-'));
const extension = process.env.ZIRAN_INSTALLED_EXTENSION || repo;
let child, browser;
try {
  await fs.writeFile(path.join(runtime, 'laws.zi'), `// A comment, distinct from the law below.
#law GuideKeys forall left: 0..1,
    right: 0..1 =>
    left + right == right + left &&
    left <= 1;
After :: 42
`);
  const profile = path.join(runtime, 'profile');
  await fs.mkdir(path.join(profile, 'User'), { recursive: true });
  await fs.writeFile(path.join(profile, 'User/settings.json'), JSON.stringify({
    'workbench.colorTheme': 'Default Dark+',
    'editor.semanticHighlighting.enabled': false,
    'editor.wordWrap': 'off',
    'editor.minimap.enabled': false,
    'editor.fontLigatures': false,
    'window.restoreWindows': 'none',
  }));
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  child = spawn(editor, ['--no-sandbox', '--disable-gpu', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--user-data-dir', profile, '--extensions-dir', path.join(runtime, 'extensions'), `--extensionDevelopmentPath=${extension}`, `--extensionTestsPath=${path.join(repo, 'tests/laws-editor.cjs')}`, `--remote-debugging-port=${port}`, runtime], {env: {...process.env, ZIRAN_LAWS_RUNTIME: runtime}, stdio: ['ignore', 'ignore', 'pipe']});
  let errors = '';
  child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-3000); });
  for (let attempt = 0; attempt < 300; attempt++) {
    if (child.exitCode !== null) throw new Error(`VSCode exited ${child.exitCode}: ${errors}`);
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(browser, 'Private VSCode did not start');
  let rows;
  for (let attempt = 0; attempt < 300; attempt++) {
    for (const context of browser.contexts()) for (const page of context.pages()) {
      rows = await page.locator('.monaco-editor .view-lines .view-line').evaluateAll(lines => lines.map(line => ({
        text: line.textContent.replaceAll('\u00a0', ' '),
        spans: [...line.querySelectorAll('span[class*="mtk"]')].map(span => ({text: span.textContent.replaceAll('\u00a0', ' '), color: getComputedStyle(span).color})),
      })));
      if (rows.some(row => row.text.includes('#law GuideKeys'))) break;
    }
    if (rows?.some(row => row.text.includes('#law GuideKeys'))) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const comment = rows.find(row => row.text.includes('// A comment'));
  const law = rows.find(row => row.text.includes('#law GuideKeys'));
  const domain = rows.find(row => row.text.includes('right: 0..1 =>'));
  const predicate = rows.find(row => row.text.includes('left + right =='));
  const after = rows.find(row => row.text.includes('After :: 42'));
  assert.ok(comment && law && domain && predicate && after, JSON.stringify(rows));
  const color = (row, text) => row.spans.find(span => span.text.includes(text))?.color;
  const commentColor = color(comment, '//');
  assert.ok(commentColor);
  assert.notEqual(color(law, 'GuideKeys'), commentColor);
  assert.ok(new Set(law.spans.map(span => span.color)).size >= 3, JSON.stringify(law));
  assert.notEqual(color(law, 'forall'), color(law, '0'));
  assert.ok(new Set(domain.spans.map(span => span.color)).size >= 2, JSON.stringify(domain));
  assert.ok(new Set(predicate.spans.map(span => span.color)).size >= 2, JSON.stringify(predicate));
  assert.notEqual(color(after, 'After'), commentColor);
  const activated = await fs.readFile(path.join(runtime, 'activated'), 'utf8');
  assert.equal(activated, extension);
  await fs.writeFile(path.join(runtime, 'done'), 'ok');
  console.log(`Private VSCode rendered law names, forall, domains and predicates; extension: ${activated}`);
} finally {
  await browser?.close();
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
  }
  await fs.rm(runtime, {recursive: true, force: true});
}
