const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { projectRoot } = require('./preview.cjs');
const { modulePaths, ziranCommand } = require('./targets.cjs');

// The line of the file's `main :: (` declaration, or -1.
function mainLine(source) {
  const lines = source.split(/\r?\n/);
  return lines.findIndex((line) => /^main\s*::\s*\(/.test(line));
}

function quote(text) {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

// Bundle the file's `main` and run it on the portable runtime, as
// `ziran bundle --root . --entry hello:main` then `ziran run`.
function runCommandLine(command, file, paths) {
  const module = path.basename(file, '.zi');
  const bundle = path.join(os.tmpdir(), 'ziran-run-' +
    createHash('sha256').update(file).digest('hex').slice(0, 16) + '.zib');
  const bundleArgs = ['bundle', '--root', path.dirname(file)];
  for (const entry of paths) bundleArgs.push('--module-path', entry);
  bundleArgs.push('--entry', `${module}:main`, '-o', bundle, file);
  return [command, ...bundleArgs].map(quote).join(' ') + ' && ' +
    [command, 'run', bundle].map(quote).join(' ');
}

function activateRun(context, vscode) {
  let terminal;
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((closed) => { if (closed === terminal) terminal = undefined; }),
    vscode.commands.registerCommand('ziran.run', async (uri) => {
      const document = uri ? await vscode.workspace.openTextDocument(uri) :
        vscode.window.activeTextEditor?.document;
      if (!document || !document.uri.fsPath.endsWith('.zi')) {
        vscode.window.showErrorMessage('Open a .zi file to run it.');
        return;
      }
      if (mainLine(document.getText()) < 0) {
        vscode.window.showErrorMessage(`${path.basename(document.uri.fsPath)} has no main :: () procedure to run.`);
        return;
      }
      if (document.isDirty) await document.save();
      const file = document.uri.fsPath;
      const command = await ziranCommand(file, vscode);
      const paths = await modulePaths(file, command, vscode);
      if (!terminal) terminal = vscode.window.createTerminal({ name: 'Ziran' });
      terminal.show(true);
      terminal.sendText(`cd ${quote(path.dirname(file))} && ${runCommandLine(command, file, paths)}`);
    }),
    vscode.languages.registerCodeLensProvider({ language: 'ziran', scheme: 'file' }, {
      async provideCodeLenses(document) {
        const line = mainLine(document.getText());
        if (line < 0 || await projectRoot(document.uri.fsPath)) return [];
        return [new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
          title: '▶ Run', command: 'ziran.run', arguments: [document.uri],
        })];
      },
    }),
  );
}

module.exports = { activateRun, mainLine, runCommandLine };
