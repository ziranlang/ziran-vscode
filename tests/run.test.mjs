import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { HEX_VIEW_SOURCE, HIGHLIGHT_SOURCE, binaryContentStart, elfCodeStart, mainLine, runHtml,
  runSteps, versionMismatchProblem, workDirectoryFor } = require('../run.cjs');
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
test('binary views start at executable content and reject malformed inputs', () => {
  const wasm = Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 1, 0x60, 10, 4, 1, 2, 0, 0]);
  for (const [name, input, expected] of [
    ['ELF main', elf64(), { offset: 0x190, label: 'main at 0x190 (.text)', toggleLabel: 'Show ELF headers' }],
    ['Ziran main', elf64(true, 'hello:main'), { offset: 0x190, label: 'hello:main at 0x190 (.text)', toggleLabel: 'Show ELF headers' }],
    ['stripped ELF', elf64(false), { offset: 0x180, label: 'code starts at 0x180 (.text)', toggleLabel: 'Show ELF headers' }],
    ['ELF64 entry', elf64Entry(), { offset: 0x100, label: 'code starts at 0x100 (entry segment)', toggleLabel: 'Show ELF headers' }],
    ['ELF32 big endian', elf32Entry(), { offset: 0x80, label: 'code starts at 0x80 (entry segment)', toggleLabel: 'Show ELF headers' }],
    ['Wasm', wasm, { offset: 13, label: 'code starts at 0xd (Wasm code section)', toggleLabel: 'Show full file' }],
    ['ZX', zx(), { offset: 288, label: 'instructions start at 0x120 (ZX program section)', toggleLabel: 'Show full file' }],
  ]) assert.deepEqual(binaryContentStart(input), expected, name);
  const malformedElf = elf64(); malformedElf.writeBigUInt64LE(0x100000n, 40);
  for (const input of [Buffer.from('unknown'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]),
    malformedElf, Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 10, 127])])
    assert.equal(binaryContentStart(input), null);
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
  const hex = {}; vm.runInNewContext(`${HEX_VIEW_SOURCE}\nthis.hexWindow = hexWindow;`, hex);
  assert.equal(hex.hexWindow(0x1040, false).start, 0x1040);
  const revealed = hex.hexWindow(0x1040, false, 0x40);
  assert.equal(revealed.start, 0); assert.equal(revealed.showFullFile, true);
  const html = runHtml('nonce');
  for (const pattern of [/class="window"/, /label: 'ZIR'/, /id="views" role="tablist"/, /id="hex-scroll"/, /Show full file/]) assert.match(html, pattern);
  assert.doesNotMatch(html, /label: 'ZX'|id="ir-section"/);
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
