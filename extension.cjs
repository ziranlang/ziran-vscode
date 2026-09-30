const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { importAt, mappedImportIds, moduleIds, parseModuleMap, resolveMapped,
  resolveModule } = require('./module-index.cjs');
const { activatePreview, runCommand } = require('./preview.cjs');
const { commandStd, modulePaths, packageRoot, ziranCommand } = require('./targets.cjs');
const { activateRun } = require('./run.cjs');
const { activateZirEditor } = require('./zir-editor.cjs');
const { apiSymbols, docComment, findSymbol, nameAt } = require('./symbols.cjs');

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

// A lone file's own directory, without descending into it.
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

// The project's import map, written by `ziran check --project`.
async function projectModuleMap(file) {
  const root = await packageRoot(file);
  if (!root) return null;
  try {
    return parseModuleMap(await fs.readFile(
      path.join(root, 'build', '.ziran', 'module-map.tsv'), 'utf8'));
  } catch { return null; }
}

// A diagnostic names its file relative to the check's root: the file's
// directory for a lone file, the package's first module root (normally
// src) under --project.
async function diagnosticPath(file, project, relative) {
  const bases = [path.dirname(file)];
  if (project) bases.push(path.join(project, 'src'), project);
  for (const base of bases) {
    const candidate = path.resolve(base, relative);
    try { await fs.access(candidate); return candidate; } catch {}
  }
  return path.resolve(path.dirname(file), relative);
}

// `ziran check` on open and save. A file in a Ziran package checks with its
// dependencies, like `ziran check --project file.zi`; a single file checks
// with its own directory as root, like `ziran check --root . file.zi`.
async function checkDocument(document, diagnostics) {
  if (document.languageId !== 'ziran' || document.uri.scheme !== 'file') return;
  const file = document.uri.fsPath;
  const command = await ziranCommand(file, vscode);
  const project = file.endsWith('.zi') ? await packageRoot(file) : null;
  const args = ['check', '--diagnostics=json'];
  if (project) {
    args.push('--project');
  } else {
    args.push('--root', path.dirname(file));
    for (const entry of await modulePaths(file, command, vscode)) args.push('--module-path', entry);
  }
  args.push(file);
  const result = await runCommand(command, args, project || path.dirname(file));
  if (result.code === null) { diagnostics.delete(document.uri); return; }
  const found = new Map();
  for (const line of `${result.stdout}\n${result.stderr}`.split(/\r?\n/)) {
    let item;
    try { item = JSON.parse(line); } catch { continue; }
    if (!item || typeof item.message !== 'string') continue;
    const target = item.path ? await diagnosticPath(file, project, item.path) : file;
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

// The declarations `ziran api` reports for a document's program, with
// absolute paths, and the document's own module; cached per version.
const symbolCache = new Map();
async function programSymbols(document) {
  const key = document.uri.fsPath;
  const cached = symbolCache.get(key);
  if (cached && cached.version === document.version) return cached.result;
  const result = (async () => {
    const file = document.uri.fsPath;
    const command = await ziranCommand(file, vscode);
    const project = file.endsWith('.zi') ? await packageRoot(file) : null;
    const args = ['api', '--json'];
    if (project) {
      args.push('--project');
    } else {
      args.push('--root', path.dirname(file));
      for (const entry of await modulePaths(file, command, vscode)) args.push('--module-path', entry);
    }
    args.push(file);
    const run = await runCommand(command, args, project || path.dirname(file));
    const symbols = apiSymbols(run.stdout || '');
    let own = null;
    for (const symbol of symbols) {
      symbol.file = await diagnosticPath(file, project, symbol.path);
      if (!own && await diagnosticPath(file, project, symbol.source) === file) own = symbol.module;
    }
    return { symbols, own };
  })();
  symbolCache.set(key, { version: document.version, result });
  return result;
}

const COMPLETION_KIND = { function: 'Function', type: 'Struct', constant: 'Constant', global: 'Variable' };

async function symbolAtPosition(document, position) {
  const found = nameAt(document.lineAt(position.line).text, position.character);
  if (!found) return null;
  const { symbols, own } = await programSymbols(document);
  const symbol = findSymbol(symbols, found.name, found.qualifier ? null : own);
  return symbol ? { symbol, found } : null;
}

function activate(context) {
  activatePreview(context, vscode);
  activateRun(context, vscode);
  activateZirEditor(context, vscode);
  const diagnostics = vscode.languages.createDiagnosticCollection('ziran');
  context.subscriptions.push(diagnostics,
    vscode.workspace.onDidOpenTextDocument((document) => checkDocument(document, diagnostics)),
    vscode.workspace.onDidSaveTextDocument((document) => checkDocument(document, diagnostics)),
    vscode.workspace.onDidCloseTextDocument((document) => diagnostics.delete(document.uri)));
  for (const document of vscode.workspace.textDocuments) checkDocument(document, diagnostics);
  const caches = new Map();
  const invalidate = () => { caches.clear(); symbolCache.clear(); };
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
      if (!imported) {
        // Procedures, types, constants, and globals the program declares.
        const { symbols } = await programSymbols(document);
        const seen = new Set();
        return symbols.filter((symbol) => !seen.has(symbol.name) && seen.add(symbol.name))
          .map((symbol) => {
            const item = new vscode.CompletionItem(symbol.name,
              vscode.CompletionItemKind[COMPLETION_KIND[symbol.kind]]);
            item.detail = symbol.detail;
            return item;
          });
      }
      if (imported.target.includes('.')) return [];
      const map = await projectModuleMap(document.uri.fsPath);
      if (map) {
        return mappedImportIds(map, document.uri.fsPath).map((id) => {
          const item = new vscode.CompletionItem(id, vscode.CompletionItemKind.Module);
          item.range = new vscode.Range(position.line, imported.start,
            position.line, imported.end);
          const matches = resolveMapped(map, document.uri.fsPath, id);
          if (matches.length) item.detail = matches[0];
          return item;
        });
      }
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
      if (!imported) {
        const at = await symbolAtPosition(document, position);
        return at ? new vscode.Location(vscode.Uri.file(at.symbol.file),
          new vscode.Position(Math.max(0, at.symbol.line - 1), 0)) : null;
      }
      const map = await projectModuleMap(document.uri.fsPath);
      let matches = map ? resolveMapped(map, document.uri.fsPath, imported.target) : [];
      if (!matches.length) {
        const { files, roots, paths } = await index(document);
        matches = resolveModule(files, imported.target,
          document.uri.fsPath, roots, paths);
      }
      return matches.map((file) => new vscode.Location(vscode.Uri.file(file),
        new vscode.Position(0, 0)));
    },
  }));

  context.subscriptions.push(vscode.languages.registerHoverProvider('ziran', {
    async provideHover(document, position) {
      if (importAt(document.lineAt(position.line).text, position.character)) return null;
      const at = await symbolAtPosition(document, position);
      if (!at) return null;
      const markdown = new vscode.MarkdownString();
      markdown.appendCodeblock(at.symbol.detail, 'ziran');
      try {
        const lines = (await fs.readFile(at.symbol.file, 'utf8')).split(/\r?\n/);
        const comment = docComment(lines, at.symbol.line);
        if (comment) markdown.appendMarkdown(`\n${comment}`);
      } catch {}
      return new vscode.Hover(markdown, new vscode.Range(position.line, at.found.start,
        position.line, at.found.end));
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
