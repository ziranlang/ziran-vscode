const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { importAt, moduleIds, resolveModule } = require('./module-index.cjs');
const { activatePreview, runCommand } = require('./preview.cjs');
const { activateTargets, commandStd, modulePaths, ziranCommand } = require('./targets.cjs');
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

async // A lone file's own directory, without descending into it.
async function collectDirectory(directory, files) {
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    if (entry.isFile() && /\.(zi|zir)$/.test(entry.name)) files.add(path.join(directory, entry.name));
  }
}

async function moduleDirectories(document) {
  const folders = vscode.workspace.workspaceFolders || [];
  const roots = folders.map((folder) => folder.uri.fsPath);
  const inFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!inFolder) roots.push(path.dirname(document.uri.fsPath));
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
  const std = commandStd(await ziranCommand(document.uri.fsPath, vscode));
  if (std) paths.push(std);
  return { roots, paths: [...new Set(paths)] };
}

// `ziran check` on open and save; a single file checks with its own
// directory as root, like `ziran check --root . file.zi`.
async function checkDocument(document, diagnostics) {
  if (document.languageId !== 'ziran' || document.uri.scheme !== 'file') return;
  const file = document.uri.fsPath;
  const command = await ziranCommand(file, vscode);
  const args = ['check', '--diagnostics=json', '--root', path.dirname(file)];
  for (const entry of await modulePaths(file, command, vscode)) args.push('--module-path', entry);
  args.push(file);
  const result = await runCommand(command, args, path.dirname(file));
  if (result.code === null) { diagnostics.delete(document.uri); return; }
  const found = new Map();
  for (const line of `${result.stdout}\n${result.stderr}`.split(/\r?\n/)) {
    let item;
    try { item = JSON.parse(line); } catch { continue; }
    if (!item || typeof item.message !== 'string') continue;
    const target = item.path ? path.resolve(path.dirname(file), item.path) : file;
    const start = new vscode.Position(Math.max(0, (item.line || 1) - 1),
      Math.max(0, (item.column || 1) - 1));
    const end = item.end_line ? new vscode.Position(Math.max(0, item.end_line - 1),
      Math.max(0, item.end_column - 1)) : start.translate(0, 1);
    const diagnostic = new vscode.Diagnostic(new vscode.Range(start, end), item.message,
      item.severity === 'warning' ? vscode.DiagnosticSeverity.Warning :
        vscode.DiagnosticSeverity.Error);
    if (item.code) diagnostic.code = item.code;
    diagnostic.source = 'ziran';
    if (!found.has(target)) found.set(target, []);
    found.get(target).push(diagnostic);
  }
  diagnostics.delete(document.uri);
  for (const [target, list] of found) diagnostics.set(vscode.Uri.file(target), list);
}

function activate(context) {
  activatePreview(context, vscode);
  activateTargets(context, vscode);
  activateZirEditor(context, vscode);
  const diagnostics = vscode.languages.createDiagnosticCollection('ziran');
  context.subscriptions.push(diagnostics,
    vscode.workspace.onDidOpenTextDocument((document) => checkDocument(document, diagnostics)),
    vscode.workspace.onDidSaveTextDocument((document) => checkDocument(document, diagnostics)),
    vscode.workspace.onDidCloseTextDocument((document) => diagnostics.delete(document.uri)));
  for (const document of vscode.workspace.textDocuments) checkDocument(document, diagnostics);
  const caches = new Map();
  const invalidate = () => { caches.clear(); };
  const index = (document) => {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    const key = folder ? '' : path.dirname(document.uri.fsPath);
    if (!caches.has(key)) caches.set(key, (async () => {
      const { roots, paths } = await moduleDirectories(document);
      const found = await vscode.workspace.findFiles('**/*.{zi,zir}',
        '**/{.git,build,dist,node_modules}/**');
      const files = new Set(found.map((uri) => uri.fsPath));
      if (key) await collectDirectory(key, files);
      for (const directory of paths) await collect(directory, files);
      return { files: [...files], roots, paths };
    })());
    return caches.get(key);
  };

  context.subscriptions.push(vscode.languages.registerCompletionItemProvider('ziran', {
    async provideCompletionItems(document, position) {
      const imported = importAt(document.lineAt(position.line).text, position.character);
      if (!imported || imported.target.includes('.')) return [];
      const { files, roots, paths } = await index(document);
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
      const { files, roots, paths } = await index(document);
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
