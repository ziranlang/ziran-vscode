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
