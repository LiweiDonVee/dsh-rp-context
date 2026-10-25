import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHistory, compileMaterials, validateSettings } from '../src/core.mjs';

const history = Array.from({ length: 7 }, (_, index) => ({
  id: `h${index}`, anchor: `a${index}`, turn: index + 1, action: `act ${index}`,
  text: `Original narrative ${index}`, source: { assistantMessageId: `a${index}`, sessionId: 's' },
  ...(index === 0 ? { summary: 'An actual fact summary' } : {}),
}));

test('recent confirmed turns stay full while older records require actual summaries', () => {
  const before = structuredClone(history);
  const result = buildHistory(history);
  assert.equal(result[0].mode, 'summary');
  assert.equal(result[0].content, 'An actual fact summary');
  assert.equal(result[1].needsSummary, true);
  assert.equal(result[1].content, '');
  assert.deepEqual(result.slice(2).map(item => item.mode), ['full', 'full', 'full', 'full', 'full']);
  assert.deepEqual(history, before);
  assert.deepEqual(result[0].source, { assistantMessageId: 'a0', sessionId: 's' });
});

test('representations expand exact originals and fold to source indexes reversibly', () => {
  const expanded = buildHistory(history, { representations: { h0: { mode: 'full' }, h6: { mode: 'index' } } });
  assert.equal(expanded[0].content, 'Original narrative 0');
  assert.equal(expanded[6].mode, 'index');
  assert.equal(expanded[6].content.includes('Original narrative'), false);
  assert.deepEqual(expanded[6].source, history[6].source);
  assert.equal(buildHistory(history)[6].content, 'Original narrative 6');
});

test('turn window counts distinct narrative turns and rejects duplicate or invalid references', () => {
  const records = [{ ...history[0], turn: 1 }, { ...history[1], turn: 1 }, { ...history[2], turn: 2 }];
  assert.deepEqual(buildHistory(records, { recentTurns: 1 }).map(item => item.mode), ['summary', 'summary', 'full']);
  assert.throws(() => buildHistory([history[0], history[0]]), { code: 'DUPLICATE_ID' });
  assert.throws(() => buildHistory([{ ...history[0], source: null }]), { code: 'INVALID_HISTORY' });
  assert.throws(() => buildHistory(history, { representations: { missing: { mode: 'full' } } }), { code: 'INVALID_REFERENCE' });
  assert.throws(() => buildHistory(history, { representations: { h0: { mode: 'script' } } }), { code: 'INVALID_REPRESENTATION' });
});

test('material snapshots preserve exact prose and entries after inputs change', () => {
  const projected = buildHistory(history.slice(-1));
  const entries = [{ id: 'entry', content: 'A fact', mode: 'required', version: 1 }];
  const material = compileMaterials({ history: projected, databaseEntries: entries, notes: 'A direction', unresolved: ['Who?'] });
  entries[0].content = 'Changed';
  projected[0].content = 'Changed';
  assert.equal(material.entries[0].content, 'A fact');
  assert.deepEqual(material.recentProse, ['Original narrative 6']);
  assert.equal(material.guidance, 'A direction');
  assert.equal(Object.isFrozen(material.history[0].source), true);
  assert.equal(Object.isFrozen(material.entries[0]), true);
  assert.equal(material.chars, JSON.stringify(material).length);
});

test('aggregate budget includes references and guidance and never drops required material', () => {
  assert.throws(() => compileMaterials({ history: buildHistory(history), maxChars: 100 }), { code: 'MISSING_SUMMARY' });
  assert.throws(() => compileMaterials({ history: [], databaseEntries: [{ id: 'x', content: 'x', source: 'z'.repeat(200) }], maxChars: 150 }), { code: 'MATERIAL_BUDGET', status: 409 });
  assert.throws(() => compileMaterials({ history: [], notes: 'x'.repeat(200), maxChars: 150 }), { code: 'MATERIAL_BUDGET' });
});

test('settings validate positive bounded integers and reject unknown mutations', () => {
  assert.deepEqual(validateSettings({}), { enabled: true, recentTurns: 5, maxChars: 24000, maxSteps: 8 });
  for (const settings of [{ maxSteps: 0 }, { recentTurns: 1.5 }, { maxChars: 10000001 }, { enabled: 'yes' }, { source: 'changed' }]) {
    assert.throws(() => validateSettings(settings), { code: 'INVALID_SETTINGS' });
  }
});

test('canonical source tuples distinguish multiple results under one assistant and reject duplicate tuples', () => {
  const source = { sessionId: 's', assistantMessageId: 'same', callSeq: 0, resultSeq: 1, callId: 'reused-wire-id', sourceEventSeqs: [0, 1] };
  const first = { ...history[0], anchor: 'same', turn: 0, source };
  const second = { ...history[1], anchor: 'same', turn: 0, source: { ...source, callSeq: 2, resultSeq: 3, sourceEventSeqs: [2, 3] } };
  const result = buildHistory([first, second]);
  assert.equal(result.length, 2);
  assert.deepEqual(result[1].source.sourceEventSeqs, [2, 3]);
  assert.throws(() => buildHistory([first, { ...second, source }]), { code: 'DUPLICATE_ID' });
});

test('history IDs that match object properties never inherit accidental representations', () => {
  const result = buildHistory([{ ...history[0], id: 'constructor' }]);
  assert.equal(result[0].mode, 'full');
});

test('canonical event references reject invalid sequence numbers without normalizing them away', () => {
  for (const source of [
    { ...history[0].source, callSeq: NaN },
    { ...history[0].source, resultSeq: -1 },
    { ...history[0].source, sourceEventSeqs: [0, '1'] },
    { ...history[0].source, sessionId: '' },
  ]) assert.throws(() => buildHistory([{ ...history[0], source }]), { code: 'INVALID_HISTORY' });
});
