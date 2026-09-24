const path = require('node:path');

function importAt(line, character) {
  const match = /^\s*#import\s+"([^"]*)/.exec(line);
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

module.exports = { importAt, moduleIds, resolveModule };
