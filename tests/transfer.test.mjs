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
  return { store, service, sessions, headers, ctx, directory };
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
  assert.deepEqual(await destination.service.preflightRestore({ sessionIds: ['story'], state }), { supported: true, conflicts: [], requirements: [] });
});

test('preflight accepts identical restored rows before and after reopening the persisted store', async t => {
  const source = await fixture(t), destination = await fixture(t);
  await source.store.configure('story', { settings: { recentTurns: 2 }, expectedRevision: 0 });
  await source.store.savePlan('story', { anchor: 'anchor', representations: { [revisionId]: { mode: 'index' } }, unresolved: ['Keep this question'], expectedRevision: 1 });
  await source.store.cacheSummaries('story', { summaries: [{ id: revisionId, summary: 'Saved accepted prose' }], expectedRevision: 2 });
  await source.store.setAuthorNote('story', { text: 'Saved owner direction', expectedRevision: 3 });
  const state = await source.service.exportState({ sessionIds: ['story'] });
  const restored = await destination.service.restoreState({ restoreId: 'same-snapshot', sessionIds: ['story'], state, expectedRevision: 0 });
  const expected = { supported: true, conflicts: [], requirements: [] };
  assert.deepEqual(await destination.service.preflightRestore({ sessionIds: ['story'], state }), expected);
  const reopened = await createContextStore({ directory: destination.directory });
  assert.deepEqual(await reopened.preflightRestore(['story'], state), expected);
  const normalized = structuredClone(state);normalized.revision += 100;
  delete normalized.payload.sessions[0].state.settings.maxChars;
  normalized.payload.sessions[0].state = Object.fromEntries(Object.entries(normalized.payload.sessions[0].state).reverse());
  assert.deepEqual(await reopened.preflightRestore(['story'], normalized), expected);
  assert.deepEqual(await reopened.contentRevision(), { revision: restored.revision });
});

test('preflight detects complete stored-row differences and same-job replay never overwrites later owner changes', async t => {
  const source = await fixture(t);
  await source.store.setAuthorNote('story', { text: 'Imported direction', expectedRevision: 0 });
  const state = await source.service.exportState({ sessionIds: ['story'] });
  const edits = [
    (store, revision) => store.configure('story', { settings: { recentTurns: 2 }, expectedRevision: revision }),
    (store, revision) => store.setAuthorNote('story', { text: 'Later owner direction', expectedRevision: revision }),
    (store, revision) => store.savePlan('story', { anchor: 'anchor', representations: { [revisionId]: { mode: 'index' } }, unresolved: ['Later question'], expectedRevision: revision }),
    (store, revision) => store.cacheSummaries('story', { summaries: [{ id: revisionId, summary: 'Later summary' }], expectedRevision: revision }),
  ];
  for (const edit of edits) {
    const destination = await fixture(t);
    const restored = await destination.service.restoreState({ restoreId: 'owned-snapshot', sessionIds: ['story'], state, expectedRevision: 0 });
    assert.equal((await destination.service.preflightRestore({ sessionIds: ['story'], state })).supported, true);
    await assert.rejects(destination.service.restoreState({ restoreId: 'new-job-same-content', sessionIds: ['story'], state, expectedRevision: restored.revision }), { code: 'RESTORE_ID_CONFLICT' });
    await edit(destination.store, restored.revision);
    const current = await destination.store.exportState(['story']);
    const conflict = { supported: false, conflicts: [{ code: 'RESTORE_ID_CONFLICT', id: 'story' }], requirements: [] };
    assert.deepEqual(await destination.service.preflightRestore({ sessionIds: ['story'], state }), conflict);
    const reopened = await createContextStore({ directory: destination.directory });
    assert.deepEqual(await reopened.preflightRestore(['story'], state), conflict);
    assert.deepEqual(await reopened.restoreState({ restoreId: 'owned-snapshot', sessionIds: ['story'], state, expectedRevision: current.revision }), restored);
    assert.deepEqual(await reopened.exportState(['story']), current);
    await assert.rejects(reopened.restoreState({ restoreId: 'different-job', sessionIds: ['story'], state, expectedRevision: current.revision }), { code: 'RESTORE_ID_CONFLICT' });
    assert.deepEqual(await reopened.exportState(['story']), current);
  }
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
  destination.ctx.get = () => undefined;
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

test('unloading optional LastStep preserves validated consumption and leaves owner replacement reset and disable usable', async t => {
  const { state, proof } = await consumedState(t), destination = await fixture(t);
  let materialReads = 0;
  destination.ctx.get = name => name === 'rpLastStep' ? { material: async input => { materialReads++;return { presentationId: input.presentationId, contextPreparation: { authorNote: proof } }; } } : undefined;
  const restored = await destination.service.restoreState({ restoreId: 'optional-proof', sessionIds: ['story'], state, expectedRevision: 0 });
  const readsBeforeUnload = materialReads;destination.ctx.get = () => undefined;
  assert.equal((await destination.service.state({ sessionId: 'story' })).authorNote.status, 'consumed');
  assert.equal((await destination.service.authorNote({ sessionId: 'story' })).status, 'consumed');
  const unrelated = await destination.store.capturePreparation('story', { presentationId: 'unrelated', anchor: 'anchor', activeAnchors: ['anchor'], activePresentationAnchors: ['anchor'] });
  assert.equal(unrelated.authorNote, null);
  destination.ctx.get = name => name === 'rpLastStep' ? { narratives: async () => { throw Error('Optional narrative service unavailable'); }, material: async () => { materialReads++;throw Error('Old proof must not be requested'); } } : undefined;
  assert.equal((await destination.service.state({ sessionId: 'story' })).authorNote.status, 'consumed');
  destination.ctx.get = () => undefined;
  destination.sessions.set('story', [...events(), { seq: 4, type: 'user/message', surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 }, data: { id: 'result-only-rewind', source: { kind: 'runtime-context' }, content: [] } }]);
  assert.equal((await destination.service.state({ sessionId: 'story' })).authorNote.status, 'pending');
  destination.sessions.set('story', events());
  assert.equal((await destination.service.state({ sessionId: 'story' })).authorNote.status, 'consumed');
  const disabled = await destination.service.configure({ sessionId: 'story', settings: { enabled: false }, expectedRevision: restored.revision });
  assert.equal(disabled.settings.enabled, false);
  const replaced = await destination.service.setAuthorNote({ sessionId: 'story', text: 'New independent owner note', expectedRevision: disabled.revision });
  assert.equal(replaced.note.status, 'pending');assert.equal(replaced.note.version, proof.version + 1);
  await assert.rejects(destination.service.setAuthorNote({ sessionId: 'story', text: 'Stale edit', expectedRevision: disabled.revision }), { code: 'REVISION_CONFLICT' });
  const reset = await destination.service.setAuthorNote({ sessionId: 'story', text: '', expectedRevision: replaced.revision });
  assert.equal(reset.note, null);assert.equal((await destination.service.state({ sessionId: 'story' })).settings.enabled, false);
  await assert.rejects(destination.service.setAuthorNote({ sessionId: 'story', text: {}, expectedRevision: reset.revision }), { code: 'INVALID_AUTHOR_NOTE' });
  await assert.rejects(destination.service.configure({ sessionId: 'story', settings: { enabled: false, unknown: true }, expectedRevision: reset.revision }), { code: 'INVALID_SETTINGS' });
  assert.equal(materialReads, readsBeforeUnload);
  const stored = await destination.store.exportState(['story']);assert.equal(stored.payload.sessions[0].state.noteClaims['initial-claim'].status, 'consumed');
  await assert.rejects(destination.service.configure({ sessionId: 'missing', settings: { enabled: false }, expectedRevision: reset.revision }), { code: 'SESSION_NOT_FOUND' });
  const fresh = await fixture(t);await fresh.store.setAuthorNote('story', { text: 'A new claim still needs proof', expectedRevision: 0 });
  const captured = await fresh.store.capturePreparation('story', { presentationId: 'initial-claim', anchor: 'anchor' });
  await assert.rejects(fresh.service.presentationOutcome({ sessionId: 'story', presentationId: 'presentation', claimId: 'initial-claim', status: 'accepted' }), { code: 'PRESENTATION_NOT_ACCEPTED' });
  assert.equal((await fresh.store.contentRevision()).revision, captured.revision);
});

test('restore journal identity precedes deeper schema logs and proof and completed replay ignores expectedRevision changes', async t => {
  const { state, proof } = await consumedState(t), destination = await fixture(t);
  destination.ctx.get = name => name === 'rpLastStep' ? { material: async input => ({ presentationId: input.presentationId, contextPreparation: { authorNote: proof } }) } : undefined;
  const restored = await destination.service.restoreState({ restoreId: 'identity-first', sessionIds: ['story'], state, expectedRevision: 0 });
  let lookups = 0;destination.ctx.typertGateway.stream = async () => { lookups++;throw Error('No dependency lookup should happen'); };destination.ctx.get = () => { lookups++;throw Error('No material lookup should happen'); };
  const changed = structuredClone(state);changed.payload.sessions[0].state.authorNote.version = 2;changed.payload.sessions[0].state.authorNoteVersion = 2;changed.payload.sessions[0].state.noteClaims['initial-claim'].note.version = 2;
  await assert.rejects(destination.service.restoreState({ restoreId: 'identity-first', sessionIds: ['story'], state: changed, expectedRevision: restored.revision }), { code: 'RESTORE_ID_CONFLICT' });
  const changedSession = structuredClone(state);changedSession.payload.sessions[0].sessionId = 'not-imported';
  await assert.rejects(destination.service.restoreState({ restoreId: 'identity-first', sessionIds: ['not-imported'], state: changedSession, expectedRevision: restored.revision }), { code: 'RESTORE_ID_CONFLICT' });
  const changedSchema = structuredClone(state);changedSchema.payload.sessions[0].state.authorNote.version = 0;
  await assert.rejects(destination.service.restoreState({ restoreId: 'identity-first', sessionIds: ['story'], state: changedSchema, expectedRevision: restored.revision }), { code: 'RESTORE_ID_CONFLICT' });
  assert.deepEqual(await destination.service.restoreState({ restoreId: 'identity-first', sessionIds: ['story'], state, expectedRevision: 999 }), restored);
  await assert.rejects(destination.service.restoreState({ restoreId: 'identity-first', sessionIds: ['story'], state, expectedRevision: -1 }), { code: 'RESTORE_PAYLOAD_INVALID' });
  assert.equal(lookups, 0);assert.equal((await destination.store.contentRevision()).revision, restored.revision);
});

test('competing restore payloads serialize identity through proof and merge instead of racing dependency validation', async t => {
  const { state, proof } = await consumedState(t), destination = await fixture(t);
  let release, started, reads = 0;
  const gate = new Promise(resolve => release = resolve), ready = new Promise(resolve => started = resolve);
  destination.ctx.get = name => name === 'rpLastStep' ? { material: async input => { reads++;started();await gate;return { presentationId: input.presentationId, contextPreparation: { authorNote: proof } }; } } : undefined;
  const first = destination.service.restoreState({ restoreId: 'one-identity', sessionIds: ['story'], state, expectedRevision: 0 });
  await ready;
  const changed = structuredClone(state);changed.payload.sessions[0].state.authorNote.version = 2;changed.payload.sessions[0].state.authorNoteVersion = 2;changed.payload.sessions[0].state.noteClaims['initial-claim'].note.version = 2;
  const second = destination.service.restoreState({ restoreId: 'one-identity', sessionIds: ['story'], state: changed, expectedRevision: 0 });
  const rejected = assert.rejects(second, { code: 'RESTORE_ID_CONFLICT' });
  await new Promise(resolve => setImmediate(resolve));assert.equal(reads, 1);
  release();const result = await first;await rejected;
  assert.equal((await destination.store.contentRevision()).revision, result.revision);assert.equal(reads, 1);
});

test('a previously validated legacy local outcome with one canonical finisher remains consumed without optional proof service', async t => {
  const { state } = await consumedState(t), destination = await fixture(t);
  delete state.payload.sessions[0].state.noteClaims['initial-claim'].outcomePresentationId;
  // Bootstrap an existing trusted local row from the prior release, not the public restore entry point.
  await destination.store.restoreState({ restoreId: 'legacy-local-row', sessionIds: ['story'], state, expectedRevision: 0 });
  assert.equal((await destination.service.state({ sessionId: 'story' })).authorNote.status, 'consumed');
  destination.sessions.set('story', [...events(), { seq: 4, type: 'user/message', surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 }, data: { id: 'remove-legacy-result', source: { kind: 'runtime-context' }, content: [] } }]);
  assert.equal((await destination.service.state({ sessionId: 'story' })).authorNote.status, 'pending');
});

test('legacy ambiguous local bookkeeping stays unverified without LastStep and caches only a later strict finisher proof', async t => {
  const { state, proof } = await consumedState(t), destination = await fixture(t);
  delete state.payload.sessions[0].state.noteClaims['initial-claim'].outcomePresentationId;
  await destination.store.restoreState({ restoreId: 'legacy-ambiguous-local-row', sessionIds: ['story'], state, expectedRevision: 0 });
  destination.sessions.set('story', ambiguousPresentations());
  assert.equal((await destination.service.state({ sessionId: 'story' })).authorNote.status, 'consumed');
  assert.equal((await destination.store.authorNoteClaims('story'))['initial-claim'].outcomePresentationId, undefined);
  const records = [...ambiguousPresentations(), { seq: 6, type: 'user/message', surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 }, data: { id: 'remove-possible-finisher', source: { kind: 'runtime-context' }, content: [] } }];
  destination.sessions.set('story', records);
  assert.equal((await destination.service.state({ sessionId: 'story' })).authorNote.status, 'consumed');
  let reads = 0;
  destination.ctx.get = name => name === 'rpLastStep' ? { material: async input => { reads++;return { presentationId: input.presentationId, contextPreparation: { authorNote: input.presentationId === 'presentation' ? proof : { ...proof, id: 'unrelated-note' } } }; } } : undefined;
  assert.equal((await destination.service.state({ sessionId: 'story' })).authorNote.status, 'pending');
  assert.equal((await destination.store.authorNoteClaims('story'))['initial-claim'].outcomePresentationId, 'presentation');
  const checkedReads = reads;destination.ctx.get = () => undefined;destination.sessions.set('story', ambiguousPresentations());
  assert.equal((await destination.service.state({ sessionId: 'story' })).authorNote.status, 'consumed');assert.equal(reads, checkedReads);
  const revision = (await destination.store.contentRevision()).revision;
  assert.equal((await destination.service.setAuthorNote({ sessionId: 'story', text: 'New owner choice', expectedRevision: revision })).note.status, 'pending');
  const allGone = await fixture(t);
  await allGone.store.restoreState({ restoreId: 'legacy-all-results-gone', sessionIds: ['story'], state, expectedRevision: 0 });
  allGone.sessions.set('story', [...ambiguousPresentations(), { seq: 6, type: 'user/message', surfaceOp: { op: 'replace', startSeq: 3, endSeq: 5 }, data: { id: 'remove-all-possible-results', source: { kind: 'runtime-context' }, content: [] } }]);
  assert.equal((await allGone.service.state({ sessionId: 'story' })).authorNote.status, 'pending');
});

function maintenanceAgent() {
  let phase = 'idle', acquisitions = 0;
  const agent = { session: { id: 'story' }, get status() { return phase === 'idle' || phase === 'maintenance' ? 'idle' : 'running'; },
    runMaintenance(work) {
      acquisitions++;
      if (phase !== 'idle') throw Error('agent "story" already has active work');
      phase = 'maintenance';
      return Promise.resolve().then(work).finally(() => { phase = 'idle'; });
    } };
  return { agent, acquisitions: () => acquisitions, generate: () => { phase = 'running'; } };
}

test('standalone Context export checks a live idle Agent without acquiring host maintenance', async t => {
  const source = await fixture(t), live = maintenanceAgent();source.ctx.agents.get = id => id === 'story' ? live.agent : undefined;
  const state = await source.service.exportState({ sessionIds: ['story'] });
  assert.equal(state.payload.sessions[0].sessionId, 'story');assert.equal(live.acquisitions(), 0);
});

test('Context export composes with an owner-held nonreentrant SDK-shaped maintenance scope', async t => {
  const source = await fixture(t), live = maintenanceAgent();source.ctx.agents.get = id => id === 'story' ? live.agent : undefined;
  const state = await live.agent.runMaintenance(async () => {
    assert.equal(live.agent.status, 'idle');
    return source.service.exportState({ sessionIds: ['story'] });
  });
  assert.equal(state.payload.sessions[0].sessionId, 'story');assert.equal(live.acquisitions(), 1);
});

test('export rejects generation starting during capture even if canonical data has not advanced yet', async t => {
  const source = await fixture(t), live = maintenanceAgent();source.ctx.agents.get = () => live.agent;
  const read = source.ctx.typertGateway.stream;let reads = 0;
  source.ctx.typertGateway.stream = async input => { const value = await read(input);if (++reads === 2) live.generate();return value; };
  await assert.rejects(source.service.exportState({ sessionIds: ['story'] }), { code: 'EXPORT_CHANGED' });
});

test('standalone export still rejects relevant source revision and live-handle changes', async t => {
  const sourceChange = await fixture(t), read = sourceChange.ctx.typertGateway.stream;let reads = 0;
  sourceChange.ctx.typertGateway.stream = async input => { if (++reads === 2) sourceChange.sessions.get('story').push({ seq: 4, type: 'user/message', surfaceOp: 'append', data: { id: 'changed-source', source: { kind: 'user' }, content: [] } });return read(input); };
  await assert.rejects(sourceChange.service.exportState({ sessionIds: ['story'] }), { code: 'EXPORT_CHANGED' });
  const revisionChange = await fixture(t), capture = revisionChange.store.exportState;
  revisionChange.store.exportState = async ids => { const value = await capture(ids);await revisionChange.store.configure('story', { settings: { recentTurns: 2 }, expectedRevision: value.revision });return value; };
  await assert.rejects(revisionChange.service.exportState({ sessionIds: ['story'] }), { code: 'EXPORT_CHANGED' });
  const handleChange = await fixture(t), first = maintenanceAgent(), second = maintenanceAgent();let lookups = 0;
  handleChange.ctx.agents.get = () => ++lookups === 1 ? first.agent : second.agent;
  await assert.rejects(handleChange.service.exportState({ sessionIds: ['story'] }), { code: 'EXPORT_CHANGED' });
});
