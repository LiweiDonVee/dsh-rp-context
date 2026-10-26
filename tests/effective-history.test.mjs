import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContextHost } from '../src/host.mjs';
import { createContextStore } from '../src/store.mjs';
import { narrativeHistory, projectSession } from '../src/session.mjs';

// Contract-shaped owner responses exercise Context; these are not native owner integration evidence.
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'rp-context-effective-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const events = [], calls = [], materials = new Map();
  const agent = { session: { id: 'story', header: { id: 'story' }, snapshotEvents: () => events }, ctx: { tools: { register: () => () => {} } } };
  const canonical = () => narrativeHistory(projectSession({ header: agent.session.header, records: events })).map(({ source, anchor: _anchor, ...record }) => ({ ...record, ref: source }));
  const f = { directory, events, calls, materials, agent, projection: null, reply: { commit: true }, historyReads: 0 };
  const last = {
    capabilities: { narrativeRevisions: 1 },
    narratives: async () => ({ records: canonical() }),
    storyHistory: async () => { f.historyReads++;return structuredClone(f.projection); },
    material: async ({ presentationId }) => ({ presentationId, contextPreparation: materials.get(presentationId) }),
  };
  const ctx = { on: () => () => {}, emit: () => {}, get: name => name === 'rpLastStep' ? last : undefined,
    agents: { get: id => id === 'story' ? agent : undefined, list: () => [agent] }, connection: { browserPeer: { id: 'owner' } },
    typertGateway: { stream: async () => ({ async *[Symbol.asyncIterator]() { yield { type: 'snapshot', header: agent.session.header, cursor: events.at(-1)?.seq ?? 0, hasMore: false, records: events.map(event => ({ type: 'event', event })) }; } }) },
  };
  const store = await createContextStore({ directory });
  const service = await createContextHost(ctx, { store, callModel: async request => {
    calls.push(structuredClone({ ...request, signal: undefined }));
    return typeof f.reply === 'function' ? f.reply(request) : { text: JSON.stringify(f.reply) };
  } });
  t.after(() => service.close());
  return Object.assign(f, { store, service, ctx, last, canonical });
}

const groupForReceipt = receipt => receipt === 'fact-older' ? 'older-round' : receipt === 'fact-next' ? 'next-round' : 'round';
function append(f, id, text, factReceiptId = 'fact-old', turn = f.events.length + 1) {
  const seq = f.events.length, anchor = `anchor-${id}`, callId = `call-${id}`, groupId = groupForReceipt(factReceiptId);
  f.events.push({ seq, type: 'user/message', surfaceOp: 'append', data: { id: `input-${id}`, source: { kind: 'user' }, content: [{ type: 'text', text: `Action ${id}` }] } });
  f.events.push({ seq: seq + 1, type: 'assistant/message', surfaceOp: 'append', data: { turn, step: 1, message: { id: anchor, content: [{ type: 'tool-call', id: callId, name: 'rp_present' }] } } });
  f.events.push({ seq: seq + 2, type: 'tool/call', data: { turn, step: 1, name: 'rp_present', callId } });
  f.events.push({ seq: seq + 3, type: 'tool/result', surfaceOp: 'append', sourceEventSeqs: [seq + 2], data: { turn, step: 1,
    message: { id: `result-${id}`, toolCallId: callId, source: { kind: 'tool', callId }, content: [{ type: 'text', text }] },
    meta: { rpLastStep: { schemaVersion: 1, record: { id, status: 'complete', text, factReceiptId, narrativeVersion: { schemaVersion: 1, groupId, factRoundId: groupId, factRevision: factReceiptId === 'fact-new' ? 2 : 1, kind: 'original' } } } } } });
  return f.canonical().at(-1);
}

function select(f, key, records, activeFactReceiptId = 'fact-old') {
  const groupId = record => groupForReceipt(record.factReceiptId);
  const all = f.canonical(), groups = [...new Set([...all.map(groupId), 'round'])];
  f.projection = { schemaVersion: 1, records, projectionKey: key, folded: groups.map(id => {
    const selected = records.find(record => groupId(record) === id), active = id === 'round' ? activeFactReceiptId : id === 'next-round' ? 'fact-next' : 'fact-older';
    return { groupId: id, factRoundId: id, activeFactReceiptId: active, selectedPresentationId: selected?.ref.presentationId ?? null, pendingFacts: !selected,
      versions: all.filter(record => groupId(record) === id).map(record => ({ presentationId: record.ref.presentationId, factReceiptId: record.factReceiptId, resultSeq: record.ref.resultSeq })) };
  }) };
}

const prepare = (f, extra = {}) => f.service.prepare({ sessionId: 'story', agent: f.agent, baseModel: { provider: 'fixture', model: 'context' }, packet: { playerAction: 'CURRENT_FACT_PACKET' }, ...extra });

test('effective selection supplies fresh writer material while canonical append-only prose stays available for proof', async t => {
  const f = await fixture(t), old = append(f, 'old', 'SUPERSEDED_BODY'), selected = append(f, 'new', 'CURRENT_BODY', 'fact-new');
  await f.store.cacheSummaries('story', { summaries: [{ id: old.id, summary: 'SUPERSEDED_SUMMARY' }], expectedRevision: 0 });
  select(f, 'projection-new', [selected], 'fact-new');
  const result = await prepare(f);
  assert.deepEqual(result.materials.recentProse, ['CURRENT_BODY']);
  assert.equal(JSON.stringify(f.calls).includes('SUPERSEDED_BODY'), false);
  assert.equal(JSON.stringify(f.calls).includes('SUPERSEDED_SUMMARY'), false);
  assert.deepEqual((await f.last.narratives()).records.map(record => record.text), ['SUPERSEDED_BODY', 'CURRENT_BODY']);
  assert.deepEqual((await f.service.state({ sessionId: 'story' })).history.map(record => record.text), ['CURRENT_BODY']);
  assert.deepEqual(result.historyProjection, { schemaVersion: 1, projectionKey: 'projection-new', selectedPresentationIds: ['new'], activeFactReceiptIds: ['fact-new'] });
});

test('an active revised fact receipt without accepted prose never includes the previous fact body', async t => {
  const f = await fixture(t);append(f, 'old', 'OLD_FACT_BODY');select(f, 'facts-awaiting-prose', [], 'fact-new');
  const result = await prepare(f, { factReceiptId: 'fact-new' });
  assert.deepEqual(result.materials.history, []);
  assert.equal(JSON.stringify(f.calls).includes('OLD_FACT_BODY'), false);
  assert.deepEqual(result.historyProjection, { schemaVersion: 1, projectionKey: 'facts-awaiting-prose', selectedPresentationIds: [], activeFactReceiptIds: ['fact-new'] });
});

test('folding accepted prose preserves consumed note proof and writer-only acceptance leaves a newer owner note pending', async t => {
  const f = await fixture(t), old = append(f, 'old', 'Old accepted prose');select(f, 'old-projection', [old]);
  await f.service.setAuthorNote({ sessionId: 'story', text: 'Old consumed guidance', expectedRevision: 0 });
  const frozen = await prepare(f, { presentationId: 'old-claim' });f.materials.set('old', frozen);
  await f.service.presentationOutcome({ sessionId: 'story', presentationId: 'old', claimId: 'old-claim', status: 'accepted' });
  select(f, 'facts-awaiting-prose', [], 'fact-new');
  assert.equal((await f.service.authorNote({ sessionId: 'story' })).status, 'consumed');
  assert.equal((await f.service.state({ sessionId: 'story' })).authorNote.status, 'consumed');
  const revised = append(f, 'writer-revision', 'New accepted prose', 'fact-new');select(f, 'writer-projection', [revised], 'fact-new');
  const revision = (await f.store.contentRevision()).revision;
  const owner = await f.service.setAuthorNote({ sessionId: 'story', text: 'Pending for a future fact preparation', expectedRevision: revision });
  f.materials.set('writer-revision', frozen);
  const modelCount = f.calls.length;
  await f.service.presentationOutcome({ sessionId: 'story', presentationId: 'writer-revision', claimId: 'old-claim', status: 'accepted' });
  const pending = await f.service.authorNote({ sessionId: 'story' });
  assert.equal(pending.status, 'pending');assert.equal(pending.version, owner.note.version);assert.equal(f.calls.length, modelCount);
  const next = await prepare(f, { presentationId: 'new-fact-claim', factReceiptId: 'fact-new' });
  assert.equal(next.authorNote.version, pending.version);assert.equal(next.authorNote.claimId, 'new-fact-claim');
});

test('actual causal removal of the original canonical accepting result still releases its consumed note', async t => {
  const f = await fixture(t), old = append(f, 'old', 'Old accepted prose');select(f, 'original', [old]);
  await f.service.setAuthorNote({ sessionId: 'story', text: 'Consumed guidance', expectedRevision: 0 });
  const frozen = await prepare(f, { presentationId: 'claim' });f.materials.set('old', frozen);
  await f.service.presentationOutcome({ sessionId: 'story', presentationId: 'old', claimId: 'claim', status: 'accepted' });
  const revised = append(f, 'new', 'Replacement selected prose', 'fact-new');select(f, 'revised', [revised], 'fact-new');
  assert.equal((await f.service.authorNote({ sessionId: 'story' })).status, 'consumed');
  f.events.push({ seq: f.events.length, type: 'user/message', surfaceOp: { op: 'replace', startSeq: old.ref.resultSeq, endSeq: old.ref.resultSeq }, data: { id: 'remove-original', source: { kind: 'runtime-context' }, content: [] } });
  assert.equal((await f.service.authorNote({ sessionId: 'story' })).status, 'pending');
});

test('prepare freezes historyProjection from the captured effective response before the model request settles', async t => {
  const f = await fixture(t), old = append(f, 'old', 'Captured prose');select(f, 'captured-projection', [old]);
  let release, started;
  const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { started = resolve; });
  f.reply = async () => { started();await gate;return { text: '{"commit":true}' }; };
  const pending = prepare(f);await ready;
  select(f, 'later-projection', [], 'fact-new');release();
  const result = await pending;
  assert.deepEqual(result.historyProjection, { schemaVersion: 1, projectionKey: 'captured-projection', selectedPresentationIds: ['old'], activeFactReceiptIds: ['fact-old'] });
  assert.deepEqual(result.materials.recentProse, ['Captured prose']);assert.equal(f.historyReads, 1);
});

test('replacing a selected fact group discards stale automatic plans and unresolved while retaining exact earlier summaries', async t => {
  const f = await fixture(t), older = append(f, 'older', 'Earlier effective source', 'fact-older', 1), latest = append(f, 'latest', 'Latest effective source', 'fact-old', 2);
  select(f, 'basis-one', [older, latest]);
  await f.service.configure({ sessionId: 'story', settings: { recentTurns: 1, maxSteps: 2 }, expectedRevision: 0 });
  let summaries = 0;
  f.reply = request => request.stageId === 'rp-context.summarize'
    ? { text: JSON.stringify({ summaries: [{ id: older.id, summary: ++summaries === 1 ? 'EXACT_EARLIER_SUMMARY' : 'Unexpected regenerated summary' }] }) }
    : { text: JSON.stringify({ ...(f.calls.length === 2 ? { historyOperations: [{ id: older.id, mode: 'index' }], unresolved: ['OLD_AUTO_FACT_PACKET'] } : {}), commit: true }) };
  await prepare(f);
  const before = f.calls.length, revised = append(f, 'revised', 'Revised effective source', 'fact-new', 3);select(f, 'basis-two', [older, revised], 'fact-new');
  const state = await f.service.state({ sessionId: 'story' });
  assert.deepEqual(state.unresolved, []);assert.equal(state.history[0].summary, 'EXACT_EARLIER_SUMMARY');assert.equal(state.history[0].mode, 'summary');
  const result = await prepare(f);
  assert.equal(summaries, 1);
  assert.equal(JSON.stringify(f.calls.slice(before)).includes('OLD_AUTO_FACT_PACKET'), false);
  assert.equal(JSON.stringify(f.calls.slice(before)).includes('Latest effective source'), false);
  assert.equal(JSON.stringify(result.materials).includes('EXACT_EARLIER_SUMMARY'), true);
  assert.equal(state.settings.maxSteps, 2);
});

test('missing new-feature history blocks dependent material operations while independent owner settings and notes remain usable', async t => {
  const f = await fixture(t);append(f, 'old', 'Old revision must not leak');delete f.last.storyHistory;
  await assert.rejects(prepare(f), { code: 'EFFECTIVE_HISTORY_UNAVAILABLE' });assert.equal(f.calls.length, 0);
  const changed = await f.service.configure({ sessionId: 'story', settings: { enabled: false }, expectedRevision: 0 });
  const note = await f.service.setAuthorNote({ sessionId: 'story', text: 'Independent pending note', expectedRevision: changed.revision });
  assert.equal((await f.service.authorNote({ sessionId: 'story' })).status, 'pending');
  assert.equal((await f.store.view('story')).settings.enabled, false);
  assert.equal(await prepare(f), null);
  assert.equal(note.note.text, 'Independent pending note');
});

test('transfer retains optional material basis and caches while consumed note restore uses the excluded canonical prose', async t => {
  const f = await fixture(t), old = append(f, 'old', 'Original canonical proof', 'fact-older', 1), latest = append(f, 'latest', 'Latest canonical prose', 'fact-old', 2);
  select(f, 'saved-basis', [old, latest]);
  await f.service.configure({ sessionId: 'story', settings: { recentTurns: 1 }, expectedRevision: 0 });
  await f.service.setAuthorNote({ sessionId: 'story', text: 'Strict consumed note', expectedRevision: 1 });
  f.reply = request => ({ text: request.stageId === 'rp-context.summarize' ? JSON.stringify({ summaries: [{ id: old.id, summary: 'Saved exact summary' }] }) : '{"commit":true}' });
  const frozen = await prepare(f, { presentationId: 'claim' });f.materials.set('latest', frozen);
  await f.service.presentationOutcome({ sessionId: 'story', presentationId: 'latest', claimId: 'claim', status: 'accepted' });
  select(f, 'superseded-basis', [], 'fact-new');
  const saved = await f.service.exportState({ sessionIds: ['story'] }), row = saved.payload.sessions[0].state;
  assert.deepEqual(row.plans[0].historyProjection, frozen.historyProjection);
  assert.equal(row.summaryProjectionKeys[old.id], 'saved-basis');
  const destination = await fixture(t);destination.events.push(...structuredClone(f.events));destination.projection = structuredClone(f.projection);destination.materials.set('latest', frozen);
  await destination.service.restoreState({ sessionIds: ['story'], restoreId: 'effective-history', state: saved, expectedRevision: 0 });
  const restored = await destination.service.state({ sessionId: 'story' });
  assert.equal(restored.authorNote.status, 'consumed');assert.deepEqual(restored.history, []);assert.deepEqual(restored.unresolved, []);assert.equal(destination.calls.length, 0);
  select(destination, 'saved-basis', [old, latest]);
  assert.equal((await destination.service.state({ sessionId: 'story' })).history[0].summary, 'Saved exact summary');
  const forged = structuredClone(saved);forged.payload.sessions[0].state.noteClaims.claim.outcomePresentationId = 'projection-only-forgery';
  const rejected = await fixture(t);rejected.events.push(...structuredClone(f.events));rejected.projection = structuredClone(f.projection);rejected.materials.set('latest', frozen);
  await assert.rejects(rejected.service.restoreState({ sessionIds: ['story'], restoreId: 'forged-selection', state: forged, expectedRevision: 0 }), { code: 'RESTORE_PAYLOAD_INVALID' });
  assert.equal((await rejected.store.contentRevision()).revision, 0);
});

test('an inconsistent effective response cannot silently select a body from a superseded fact receipt', async t => {
  const f = await fixture(t), old = append(f, 'old', 'Superseded mismatched fact prose');select(f, 'inconsistent', [old], 'fact-new');
  await assert.rejects(prepare(f), { code: 'EFFECTIVE_HISTORY_UNAVAILABLE' });
  assert.equal(f.calls.length, 0);
});

test('ordinary append preserves exact-ref summary caches and automatic unresolved carry', async t => {
  const f = await fixture(t), older = append(f, 'older', 'Earlier source', 'fact-older', 1), latest = append(f, 'latest', 'Latest source', 'fact-old', 2);
  select(f, 'append-base', [older, latest]);await f.service.configure({ sessionId: 'story', settings: { recentTurns: 1 }, expectedRevision: 0 });
  const summaryInputs = [];
  f.reply = request => {
    if (request.stageId === 'rp-context.summarize') { summaryInputs.push(request.input.history.map(record => record.id));return { text: JSON.stringify({ summaries: request.input.history.map(record => ({ id: record.id, summary: 'Exact source summary' })) }) }; }
    return { text: '{"unresolved":["Still relevant question"],"commit":true}' };
  };
  await prepare(f);const next = append(f, 'next', 'Next round prose', 'fact-next', 3);select(f, 'ordinary-append', [older, latest, next]);
  const state = await f.service.state({ sessionId: 'story' });
  assert.deepEqual(state.unresolved, ['Still relevant question']);assert.equal(state.history[0].summary, 'Exact source summary');
  await prepare(f);
  assert.deepEqual(summaryInputs, [['["older",3]'], ['["latest",7]']]);
});

test('owner representations persist by exact selected ref across replacement of another fact group', async t => {
  const f = await fixture(t), older = append(f, 'older', 'Earlier selected prose', 'fact-older', 1), latest = append(f, 'latest', 'Latest selected prose', 'fact-old', 2);
  select(f, 'owner-base', [older, latest]);
  await f.service.represent({ sessionId: 'story', historyId: older.id, mode: 'index', expectedRevision: 0 });
  assert.equal((await f.service.state({ sessionId: 'story' })).history[0].mode, 'index');
  const revised = append(f, 'revised', 'Revised current prose', 'fact-new', 3);select(f, 'owner-revised', [older, revised], 'fact-new');
  assert.equal((await f.service.state({ sessionId: 'story' })).history[0].mode, 'index');
  assert.equal((await prepare(f)).materials.history[0].mode, 'index');
});

test('missing storyHistory checks actual Database groups even when revised facts have no prose metadata', async t => {
  const f = await fixture(t);append(f, 'legacy', 'Legacy canonical prose');delete f.events.at(-1).data.meta.rpLastStep.record.narrativeVersion;delete f.last.storyHistory;delete f.last.capabilities;
  const projection = { schemaVersion: 1, latestRoundId: 'captured', groups: [{ roundId: 'captured', source: { sessionId: 'story', assistantMessageId: 'fact-source', callSeq: 10, resultSeq: 11 }, activeReceiptId: 'new-fact-no-prose', factRevision: 2, pendingCandidateId: null }] };
  const db = { apiVersion: 2, capabilities: { factReview: 1 }, factReviewProjection: async () => projection, hasBinding: () => false, materialAccess: () => { throw Error('No binding'); } };
  f.ctx.get = name => name === 'rpLastStep' ? f.last : name === 'rpDatabase' ? db : undefined;
  await assert.rejects(prepare(f), { code: 'EFFECTIVE_HISTORY_UNAVAILABLE' });assert.equal(f.calls.length, 0);
  projection.groups = [];projection.latestRoundId = null;
  assert.deepEqual((await prepare(f)).materials.recentProse, ['Legacy canonical prose']);
});

test('state reports missing effective history without blocking owner controls or swallowing source authorization errors', async t => {
  const f = await fixture(t);append(f, 'old', 'Raw superseded prose');delete f.last.storyHistory;
  await f.service.setAuthorNote({ sessionId: 'story', text: 'Owner control remains available', expectedRevision: 0 });
  const state = await f.service.state({ sessionId: 'story' });
  assert.deepEqual(state.history, []);assert.equal(state.historyError.code, 'EFFECTIVE_HISTORY_UNAVAILABLE');assert.equal(state.revision, 1);
  assert.equal(state.settings.enabled, true);assert.equal(state.authorNote.status, 'pending');assert.equal(state.authorNote.text, 'Owner control remains available');
  f.last.storyHistory = async () => { throw Object.assign(new Error('Access denied'), { code: 'FORBIDDEN', status: 403 }); };
  await assert.rejects(f.service.state({ sessionId: 'story' }), { code: 'FORBIDDEN' });
});

test('unaccepted version metadata cannot turn a legacy story into a required effective-reader dependency', async t => {
  const f = await fixture(t);append(f, 'legacy', 'Accepted legacy prose');delete f.events.at(-1).data.meta.rpLastStep.record.narrativeVersion;delete f.last.storyHistory;
  f.events.push({ seq: 4, type: 'tool/result', surfaceOp: 'append', data: { meta: { rpLastStep: { schemaVersion: 1, record: { id: 'unaccepted', status: 'complete', text: 'Not a canonical narrative', narrativeVersion: { schemaVersion: 1, groupId: 'unaccepted-group', kind: 'original' } } } } } });
  assert.deepEqual((await prepare(f)).materials.recentProse, ['Accepted legacy prose']);
});

for (const method of ['narratives', 'storyHistory']) for (const ErrorType of [SyntaxError, TypeError]) {
  test(`${method} preserves the original unencoded ${ErrorType.name} instead of falling back or reporting a missing reader`, async t => {
    const f = await fixture(t), record = append(f, 'accepted', 'Accepted source');select(f, 'source-error-basis', [record]);
    const sourceError = new ErrorType('Malformed owner source payload');
    f.last[method] = async () => { throw sourceError; };
    await assert.rejects(f.service.state({ sessionId: 'story', agent: f.agent }), error => error === sourceError);
    assert.equal(f.calls.length, 0);
  });
}

test('an available effective reader may explicitly report its missing dependency without losing owner controls', async t => {
  const f = await fixture(t);append(f, 'accepted', 'Accepted source');
  await f.service.setAuthorNote({ sessionId: 'story', text: 'Pending owner choice', expectedRevision: 0 });
  f.last.storyHistory = async () => { throw Object.assign(new Error('Effective owner dependency missing'), { code: 'EFFECTIVE_HISTORY_UNAVAILABLE' }); };
  const state = await f.service.state({ sessionId: 'story', agent: f.agent });
  assert.equal(state.historyError.code, 'EFFECTIVE_HISTORY_UNAVAILABLE');assert.equal(state.authorNote.text, 'Pending owner choice');assert.equal(state.revision, 1);
});

async function inheritedFixture(t, mismatchedSource = false) {
  const parent = await fixture(t), original = append(parent, 'inherited', 'Verified inherited prose');
  const ownerRef = ({ callId: _localOnlyCallId, ...ref }) => ref;
  original.ref = ownerRef(original.ref);select(parent, 'actual-parent-key', [original]);
  const ref = { ...original.ref, ...(mismatchedSource ? { callId: 'different-call' } : {}) }, basis = { schemaVersion: 1, projectionKey: 'actual-parent-key', selectedPresentationIds: ['inherited'], activeFactReceiptIds: ['fact-old'] };
  await parent.store.savePlan('story', { anchor: original.ref.assistantMessageId, representations: { [original.id]: { mode: 'index' } }, unresolved: ['Inherited unresolved question'], historyProjection: basis, historyRefs: [ref], ownerRepresentationIds: [original.id], expectedRevision: 0 });
  await parent.store.cacheSummaries('story', { summaries: [{ id: original.id, summary: 'Verified inherited summary' }], historyProjection: basis, historyRefs: [ref], expectedRevision: 1 });
  const events = structuredClone(parent.events), agent = { session: { id: 'child', header: { id: 'child', parentSession: 'story' }, snapshotEvents: () => events }, ctx: { tools: { register: () => () => {} } } };
  const canonical = () => narrativeHistory(projectSession({ header: agent.session.header, records: events })).map(({ source, anchor: _anchor, ...record }) => ({ ...record, ref: ownerRef(source) }));
  const child = { events, agent, canonical, projection: null };select(child, 'actual-child-key', canonical());
  parent.ctx.agents.get = id => id === 'story' ? parent.agent : id === 'child' ? agent : undefined;
  parent.last.narratives = async ({ sessionId }) => ({ records: sessionId === 'child' ? canonical() : parent.canonical() });
  parent.last.storyHistory = async ({ sessionId }) => structuredClone(sessionId === 'child' ? child.projection : parent.projection);
  child.prepare = () => parent.service.prepare({ sessionId: 'child', agent, baseModel: { provider: 'fixture', model: 'context' }, packet: { playerAction: 'Child action' } });
  return { parent, child, original };
}

for (const change of ['replacement', 'removal']) test(`first child prepare preserves verified inherited material and ${change} still drops automatic carry`, async t => {
  const { parent, child, original } = await inheritedFixture(t);
  const prepared = await child.prepare();
  assert.equal(prepared.materials.history[0].mode, 'index');assert.deepEqual(prepared.materials.unresolved, ['Inherited unresolved question']);assert.equal(prepared.historyProjection.projectionKey, 'actual-child-key');
  const state = await parent.service.state({ sessionId: 'child', agent: child.agent });
  assert.equal(state.history[0].summary, 'Verified inherited summary');
  const inherited = (await parent.store.exportState(['child'])).payload.sessions[0].state;
  assert.equal(inherited.summaryRefs[original.id].sessionId, 'child');assert.equal(inherited.plans.at(-1).historyRefs[0].sessionId, 'child');assert.equal(inherited.plans.at(-1).historyProjection.projectionKey, 'actual-child-key');
  const parentState = (await parent.store.exportState(['story'])).payload.sessions[0].state;
  assert.equal(parentState.summaryRefs[original.id].sessionId, 'story');assert.equal(parentState.plans[0].historyProjection.projectionKey, 'actual-parent-key');
  if (change === 'replacement') {
    const revised = append(child, 'revised-child', 'New child prose', 'fact-new', 2);select(child, 'revised-child-key', [revised], 'fact-new');
  } else {
    child.events.push({ seq: child.events.length, type: 'user/message', surfaceOp: { op: 'replace', startSeq: original.ref.resultSeq, endSeq: original.ref.resultSeq }, data: { id: 'remove-inherited', source: { kind: 'runtime-context' }, content: [] } });
    select(child, 'removed-child-key', [], null);
  }
  const changed = await child.prepare();
  assert.deepEqual(changed.materials.unresolved, []);assert.equal(changed.materials.history.some(record => record.id === original.id), false);
});

test('fork mapping does not rewrite a different canonical source with the same presentation ID', async t => {
  const { child } = await inheritedFixture(t, true), prepared = await child.prepare();
  assert.equal(prepared.materials.history[0].mode, 'full');assert.deepEqual(prepared.materials.unresolved, []);
});
