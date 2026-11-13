const path = require('node:path');

// The module an import line names, in `#import "text"`,
// `Text :: #import "kryon/text";` or `using Text :: #import "kryon/text";`.
function importAt(line, character) {
  const match = /^\s*(?:using\s+)?(?:[A-Za-z_]\w*\s*::\s*)?#import\s+"([^"]*)/.exec(line);
  if (!match) return null;
  const start = match[0].length - match[1].length;
  if (character < start || character > start + match[1].length) return null;
  return { target: match[1], start, end: start + match[1].length };
}

function moduleIds(files, roots) {
  const ids = new Set();
  for (const file of files) {
    if (!/\.(zi|zir)$/.test(file)) continue;
    const name = path.basename(file).replace(/\.(zi|zir)$/, '');
    if (/^[A-Za-z0-9_-]+$/.test(name)) ids.add(name);
    for (const root of roots) {
      const relative = path.relative(root, file);
      if (relative && !relative.startsWith('..' + path.sep) &&
          relative !== '..' && !path.isAbsolute(relative)) {
        const id = relative.replace(/\.(zi|zir)$/, '').split(path.sep).join('/');
        if (/^[A-Za-z0-9_/-]+$/.test(id)) ids.add(id);
      }
    }
  }
  return [...ids].sort();
}

function resolveModule(files, target, documentPath, roots, modulePaths) {
  if (!target || target.includes('.') || target.startsWith('/') ||
      target.includes('\\') || target.split('/').includes('..')) return [];
  const relative = target.split('/').join(path.sep);
  const local = path.dirname(documentPath);
  const directories = [local, ...roots, ...modulePaths];
  const matches = files.filter((file) =>
    file.endsWith(path.sep + relative + '.zi') ||
    file.endsWith(path.sep + relative + '.zir'));
  const rank = (file) => {
    for (let i = 0; i < directories.length; i++) {
      if (file === path.join(directories[i], relative + '.zi')) return i * 2;
      if (file === path.join(directories[i], relative + '.zir')) return i * 2 + 1;
    }
    return directories.length * 2 + (file.endsWith('.zi') ? 0 : 1);
  };
  return [...new Set(matches)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

// `ziran check --project` writes build/.ziran/module-map.tsv: the package
// roots (P), their modules (M), and what each package may import (D). It
// names the exact file behind every import, including package-qualified
// ones such as kryon/Widgets and std/text.
function parseModuleMap(text) {
  const map = { roots: [], modules: new Map(), edges: new Map() };
  for (const line of text.split(/\r?\n/)) {
    const fields = line.split('\t');
    if (fields[0] === 'P' && fields.length >= 3) {
      map.roots.push({ id: fields[1], path: fields[2] });
    } else if (fields[0] === 'M' && fields.length >= 4) {
      map.modules.set(`${fields[1]}\t${fields[2]}`, fields[3]);
    } else if (fields[0] === 'D' && fields.length >= 5) {
      map.edges.set(`${fields[1]}\t${fields[2]}`, { id: fields[3], name: fields[4] });
    }
  }
  return map;
}

function mapOwner(map, documentPath) {
  let owner = null;
  let best = -1;
  for (const root of map.roots) {
    if ((documentPath === root.path || documentPath.startsWith(root.path + path.sep)) &&
        root.path.length > best) {
      owner = root.id;
      best = root.path.length;
    }
  }
  return owner;
}

// Resolves an import the way the compiler does: the package's own module,
// then a direct dependency's export, then the standard library.
function resolveMapped(map, documentPath, target) {
  const owner = mapOwner(map, documentPath);
  if (owner === null || !target) return [];
  let id = owner;
  let name = target;
  if (target.startsWith('std/')) {
    id = 'std';
    name = target.slice(4);
  } else if (!map.modules.has(`${owner}\t${target}`)) {
    const edge = map.edges.get(`${owner}\t${target}`);
    if (edge) ({ id, name } = edge);
    else if (target.includes('/')) return [];
    else id = 'std';
  }
  const file = map.modules.get(`${id}\t${name}`);
  return file ? [file] : [];
}

// Every import a file in the map can write, qualified names first.
function mappedImportIds(map, documentPath) {
  const owner = mapOwner(map, documentPath);
  if (owner === null) return [];
  const ids = new Set();
  for (const key of map.edges.keys()) {
    const [from, visible] = key.split('\t');
    if (from === owner && visible.includes('/')) ids.add(visible);
  }
  for (const key of map.modules.keys()) {
    const [id, name] = key.split('\t');
    if (id === owner) ids.add(name);
    if (id === 'std') ids.add(`std/${name}`);
  }
  return [...ids].sort();
}

// `NAME=DIR` module paths serve `NAME/MODULE` imports from DIR/MODULE.zi
// and DIR/MODULE/module.zi, as `ziran --module-path NAME=DIR` does.
function packageEntries(paths) {
  const entries = [];
  for (const entry of paths) {
    const match = /^([A-Za-z_][\w-]*)=(.+)$/.exec(entry);
    if (match) entries.push({ name: match[1], directory: match[2] });
  }
  return entries;
}

function packageCandidates(target, paths) {
  const slash = target.indexOf('/');
  if (slash <= 0 || target.split('/').includes('..') || target.includes('\\')) return [];
  const name = target.slice(0, slash);
  const relative = target.slice(slash + 1).split('/').join(path.sep);
  const candidates = [];
  for (const entry of packageEntries(paths)) {
    if (entry.name !== name) continue;
    candidates.push(path.join(entry.directory, relative + '.zi'),
      path.join(entry.directory, relative, 'module.zi'));
  }
  return candidates;
}

// Qualified import ids for the modules FILES holds under each package path.
function packageModuleIds(files, paths) {
  const ids = new Set();
  for (const entry of packageEntries(paths)) {
    for (const file of files) {
      const relative = path.relative(entry.directory, file);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
      const parts = relative.split(path.sep);
      if (parts.length === 1 && /\.zi$/.test(relative)) ids.add(`${entry.name}/${relative.slice(0, -3)}`);
      if (parts.length === 2 && parts[1] === 'module.zi') ids.add(`${entry.name}/${parts[0]}`);
    }
  }
  return [...ids].sort();
}

// The file behind a module `ziran api` names. Package modules appear as
// `p<package id>_<module>`; a project's module map holds that package id,
// and NAME=DIR paths hold the module by its own name.
function moduleSource(moduleName, map, paths, existsSync) {
  const match = /^(p[0-9a-f]{16})_(.+)$/.exec(moduleName || '');
  if (!match) return null;
  const mapped = map?.modules.get(`${match[1]}\t${match[2]}`);
  if (mapped) return mapped;
  for (const entry of packageEntries(paths)) {
    for (const candidate of [path.join(entry.directory, match[2] + '.zi'),
      path.join(entry.directory, match[2], 'module.zi')]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

module.exports = { importAt, mappedImportIds, moduleIds, moduleSource, packageCandidates,
  packageEntries, packageModuleIds, parseModuleMap, resolveMapped, resolveModule };
