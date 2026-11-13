import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { importAt, mappedImportIds, moduleIds, parseModuleMap, resolveMapped,
  resolveModule } = require('../module-index.cjs');

test('import recognition accepts extensionless modules and ignores ordinary code', () => {
  assert.deepEqual(importAt('  #import "text_widget"', 13),
    { target: 'text_widget', start: 11, end: 22 });
  assert.equal(importAt('  # explanation', 8), null);
  assert.equal(importAt('  #import "text_widget"', 3), null);
});

test('module discovery uses files rather than a fixed Kryon list', () => {
  const files = ['/work/app/main.zi', '/work/kryon/src/ui/text_widget.zi',
    '/work/ziran/std/math.zi', '/work/app/lib/math.zi'];
  const roots = ['/work/app', '/work/kryon'];
  const paths = ['/work/ziran/std', '/work/kryon/src/ui'];
  assert.ok(moduleIds(files, [...roots, ...paths]).includes('text_widget'));
  assert.ok(moduleIds(files, [...roots, ...paths]).includes('math'));
  assert.deepEqual(resolveModule(files, 'math', '/work/app/lib/main.zi', roots, paths),
    ['/work/app/lib/math.zi', '/work/ziran/std/math.zi']);
  assert.deepEqual(resolveModule(files, 'text_widget', '/work/app/main.zi', roots, paths),
    ['/work/kryon/src/ui/text_widget.zi']);
  assert.deepEqual(resolveModule(files, 'stdio.h', '/work/app/main.zi', roots, paths), []);
});

test('a project module map resolves package-qualified and standard imports', () => {
  const map = parseModuleMap([
    'P\troot\t/work/app',
    'M\troot\tapp\t/work/app/src/app.zi',
    'M\troot\tsession\t/work/app/src/session.zi',
    'P\tp1\t/cache/kryon',
    'M\tp1\tsession\t/cache/kryon/src/ui/session.zi',
    'M\tp1\tWidgets\t/cache/kryon/src/ui/Widgets/module.zi',
    'P\tstd\t/cache/ziran',
    'M\tstd\ttext\t/cache/ziran/std/text.zi',
    'D\troot\tkryon/Widgets\tp1\tWidgets',
    'D\troot\tkryon/session\tp1\tsession',
    'D\troot\tWidgets\tp1\tWidgets',
    'D\tp1\tunused\tp1\tsession',
  ].join('\n'));
  const app = '/work/app/src/app.zi';
  assert.deepEqual(resolveMapped(map, app, 'kryon/Widgets'),
    ['/cache/kryon/src/ui/Widgets/module.zi']);
  assert.deepEqual(resolveMapped(map, app, 'Widgets'),
    ['/cache/kryon/src/ui/Widgets/module.zi']);
  // The package's own module wins the short name; the qualified one reaches Kryon.
  assert.deepEqual(resolveMapped(map, app, 'session'), ['/work/app/src/session.zi']);
  assert.deepEqual(resolveMapped(map, app, 'kryon/session'),
    ['/cache/kryon/src/ui/session.zi']);
  assert.deepEqual(resolveMapped(map, app, 'std/text'), ['/cache/ziran/std/text.zi']);
  assert.deepEqual(resolveMapped(map, app, 'text'), ['/cache/ziran/std/text.zi']);
  assert.deepEqual(resolveMapped(map, app, 'other/Widgets'), []);
  assert.deepEqual(resolveMapped(map, '/elsewhere/x.zi', 'Widgets'), []);
  const ids = mappedImportIds(map, app);
  for (const id of ['kryon/Widgets', 'kryon/session', 'std/text', 'app']) {
    assert.ok(ids.includes(id), id);
  }
});

test('named and using imports are recognized like plain ones', () => {
  assert.deepEqual(importAt('Text :: #import "kryon/text";', 20),
    { target: 'kryon/text', start: 17, end: 27 });
  assert.deepEqual(importAt('using Widgets :: #import "kryon/Widgets";', 30),
    { target: 'kryon/Widgets', start: 26, end: 39 });
  assert.equal(importAt('Text :: Draw("x")', 10), null);
});

test('NAME=DIR paths serve package-qualified imports outside a project', async () => {
  const { packageCandidates, packageModuleIds, moduleSource } = require('../module-index.cjs');
  const paths = ['/std', 'kryon=/work/kryon/src', 'kryon=/work/kryon/src/ui'];
  assert.deepEqual(packageCandidates('kryon/text', paths), [
    '/work/kryon/src/text.zi', '/work/kryon/src/text/module.zi',
    '/work/kryon/src/ui/text.zi', '/work/kryon/src/ui/text/module.zi']);
  assert.deepEqual(packageCandidates('plot/Plot', paths), []);
  assert.deepEqual(packageCandidates('kryon/../secret', paths), []);
  assert.deepEqual(packageModuleIds(['/work/kryon/src/text.zi', '/work/kryon/src/ui/button/module.zi',
    '/work/kryon/src/ui/deep/x/y.zi', '/work/app/main.zi'], paths), ['kryon/button', 'kryon/text']);
  const map = parseModuleMap('P\tp11e2ac7ed9577d35\t/cache/kryon\nM\tp11e2ac7ed9577d35\ttext\t/cache/kryon/src/text.zi\n');
  assert.equal(moduleSource('p11e2ac7ed9577d35_text', map, [], () => false), '/cache/kryon/src/text.zi');
  assert.equal(moduleSource('p59ed40033882ead0_text', null, paths,
    (file) => file === '/work/kryon/src/ui/text.zi'), '/work/kryon/src/ui/text.zi');
  assert.equal(moduleSource('hello', map, paths, () => true), null);
});
