import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import oniguruma from 'vscode-oniguruma';
import textmate from 'vscode-textmate';
const require = createRequire(import.meta.url);
await oniguruma.loadWASM(readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm')));
const grammar = await new textmate.Registry({
  onigLib: Promise.resolve({
    createOnigScanner: sources => new oniguruma.OnigScanner(sources),
    createOnigString: source => new oniguruma.OnigString(source),
  }),
  loadGrammar: async scope => scope === 'source.ziran' ? textmate.parseRawGrammar(
    readFileSync(process.env.ZIRAN_GRAMMAR_PATH || 'syntaxes/ziran.tmLanguage.json', 'utf8'),
    'ziran.tmLanguage.json') : null,
}).loadGrammar('source.ziran');
function rows(source) {
  let stack = null;
  return source.split('\n').map(line => {
    const result = grammar.tokenizeLine(line, stack); stack = result.ruleStack;
    return { line, tokens: result.tokens };
  });
}
function scopes(row, text, last = false) {
  const index = last ? row.line.lastIndexOf(text) : row.line.indexOf(text);
  const token = row.tokens.find(item => item.startIndex <= index && index < item.endIndex);
  assert.ok(index >= 0 && token, `Missing ${text} in ${row.line}`);
  return token.scopes;
}
test('directives, declarations and comments keep their scopes', () => {
  const cases = [
    ['    } else #if WEB {', '#', 'meta.preprocessor.ziran', false],
    ['    } else #if WEB {', '{', 'comment.', true],
    ['Measure :: (value: float32) -> s32 #foreign host_api;', 'Measure', 'entity.name.function.ziran', false],
    ['Measure :: (value: float32) -> s32 #foreign host_api;', 'float32', 'storage.type.ziran', false],
    ['Measure :: (value: float32) -> s32 #foreign host_api;', '#foreign', 'meta.preprocessor.ziran', false],
    ['    # explanation {', '{', 'comment.line.number-sign.ziran', false],
  ];
  for (const [line, text, scope, absent] of cases) {
    const found = scopes(rows(line)[0], text, text === '{');
    assert.equal(found.some(item => absent ? item.startsWith(scope) : item === scope), !absent, `${text}: ${found}`);
  }
  for (const [opening, closing, index] of [["// ATR2's archive layout", 'Candle :: struct {', 0],
    ["/* outer /* inner ' */ still outer", '*/ Candle :: struct {', 3]]) {
    const state = grammar.tokenizeLine(opening).ruleStack;
    const token = grammar.tokenizeLine(closing, state).tokens.find(item => item.startIndex <= index && index < item.endIndex);
    assert.ok(token.scopes.includes('entity.name.function.ziran'));
    assert.ok(!token.scopes.some(scope => scope.startsWith(opening.startsWith('//') ? 'string.' : 'comment.')));
  }
});
test('laws retain scopes across lines without leaking from literals or past semicolons', () => {
  const tokenRows = rows(`#law GuideKeys forall left: -1..1,
    right: 0..1, mode: Mode, bits: [2]0..1 =>
    // Predicate comment; does not terminate the law.
    GuideInputFor(left, right).next_requested == (right == 1) && true;
After :: () -> bool { return true }`);
  for (const [row, text, scope] of [[0, '#', 'punctuation.definition.directive.ziran'],
    [0, 'law', 'keyword.control.directive.ziran'], [0, 'GuideKeys', 'entity.name.law.ziran'],
    [0, 'forall', 'keyword.control.law.ziran'], [0, 'left:', 'variable.parameter.law.ziran'],
    [0, '..', 'keyword.operator.law.ziran'], [1, 'right:', 'variable.parameter.law.ziran'],
    [1, 'Mode', 'entity.name.type.ziran'], [1, '=>', 'keyword.operator.law.ziran'],
    [2, 'Predicate', 'comment.line.double-slash.ziran'], [3, 'GuideInputFor', 'entity.name.function.call.ziran'],
    [3, 'next_requested', 'variable.other.property.ziran'], [3, '==', 'keyword.operator.ziran'],
    [3, '&&', 'keyword.operator.ziran'], [3, 'true', 'constant.language.ziran'],
    [3, ';', 'punctuation.terminator.law.ziran'], [4, 'After', 'entity.name.function.ziran']])
    assert.ok(scopes(tokenRows[row], text).includes(scope), `${text}: ${scopes(tokenRows[row], text)}`);
  assert.ok(!scopes(tokenRows[4], 'After').includes('meta.law.ziran'));
  for (const literal of ['// #law Fake forall x:0..1 => false;', 'text :: "#law Fake forall x:0..1 => false;"'])
    assert.ok(!scopes(rows(literal)[0], 'Fake').includes('entity.name.law.ziran'));
  const block = rows('/*\n#law Fake forall x:0..1 => false;\n*/\n#law Real custom ";" == ";";\nAfter :: 42');
  assert.ok(scopes(block[1], 'Fake').includes('comment.block.ziran'));
  assert.ok(scopes(block[3], 'Real').includes('entity.name.law.ziran'));
  assert.ok(!scopes(block[4], 'After').includes('meta.law.ziran'));
});
