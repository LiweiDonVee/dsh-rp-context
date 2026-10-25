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
  const store = await createContextStore({ directory });
  const ctx = { on: () => () => {}, get: () => undefined, agents: { list: () => [], get: () => undefined }, connection: { browserPeer: { id: 'owner' } }, typertGateway: { stream: async input => ({ async *[Symbol.asyncIterator]() { const id = input.args.request.address.sessionId; if (sessions.has(id)) yield { type: 'snapshot', header: { id }, cursor: 3, hasMore: false, records: sessions.get(id) }; } }) } };
  const service = await createContextHost(ctx, { store, callModel: () => { throw Error('Transfer cannot call models'); } });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, service, sessions, ctx };
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
  await assert.rejects(destination.service.restoreState({ restoreId: 'restore', sessionIds: ['story'], state: changed, expectedRevision: restored.revision }), { code: 'RESTORE_CONTENT_CONFLICT' });
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
