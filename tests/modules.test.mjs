import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { importAt, moduleIds, resolveModule } = require('../module-index.cjs');

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
