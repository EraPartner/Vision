const assert = require('node:assert/strict');
const test = require('node:test');

const { extractTranslationCalls } = require('../lib/localeCallParser');

test('extracts direct t and tc calls from TypeScript and TSX', () => {
  const calls = extractTranslationCalls(`
const first = t('common.save');
const second = tc(
  \`items.count\`,
  count,
  { count, "label": name },
);
const view = <span>{t('common.done', { value: nested(call()) })}</span>;
`, 'fixture.tsx');

  assert.deepEqual(calls, [
    { fn: 't', key: 'common.save', line: 2, variableNames: null },
    { fn: 'tc', key: 'items.count', line: 3, variableNames: ['count', 'label'] },
    { fn: 't', key: 'common.done', line: 8, variableNames: ['value'] },
  ]);
});

test('ignores comments, property calls, and computed translation keys', () => {
  const calls = extractTranslationCalls(`
// t('comment.line')
/* tc('comment.block', 2) */
translator.t('property.call');
t(prefix + '.suffix');
t(\`dynamic.\${kind}\`);
t('real.key');
`, 'fixture.ts');

  assert.deepEqual(calls, [
    { fn: 't', key: 'real.key', line: 7, variableNames: null },
  ]);
});

test('skips dropped-variable analysis for non-static objects', () => {
  const calls = extractTranslationCalls(`
t('spread.vars', { count, ...extra });
t('computed.vars', { [field]: value });
t('variable.vars', variables);
t('static.vars', { count, method() {}, get label() { return ''; } });
`, 'fixture.ts');

  assert.deepEqual(calls, [
    { fn: 't', key: 'spread.vars', line: 2, variableNames: null },
    { fn: 't', key: 'computed.vars', line: 3, variableNames: null },
    { fn: 't', key: 'variable.vars', line: 4, variableNames: null },
    { fn: 't', key: 'static.vars', line: 5, variableNames: ['count', 'method', 'label'] },
  ]);
});

test('uses the third tc argument for interpolation variables', () => {
  const calls = extractTranslationCalls(
    "tc('items.count', amount, { count: amount, 'unit-name': unit })",
    'fixture.ts',
  );

  assert.deepEqual(calls, [
    {
      fn: 'tc',
      key: 'items.count',
      line: 1,
      variableNames: ['count', 'unit-name'],
    },
  ]);
});
