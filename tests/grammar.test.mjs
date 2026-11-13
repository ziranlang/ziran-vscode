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
    const source = readFileSync(process.env.ZIRAN_GRAMMAR_PATH || 'syntaxes/ziran.tmLanguage.json', 'utf8');
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

test('apostrophes in line comments do not turn following code into a string', () => {
  const comment = grammar.tokenizeLine("// ATR2's archive layout");
  assert.ok(comment.tokens.every(({ scopes }) => scopes.includes('comment.line.double-slash.ziran')));

  const code = grammar.tokenizeLine('Candle :: struct {', comment.ruleStack);
  const candle = code.tokens.find(({ startIndex, endIndex }) => startIndex <= 0 && 0 < endIndex);
  assert.ok(candle.scopes.includes('entity.name.function.ziran'));
  assert.ok(!candle.scopes.some((scope) => scope.startsWith('string.')));
});

test('nested block comments end before following declarations', () => {
  const state = grammar.tokenizeLine("/* outer /* inner ' */ still outer", null).ruleStack;
  const end = grammar.tokenizeLine('*/ Candle :: struct {', state);
  const candle = end.tokens.find(({ startIndex, endIndex }) => startIndex <= 3 && 3 < endIndex);
  assert.ok(candle.scopes.includes('entity.name.function.ziran'));
  assert.ok(!candle.scopes.some((scope) => scope.startsWith('comment.')));
});

function tokenizeSource(source) {
  let stack = null;
  return source.split('\n').map(line => {
    const result = grammar.tokenizeLine(line, stack);
    stack = result.ruleStack;
    return { line, tokens: result.tokens };
  });
}

function sourceScopes(row, text) {
  const index = row.line.indexOf(text);
  assert.ok(index >= 0, `Missing ${text} in ${row.line}`);
  return row.tokens.find(t => t.startIndex <= index && index < t.endIndex).scopes;
}

test('quantified laws highlight their name, bindings, domains, and predicate', () => {
  const line = '#law GuideKeys forall left:0..1,right:0..1 => GuideInputFor(B(left), B(right)).previous_requested == B(left) && true;';
  const [row] = tokenizeSource(line);
  for (const [text, scope] of [
    ['#', 'punctuation.definition.directive.ziran'],
    ['law', 'keyword.control.directive.ziran'],
    ['GuideKeys', 'entity.name.law.ziran'],
    ['forall', 'keyword.control.law.ziran'],
    ['left:', 'variable.parameter.law.ziran'],
    ['right:', 'variable.parameter.law.ziran'],
    ['0', 'constant.numeric.ziran'],
    ['1', 'constant.numeric.ziran'],
    ['..', 'keyword.operator.law.ziran'],
    ['=>', 'keyword.operator.law.ziran'],
    ['GuideInputFor', 'entity.name.function.call.ziran'],
    ['previous_requested', 'variable.other.property.ziran'],
    ['==', 'keyword.operator.ziran'],
    ['&&', 'keyword.operator.ziran'],
    ['true', 'constant.language.ziran'],
  ]) assert.ok(sourceScopes(row, text).includes(scope), `${text}: ${sourceScopes(row, text)}`);
  assert.ok(row.tokens.every(t => !t.scopes.some(s => s.startsWith('comment.'))));
});

test('multiline laws retain domains and predicates, then end at the semicolon', () => {
  const rows = tokenizeSource(`#law PagerKeys forall left: -1..1,
    right: 0..1,
    mode: Mode,
    bits: [2]0..1 =>
    // Predicate comment; does not terminate the law.
    GuideInputFor(left, right).next_requested == (right == 1) &&
    bits[0] <= bits[1];
After :: () -> bool { return true }`);
  assert.ok(sourceScopes(rows[1], 'right').includes('variable.parameter.law.ziran'));
  assert.ok(sourceScopes(rows[2], 'Mode').includes('entity.name.type.ziran'));
  assert.ok(sourceScopes(rows[3], '..').includes('keyword.operator.law.ziran'));
  assert.ok(sourceScopes(rows[4], 'Predicate').includes('comment.line.double-slash.ziran'));
  assert.ok(sourceScopes(rows[5], 'next_requested').includes('variable.other.property.ziran'));
  assert.ok(sourceScopes(rows[6], '<=').includes('keyword.operator.ziran'));
  assert.ok(sourceScopes(rows[6], ';').includes('punctuation.terminator.law.ziran'));
  assert.ok(sourceScopes(rows[7], 'After').includes('entity.name.function.ziran'));
  assert.ok(!sourceScopes(rows[7], 'After').includes('meta.law.ziran'));
});

test('law-looking text inside comments and strings stays literal', () => {
  for (const line of ['// #law Fake forall x:0..1 => false;', 'text :: "#law Fake forall x:0..1 => false;"']) {
    assert.ok(!scopesAt(line, line.indexOf('Fake')).includes('entity.name.law.ziran'));
  }
  const rows = tokenizeSource('/*\n#law Fake forall x:0..1 => false;\n*/\n#law Real custom ";" == ";";\nAfter :: 42');
  assert.ok(sourceScopes(rows[1], 'Fake').includes('comment.block.ziran'));
  assert.ok(sourceScopes(rows[3], 'Real').includes('entity.name.law.ziran'));
  assert.ok(sourceScopes(rows[3], '==').includes('keyword.operator.ziran'));
  assert.ok(!sourceScopes(rows[4], 'After').includes('meta.law.ziran'));
});
