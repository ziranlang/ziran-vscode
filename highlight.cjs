// Highlights Ziran source for the preview's code tabs with the extension's
// own TextMate grammar (syntaxes/ziran.tmLanguage.json), the one the editor
// uses, so the tabs color the same tokens the editor does. Scopes map to the
// tok-* classes the page themes for light and dark.
const { readFileSync } = require('node:fs');
const path = require('node:path');
const oniguruma = require('vscode-oniguruma');
const textmate = require('vscode-textmate');

// The first matching prefix wins; scopes are checked from the innermost out.
const CLASSES = [
  ['comment', 'comment'],
  ['string', 'string'],
  ['constant.character.escape', 'string'],
  ['meta.preprocessor', 'directive'],
  ['keyword.control.directive', 'directive'],
  ['punctuation.definition.directive', 'directive'],
  ['constant.numeric', 'number'],
  ['constant.language', 'keyword'],
  ['keyword.operator', ''],
  ['keyword', 'keyword'],
  ['storage.type', 'type'],
  ['storage', 'keyword'],
  ['entity.name.type', 'type'],
  ['entity.name.function', 'function'],
  ['entity.name.constant', 'number'],
];
const classOf = (scopes) => {
  for (let index = scopes.length - 1; index > 0; index--) {
    const found = CLASSES.find(([prefix]) => scopes[index].startsWith(prefix));
    if (found) return found[1];
  }
  return '';
};
const escapeHtml = (text) => text.replace(/[&<>]/g, (c) => c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;');

let loading = null;
function loadGrammar() {
  loading ||= (async () => {
    await oniguruma.loadWASM(readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm')));
    return new textmate.Registry({
      onigLib: Promise.resolve({
        createOnigScanner: (sources) => new oniguruma.OnigScanner(sources),
        createOnigString: (source) => new oniguruma.OnigString(source),
      }),
      loadGrammar: async (scope) => scope === 'source.ziran' ? textmate.parseRawGrammar(
        readFileSync(path.join(__dirname, 'syntaxes', 'ziran.tmLanguage.json'), 'utf8'),
        'ziran.tmLanguage.json') : null,
    }).loadGrammar('source.ziran');
  })();
  return loading;
}

// TEXT as HTML with tok-* spans, or null when the grammar cannot load.
async function highlightZiran(text) {
  let grammar;
  try { grammar = await loadGrammar(); } catch { loading = null; return null; }
  if (!grammar) return null;
  let stack = null;
  const lines = text.split('\n').map((line) => {
    const result = grammar.tokenizeLine(line, stack);
    stack = result.ruleStack;
    // Neighboring tokens of one class share a span.
    const runs = [];
    for (const token of result.tokens) {
      const name = classOf(token.scopes);
      const piece = escapeHtml(line.slice(token.startIndex, token.endIndex));
      if (runs.length && runs[runs.length - 1].name === name) runs[runs.length - 1].text += piece;
      else runs.push({ name, text: piece });
    }
    return runs.map(({ name, text: piece }) => name ? `<span class="tok-${name}">${piece}</span>` : piece).join('');
  });
  return lines.join('\n');
}

// A file's highlighted HTML when it is Ziran source worth highlighting.
const HIGHLIGHT_LIMIT = 400000;
async function highlightedFile(name, text) {
  return /\.zi$/.test(name) && typeof text === 'string' && text.length <= HIGHLIGHT_LIMIT ?
    highlightZiran(text) : null;
}

module.exports = { highlightZiran, highlightedFile };
