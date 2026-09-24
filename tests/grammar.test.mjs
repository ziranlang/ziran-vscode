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
    if (scopeName !== 'source.ziran') {
      return null;
    }
    const source = readFileSync('syntaxes/ziran.tmLanguage.json', 'utf8');
    return textmate.parseRawGrammar(source, 'ziran.tmLanguage.json');
  },
});

const grammar = await registry.loadGrammar('source.ziran');

function scopesAt(line, index) {
  const { tokens } = grammar.tokenizeLine(line);
  const token = tokens.find(({ startIndex, endIndex }) => startIndex <= index && index < endIndex);
  assert.ok(token, `No grammar token at index ${index} in ${line}`);
  return token.scopes;
}

test('compile-time branch directive leaves its opening brace visible', () => {
  const line = '    } else #if WEB {';
  assert.ok(scopesAt(line, line.indexOf('#')).includes('meta.preprocessor.ziran'));
  assert.ok(!scopesAt(line, line.lastIndexOf('{')).some((scope) => scope.startsWith('comment.')));
});

test('Ziran foreign declaration and scalar types are highlighted', () => {
  const line = 'Measure :: (value: float32) -> s32 #foreign host_api;';
  assert.ok(scopesAt(line, line.indexOf('Measure')).includes('entity.name.function.ziran'));
  assert.ok(scopesAt(line, line.indexOf('float32')).includes('storage.type.ziran'));
  assert.ok(scopesAt(line, line.indexOf('#foreign')).includes('meta.preprocessor.ziran'));
});

test('ordinary hash comments remain comments', () => {
  const line = '    # explanation {';
  assert.ok(scopesAt(line, line.lastIndexOf('{')).includes('comment.line.number-sign.ziran'));
});
