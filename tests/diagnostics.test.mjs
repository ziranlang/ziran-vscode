import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { diagnosticRecords, diagnosticRange, diagnosticActions } = require('../diagnostics.cjs');

const vscode = {
  Position: class {
    constructor(line, character) { this.line = line; this.character = character; }
    translate(line, character) { return new this.constructor(this.line + line, this.character + character); }
  },
  Range: class { constructor(start, end) { this.start = start; this.end = end; } },
  CodeActionKind: { QuickFix: 'quickfix' },
  CodeAction: class { constructor(title, kind) { this.title = title; this.kind = kind; } },
  WorkspaceEdit: class {
    replace(uri, range, replacement) { this.replacement = { uri, range, replacement }; }
  },
};

test('diagnostic stream rejects unsupported schemas and retains structured metadata', () => {
  const record = { schema_version: 1, message: 'type mismatch', expected_type: 's32',
    actual_type: 'string', related: [{ path: 'library.zi', line: 4, message: 'Declared here' }] };
  assert.deepEqual(diagnosticRecords([
    'ordinary tool output', JSON.stringify(record),
    JSON.stringify({ ...record, schema_version: 99 }), 'null', '{}',
  ].join('\n')), [record]);
});

test('missing and reversed source ranges become a visible one-character range', () => {
  for (const item of [{ line: 2, column: 3 },
    { line: 2, column: 3, end_line: 1, end_column: 1 }]) {
    const range = diagnosticRange(vscode, item);
    assert.deepEqual([range.start.line, range.start.character, range.end.line, range.end.character],
      [1, 2, 1, 3]);
  }
});

test('quick fix changes only the original name in the current document', () => {
  const uri = { fsPath: '/project/main.zi' };
  const range = diagnosticRange(vscode, { line: 4, column: 1, end_line: 4, end_column: 7 });
  const diagnostic = { edits: [{ uri, range, original: 'Comptue', replacement: 'Compute' }] };
  const document = { uri, getText: () => 'Comptue' };
  const actions = diagnosticActions(vscode, document, { diagnostics: [diagnostic] });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].edit.replacement.replacement, 'Compute');
  document.getText = () => 'NewName';
  assert.deepEqual(diagnosticActions(vscode, document, { diagnostics: [diagnostic] }), []);
  document.getText = () => 'Comptue';
  document.uri = { fsPath: '/project/other.zi' };
  assert.deepEqual(diagnosticActions(vscode, document, { diagnostics: [diagnostic] }), []);
});
