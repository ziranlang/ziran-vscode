function diagnosticRecords(output) {
  const records = [];
  for (const line of output.split(/\r?\n/)) {
    let item;
    try { item = JSON.parse(line); } catch { continue; }
    if (!item || item.schema_version !== 1 || typeof item.message !== 'string') continue;
    records.push(item);
  }
  return records;
}

function diagnosticRange(vscode, item) {
  const positive = (value) => Number.isInteger(value) && value > 0;
  const line = positive(item.line) ? item.line - 1 : 0;
  const column = positive(item.column) ? item.column - 1 : 0;
  const start = new vscode.Position(line, column);
  const endLine = positive(item.end_line) ? item.end_line - 1 : line;
  const endColumn = positive(item.end_column) ? item.end_column - 1 : column + 1;
  const end = endLine > line || (endLine === line && endColumn > column) ?
    new vscode.Position(endLine, endColumn) : start.translate(0, 1);
  return new vscode.Range(start, end);
}

function diagnosticActions(vscode, document, context) {
  const actions = [];
  for (const diagnostic of context.diagnostics) {
    for (const edit of diagnostic.edits || []) {
      // A saved diagnostic cannot replace a name that the user has edited.
      if (edit.uri.fsPath !== document.uri.fsPath ||
          typeof edit.original !== 'string' ||
          document.getText(edit.range) !== edit.original) continue;
      const action = new vscode.CodeAction(edit.message || `Replace with ${edit.replacement}`,
        vscode.CodeActionKind.QuickFix);
      action.diagnostics = [diagnostic];
      action.edit = new vscode.WorkspaceEdit();
      action.edit.replace(edit.uri, edit.range, edit.replacement);
      actions.push(action);
    }
  }
  return actions;
}

module.exports = { diagnosticRecords, diagnosticRange, diagnosticActions };
