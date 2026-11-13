const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
exports.run = async () => {
  const root = process.env.ZIRAN_PREVIEW_PROJECT;
  const document = await vscode.workspace.openTextDocument(path.join(root, process.env.ZIRAN_PREVIEW_ENTRY || 'button.zi'));
  await vscode.window.showTextDocument(document);
  const extension = vscode.extensions.getExtension('kryonlabs.ziran-language');
  await extension.activate();
  if (!extension.isActive) throw new Error('Ziran extension did not activate');
  if (process.env.ZIRAN_PREVIEW_PROFILE) await vscode.workspace.getConfiguration('ziran').update('previewProfile', process.env.ZIRAN_PREVIEW_PROFILE, vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand(process.env.ZIRAN_RUN_TEST ? 'ziran.run' : 'kryon.preview');
  await fs.writeFile(path.join(process.env.ZIRAN_PREVIEW_RUNTIME, 'activated'), extension.extensionPath);
  for (let attempt = 0; attempt < 9000; attempt++) {
    try { await fs.access(path.join(process.env.ZIRAN_PREVIEW_RUNTIME, 'done')); return; } catch {}
    // Focus another file; the Run pane follows the focused .zi file.
    const openPath = path.join(process.env.ZIRAN_PREVIEW_RUNTIME, 'open');
    try {
      const other = await vscode.workspace.openTextDocument((await fs.readFile(openPath, 'utf8')).trim());
      await vscode.window.showTextDocument(other);
      await fs.unlink(openPath);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const editPath = path.join(process.env.ZIRAN_PREVIEW_RUNTIME, 'edit');
    try {
      const source = await fs.readFile(editPath, 'utf8');
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), source);
      await vscode.workspace.applyEdit(edit);
      await document.save();
      await fs.unlink(editPath);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Preview browser verification did not finish');
};
