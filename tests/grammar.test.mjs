import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import oniguruma from 'vscode-oniguruma';
import textmate from 'vscode-textmate';

const require = createRequire(import.meta.url);
await oniguruma.loadWASM(readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm')));

const registry = new textmate.Registry({
  onigLib: Promise.resolve({
    createOnigScanner: (sources) => new oniguruma.OnigScanner(sources),
    createOnigString: (source) => new oniguruma.OnigString(source),
  }),
  loadGrammar: async (scopeName) => {
    if (scopeName !== 'source.kryon') {
      return null;
    }
    const source = readFileSync('syntaxes/kryon.tmLanguage.json', 'utf8');
    return textmate.parseRawGrammar(source, 'kryon.tmLanguage.json');
  },
});

const grammar = await registry.loadGrammar('source.kryon');

function scopesAt(line, index) {
  const { tokens } = grammar.tokenizeLine(line);
  const token = tokens.find(({ startIndex, endIndex }) => startIndex <= index && index < endIndex);
  assert.ok(token, `No grammar token at index ${index} in ${line}`);
  return token.scopes;
}

for (const directive of ['#else', '#else_if WEB']) {
  test(`inline ${directive} leaves its opening brace visible to the editor`, () => {
    const line = `    } ${directive} {`;
    assert.ok(scopesAt(line, line.indexOf('#')).includes('meta.preprocessor.kryon'));
    assert.ok(!scopesAt(line, line.lastIndexOf('{')).some((scope) => scope.startsWith('comment.')));
  });
}

test('ordinary hash comments remain comments', () => {
  const line = '    # explanation {';
  assert.ok(scopesAt(line, line.lastIndexOf('{')).includes('comment.line.number-sign.kryon'));
});
