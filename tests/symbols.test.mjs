import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { apiSymbols, docComment, findSymbol, nameAt } = require('../symbols.cjs');

const api = JSON.stringify({
  schema_version: 1,
  modules: [
    {
      name: 'app', source: 'app.zi', imports: [], globals: [],
      constants: [{ name: 'Limit', value: '10', path: 'app.zi', line: 1 }],
      types: [{ name: 'Point', body: 'x: s32\ny: s32\n', type_parameters: '',
        record_template: false, enum: false, procedure: false, path: 'app.zi', line: 2 }],
      functions: [{ name: 'Area', parameters: 'w:s32,h: s32', return_type: 's32',
        path: 'app.zi', line: 5 },
      { name: 'Show', parameters: '', return_type: 'void', path: 'app.zi', line: 8 }],
    },
    {
      name: 'shapes', source: 'shapes.zi', imports: [], constants: [], types: [],
      globals: [{ name: 'count', type: 's64', path: 'shapes.zi', line: 3 }],
      functions: [{ name: 'Area', parameters: 'side: s32', return_type: 's32',
        path: 'shapes.zi', line: 7 }],
    },
  ],
});

test('api output lists every declaration with its signature and place', () => {
  const symbols = apiSymbols(api);
  assert.deepEqual(symbols.map((symbol) => [symbol.kind, symbol.detail, symbol.path, symbol.line]), [
    ['function', 'Area :: (w: s32, h: s32) -> s32', 'app.zi', 5],
    ['function', 'Show :: ()', 'app.zi', 8],
    ['type', 'Point :: struct { x: s32; y: s32; }', 'app.zi', 2],
    ['constant', 'Limit :: 10', 'app.zi', 1],
    ['function', 'Area :: (side: s32) -> s32', 'shapes.zi', 7],
    ['global', 'count: s64', 'shapes.zi', 3],
  ]);
  assert.deepEqual(apiSymbols('not json'), []);
});

test('a name prefers the file\'s own module', () => {
  const symbols = apiSymbols(api);
  assert.equal(findSymbol(symbols, 'Area', 'app').path, 'app.zi');
  assert.equal(findSymbol(symbols, 'Area', 'shapes').path, 'shapes.zi');
  assert.equal(findSymbol(symbols, 'count', 'app').module, 'shapes');
  assert.equal(findSymbol(symbols, 'Missing', 'app'), null);
});

test('the name under the cursor, with the alias it is read through', () => {
  assert.deepEqual(nameAt('    total := Shapes.Area(3)', 22),
    { name: 'Area', qualifier: 'Shapes', start: 20, end: 24 });
  assert.equal(nameAt('x := 42', 6), null);
  assert.equal(nameAt('a + b', 2), null);
  assert.equal(nameAt('Area(1)', 0).name, 'Area');
});

test('the comment above a declaration documents it', () => {
  const lines = [
    '// Module summary.',
    '',
    '// Area of a rectangle,',
    '// in square units.',
    '#program_export',
    'Area :: (w: s32, h: s32) -> s32 { return w * h }',
    'Plain :: () {}',
  ];
  assert.equal(docComment(lines, 6), 'Area of a rectangle,\nin square units.');
  assert.equal(docComment(lines, 7), '');
  assert.equal(docComment(['// Only the module comment.', 'First :: () {}'], 2), '');
});
