import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { highlightZiran, highlightedFile } = require('../highlight.cjs');
const { HIGHLIGHT_SOURCE, TargetInspector } = require('../inspector.cjs');
const hello = path.resolve('../../kryonlabs/kryon/examples/hello.zi');
const spans = (html, name) => [...html.matchAll(new RegExp(`<span class="tok-${name}">([^<]*)</span>`, 'g'))].map(match => match[1]);

test('Ziran source is colored from the extension grammar: keywords, strings and comments', async () => {
  const html = await highlightZiran('// greet\nmain :: () -> s32 {\n    name := "a<b"\n    return 1\n}\n/* block\n   comment */\n');
  assert.deepEqual(spans(html, 'comment'), ['// greet', '/* block', '   comment */']);
  assert.ok(spans(html, 'keyword').includes('return'));
  assert.ok(spans(html, 'type').includes('s32'));
  assert.ok(spans(html, 'string').join('').includes('a&lt;b'));
  assert.ok(spans(html, 'function').includes('main'));
  assert.ok(spans(html, 'number').includes('1'));
  assert.equal(html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'),
    '// greet\nmain :: () -> s32 {\n    name := "a<b"\n    return 1\n}\n/* block\n   comment */\n', 'no text is lost');
});

test('the Source view of hello.zi carries token classes', { skip: !existsSync(hello) }, async () => {
  const text = await fs.readFile(hello, 'utf8');
  const inspector = Object.create(TargetInspector.prototype);
  Object.assign(inspector, { generation: 1, binaries: new Map(), texts: new Map() });
  const result = await inspector.registerResult({ id: 'c', views: [{ id: 'source', files: [{ name: 'hello.zi', text }] }] });
  const html = result.views[0].files[0].html;
  assert.ok(spans(html, 'string').length > 0, 'strings');
  assert.ok(spans(html, 'keyword').length > 0 || spans(html, 'type').length > 0, 'keywords');
  assert.ok(spans(html, 'directive').length > 0 || spans(html, 'function').length > 0);
  // Other files and oversized files are left to the page's cheap highlighter.
  assert.equal(await highlightedFile('hello.c', text), null);
  assert.equal(await highlightedFile('hello.zi', 'x'.repeat(400001)), null);
});

test('dependency sources arrive highlighted too', async () => {
  const inspector = Object.create(TargetInspector.prototype);
  const sent = [];
  Object.assign(inspector, { texts: new Map([['k', { name: 'app.zi', load: async () => 'return 1 // done\n' }]]), send: message => sent.push(message) });
  await inspector.sendText({ key: 'k' });
  assert.match(sent[0].html, /tok-keyword">return<\/span>/);
  assert.match(sent[0].html, /tok-comment">\/\/ done<\/span>/);
});

test('generated C, Go, assembly and LIR get light highlighting in the page', () => {
  const context = {}; vm.runInNewContext(`${HIGHLIGHT_SOURCE}; this.api = { highlight, languageOf };`, context);
  const { highlight, languageOf } = context.api;
  assert.match(highlight('return 0; // x\n"s"', languageOf('hello.c')), /tok-keyword">return[\s\S]*tok-comment[\s\S]*tok-string/);
  assert.match(highlight('func main() {}', languageOf('hello.go')), /tok-keyword">func/);
  assert.match(highlight('lir 1 entry', languageOf('lowered.lir')), /<span class="tok-/);
  const asm = highlight('<hello:main>:\n  401000:\t55\tpush %rbp\n  mov $0x10, %rax # c\n', languageOf('final.disasm'));
  assert.match(asm, /tok-function">&lt;hello:main&gt;:/);
  assert.match(asm, /tok-type">%rbp/);
  assert.match(asm, /tok-number">\$0x10/);
  assert.match(asm, /tok-comment"># c/);
  assert.equal(languageOf('hello.s'), 'asm');
});
