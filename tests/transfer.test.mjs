import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContextStore } from '../src/store.mjs';
import { createContextHost } from '../src/host.mjs';

const revisionId = JSON.stringify(['presentation', 3]);
const events = () => [
  { seq: 0, type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'user' }, content: [] } },
  { seq: 1, type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: 'anchor', content: [{ type: 'tool-call', name: 'rp_present', id: 'call' }] } } },
  { seq: 2, type: 'tool/call', data: { turn: 1, step: 1, name: 'rp_present', callId: 'call' } },
  { seq: 3, type: 'tool/result', surfaceOp: 'append', sourceEventSeqs: [2], data: { turn: 1, step: 1, message: { id: 'result', toolCallId: 'call', source: { kind: 'tool', callId: 'call' }, content: [{ type: 'text', text: 'Original' }] }, meta: { rpLastStep: { schemaVersion: 1, record: { id: 'presentation', status: 'complete', text: 'Original' } } } } },
];
async function fixture(t, withSession = true) {
  const directory = await mkdtemp(join(tmpdir(), 'rp-context-transfer-')), sessions = new Map(withSession ? [['story', events()]] : []);
  const store = await createContextStore({ directory }), headers = new Map();
  const ctx = { on: () => () => {}, get: () => undefined, agents: { list: () => [], get: () => undefined }, connection: { browserPeer: { id: 'owner' } }, typertGateway: { stream: async input => ({ async *[Symbol.asyncIterator]() { const id = input.args.request.address.sessionId; if (sessions.has(id)) yield { type: 'snapshot', header: headers.get(id) ?? { id }, cursor: sessions.get(id).at(-1)?.seq ?? 0, hasMore: false, records: sessions.get(id) }; } }) } };
  const service = await createContextHost(ctx, { store, callModel: () => { throw Error('Transfer cannot call models'); } });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, service, sessions, headers, ctx };
}

test('Context transfer is scoped, exact and idempotent, and requires real canonical sessions before restore', async t => {
  const source = await fixture(t);
  await source.store.configure('story', { settings: { recentTurns: 1 }, expectedRevision: 0 });
  await source.store.cacheSummaries('story', { summaries: [{ id: revisionId, summary: 'Actual summary' }, { id: 'outside-prefix', summary: 'Unused cache' }], expectedRevision: 1 });
  await source.store.savePlan('story', { anchor: 'anchor', representations: { [revisionId]: { mode: 'index' } }, unresolved: ['Question'], expectedRevision: 2 });
  await source.store.setAuthorNote('story', { text: 'Owner note', expectedRevision: 3 });
  await source.store.capturePreparation('story', { presentationId: 'captured', anchor: 'anchor' });
  const state = await source.service.exportState({ sessionIds: ['story'] });
  assert.equal(state.schemaVersion, 1);assert.equal(state.payload.sessions.length, 1);
  assert.equal(state.payload.sessions[0].sessionId, 'story');
  assert.equal(state.payload.sessions[0].state.summaries['outside-prefix'], undefined);
  assert.equal(JSON.stringify(state).includes('provider'), false);
  const destination = await fixture(t, false);
  assert.deepEqual(await destination.service.preflightRestore({ sessionIds: ['story'], state }), { supported: true, conflicts: [], requirements: [] });
  await assert.rejects(destination.service.restoreState({ restoreId: 'restore', sessionIds: ['story'], state, expectedRevision: 0 }), { code: 'RESTORE_REQUIREMENT_MISSING' });
  assert.equal((await destination.service.contentRevision({})).revision, 0);
  destination.sessions.set('story', events());
  const restored = await destination.service.restoreState({ restoreId: 'restore', sessionIds: ['story'], state, expectedRevision: 0 });
  assert.deepEqual(restored.restoredSessionIds, ['story']);
  assert.equal((await destination.store.view('story', { activeAnchors: ['anchor'] })).authorNote.status, 'claimed');
  assert.equal((await destination.store.view('story')).settings.recentTurns, 1);
  assert.deepEqual(await destination.service.restoreState({ restoreId: 'restore', sessionIds: ['story'], state, expectedRevision: 0 }), restored);
  const changed = structuredClone(state);changed.payload.sessions[0].state.authorNote.text = 'Conflicting payload';
  await assert.rejects(destination.service.restoreState({ restoreId: 'restore', sessionIds: ['story'], state: changed, expectedRevision: restored.revision }), { code: 'RESTORE_ID_CONFLICT' });
  const otherState = structuredClone(state);otherState.payload.sessions[0].sessionId = 'other-story';destination.sessions.set('other-story', events());
  await assert.rejects(destination.service.restoreState({ restoreId: 'restore', sessionIds: ['other-story'], state: otherState, expectedRevision: restored.revision }), { code: 'RESTORE_ID_CONFLICT' });
  assert.equal((await destination.service.preflightRestore({ sessionIds: ['story'], state })).conflicts[0].code, 'RESTORE_ID_CONFLICT');
});

test('restore validates canonical source anchors and rejects unknown payload fields without any write', async t => {
  const source = await fixture(t);
  await source.store.savePlan('story', { anchor: 'anchor', representations: { [revisionId]: { mode: 'full' } }, unresolved: [], expectedRevision: 0 });
  const state = await source.service.exportState({ sessionIds: ['story'] }), destination = await fixture(t);
  const invalid = structuredClone(state);invalid.payload.sessions[0].state.plans[0].anchor = 'forged-anchor';
  await assert.rejects(destination.service.restoreState({ restoreId: 'bad-source', sessionIds: ['story'], state: invalid, expectedRevision: 0 }), { code: 'RESTORE_PAYLOAD_INVALID' });
  assert.equal((await destination.service.contentRevision({})).revision, 0);
  const credentials = structuredClone(state);credentials.payload.sessions[0].state.providerKey = 'must-not-import';
  const preview = await destination.service.preflightRestore({ sessionIds: ['story'], state: credentials });
  assert.equal(preview.supported, false);assert.equal(preview.conflicts[0].code, 'RESTORE_PAYLOAD_INVALID');
  destination.ctx.agents.get = () => ({ status: 'running' });
  await assert.rejects(destination.service.exportState({ sessionIds: ['story'] }), { code: 'EXPORT_CHANGED' });
});

test('cold child export initializes causal inherited state before capture and preserves rewind after restore', async t => {
  const source = await fixture(t, false);
  source.sessions.set('parent', [...events(), { seq: 4, type: 'assistant/message', surfaceOp: 'append', data: { turn: 2, step: 1, message: { id: 'later-anchor', content: [] } } }]);
  source.sessions.set('child', events());source.headers.set('child', { id: 'child', parentSession: 'parent' });
  await source.store.configure('parent', { settings: { recentTurns: 1, maxChars: 9999 }, expectedRevision: 0 });
  await source.store.savePlan('parent', { anchor: 'anchor', representations: { [revisionId]: { mode: 'index' } }, unresolved: ['Inherited question'], expectedRevision: 1 });
  await source.store.savePlan('parent', { anchor: 'later-anchor', representations: {}, unresolved: ['Parent future question'], expectedRevision: 2 });
  const owner = await source.store.setAuthorNote('parent', { text: 'Pending parent instruction', expectedRevision: 3 });
  const saved = await source.service.exportState({ sessionIds: ['parent', 'child'] });
  const child = saved.payload.sessions.find(item => item.sessionId === 'child').state;
  assert.equal(child.settings.recentTurns, 1);assert.equal(child.settings.maxChars, 9999);
  assert.deepEqual(child.plans.map(plan => plan.anchor), ['anchor']);
  assert.equal(child.authorNote.text, owner.note.text);assert.notEqual(child.authorNote.id, owner.note.id);
  const effective = await source.service.state({ sessionId: 'child' });
  assert.deepEqual(effective.unresolved, ['Inherited question']);
  const destination = await fixture(t, false);
  for (const [id, records] of source.sessions) destination.sessions.set(id, records);
  destination.headers.set('child', { id: 'child', parentSession: 'parent' });
  await destination.service.restoreState({ restoreId: 'cold-child', sessionIds: ['parent', 'child'], state: saved, expectedRevision: 0 });
  const restored = await destination.service.state({ sessionId: 'child' });
  assert.deepEqual(restored.settings, effective.settings);assert.deepEqual(restored.unresolved, effective.unresolved);assert.deepEqual(restored.authorNote, effective.authorNote);
  assert.deepEqual((await destination.store.view('child', { activeAnchors: [] })).unresolved, []);
});

async function consumedState(t) {
  const source = await fixture(t);
  const owner = await source.store.setAuthorNote('story', { text: 'Consumed only by accepted prose', expectedRevision: 0 });
  await source.store.capturePreparation('story', { presentationId: 'initial-claim', anchor: 'anchor' });
  await source.store.presentationOutcome('story', { presentationId: 'presentation', claimId: 'initial-claim', status: 'accepted', anchor: 'anchor' });
  return { state: await source.store.exportState(['story']), proof: { id: owner.note.id, version: owner.note.version, claimId: 'initial-claim' } };
}

test('restored consumed notes require canonical finishing prose and restored LastStep proof before any write', async t => {
  const { state, proof } = await consumedState(t), destination = await fixture(t);
  destination.sessions.set('story', [{ seq: 1, type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: 'anchor', content: [{ type: 'text', text: 'Not a presentation' }] } } }]);
  await assert.rejects(destination.service.restoreState({ restoreId: 'forged', sessionIds: ['story'], state, expectedRevision: 0 }), { code: 'RESTORE_PAYLOAD_INVALID' });
  assert.equal((await destination.store.contentRevision()).revision, 0);
  destination.sessions.set('story', events());
  await assert.rejects(destination.service.restoreState({ restoreId: 'missing-last-step', sessionIds: ['story'], state, expectedRevision: 0 }), { code: 'RESTORE_REQUIREMENT_MISSING' });
  assert.equal((await destination.store.contentRevision()).revision, 0);
  destination.ctx.get = name => name === 'rpLastStep' ? { material: async () => { throw Object.assign(new Error('Receipt state not restored'), { code: 'RECEIPT_NOT_FOUND', status: 404 }); } } : undefined;
  await assert.rejects(destination.service.restoreState({ restoreId: 'missing-receipt', sessionIds: ['story'], state, expectedRevision: 0 }), { code: 'RESTORE_REQUIREMENT_MISSING' });
  assert.equal((await destination.store.contentRevision()).revision, 0);
  let frozen = { ...proof, version: 99 }, reads = [];
  destination.ctx.get = name => name === 'rpLastStep' ? { material: async input => { reads.push(input);return { presentationId: input.presentationId, contextPreparation: { authorNote: frozen } }; } } : undefined;
  for (const patch of [{ id: 'wrong-note' }, { version: 99 }, { claimId: 'wrong-claim' }]) {
    frozen = { ...proof, ...patch };
    await assert.rejects(destination.service.restoreState({ restoreId: 'wrong-note', sessionIds: ['story'], state, expectedRevision: 0 }), { code: 'RESTORE_PAYLOAD_INVALID' });
  }
  assert.equal((await destination.store.contentRevision()).revision, 0);
  frozen = proof;
  await destination.service.restoreState({ restoreId: 'valid-note', sessionIds: ['story'], state, expectedRevision: 0 });
  assert.equal(reads.at(-1).presentationId, 'presentation');
  assert.equal((await destination.service.state({ sessionId: 'story' })).authorNote.status, 'consumed');
});

test('accepted note audit survives restore but a result rewound off the active surface projects pending', async t => {
  const { state, proof } = await consumedState(t), destination = await fixture(t);
  destination.sessions.set('story', [...events(), { seq: 4, type: 'user/message', surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 }, data: { id: 'rewind-result', source: { kind: 'runtime-context' }, content: [] } }]);
  destination.ctx.get = name => name === 'rpLastStep' ? { material: async input => ({ presentationId: input.presentationId, contextPreparation: { authorNote: proof } }) } : undefined;
  await destination.service.restoreState({ restoreId: 'audit-note', sessionIds: ['story'], state, expectedRevision: 0 });
  const current = await destination.service.state({ sessionId: 'story' });
  assert.equal(current.history.length, 0);assert.equal(current.authorNote.status, 'pending');
  assert.equal((await destination.store.exportState(['story'])).payload.sessions[0].state.noteClaims['initial-claim'].status, 'consumed');
  destination.sessions.set('story', [...ambiguousPresentations(), { seq: 6, type: 'user/message', surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 }, data: { id: 'remove-first-result', source: { kind: 'runtime-context' }, content: [] } }]);
  destination.ctx.get = name => name === 'rpLastStep' ? { material: async input => ({ presentationId: input.presentationId, contextPreparation: { authorNote: input.presentationId === 'presentation' ? proof : { ...proof, id: 'unrelated-note' } } }) } : undefined;
  const withSibling = await destination.service.state({ sessionId: 'story' });
  assert.equal(withSibling.history.length, 1);assert.equal(withSibling.authorNote.status, 'pending');
  destination.sessions.set('child', destination.sessions.get('story'));destination.headers.set('child', { id: 'child', parentSession: 'story' });
  const child = await destination.service.state({ sessionId: 'child' });
  assert.equal(child.authorNote.status, 'pending');assert.notEqual(child.authorNote.id, proof.id);
});

function ambiguousPresentations() {
  const records = events();
  records[1].data.message.content.push({ type: 'tool-call', name: 'rp_present', id: 'second-call' });
  records.push({ seq: 4, type: 'tool/call', data: { turn: 1, step: 1, name: 'rp_present', callId: 'second-call' } }, { seq: 5, type: 'tool/result', surfaceOp: 'append', sourceEventSeqs: [4], data: { turn: 1, step: 1, message: { id: 'second-result', toolCallId: 'second-call', source: { kind: 'tool', callId: 'second-call' }, content: [{ type: 'text', text: 'Second prose' }] }, meta: { rpLastStep: { schemaVersion: 1, record: { id: 'second-presentation', status: 'complete', text: 'Second prose' } } } } });
  return records;
}

test('ambiguous canonical finishing candidates cannot choose an arbitrary frozen receipt in restore or acceptance', async t => {
  const { state, proof } = await consumedState(t), destination = await fixture(t);
  destination.sessions.set('story', ambiguousPresentations());
  destination.ctx.get = name => name === 'rpLastStep' ? { material: async input => ({ presentationId: input.presentationId, contextPreparation: { authorNote: proof } }) } : undefined;
  await assert.rejects(destination.service.restoreState({ restoreId: 'ambiguous', sessionIds: ['story'], state, expectedRevision: 0 }), { code: 'RESTORE_PAYLOAD_INVALID' });
  assert.equal((await destination.store.contentRevision()).revision, 0);
  await destination.store.setAuthorNote('story', { text: 'Live claimed note', expectedRevision: 0 });
  const captured = await destination.store.capturePreparation('story', { presentationId: 'initial-claim', anchor: 'anchor' });
  destination.ctx.get = name => name === 'rpLastStep' ? { material: async input => ({ presentationId: input.presentationId, contextPreparation: { authorNote: { id: captured.authorNote.id, version: captured.authorNote.version, claimId: 'initial-claim' } } }) } : undefined;
  await assert.rejects(destination.service.presentationOutcome({ sessionId: 'story', presentationId: 'presentation', claimId: 'initial-claim', status: 'accepted' }), { code: 'PRESENTATION_NOT_ACCEPTED' });
  assert.equal((await destination.store.contentRevision()).revision, captured.revision);
});
