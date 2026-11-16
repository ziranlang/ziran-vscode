import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { mainLine, runHtml, runSteps, versionMismatchProblem, workDirectoryFor } = require('../run.cjs');
const { HEX_VIEW_SOURCE, HIGHLIGHT_SOURCE, TargetInspector } = require('../inspector.cjs');
const { binaryRegions } = require('../binary-layout.cjs');
const put = (data, values) => { for (const [method, offset, value] of values) data[method](value, offset); return data; };
function elf64(main = true, mainName = 'main') {
  const data = Buffer.alloc(0x500); Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(data);
  put(data, [['writeUInt16LE', 16, 2], ['writeUInt16LE', 18, 0x3e], ['writeUInt32LE', 20, 1],
    ['writeBigUInt64LE', 24, 0x401000n], ['writeBigUInt64LE', 32, 0n], ['writeBigUInt64LE', 40, 0x300n],
    ['writeUInt16LE', 52, 64], ['writeUInt16LE', 54, 56], ['writeUInt16LE', 58, 64],
    ['writeUInt16LE', 60, 5], ['writeUInt16LE', 62, 1]]);
  Buffer.from('\0.shstrtab\0.strtab\0.symtab\0.text\0').copy(data, 0x200);
  const symbolName = main ? mainName : 'other';
  Buffer.from(`\0${symbolName}\0`).copy(data, 0x240);
  for (const [offset, name, type, fileOffset, size] of [[0x340, 1, 3, 0x200n, 33n],
    [0x380, 11, 3, 0x240n, BigInt(Buffer.byteLength(symbolName) + 2)], [0x3c0, 19, 2, 0x280n, 48n]])
    put(data, [['writeUInt32LE', offset, name], ['writeUInt32LE', offset + 4, type],
      ['writeBigUInt64LE', offset + 24, fileOffset], ['writeBigUInt64LE', offset + 32, size]]);
  put(data, [['writeUInt32LE', 0x3e8, 2], ['writeBigUInt64LE', 0x3f8, 24n],
    ['writeUInt32LE', 0x298, 1], ['writeUInt16LE', 0x29e, 4],
    ['writeBigUInt64LE', 0x2a0, 0x401010n], ['writeBigUInt64LE', 0x2a8, 16n],
    ['writeUInt32LE', 0x400, 27], ['writeUInt32LE', 0x404, 1], ['writeBigUInt64LE', 0x408, 6n],
    ['writeBigUInt64LE', 0x410, 0x401000n], ['writeBigUInt64LE', 0x418, 0x180n], ['writeBigUInt64LE', 0x420, 64n]]);
  data[0x29c] = 0x12; return data;
}
function elf64Entry() {
  const data = Buffer.alloc(0x200); Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(data);
  return put(data, [['writeUInt16LE', 16, 2], ['writeUInt16LE', 18, 0x3e], ['writeUInt32LE', 20, 1],
    ['writeBigUInt64LE', 24, 0x401020n], ['writeBigUInt64LE', 32, 64n], ['writeUInt16LE', 52, 64],
    ['writeUInt16LE', 54, 56], ['writeUInt16LE', 56, 1], ['writeUInt32LE', 64, 1],
    ['writeUInt32LE', 68, 5], ['writeBigUInt64LE', 72, 0x100n], ['writeBigUInt64LE', 80, 0x401000n],
    ['writeBigUInt64LE', 88, 0x401000n], ['writeBigUInt64LE', 96, 0x80n],
    ['writeBigUInt64LE', 104, 0x80n], ['writeBigUInt64LE', 112, 0x1000n]]);
}
function elf32Entry() {
  const data = Buffer.alloc(0x100); Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 1]).copy(data);
  return put(data, [['writeUInt16BE', 16, 2], ['writeUInt16BE', 18, 3], ['writeUInt32BE', 20, 1],
    ['writeUInt32BE', 24, 0x1010], ['writeUInt32BE', 28, 52], ['writeUInt16BE', 40, 52],
    ['writeUInt16BE', 42, 32], ['writeUInt16BE', 44, 1], ['writeUInt16BE', 46, 40],
    ['writeUInt32BE', 52, 1], ['writeUInt32BE', 56, 0x80], ['writeUInt32BE', 60, 0x1000],
    ['writeUInt32BE', 64, 0x1000], ['writeUInt32BE', 68, 0x40], ['writeUInt32BE', 72, 0x40],
    ['writeUInt32BE', 76, 5], ['writeUInt32BE', 80, 0x10]]);
}
function zx() {
  const data = Buffer.alloc(300); Buffer.from([0x5a, 0x58, 0, 0]).copy(data);
  put(data, [['writeUInt32LE', 4, 28], ['writeUInt32LE', 8, 64], ['writeUInt32LE', 12, 32],
    ['writeBigUInt64LE', 16, 1n], ['writeUInt32LE', 32, 3], ['writeBigUInt64LE', 40, 300n],
    ['writeBigUInt64LE', 48, 64n], ['writeUInt32LE', 56, 1]]);
  for (const [index, kind, offset, length] of [[0, 1, 160, 128], [1, 2, 288, 8], [2, 3, 296, 4]])
    put(data, [['writeUInt32LE', 64 + index * 32, kind], ['writeUInt32LE', 68 + index * 32, 1],
      ['writeBigUInt64LE', 72 + index * 32, BigInt(offset)], ['writeBigUInt64LE', 80 + index * 32, BigInt(length)],
      ['writeUInt32LE', 88 + index * 32, 8]]);
  data[288] = 3; return data;
}
const parts = (input) => binaryRegions(input)?.regions.map(({ start, end, kind, label }) => [label, kind, start, end]);
test('binary regions cover each file and mark the program\'s code and data', () => {
  assert.deepEqual(parts(elf64()), [['ELF header', 'header', 0, 64], ['padding', 'padding', 64, 0x180],
    ['.text', 'code', 0x180, 0x1c0], ['padding', 'padding', 0x1c0, 0x200], ['.shstrtab', 'header', 0x200, 0x221],
    ['padding', 'padding', 0x221, 0x240], ['.strtab', 'header', 0x240, 0x246], ['padding', 'padding', 0x246, 0x280],
    ['.symtab', 'header', 0x280, 0x2b0], ['padding', 'padding', 0x2b0, 0x300],
    ['section headers (5)', 'header', 0x300, 0x440], ['padding', 'padding', 0x440, 0x500]]);
  assert.equal(binaryRegions(elf64()).filterLabel, 'Hide ELF parts');
  // Without sections, each loadable segment outside the headers is code or data.
  assert.deepEqual(parts(elf64Entry()), [['ELF header', 'header', 0, 64], ['program headers (1)', 'header', 64, 120],
    ['padding', 'padding', 120, 0x100], ['segment 0 (R E)', 'code', 0x100, 0x180], ['padding', 'padding', 0x180, 0x200]]);
  assert.deepEqual(parts(elf32Entry()), [['ELF header', 'header', 0, 52], ['program headers (1)', 'header', 52, 84],
    ['padding', 'padding', 84, 0x80], ['segment 0 (R E)', 'code', 0x80, 0xc0], ['padding', 'padding', 0xc0, 0x100]]);
  const wasm = Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 1, 0x60, 10, 4, 1, 2, 0, 0]);
  assert.deepEqual(parts(wasm), [['Wasm header', 'header', 0, 8], ['type section', 'header', 8, 11],
    ['code section', 'code', 11, 17]]);
  assert.deepEqual(parts(zx()), [['ZX header', 'header', 0, 64], ['section table (3)', 'header', 64, 160],
    ['section 1', 'header', 160, 288], ['program section', 'code', 288, 296], ['section 3', 'header', 296, 300]]);
  const malformedElf = elf64(); malformedElf.writeBigUInt64LE(0x100000n, 40);
  for (const input of [Buffer.from('unknown!'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]),
    malformedElf, Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 10, 127])])
    assert.equal(binaryRegions(input), null);
});
test('the hex view shows every region with its label, or only the program', () => {
  const hex = {}; vm.runInNewContext(`${HEX_VIEW_SOURCE}\nObject.assign(this, { hexFilterable, hexLayout, hexRowAt, hexRowOf, hexLabel });`, hex);
  const { regions } = binaryRegions(elf64Entry());
  const full = hex.hexLayout(regions, 0x200, false);
  // A label row, then the region's rows of sixteen bytes at their real offsets.
  const plain = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(full.blocks.map((block) => [block.region.label, block.row, block.first, block.count])),
    [['ELF header', 0, 0, 4], ['program headers (1)', 5, 4, 4], ['padding', 10, 7, 9],
      ['segment 0 (R E)', 20, 16, 8], ['padding', 29, 24, 8]]);
  assert.equal(full.rows, 38);
  assert.equal(hex.hexRowAt(full, 0).line, -1);
  assert.equal(hex.hexLabel(hex.hexRowAt(full, 20).block.region), '── segment 0 (R E) · 0x100–0x180 · 128 bytes');
  assert.equal(hex.hexRowOf(full, 0x40), 6);
  const program = hex.hexLayout(regions, 0x200, true);
  assert.deepEqual(plain(program.blocks.map((block) => block.region.label)), ['segment 0 (R E)']);
  assert.equal(program.rows, 9);
  assert.equal(hex.hexRowOf(program, 0x110), 2);
  assert.equal(hex.hexRowOf(program, 0x10), -1, 'the ELF header is hidden');
  assert.equal(hex.hexFilterable(regions), true);
  assert.equal(hex.hexFilterable(null), false);
  // A file of unknown format is one unlabelled run of rows.
  const unknown = hex.hexLayout(null, 40, true);
  assert.equal(unknown.rows, 3); assert.equal(hex.hexRowAt(unknown, 0).line, 0);
});
test('run commands, webview navigation and generated-code highlighting stay valid', () => {
  const work = workDirectoryFor('/notes/hello.zi', '/extension-storage/run/owned');
  assert.match(work, /^\/extension-storage\/run\/owned\/[0-9a-f]{16}$/);
  assert.equal(workDirectoryFor('/notes/hello.zi', '/extension-storage/run/owned'), work);
  assert.notEqual(workDirectoryFor('/notes/other.zi', '/extension-storage/run/owned'), work);
  assert.equal(mainLine('// hello\nmain :: () {\n}\n'), 1);
  for (const source of ['Answer :: () -> s32 { return 42 }\n', '  main :: () {}\n']) assert.equal(mainLine(source), -1);
  assert.deepEqual(runSteps('ziran', '/notes/hello.zi', ['/std'], '/tmp/hello.zx'), [
    { command: 'ziran', args: ['bundle', '--root', '/notes', '--module-path', '/std', '--entry', 'hello:main', '-o', '/tmp/hello.zx', '/notes/hello.zi'] },
    { command: 'ziran', args: ['run', '/tmp/hello.zx'] },
  ]);
  // A project bundle runs on the pinned toolchain that wrote it.
  assert.deepEqual(runSteps('ziran', '/app/src/hello.zi', [], '/tmp/hello.zx', true)[1],
    { command: 'ziran', args: ['run', '--project', '/tmp/hello.zx'] });
  const html = runHtml('nonce');
  for (const pattern of [/class="window"/, /id="views" role="tablist"/, /id="hex-scroll"/, /box\.id = 'program-only'/])
    assert.match(html, pattern);
  // No ZIR tab, no view descriptions and no separate header toggle.
  for (const removed of [/'ZIR'|irModules|irError/, /caption/, /hex-headers|Show full file|hex-code/])
    assert.doesNotMatch(html, removed);
  // Dependency files sit in their own picker, and a failure reads as one line
  // with the tool's full output collapsed beneath it.
  for (const pattern of [/'dependency-files'/, /'own-files'/, /← Own code/, /id="problem-details" hidden/])
    assert.match(html, pattern);
  assert.doesNotThrow(() => new vm.Script(html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1]));
  const syntax = {}; vm.runInNewContext(`${HIGHLIGHT_SOURCE}\nthis.highlight=highlight;this.languageOf=languageOf;`, syntax);
  const highlighted = syntax.highlight('int32_t main(void) { return 42; } // done <x>\n#include "a.h"', 'c');
  for (const pattern of [/tok-type">int32_t/, /tok-function">main/, /tok-keyword">return/, /tok-number">42/,
    /tok-comment">\/\/ done &lt;x&gt;/, /tok-directive">#include/]) assert.match(highlighted, pattern);
  assert.match(syntax.highlight('pub fn main() { let s = "x"; }', 'rust'), /tok-string">"x"/);
  assert.match(syntax.highlight('%2 call type=void', 'zir'), /tok-number">%2/);
  assert.match(syntax.highlight('def main():  # start\n return "x"', 'py'), /tok-comment"># start/);
  assert.equal(syntax.highlight('<b>', ''), '&lt;b&gt;');
  assert.deepEqual(['src/main.rs', 'out/__init__.py', 'hello.hpp'].map(syntax.languageOf), ['rust', 'py', 'cpp']);
});

test('ZIR version failures identify the selected compiler tools', () => {
  const message = versionMismatchProblem('unsupported ZIR version 64\ninvalid embedded ZIR',
    '/checkout/build/bin/ziran', '/home/wao/.local/bin/zi2zx');
  assert.match(message, /unsupported ZIR version 64/);
  assert.match(message, /Toolchain paths:\n  ziran: \/checkout\/build\/bin\/ziran\n  zi2zx: \/home\/wao\/\.local\/bin\/zi2zx$/);
  assert.equal(versionMismatchProblem('syntax error', '/ziran', '/zi2zx'), 'syntax error');
  assert.match(versionMismatchProblem('invalid embedded ZIR', '/ziran', null), /zi2zx: not found$/);
});

test('dependency files reach the webview as keys and load only when asked', async () => {
  const { KRYON_PROGRAM_NOTICE } = require('../run.cjs');
  assert.doesNotMatch(KRYON_PROGRAM_NOTICE, /New Window/);
  const posted = [];
  const inspector = new TargetInspector({ vscode: {}, state: {}, post: () => {},
    send: (message) => posted.push(message), storage: '/extension-storage', rerun: () => {} });
  inspector.beginRegistration();
  let loads = 0;
  const result = await inspector.registerResult({ id: 'c', views: [{ id: 'generated', files: [
    { name: 'window.c', text: 'own' },
    { name: 'app.c', dependency: true, size: 3, load: async () => { loads++; return 'dep'; } }] }] });
  const [own, dependency] = result.views[0].files;
  assert.equal(own.text, 'own');
  assert.equal(dependency.load, undefined);
  assert.equal(dependency.text, undefined);
  assert.equal(dependency.lazy, '1:c:generated:app.c');
  assert.equal(inspector.state.generation, 1);
  assert.equal(loads, 0);
  assert.doesNotThrow(() => JSON.stringify(result));
  assert.equal(await inspector.message({ type: 'text', key: dependency.lazy }), true);
  assert.deepEqual(posted, [{ type: 'text', key: '1:c:generated:app.c', text: 'dep' }]);
  assert.equal(loads, 1);
  await inspector.message({ type: 'text', key: 'stale' });
  assert.match(posted[1].text, /earlier build/);
  assert.equal(await inspector.message({ type: 'run' }), false);
});
