// Declarations of a checked Ziran program, from `ziran api --json`: every
// procedure, type, constant, and global of the file and the modules it
// imports, with the signature to show and the place it is declared.

const KIND = { functions: 'function', types: 'type', constants: 'constant', globals: 'global' };

function spacedParameters(text) {
  return String(text || '').replace(/\s*,\s*/g, ', ').replace(/(\w)\s*:\s*(?!:)/g, '$1: ');
}

function signature(kind, item) {
  if (kind === 'functions') {
    const result = !item.return_type || item.return_type === 'void' ? '' : ` -> ${item.return_type}`;
    return `${item.name} :: (${spacedParameters(item.parameters)})${result}`;
  }
  if (kind === 'types') {
    if (item.procedure) {
      const result = item.return_type && item.return_type !== 'void' ? ` -> ${item.return_type}` : '';
      return `${item.name} :: #type (${spacedParameters(item.body)})${result}`;
    }
    const parameters = String(item.type_parameters || '').split(',').map((name) => name.trim())
      .filter(Boolean);
    const generic = parameters.length ? `(${parameters.map((name) => `$${name}: Type`).join(', ')})` : '';
    const fields = String(item.body || '').split(/[;\n]/).map((field) => field.trim()).filter(Boolean);
    const shape = item.enum ? 'enum' : 'struct';
    return fields.length ? `${item.name} :: ${shape}${generic} { ${fields.join('; ')}; }` :
      `${item.name} :: ${shape}${generic}`;
  }
  if (kind === 'constants') return `${item.name} :: ${item.value}`;
  return `${item.name}: ${item.type}`;
}

// The declarations in `ziran api --json` output, each with the module it
// belongs to and its path relative to the check's root.
function apiSymbols(text) {
  let data;
  try { data = JSON.parse(text); } catch { return []; }
  const symbols = [];
  for (const module of (data && data.modules) || []) {
    for (const kind of Object.keys(KIND)) {
      for (const item of module[kind] || []) {
        if (!item || !item.name) continue;
        symbols.push({
          name: item.name,
          kind: KIND[kind],
          detail: signature(kind, item),
          module: module.name,
          source: module.source,
          path: item.path || module.source,
          line: item.line || 1,
        });
      }
    }
  }
  return symbols;
}

// The name under CHARACTER in LINE, and the Alias it is read through in
// Alias.Name, or null outside a name.
function nameAt(line, character) {
  const isName = (c) => /[A-Za-z0-9_]/.test(c);
  let start = character, end = character;
  while (start > 0 && isName(line[start - 1])) start--;
  while (end < line.length && isName(line[end])) end++;
  if (start === end || /[0-9]/.test(line[start])) return null;
  let qualifier = '';
  if (start > 1 && line[start - 1] === '.' && isName(line[start - 2])) {
    let before = start - 1;
    while (before > 0 && isName(line[before - 1])) before--;
    qualifier = line.slice(before, start - 1);
  }
  return { name: line.slice(start, end), qualifier, start, end };
}

// The // comment block right above LINE (1-based), past attribute lines
// such as #program_export; the comment that opens the file describes the
// module, not the declaration after it.
function docComment(lines, line) {
  let index = line - 2;
  while (index >= 0 && /^\s*#/.test(lines[index]) && !/^\s*#import/.test(lines[index])) index--;
  const block = [];
  while (index >= 0 && /^\s*\/\//.test(lines[index])) {
    block.unshift(lines[index].replace(/^\s*\/\/\s?/, ''));
    index--;
  }
  if (index < 0) return '';
  return block.join('\n').trim();
}

// The declaration SYMBOLS name NAME, preferring the file's own module.
function findSymbol(symbols, name, preferredModule) {
  const matches = symbols.filter((symbol) => symbol.name === name);
  return matches.find((symbol) => symbol.module === preferredModule) || matches[0] || null;
}

module.exports = { apiSymbols, docComment, findSymbol, nameAt, signature };
