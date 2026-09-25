const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { importAt, moduleIds, resolveModule } = require('./module-index.cjs');
const { activatePreview } = require('./preview.cjs');
const { activateZirEditor } = require('./zir-editor.cjs');

async function collect(directory, files) {
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    if (entry.isDirectory() && !['.git', 'build', 'dist', 'node_modules'].includes(entry.name)) {
      await collect(path.join(directory, entry.name), files);
    } else if (entry.isFile() && /\.(zi|zir)$/.test(entry.name)) {
      files.add(path.join(directory, entry.name));
    }
  }
}

function moduleDirectories() {
  const folders = vscode.workspace.workspaceFolders || [];
  const roots = folders.map((folder) => folder.uri.fsPath);
  const configured = vscode.workspace.getConfiguration('ziran').get('modulePaths', []);
  const paths = [];
  for (const folder of folders) {
    paths.push(path.resolve(folder.uri.fsPath, 'std'));
    paths.push(path.resolve(folder.uri.fsPath, '..', 'ziran', 'std'));
    for (const entry of configured) {
      paths.push(path.resolve(folder.uri.fsPath, entry));
    }
  }
  for (const entry of configured) {
    if (path.isAbsolute(entry)) paths.push(entry);
  }
  return { roots, paths: [...new Set(paths)] };
}

function activate(context) {
  activatePreview(context, vscode);
  activateZirEditor(context, vscode);
  let cache;
  const invalidate = () => { cache = undefined; };
  const index = () => {
    if (!cache) cache = (async () => {
      const { roots, paths } = moduleDirectories();
      const found = await vscode.workspace.findFiles('**/*.{zi,zir}',
        '**/{.git,build,dist,node_modules}/**');
      const files = new Set(found.map((uri) => uri.fsPath));
      for (const directory of paths) await collect(directory, files);
      return { files: [...files], roots, paths };
    })();
    return cache;
  };

  context.subscriptions.push(vscode.languages.registerCompletionItemProvider('ziran', {
    async provideCompletionItems(document, position) {
      const imported = importAt(document.lineAt(position.line).text, position.character);
      if (!imported || imported.target.includes('.')) return [];
      const { files, roots, paths } = await index();
      return moduleIds(files, [...roots, ...paths]).map((id) => {
        const item = new vscode.CompletionItem(id, vscode.CompletionItemKind.Module);
        item.range = new vscode.Range(position.line, imported.start,
          position.line, imported.end);
        const matches = resolveModule(files, id, document.uri.fsPath, roots, paths);
        if (matches.length) item.detail = matches[0];
        return item;
      });
    },
  }, '"', '/'));

  context.subscriptions.push(vscode.languages.registerDefinitionProvider('ziran', {
    async provideDefinition(document, position) {
      const imported = importAt(document.lineAt(position.line).text, position.character);
      if (!imported) return null;
      const { files, roots, paths } = await index();
      const matches = resolveModule(files, imported.target,
        document.uri.fsPath, roots, paths);
      return matches.map((file) => new vscode.Location(vscode.Uri.file(file),
        new vscode.Position(0, 0)));
    },
  }));

  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{zi,zir}');
  context.subscriptions.push(watcher, watcher.onDidCreate(invalidate),
    watcher.onDidDelete(invalidate), watcher.onDidChange(invalidate),
    vscode.workspace.onDidChangeWorkspaceFolders(invalidate),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('ziran.modulePaths')) invalidate();
    }));
}

module.exports = { activate };
