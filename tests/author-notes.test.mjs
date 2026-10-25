import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContextStore } from '../src/store.mjs';
import { createPlanner } from '../src/planner.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'rp-author-note-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await createContextStore({ directory });
  return { store, input: { sessionId: 'story', anchor: 'assistant', history: [], baseModel: { provider: 'local', model: 'fixture' } } };
}

test('author note capture is consistent, exclusive and versioned; a retry consumes its original claim only', async t => {
  const { store } = await fixture(t);
  const initial = await store.setAuthorNote('story', { text: 'Keep the prose spare.', expectedRevision: 0 });
  const captured = await store.capturePreparation('story', { presentationId: 'first', anchor: 'assistant', activeAnchors: ['assistant'] });
  assert.equal(captured.revision, initial.revision + 1);
  assert.equal(captured.authorNote.status, 'claimed');
  assert.equal(captured.authorNote.claimedBy, 'first');
  const repeated = await store.capturePreparation('story', { presentationId: 'first', anchor: 'assistant' });
  assert.equal(repeated.revision, captured.revision);
  assert.deepEqual(repeated.authorNote, captured.authorNote);
  const unrelated = await store.capturePreparation('story', { presentationId: 'unrelated', anchor: 'assistant' });
  assert.equal(unrelated.authorNote, null);
  await assert.rejects(store.setAuthorNote('story', { text: 'Stale edit', expectedRevision: initial.revision }), { code: 'REVISION_CONFLICT' });
  const replacement = await store.setAuthorNote('story', { text: 'A new direction.', expectedRevision: captured.revision });
  assert.equal(replacement.note.version, initial.note.version + 1);
  await store.presentationOutcome('story', { presentationId: 'writer-retry', claimId: 'first', status: 'accepted', anchor: 'accepted' });
  const next = await store.view('story');
  assert.equal(next.authorNote.text, 'A new direction.');
  assert.equal(next.authorNote.status, 'pending');
  assert.equal(captured.authorNote.text, 'Keep the prose spare.');
  const second = await store.capturePreparation('story', { presentationId: 'second', anchor: 'assistant' });
  const kept = await store.presentationOutcome('story', { presentationId: 'second', status: 'failed-after-freeze' });
  assert.equal(kept.revision, second.revision);
  assert.equal((await store.view('story')).authorNote.status, 'claimed');
  const released = await store.presentationOutcome('story', { presentationId: 'second', status: 'failed-before-freeze' });
  assert.equal((await store.view('story')).authorNote.status, 'pending');
  assert.equal((await store.presentationOutcome('story', { presentationId: 'second', status: 'failed-before-freeze' })).revision, released.revision);
});

test('material preparation freezes owner writing guidance and releases its claim on pre-return failure', async t => {
  const f = await fixture(t);
  await f.store.setAuthorNote('story', { text: 'Use brief sentences.', expectedRevision: 0 });
  let calls = 0;
  const planner = createPlanner({ store: f.store, callModel: async request => {
    calls++;
    assert.equal((await f.store.view('story')).authorNote.status, 'claimed');
    assert.equal(request.input.authorNote, 'Use brief sentences.');
    assert.equal(request.input.factReceiptId, 'receipt');
    return { text: JSON.stringify({ notes: 'Rain remains visible.', commit: true }) };
  } });
  const result = await planner.prepare({ ...f.input, presentationId: 'first', factReceiptId: 'receipt', story: { title: 'Story' } });
  assert.deepEqual(result.authorNote, { id: (await f.store.view('story')).authorNote.id, version: 1, claimId: 'first' });
  assert.match(result.materials.guidance, /Owner writing guidance[^\n]*\nUse brief sentences\./);
  assert.equal(result.materials.entries.length, 0);
  await f.store.setAuthorNote('story', { text: 'Later owner note.', expectedRevision: result.revision });
  assert.match(result.materials.guidance, /Use brief sentences/);
  assert.equal(result.materials.guidance.includes('Later owner note'), false);
  const broken = createPlanner({ store: f.store, callModel: async () => { throw new Error('Fixture provider failed'); } });
  await assert.rejects(broken.prepare({ ...f.input, presentationId: 'second' }), /Fixture provider failed/);
  assert.equal((await f.store.view('story')).authorNote.status, 'pending');
  assert.equal(calls, 1);
});

test('the note is claimed before a missing-history summary call and legacy callers do not claim it', async t => {
  const f = await fixture(t);
  await f.store.setAuthorNote('story', { text: 'Owner direction.', expectedRevision: 0 });
  await f.store.configure('story', { settings: { recentTurns: 1 }, expectedRevision: 1 });
  const calls = [];
  const planner = createPlanner({ store: f.store, callModel: async request => {
    calls.push(request.stageId);
    assert.equal((await f.store.view('story')).authorNote.claimedBy, 'presentation');
    return { text: JSON.stringify(request.stageId === 'rp-context.summarize' ? { summaries: [{ id: 'old', summary: 'Exact factual summary.' }] } : { commit: true }) };
  } });
  const history = [0, 1].map(index => ({ id: index ? 'new' : 'old', anchor: `a${index}`, turn: index, action: '', text: 'Exact prose.', source: { assistantMessageId: `a${index}` } }));
  await planner.prepare({ ...f.input, history, presentationId: 'presentation' });
  assert.equal(calls[0], 'rp-context.summarize');
  const legacy = await fixture(t);
  await legacy.store.setAuthorNote('story', { text: 'Pending.', expectedRevision: 0 });
  const noClaim = createPlanner({ store: legacy.store, callModel: async () => ({ text: '{"commit":true}' }) });
  assert.equal((await noClaim.prepare(legacy.input)).authorNote, undefined);
  assert.equal((await legacy.store.view('story')).authorNote.status, 'pending');
});

test('note claim and accepted anchors project through rollback; forks copy only pending text under a new ID', async t => {
  const { store } = await fixture(t);
  const initial = await store.setAuthorNote('story', { text: 'Owner configuration.', expectedRevision: 0 });
  await store.capturePreparation('story', { presentationId: 'first', anchor: 'claim-anchor', activeAnchors: ['claim-anchor'] });
  await store.presentationOutcome('story', { presentationId: 'retry', claimId: 'first', status: 'accepted', anchor: 'accepted-anchor' });
  assert.equal((await store.view('story', { activeAnchors: ['claim-anchor', 'accepted-anchor'] })).authorNote.status, 'consumed');
  assert.equal((await store.view('story', { activeAnchors: ['claim-anchor'] })).authorNote.status, 'pending');
  assert.equal((await store.view('story', { activeAnchors: [] })).authorNote.status, 'pending');
  let revision = (await store.view('story')).revision;
  await store.forkSession('story', 'before-accepted', { activeAnchors: ['claim-anchor'], expectedRevision: revision });
  const child = (await store.view('before-accepted')).authorNote;
  assert.equal(child.status, 'pending');assert.equal(child.text, initial.note.text);assert.notEqual(child.id, initial.note.id);assert.equal(child.claimedBy, undefined);
  revision = (await store.view('story')).revision;
  await store.forkSession('story', 'after-accepted', { activeAnchors: ['claim-anchor', 'accepted-anchor'], expectedRevision: revision });
  assert.equal((await store.view('after-accepted')).authorNote, null);
  revision = (await store.view('story')).revision;
  await store.setAuthorNote('story', { text: 'Later owner replacement.', expectedRevision: revision });
  assert.equal((await store.view('story', { activeAnchors: [] })).authorNote.text, 'Later owner replacement.');
});
