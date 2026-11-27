const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { importAt, mappedImportIds, moduleIds, moduleSource, packageCandidates, packageEntries, sourceStem, tsBindings,
  packageModuleIds, parseModuleMap, resolveMapped, resolveModule } = require('./module-index.cjs');
const { activatePreview, runCommand } = require('./preview.cjs');
const { commandStd, modulePaths, packageModulePaths, packageRoot, ziranCommand } = require('./targets.cjs');
const { activateRun } = require('./run.cjs');
const { activateZirEditor } = require('./zir-editor.cjs');
const { apiImports, apiSymbols, docComment, findSymbol, nameAt, qualifierBefore } = require('./symbols.cjs');
const { diagnosticRecords, diagnosticRange, diagnosticActions } = require('./diagnostics.cjs');

const sourceSelector = ['ziran', 'typescript', 'typescriptreact'].map(language => ({ language, scheme: 'file' }));

// TS/TSX remains VS Code's built-in language. Only a native project opts into
// compiler services; ordinary TypeScript/React workspaces are untouched.
async function nativeDocument(document) {
  if (document.uri.scheme !== 'file') return false;
  if (document.languageId === 'ziran' && document.uri.fsPath.endsWith('.zi')) return true;
  return ['typescript', 'typescriptreact'].includes(document.languageId) &&
    /\.tsx?$/.test(document.uri.fsPath) && Boolean(await packageRoot(document.uri.fsPath));
}

// Only explicit compiler actions refresh the binding consumer. The compiler
// owns this manifest and every declaration; the editor never fabricates types.
async function refreshTypeScriptBindings(document) {
  const project = await packageRoot(document.uri.fsPath);
  if (!project) return;
  try { await fs.access(path.join(project, 'build', '.ziran', 'types', 'manifest.json')); }
  catch { return; }
  const typescript = vscode.extensions.getExtension('vscode.typescript-language-features');
  if (!typescript) throw new Error('The built-in TypeScript language service is unavailable for native bindings.');
  await typescript.activate();
  await vscode.commands.executeCommand('_typescript.configurePlugin', 'ziran-typescript-plugin',
    { project, revision: Date.now() });
}

async function collect(directory, files) {
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    if (entry.isDirectory() && !['.git', 'build', 'dist', 'node_modules', 'backup', 'work', 'vendor'].includes(entry.name)) {
      await collect(path.join(directory, entry.name), files);
    } else if (entry.isFile() && /\.(zi|ts|tsx|zir)$/.test(entry.name)) {
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
    if (entry.isFile() && /\.(zi|ts|tsx|zir)$/.test(entry.name)) files.add(path.join(directory, entry.name));
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
  // `kryon/text` imports of a file outside a project: NAME=DIR paths.
  const packages = await packageRoot(document.uri.fsPath) ? [] :
    await packageModulePaths(document.uri.fsPath, vscode);
  return { roots, paths: [...new Set(paths)], packages };
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
async function diagnosticPath(file, project, relative, extra = []) {
  const bases = [path.dirname(file)];
  if (project) bases.push(path.join(project, 'src'), project);
  bases.push(...extra);
  for (const base of bases) {
    const candidate = path.resolve(base, relative);
    for (const source of [candidate, ...(candidate.endsWith('.zi') ? [candidate.slice(0, -3) + '.ts', candidate.slice(0, -3) + '.tsx'] : [])]) {
      try { await fs.access(source); return source; } catch {}
    }
  }
  return path.resolve(path.dirname(file), relative);
}

// Each open source owns its check's diagnostics, including imported files.
// Replacing one result clears its old errors without erasing another source's.
const checkedDiagnostics = new Map();
const checkVersions = new Map();
function publishDiagnostics(document, found, diagnostics) {
  const key = document.uri.toString();
  const affected = new Set([...(checkedDiagnostics.get(key)?.keys() || []), ...found.keys()]);
  if (found.size) checkedDiagnostics.set(key, found);
  else checkedDiagnostics.delete(key);
  for (const file of affected) {
    const list = [...checkedDiagnostics.values()].flatMap(result => result.get(file) || []);
    diagnostics.set(vscode.Uri.file(file), list);
  }
}

// Only explicit Check, Run and Preview actions call `ziran check`. A file
// in a Ziran package checks with its dependencies, like `ziran check --project file.zi`; a single file checks
// with its own directory as root, like `ziran check --root . file.zi`.
async function sourceRange(file, item) {
  try { return diagnosticRange(vscode, item, await fs.readFile(file, 'utf8')); }
  catch { return diagnosticRange(vscode, item); }
}
async function checkDocument(document, diagnostics) {
  if (!await nativeDocument(document)) return;
  const file = document.uri.fsPath;
  const version = document.version;
  const generation = (checkVersions.get(file) || 0) + 1;
  checkVersions.set(file, generation);
  const current = () => !document.isClosed && document.version === version && checkVersions.get(file) === generation;
  const command = await ziranCommand(file, vscode);
  const project = await packageRoot(file);
  const args = ['check', '--diagnostics=json'];
  let bases = [];
  if (project) {
    args.push('--project');
  } else {
    args.push('--root', path.dirname(file));
    const paths = await modulePaths(file, command, vscode);
    bases = packageEntries(paths).map((entry) => entry.directory);
    for (const entry of paths) args.push('--module-path', entry);
  }
  args.push(file);
  const result = await runCommand(command, args, project || path.dirname(file));
  if (!current()) return;
  const found = new Map();
  const records = diagnosticRecords(`${result.stdout}\n${result.stderr}`);
  if (result.code !== 0 && !records.length) records.push({
    severity: 'error', code: 'tool.failure', path: file, line: 1, column: 1,
    message: `Ziran check failed (${result.code ?? 'could not start'}): ${(result.stderr || result.stdout || command).trim().slice(0, 2000)}`,
  });
  for (const item of records) {
    const target = item.path ? await diagnosticPath(file, project, item.path, bases) : file;
    const diagnostic = new vscode.Diagnostic(await sourceRange(target, item), item.message,
      item.severity === 'warning' ? vscode.DiagnosticSeverity.Warning :
        vscode.DiagnosticSeverity.Error);
    if (item.code) diagnostic.code = item.code;
    diagnostic.source = 'ziran';
    diagnostic.relatedInformation = [];
    for (const related of item.related_graph?.nodes || []) {
      if (related.role === 'primary') continue;
      if (typeof related.path !== 'string' || typeof related.message !== 'string') continue;
      const relatedFile = await diagnosticPath(file, project, related.path, bases);
      diagnostic.relatedInformation.push(new vscode.DiagnosticRelatedInformation(
        new vscode.Location(vscode.Uri.file(relatedFile), await sourceRange(relatedFile, related)),
        related.message));
    }
    diagnostic.alternatives = [];
    for (const alternative of item.alternatives || []) {
      const edits = [];
      for (const edit of alternative.edits || []) {
        if (typeof edit.path !== 'string' || typeof edit.replacement !== 'string' ||
            typeof edit.original !== 'string' || typeof edit.document_sha256 !== 'string') continue;
        const file = await diagnosticPath(document.uri.fsPath, project, edit.path, bases);
        edits.push({ ...edit, uri: vscode.Uri.file(file), range: await sourceRange(file, edit) });
      }
      if (edits.length && edits.length === alternative.edits?.length) diagnostic.alternatives.push({ ...alternative, edits });
    }
    if (!found.has(target)) found.set(target, []);
    found.get(target).push(diagnostic);
  }
  if (!current()) return;
  publishDiagnostics(document, found, diagnostics);
}

// The declarations `ziran api` reports for a document's program, with
// absolute paths, and the document's own module; cached per version.
const symbolCache = new Map();
async function programSymbols(document, moduleName = null, refresh = false) {
  const key = document.uri.fsPath + '\0' + (moduleName || '');
  const cached = symbolCache.get(key);
  if (cached && cached.version === document.version) return cached.result;
  // Language providers must never start a compiler while the owner edits.
  if (!refresh) return { symbols: [], own: null, aliases: new Map(), modules: [] };
  const result = (async () => {
    const file = document.uri.fsPath;
    const command = await ziranCommand(file, vscode);
    const project = await packageRoot(file);
    const args = ['api', '--json', '--max-symbols', '4096', '--max-bytes', '1048576'];
    const selected = moduleName || (document.languageId !== 'ziran' ? sourceStem(file) : null);
    if (selected) args.push('--module', selected);
    let paths = [];
    if (project) {
      args.push('--project');
    } else {
      args.push('--root', path.dirname(file));
      paths = await modulePaths(file, command, vscode);
      for (const entry of paths) args.push('--module-path', entry);
    }
    args.push(file);
    const run = await runCommand(command, args, project || path.dirname(file));
    const symbols = apiSymbols(run.stdout || '');
    const map = project ? await projectModuleMap(file) : null;
    const sources = new Map();
    let own = null;
    for (const symbol of symbols) {
      // A package module's declarations live in its own file, by its own path.
      if (!sources.has(symbol.module)) sources.set(symbol.module, moduleSource(symbol.module, map, paths, existsSync));
      const source = sources.get(symbol.module);
      symbol.file = source ? (sourceStem(symbol.path) === sourceStem(source) ? source :
        path.resolve(path.dirname(source), symbol.path)) : await diagnosticPath(file, project, symbol.path);
      if (!own && (source ? path.resolve(source) === path.resolve(file) :
        await diagnosticPath(file, project, symbol.source) === file)) own = symbol.module;
    }
    // Alias -> module for the file's `Alias :: #import "..."` declarations.
    const aliases = new Map(apiImports(run.stdout || '')
      .filter((item) => item.module === own).map((item) => [item.alias, item.target]));
    let data;
    try { data = JSON.parse(run.stdout); } catch {}
    return { symbols, own, aliases, modules: data?.modules || [] };
  })();
  symbolCache.set(key, { version: document.version, result });
  return result;
}

// Resolve TS import spellings through the compiler's module map, never an
// npm alias or a duplicate handwritten declaration.
async function importedSymbols(document, binding, seen = new Set(), refresh = false) {
  const map = await projectModuleMap(document.uri.fsPath);
  const source = map && resolveMapped(map, document.uri.fsPath, binding.target)[0];
  const moduleName = source ? sourceStem(source) : binding.target;
  return moduleSymbols(document, moduleName, seen, refresh);
}
async function moduleSymbols(document, moduleName, seen = new Set(), refresh = false) {
  if (seen.has(moduleName)) return [];
  seen.add(moduleName);
  const result = await programSymbols(document, moduleName, refresh);
  const symbols = [...result.symbols];
  // Ziran's using imports expose the native module's declarations too.
  for (const module of result.modules) for (const imported of module.imports || []) {
    if (imported.using) {
      symbols.push(...await moduleSymbols(document, imported.resolved_module || imported.target, seen, refresh));
    }
  }
  return symbols;
}

const COMPLETION_KIND = { function: 'Function', type: 'Struct', constant: 'Constant', global: 'Variable' };

async function symbolAtPosition(document, position) {
  const found = nameAt(document.lineAt(position.line).text, position.character);
  if (!found) return null;
  const binding = document.languageId !== 'ziran' && tsBindings(document.getText()).get(found.qualifier || found.name);
  if (binding) {
    const symbols = await importedSymbols(document, binding);
    const symbol = symbols.find(item => item.name === (binding.name || found.name));
    return symbol ? { symbol, found } : null;
  }
  const { symbols, own, aliases } = await programSymbols(document);
  const module = found.qualifier ? aliases.get(found.qualifier) : own;
  const symbol = found.qualifier && module ?
    symbols.find((item) => item.module === module && item.name === found.name) || null :
    findSymbol(symbols, found.name, found.qualifier ? null : own);
  return symbol ? { symbol, found } : null;
}

function activate(context) {
  // Build actions alone refresh native compiler diagnostics and declarations.
  const onBuild = async file => {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.commands.executeCommand('ziran.check', document.uri);
  };
  activatePreview(context, vscode, onBuild);
  activateRun(context, vscode, onBuild);
  activateZirEditor(context, vscode);
  let editorRevision = 0;
  const updatePipelineSource = async editor => {
    const revision = ++editorRevision;
    const enabled = editor ? await nativeDocument(editor.document) : false;
    if (revision === editorRevision) await vscode.commands.executeCommand('setContext', 'ziran.pipelineSource', enabled);
  };
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updatePipelineSource));
  void updatePipelineSource(vscode.window.activeTextEditor);
  const diagnostics = vscode.languages.createDiagnosticCollection('ziran');
  context.subscriptions.push(diagnostics,
    vscode.workspace.onDidCloseTextDocument((document) => {
      checkVersions.delete(document.uri.fsPath);
      publishDiagnostics(document, new Map(), diagnostics);
    }));
  const checking = new Map();
  context.subscriptions.push(vscode.commands.registerCommand('ziran.check', async uri => {
    const document = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
    if (!document || !await nativeDocument(document)) return;
    const file = document.uri.fsPath;
    if (checking.has(file)) return checking.get(file);
    const work = (async () => {
      if (document.isDirty) await document.save();
      symbolCache.clear();
      await checkDocument(document, diagnostics);
      await programSymbols(document, null, true);
      if (document.languageId !== 'ziran') {
        const seen = new Set();
        for (const binding of tsBindings(document.getText()).values()) {
          await importedSymbols(document, binding, seen, true);
        }
      }
      await refreshTypeScriptBindings(document);
    })();
    checking.set(file, work);
    try { await work; } finally { checking.delete(file); }
  }));
  context.subscriptions.push(vscode.languages.registerCodeActionsProvider(sourceSelector, {
    provideCodeActions(document, range, context) {
      return diagnosticActions(vscode, document, context);
    },
  }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }));
  const caches = new Map();
  const invalidate = () => { caches.clear(); };
  const index = (document) => {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    const key = folder ? '' : path.dirname(document.uri.fsPath);
    if (!caches.has(key)) caches.set(key, (async () => {
      const { roots, paths, packages } = await moduleDirectories(document);
      const found = await vscode.workspace.findFiles('**/*.{zi,ts,tsx,zir}',
        '**/{.git,build,dist,node_modules,backup,work,vendor}/**');
      const files = new Set(found.map((uri) => uri.fsPath));
      if (key) await collectDirectory(key, files);
      for (const directory of paths) await collect(directory, files);
      for (const entry of packageEntries(packages)) await collect(entry.directory, files);
      return { files: [...files], roots, paths, packages };
    })());
    return caches.get(key);
  };

  context.subscriptions.push(vscode.languages.registerCompletionItemProvider(sourceSelector, {
    async provideCompletionItems(document, position) {
      if (symbolCache.get(document.uri.fsPath + '\0')?.version !== document.version) return null;
      if (!await nativeDocument(document)) return null;
      const imported = importAt(document.lineAt(position.line).text, position.character);
      if (!imported) {
        // Procedures, types, constants, and globals the program declares;
        // after `Alias.` only those of the module Alias imports.
        let { symbols, aliases } = await programSymbols(document);
        const qualifier = qualifierBefore(document.lineAt(position.line).text.slice(0, position.character));
        const module = qualifier ? aliases.get(qualifier) : null;
        const binding = document.languageId !== 'ziran' && tsBindings(document.getText()).get(qualifier);
        if (binding) symbols = await importedSymbols(document, binding);
        const seen = new Set();
        return symbols.filter((symbol) => !module || symbol.module === module)
          .filter((symbol) => !seen.has(symbol.name) && seen.add(symbol.name))
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
      const { files, roots, paths, packages } = await index(document);
      const ids = [...new Set([...packageModuleIds(files, packages), ...moduleIds(files, [...roots, ...paths])])];
      return ids.map((id) => {
        const item = new vscode.CompletionItem(id, vscode.CompletionItemKind.Module);
        item.range = new vscode.Range(position.line, imported.start,
          position.line, imported.end);
        const matches = [...packageCandidates(id, packages).filter((file) => files.includes(file)),
          ...resolveModule(files, id, document.uri.fsPath, roots, paths)];
        if (matches.length) item.detail = matches[0];
        return item;
      });
    },
  }, '"', '/'));

  context.subscriptions.push(vscode.languages.registerDefinitionProvider(sourceSelector, {
    async provideDefinition(document, position) {
      if (symbolCache.get(document.uri.fsPath + '\0')?.version !== document.version) return null;
      if (!await nativeDocument(document)) return null;
      const imported = importAt(document.lineAt(position.line).text, position.character);
      if (!imported) {
        const at = await symbolAtPosition(document, position);
        return at ? new vscode.Location(vscode.Uri.file(at.symbol.file),
          new vscode.Position(Math.max(0, at.symbol.line - 1), 0)) : null;
      }
      const map = await projectModuleMap(document.uri.fsPath);
      let matches = map ? resolveMapped(map, document.uri.fsPath, imported.target) : [];
      if (!matches.length) {
        const { files, roots, paths, packages } = await index(document);
        matches = packageCandidates(imported.target, packages).filter((file) => existsSync(file));
        if (!matches.length) {
          matches = resolveModule(files, imported.target,
            document.uri.fsPath, roots, paths);
        }
      }
      return matches.map((file) => new vscode.Location(vscode.Uri.file(file),
        new vscode.Position(0, 0)));
    },
  }));

  context.subscriptions.push(vscode.languages.registerHoverProvider(sourceSelector, {
    async provideHover(document, position) {
      if (symbolCache.get(document.uri.fsPath + '\0')?.version !== document.version) return null;
      if (!await nativeDocument(document)) return null;
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

  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{zi,ts,tsx,zir}');
  context.subscriptions.push(watcher, watcher.onDidCreate(invalidate),
    watcher.onDidDelete(invalidate), watcher.onDidChange(invalidate),
    vscode.workspace.onDidChangeWorkspaceFolders(invalidate),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('ziran.modulePaths')) invalidate();
    }));
}

module.exports = { activate };
