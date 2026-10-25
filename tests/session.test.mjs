import test from 'node:test';
import assert from 'node:assert/strict';
import { narrativeHistory, projectSession } from '../src/session.mjs';
import { buildHistory } from '../src/core.mjs';

function fixture() {
  return [
    { seq: 0, type: 'user/message', surfaceOp: 'append', data: { id: 'u', source: { kind: 'user' }, content: [{ type: 'text', text: 'Push the door' }] } },
    { seq: 1, type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: 'assistant', content: [{ type: 'tool-call', name: 'rp_present', id: 'reused' }] } } },
    { seq: 2, type: 'tool/call', data: { turn: 1, step: 1, name: 'rp_present', callId: 'reused' } },
    { seq: 3, type: 'tool/result', surfaceOp: 'append', sourceEventSeqs: [2], data: { turn: 1, step: 1, message: { id: 'result', toolCallId: 'reused', source: { kind: 'tool', callId: 'reused' }, content: [{ type: 'text', text: 'The door stays closed.' }] }, meta: { rpLastStep: { schemaVersion: 1, record: { id: 'presentation', status: 'complete', text: 'The door stays closed.' } } } } },
  ];
}
function adopted(events, seq, previous, text) {
  const event = structuredClone(events.find(item => item.seq === previous));
  event.seq = seq;
  event.surfaceOp = { op: 'replace', startSeq: previous, endSeq: previous };
  event.sourceEventSeqs = [2, previous];
  event.data.message.content = [{ type: 'text', text }];
  return event;
}
const read = events => narrativeHistory(projectSession({ header: { id: 'story' }, records: events }));

test('revision references reject mismatched IDs and invalid original-result sequences', () => {
  const record = read(fixture())[0];
  assert.throws(() => buildHistory([{ ...record, id: 'presentation' }]), { code: 'INVALID_HISTORY' });
  assert.throws(() => buildHistory([{ ...record, source: { ...record.source, baseResultSeq: -1 } }]), { code: 'INVALID_HISTORY' });
});

test('formal history uses opaque revision IDs and exact adopted content through the complete result chain', () => {
  const events = fixture();
  const original = read(events)[0];
  assert.equal(original.id, JSON.stringify(['presentation', 3]));
  assert.equal(original.source.presentationId, 'presentation');
  assert.equal(original.source.baseResultSeq, 3);
  events.push(adopted(events, 5, 3, 'The closed door resists every push.'));
  let current = read(events);
  assert.equal(current.length, 1);
  assert.equal(current[0].id, JSON.stringify(['presentation', 5]));
  assert.equal(current[0].text, 'The closed door resists every push.');
  assert.equal(current[0].source.baseResultSeq, 3);
  assert.equal(events[3].data.meta.rpLastStep.record.text, 'The door stays closed.');
  events.push(adopted(events, 8, 5, 'The oak door remains firmly shut.'));
  current = read(events);
  assert.equal(current[0].id, JSON.stringify(['presentation', 8]));
  assert.equal(current[0].text, 'The oak door remains firmly shut.');
  assert.equal(current[0].source.resultSeq, 8);
});

test('fork prefixes and compaction preserve the appropriate adopted revision without reviving rewound prose', () => {
  const events = fixture();
  events.push(adopted(events, 5, 3, 'Adopted prose'));
  assert.equal(read(events.filter(item => item.seq < 5))[0].text, 'The door stays closed.');
  events.push({ seq: 6, type: 'user/message', surfaceOp: { op: 'replace', startSeq: 1, endSeq: 5 }, data: { id: 'compact', source: { kind: 'compact-checkpoint' }, content: [] } });
  assert.equal(read(events)[0].text, 'Adopted prose');
  events.push({ seq: 7, type: 'user/message', surfaceOp: { op: 'replace', startSeq: 6, endSeq: 6 }, data: { id: 'undo', source: { kind: 'runtime-context' }, content: [] } });
  assert.deepEqual(read(events), []);
});

test('unadopted or altered-metadata replacements never become formal narrative', () => {
  const events = fixture();
  events.push({ seq: 4, type: 'assistant/message', surfaceOp: 'append', data: { turn: 2, step: 1, message: { id: 'draft', content: [{ type: 'text', text: 'Unadopted draft' }] } } });
  assert.equal(read(events).length, 1);
  const replacement = adopted(events, 5, 3, 'Bad replacement');
  replacement.data.meta.rpLastStep.record.id = 'forged';
  events.push(replacement);
  assert.deepEqual(read(events), []);
});
