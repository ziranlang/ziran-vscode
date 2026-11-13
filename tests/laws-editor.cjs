const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
exports.run = async () => {
  const runtime = process.env.ZIRAN_LAWS_RUNTIME;
  const document = await vscode.workspace.openTextDocument(path.join(runtime, 'laws.zi'));
  await vscode.window.showTextDocument(document);
  if (document.languageId !== 'ziran') throw new Error(`Unexpected language: ${document.languageId}`);
  const extension = vscode.extensions.getExtension('kryonlabs.ziran-language');
  await extension.activate();
  await fs.writeFile(path.join(runtime, 'activated'), extension.extensionPath);
  for (let attempt = 0; attempt < 600; attempt++) {
    try { await fs.access(path.join(runtime, 'done')); return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Law editor verification did not finish');
};
