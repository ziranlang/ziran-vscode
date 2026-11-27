const { createHash } = require('node:crypto');

function diagnosticRecords(output) {
  const records = [];
  for (const line of output.split(/\r?\n/)) {
    let item;
    try { item = JSON.parse(line); } catch { continue; }
    if (!item || item.schema_version !== 2 || typeof item.message !== 'string') continue;
    records.push(item);
  }
  return records;
}

function diagnosticRange(vscode, item, source = null) {
  const positive = (value) => Number.isInteger(value) && value > 0;
  const line = positive(item.line) ? item.line - 1 : 0;
  // Compiler columns are UTF-8 bytes; editor columns are UTF-16 code units.
  const lines = source === null ? null : source.split(/\r\n|\r|\n/);
  const columnAt = (line, column) => lines ? Buffer.from(lines[line] || '', 'utf8').subarray(0, column).toString('utf8').length : column;
  const column = columnAt(line, positive(item.column) ? item.column - 1 : 0);
  const start = new vscode.Position(line, column);
  const endLine = positive(item.end_line) ? item.end_line - 1 : line;
  const endColumn = positive(item.end_column) ? columnAt(endLine, item.end_column - 1) : column + 1;
  const end = endLine > line || (endLine === line && endColumn > column) ?
    new vscode.Position(endLine, endColumn) : start.translate(0, 1);
  return new vscode.Range(start, end);
}

function diagnosticActions(vscode, document, context) {
  const actions = [];
  for (const diagnostic of context.diagnostics) {
    for (const alternative of diagnostic.alternatives || []) {
      const edits = alternative.edits || [];
      if (!edits.length) continue;
      const hash = createHash('sha256').update(document.getText(), 'utf8').digest('hex');
      // Current compiler repairs are local exact replacements. Offer a repair
      // only while its entire saved document and every preimage still match.
      if (!edits.every(edit => edit.uri.fsPath === document.uri.fsPath &&
          edit.document_sha256 === hash && typeof edit.original === 'string' &&
          document.getText(edit.range) === edit.original)) continue;
      const action = new vscode.CodeAction(alternative.message || 'Apply Ziran repair',
        vscode.CodeActionKind.QuickFix);
      action.diagnostics = [diagnostic];
      action.edit = new vscode.WorkspaceEdit();
      for (const edit of edits) action.edit.replace(edit.uri, edit.range, edit.replacement);
      actions.push(action);
    }
  }
  return actions;
}

module.exports = { diagnosticRecords, diagnosticRange, diagnosticActions };
