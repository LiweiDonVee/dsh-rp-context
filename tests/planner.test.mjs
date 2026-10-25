import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContextStore } from '../src/store.mjs';
import { createPlanner } from '../src/planner.mjs';

const narrative = (index, overrides = {}) => ({ id: `h${index}`, anchor: `a${index}`, turn: index, action: `action ${index}`, text: `Exact narrative ${index}`, source: { sessionId: 's', assistantMessageId: `a${index}`, callSeq: index * 2, resultSeq: index * 2 + 1, callId: 'reused' }, ...overrides });
const entry = (id, extra = {}) => ({ id, title: id, content: `fact ${id}`, keywords: [], tags: [], notes: '', readOnly: false, mode: 'auto', version: 1, ...extra });
function database(entries) {
  let persisted = structuredClone(entries);
  let revision = 4;
  const commits = [];
  const searches = [];
  const reject = code => { throw Object.assign(new Error(code), { code }); };
  const facade = {
    snapshot: async () => ({ revision, databaseId: 'db', version: 2, entries: structuredClone(persisted), notes: [] }),
    search: async ({ query }) => {
      searches.push(query);
      return { revision, candidates: persisted.filter(item => item.mode !== 'disabled' && (query.includes('secret') ? item.id === 'outside' : item.id === 'near')), required: persisted.filter(item => item.mode === 'required'), degraded: [] };
    },
    select: (source, ids) => {
      const selected = ids.map(id => {
        const found = source.find(item => item.id === id);
        if (!found) reject('NOT_FOUND');
        if (found.mode === 'disabled') reject('DISABLED');
        return found;
      });
      return [...new Map([...selected, ...source.filter(item => item.mode === 'required')].map(item => [item.id, structuredClone(item)])).values()];
    },
    apply: (source, operations) => {
      const result = structuredClone(source);
      const notes = [];
      for (const operation of operations) {
        const target = result.find(item => item.id === operation.id);
        if (!target) reject('NOT_FOUND');
        if (target.mode === 'disabled') reject('DISABLED');
        if (target.readOnly) reject('READ_ONLY');
        if (operation.op === 'note' && typeof operation.text === 'string') notes.push({ id: target.id, text: operation.text });
        else if (operation.op === 'update' && operation.patch && Object.keys(operation.patch).every(key => ['content', 'notes', 'title'].includes(key))) { Object.assign(target, operation.patch); target.version++; }
        else reject('INVALID_OPERATION');
      }
      return { entries: result, notes };
    },
    commit: async ({ operations, expectedRevision, signal }) => {
      signal?.throwIfAborted();
      if (expectedRevision !== revision) reject('REVISION_CONFLICT');
      const applied = facade.apply(persisted, operations);
      persisted = applied.entries;
      commits.push(structuredClone(operations));
      return { revision: ++revision };
    },
  };
  return { facade, commits, searches, change: () => { revision++; }, edit: text => { persisted[0].content = text; } };
}
async function fixture(t, replies, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'rp-planner-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await createContextStore({ directory });
  const calls = [];
  const events = [];
  const planner = createPlanner({ store, publish: event => events.push(event), ...options, callModel: async request => {
    calls.push(structuredClone({ ...request, signal: undefined }));
    const reply = replies.shift();
    if (typeof reply === 'function') return reply(request);
    return { text: JSON.stringify(reply), config: request.config };
  } });
  return { planner, store, calls, events, input: { sessionId: 's', anchor: 'next', packet: { playerAction: 'Go near', sceneInstruction: 'Night', visibleConsequences: ['Rain'] }, history: [narrative(0)], baseModel: { provider: 'base', model: 'writer', maxTokens: 2000 } } };
}

test('no-database mode prepares frozen history and resolves stage routes once', async t => {
  let resolutions = 0;
  const route = { prepare: { provider: 'gm', model: 'planner', reasoningEffort: 'low' } };
  const f = await fixture(t, [request => {
    route.prepare.model = 'changed';
    return { text: JSON.stringify({ selectedEntries: [], notes: 'Keep rain visible', unresolved: ['Who follows?'], commit: true }), config: request.config };
  }], { resolveModels: async () => { resolutions++; return route; } });
  const result = await f.planner.prepare(f.input);
  f.input.history[0].text = 'Edited later';
  assert.equal(resolutions, 1);
  assert.equal(result.models.prepare.model, 'planner');
  assert.equal(result.models.prepare.maxTokens, 2000);
  assert.equal(result.materials.history[0].content, 'Exact narrative 0');
  assert.equal(result.materials.guidance, 'Keep rain visible');
  assert.deepEqual(result.materials.unresolved, ['Who follows?']);
  assert.equal(Object.isFrozen(result.materials), true);
  assert.equal(result.database, undefined);
  assert.equal(f.calls[0].stageId, 'rp-context.prepare');
  assert.match(f.calls[0].system, /RP_CONTEXT_PREPARE/);
  assert.deepEqual(f.events.map(event => event.status), ['prepared', 'running', 'complete']);
  assert.equal(JSON.stringify(f.events).includes('Exact narrative'), false);
});

test('shared model control overrides apply even without a provider or model override', async t => {
  const f = await fixture(t, [{commit:true}], {resolveModels:async()=>({reasoningEffort:'high',maxTokens:9000})});
  const result=await f.planner.prepare(f.input);
  assert.equal(result.models.prepare.reasoningEffort,'high');
  assert.equal(result.models.prepare.maxTokens,9000);
});

test('base model is captured before asynchronous store and route resolution', async t => {
  let input;
  const f = await fixture(t,[{commit:true}],{resolveModels:async()=>{input.baseModel.model='changed';input.baseModel.maxTokens=7;return {}}});
  input=f.input;
  const result=await f.planner.prepare(input);
  assert.equal(result.models.prepare.model,'writer');
  assert.equal(result.models.prepare.maxTokens,2000);
});

test('a different model route does not inherit reasoning controls belonging to the main model', async t => {
  const f=await fixture(t,[{commit:true}],{resolveModels:async()=>({prepare:{provider:'local',model:'fast'}})});
  f.input.baseModel.reasoningEffort='high';
  const result=await f.planner.prepare(f.input);
  assert.equal(result.models.prepare.reasoningEffort,undefined);
});

test('candidate-outside search and exact entry reads select a required union', async t => {
  const db = database([entry('near'), entry('outside'), entry('required', { mode: 'required' }), entry('hidden', { mode: 'disabled' })]);
  const f = await fixture(t, [
    { search: ['secret location'], commit: false },
    request => {
      assert.equal(request.input.searchResults[0].candidates[0].id, 'outside');
      return { text: JSON.stringify({ readEntries: ['outside'], commit: false }) };
    },
    request => {
      assert.equal(request.input.readEntries[0].content, 'fact outside');
      return { text: JSON.stringify({ selectedEntries: ['outside'], commit: true }) };
    },
  ]);
  const result = await f.planner.prepare({ ...f.input, database: db.facade });
  assert.deepEqual(result.materials.entries.map(item => item.id), ['outside', 'required']);
  assert.equal(db.searches[0], 'Go near\nNight\nRain');
  assert.deepEqual(db.searches.slice(1), ['secret location']);
  assert.equal(JSON.stringify(f.calls[0].input).includes('fact hidden'), false);
  assert.equal(JSON.stringify(f.calls[0].input).includes('fact outside'), false);
  assert.deepEqual(result.database.entryRefs, [{ id: 'outside', version: 1 }, { id: 'required', version: 1 }]);
  assert.equal(result.database.version, 2);
  assert.equal(db.commits.length, 0);
});

test('locked and disabled failures allow correction and never stage rejected changes', async t => {
  const db = database([entry('near'), entry('locked', { readOnly: true }), entry('hidden', { mode: 'disabled' })]);
  const f = await fixture(t, [
    { databaseOperations: [{ op: 'update', id: 'locked', patch: { content: 'bad' } }], commit: true },
    request => {
      assert.equal(request.input.diagnostics[0].code, 'READ_ONLY');
      return { text: JSON.stringify({ selectedEntries: ['hidden'], commit: true }) };
    },
    request => {
      assert.equal(request.input.diagnostics[0].code, 'DISABLED');
      return { text: JSON.stringify({ selectedEntries: ['near'], commit: true }) };
    },
  ]);
  const result = await f.planner.prepare({ ...f.input, database: db.facade });
  assert.equal(result.steps, 3);
  assert.equal(result.materials.entries[0].content, 'fact near');
  assert.equal(db.commits.length, 0);
});

test('local edits remain detached until valid material then commit accumulated operations exactly once', async t => {
  const db = database([entry('near')]);
  const f = await fixture(t, [
    { databaseOperations: [{ op: 'update', id: 'near', patch: { content: 'New fact' } }], commit: false },
    async request => {
      assert.equal((await db.facade.snapshot()).entries[0].content, 'fact near');
      assert.equal(request.input.candidates[0].excerpt, 'New fact');
      return { text: JSON.stringify({ selectedEntries: ['near'], commit: true }) };
    },
  ]);
  const result = await f.planner.prepare({ ...f.input, database: db.facade });
  assert.equal(db.commits.length, 1);
  assert.equal(result.materials.entries[0].content, 'New fact');
  assert.equal(result.materials.entries[0].version, 2);
  db.edit('Changed after freeze');
  assert.equal(result.materials.entries[0].content, 'New fact');
});

test('GM can expand exact active history and fold it without changing originals', async t => {
  const records = [narrative(0, { summary: 'Old summary' }), narrative(1)];
  const f = await fixture(t, [
    { readHistory: ['h0'], commit: false },
    request => {
      assert.equal(request.input.readHistory[0].text, 'Exact narrative 0');
      assert.deepEqual(request.input.readHistory[0].source, records[0].source);
      return { text: JSON.stringify({ historyOperations: [{ id: 'h0', mode: 'full' }, { id: 'h1', mode: 'index' }], commit: true }) };
    },
  ]);
  await f.store.configure('s', { settings: { recentTurns: 1 }, expectedRevision: 0 });
  const result = await f.planner.prepare({ ...f.input, history: records });
  assert.equal(result.materials.history[0].content, 'Exact narrative 0');
  assert.equal(result.materials.history[1].mode, 'index');
  assert.equal(records[0].text, 'Exact narrative 0');
});

test('missing actual summaries use bounded batches and a cache, never excerpts', async t => {
  const records = Array.from({ length: 11 }, (_, index) => narrative(index));
  const makeSummaries = request => ({ text: JSON.stringify({ summaries: request.input.history.map(item => ({ id: item.id, summary: `Fact summary for ${item.id}` })) }) });
  const f = await fixture(t, [makeSummaries, makeSummaries, { commit: true }, { commit: true }]);
  await f.store.configure('s', { settings: { recentTurns: 1 }, expectedRevision: 0 });
  const result = await f.planner.prepare({ ...f.input, history: records });
  assert.equal(result.materials.history[0].content, 'Fact summary for h0');
  assert.equal(result.materials.history.at(-1).content, 'Exact narrative 10');
  assert.deepEqual(f.calls.slice(0, 2).map(call => call.input.history.length), [8, 2]);
  assert.equal(f.calls[0].stageId, 'rp-context.summarize');
  await f.planner.prepare({ ...f.input, history: [records[0], records[10]] });
  assert.equal(f.calls.filter(call => call.stageId === 'rp-context.summarize').length, 2);
  assert.equal(f.calls.at(-1).input.history.some(item => item.id === 'h5'), false);
});

test('summary stage rejects wrong IDs and oversized records instead of inventing success', async t => {
  const f = await fixture(t, [{ summaries: [{ id: 'foreign', summary: 'Wrong' }] }]);
  await f.store.configure('s', { settings: { recentTurns: 1 }, expectedRevision: 0 });
  await assert.rejects(f.planner.prepare({ ...f.input, history: [narrative(0), narrative(1)] }), { code: 'INVALID_SUMMARY' });
  const g = await fixture(t, []);
  await g.store.configure('s', { settings: { recentTurns: 1 }, expectedRevision: 0 });
  await assert.rejects(g.planner.prepare({ ...g.input, history: [narrative(0, { text: 'x'.repeat(40000) }), narrative(1)] }), { code: 'SUMMARY_BUDGET' });
  assert.equal(g.calls.length, 0);
});

test('step exhaustion and malformed operations never yield partial materials or database writes', async t => {
  const db = database([entry('near')]);
  const f = await fixture(t, [{ databaseOperations: [{ op: 'update', id: 'near', patch: { content: 'staged only' } }], commit: false }, { execute: 'script', commit: true }]);
  await f.store.configure('s', { settings: { maxSteps: 2 }, expectedRevision: 0 });
  await assert.rejects(f.planner.prepare({ ...f.input, database: db.facade }), { code: 'MAX_STEPS', status: 409 });
  assert.equal(db.commits.length, 0);
  assert.equal((await db.facade.snapshot()).entries[0].content, 'fact near');
  assert.equal(f.events.at(-1).status, 'failed');
});

test('aggregate material budget rejects before database commit', async t => {
  const db = database([entry('near', { content: 'x'.repeat(1000), mode: 'required' })]);
  const f = await fixture(t, [{ databaseOperations: [{ op: 'update', id: 'near', patch: { notes: 'A note' } }], commit: true }]);
  await f.store.configure('s', { settings: { maxChars: 500 }, expectedRevision: 0 });
  await assert.rejects(f.planner.prepare({ ...f.input, database: db.facade }), { code: 'MATERIAL_BUDGET', status: 409 });
  assert.equal(db.commits.length, 0);
});

test('context and database revisions stop stale preparations before any write', async t => {
  const db = database([entry('near')]);
  const f = await fixture(t, [async () => {
    await f.store.configure('s', { settings: { maxSteps: 3 }, expectedRevision: 0 });
    return { text: JSON.stringify({ databaseOperations: [{ op: 'update', id: 'near', patch: { content: 'bad' } }], commit: true }) };
  }]);
  await assert.rejects(f.planner.prepare({ ...f.input, database: db.facade }), { code: 'REVISION_CONFLICT' });
  assert.equal(db.commits.length, 0);
  const g = await fixture(t, [() => {
    db.change();
    return { text: JSON.stringify({ commit: true }) };
  }]);
  await assert.rejects(g.planner.prepare({ ...g.input, database: db.facade }), { code: 'REVISION_CONFLICT' });
});

test('abort after model response leaves staged facts and context untouched', async t => {
  const controller = new AbortController();
  const db = database([entry('near')]);
  const f = await fixture(t, [() => {
    controller.abort();
    return { text: JSON.stringify({ databaseOperations: [{ op: 'update', id: 'near', patch: { content: 'bad' } }], commit: true }) };
  }]);
  await assert.rejects(f.planner.prepare({ ...f.input, database: db.facade, signal: controller.signal }), { code: 'CANCELLED' });
  assert.equal(db.commits.length, 0);
  assert.equal((await f.store.view('s')).revision, 0);
  assert.equal(f.events.at(-1).status, 'cancelled');
});

test('entry reads and search results use the staged version created in the same GM step', async t => {
  const db = database([entry('near')]);
  const f = await fixture(t, [
    { databaseOperations: [{ op: 'update', id: 'near', patch: { content: 'Staged current fact' } }], readEntries: ['near'], search: ['near'], commit: false },
    request => {
      assert.equal(request.input.readEntries[0].content, 'Staged current fact');
      assert.equal(request.input.searchResults[0].candidates[0].excerpt, 'Staged current fact');
      return { text: JSON.stringify({ selectedEntries: ['near'], commit: true }) };
    },
  ]);
  const result = await f.planner.prepare({ ...f.input, database: db.facade });
  assert.equal(result.materials.entries[0].content, 'Staged current fact');
});

test('invalid history compression allows correction and cannot stage a sibling database edit', async t => {
  const db = database([entry('near')]);
  const f = await fixture(t, [
    { databaseOperations: [{ op: 'update', id: 'near', patch: { content: 'Must be discarded' } }], historyOperations: [{ id: 'h0', mode: 'summary' }], commit: true },
    request => {
      assert.equal(request.input.diagnostics[0].code, 'MISSING_SUMMARY');
      return { text: JSON.stringify({ selectedEntries: ['near'], commit: true }) };
    },
  ]);
  const result = await f.planner.prepare({ ...f.input, database: db.facade });
  assert.equal(result.materials.entries[0].content, 'fact near');
  assert.equal(db.commits.length, 0);
});

function qualifiedDatabase() {
  const ref = (sourceKey, entryId) => ({ sourceKey, entryId });
  const key = value => JSON.stringify([value.sourceKey, value.entryId]);
  const binding = { schemaVersion: 2, sources: [{ key: 'alpha', databaseId: 'one', version: 2 }, { key: 'beta', databaseId: 'two', version: 4 }], factEntryRefs: [ref('@session', 'gm.facts')] };
  let persisted = [entry('same', { ref: ref('alpha', 'same'), content: 'Alpha original' }), entry('same', { ref: ref('beta', 'same'), content: 'Beta original', mode: 'required' }), entry('gm.facts', { ref: ref('@session', 'gm.facts'), content: 'Protected facts' })];
  let revision = 7;
  const commits = [];
  const reject = code => { throw Object.assign(new Error(code), { code }); };
  const facade = {
    version: 2,
    snapshot: async () => ({ revision, binding: structuredClone(binding), entries: structuredClone(persisted), notes: [], changes: [] }),
    search: async () => ({ revision, candidates: [{ key: key(ref('alpha', 'same')), ref: ref('alpha', 'same'), score: 1, reasons: ['keyword'] }], required: [{ key: key(ref('beta', 'same')), ref: ref('beta', 'same') }], degraded: [] }),
    select: (source, keys) => {
      const selected = keys.map(value => source.find(item => key(item.ref) === value) ?? reject('NOT_FOUND'));
      return structuredClone([...new Map([...selected, ...source.filter(item => item.mode === 'required')].map(item => [key(item.ref), item])).values()]);
    },
    apply: (source, operations) => {
      if (operations.some(operation => operation.id === key(ref('@session', 'gm.facts')))) reject('FACT_OWNER_REQUIRED');
      const entries = structuredClone(source);
      for (const operation of operations) {
        const target = entries.find(item => key(item.ref) === operation.id);
        if (!target) reject('NOT_FOUND');
        if (operation.op !== 'update' || typeof operation.patch?.content !== 'string') reject('INVALID_OPERATION');
        target.content = operation.patch.content; target.version++;
      }
      return { entries, notes: [] };
    },
    commit: async ({ operations, expectedRevision }) => {
      assert.equal(expectedRevision, revision);
      persisted = facade.apply(persisted, operations).entries;
      commits.push(structuredClone(operations));
      return { revision: ++revision };
    },
  };
  return { facade, binding, commits, alpha: key(ref('alpha', 'same')), beta: key(ref('beta', 'same')), facts: key(ref('@session', 'gm.facts')) };
}

test('v2 material facade keeps duplicate raw entry IDs distinct with qualified frozen refs', async t => {
  const db = qualifiedDatabase();
  const f = await fixture(t, [request => {
    assert.equal(request.input.database.binding.sources.length, 2);
    assert.equal(request.input.database.catalog[0].id, db.alpha);
    assert.equal(request.input.database.catalog[0].key, db.alpha);
    assert.deepEqual(request.input.candidates.map(item => item.key), [db.alpha, db.beta]);
    return { text: JSON.stringify({ readEntries: [db.alpha, db.beta], commit: false }) };
  }, request => {
    assert.deepEqual(request.input.readEntries.map(item => item.content), ['Alpha original', 'Beta original']);
    return { text: JSON.stringify({ databaseOperations: [{ op: 'update', id: db.alpha, patch: { content: 'Alpha staged' } }], selectedEntries: [db.alpha], commit: true }) };
  }]);
  const result = await f.planner.prepare({ ...f.input, database: db.facade });
  assert.deepEqual(result.materials.entries.map(item => item.content), ['Alpha staged', 'Beta original']);
  assert.deepEqual(result.database, { binding: db.binding, revision: 8, entryRefs: [{ sourceKey: 'alpha', entryId: 'same', version: 2 }, { sourceKey: 'beta', entryId: 'same', version: 1 }] });
  assert.equal(result.materials.entries[1].ref.sourceKey, 'beta');
  assert.equal(Object.isFrozen(result.database.binding.sources), true);
  assert.equal(result.candidates[0].key, db.alpha);
  assert.equal(result.candidates[0].score, 1);
  assert.deepEqual(result.candidates[0].reasons, ['keyword']);
  assert.equal(result.candidates[0].content, undefined);
  assert.equal(result.candidates[0].excerpt, undefined);
  assert.equal(db.commits.length, 1);
});

test('a mixed material batch touching GM-owned facts stages no otherwise-valid changes', async t => {
  const db = qualifiedDatabase();
  const f = await fixture(t, [
    { databaseOperations: [{ op: 'update', id: db.alpha, patch: { content: 'Must be discarded' } }, { op: 'update', id: db.facts, patch: { content: 'Forbidden' } }], commit: true },
    request => {
      assert.equal(request.input.diagnostics[0].code, 'FACT_OWNER_REQUIRED');
      assert.equal(request.input.candidates[0].excerpt, 'Alpha original');
      return { text: JSON.stringify({ selectedEntries: [db.alpha], commit: true }) };
    },
  ]);
  const result = await f.planner.prepare({ ...f.input, database: db.facade });
  assert.equal(result.materials.entries[0].content, 'Alpha original');
  assert.equal(db.commits.length, 0);
});
