import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContextStore } from '../src/store.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'rp-context-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: await createContextStore({ directory }) };
}

test('anchored plans filter rewound branches, restart, and return detached reads', async t => {
  const { directory, store } = await fixture(t);
  assert.equal((await store.view('../session')).revision, 0);
  await store.savePlan('../session', { representations: { h1: { mode: 'index' } }, unresolved: ['Old question'], expectedRevision: 0, anchor: 'a1' });
  await store.savePlan('../session', { representations: { h1: { mode: 'full' } }, unresolved: ['New question'], expectedRevision: 1, anchor: 'a2' });
  const rewound = await store.view('../session', { activeAnchors: ['a1'] });
  assert.deepEqual(rewound.representations, { h1: { mode: 'index' } });
  assert.deepEqual(rewound.unresolved, ['Old question']);
  rewound.representations.h1.mode = 'full';
  const reopened = await createContextStore({ directory });
  assert.equal((await reopened.view('../session', { activeAnchors: ['a1'] })).representations.h1.mode, 'index');
  assert.deepEqual((await reopened.view('../session', { activeAnchors: [] })).representations, {});
  assert.deepEqual(await readdir(directory), ['state.json']);
  const persisted = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
  assert.equal(Object.keys(persisted.sessions).some(key => key.includes('session')), false);
});

test('required revisions reject missing or stale writes across handles sharing a directory', async t => {
  const { directory, store } = await fixture(t);
  await assert.rejects(store.configure('s', { settings: { maxSteps: 2 } }), { code: 'INVALID_REVISION' });
  const other = await createContextStore({ directory });
  const settled = await Promise.allSettled([
    store.configure('s', { settings: { maxSteps: 2 }, expectedRevision: 0 }),
    other.configure('s', { settings: { maxSteps: 3 }, expectedRevision: 0 }),
  ]);
  assert.equal(settled.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(settled.find(item => item.status === 'rejected').reason.code, 'REVISION_CONFLICT');
  assert.equal((await other.view('s')).settings.maxSteps, 2);
  await assert.rejects(store.configure('s', { settings: { representations: {} }, expectedRevision: 1 }), { code: 'INVALID_SETTINGS' });
});

test('fork preserves active parent plan causality and independent summaries, settings and questions', async t => {
  const { store } = await fixture(t);
  await store.configure('parent', { settings: { recentTurns: 2 }, expectedRevision: 0 });
  await store.cacheSummaries('parent', { summaries: [{ id: 'h1', summary: 'Actual summary' }], expectedRevision: 1 });
  await store.savePlan('parent', { representations: { h1: { mode: 'index' } }, unresolved: ['Question'], anchor: 'a1', expectedRevision: 2 });
  await store.savePlan('parent', { representations: { h1: { mode: 'full' } }, unresolved: [], anchor: 'a2', expectedRevision: 3 });
  await store.forkSession('parent', 'child', { activeAnchors: ['a1'], expectedRevision: 4 });
  await store.configure('parent', { settings: { recentTurns: 3 }, expectedRevision: 5 });
  const child = await store.view('child', { activeAnchors: ['a1'] });
  assert.equal(child.settings.recentTurns, 2);
  assert.deepEqual(child.representations, { h1: { mode: 'index' } });
  assert.deepEqual(child.unresolved, ['Question']);
  assert.deepEqual(child.summaries, { h1: 'Actual summary' });
  const rewound = await store.view('child', { activeAnchors: [] });
  assert.deepEqual(rewound.representations, {});
  assert.deepEqual(rewound.unresolved, []);
  assert.deepEqual((await store.view('child', { activeAnchors: ['a2'] })).representations, {});
  await assert.rejects(store.forkSession('parent', 'child', { expectedRevision: 6 }), { code: 'SESSION_EXISTS' });
});

test('malformed plan anchors, representations, summaries and unresolved never persist', async t => {
  const { store } = await fixture(t);
  const valid = { representations: {}, unresolved: [], anchor: 'a1', expectedRevision: 0 };
  for (const patch of [{ anchor: '' }, { representations: { h: { mode: 'execute' } } }, { unresolved: ['q', null] }]) {
    await assert.rejects(store.savePlan('s', { ...valid, ...patch }));
  }
  await assert.rejects(store.cacheSummaries('s', { summaries: [{ id: 'h', summary: '' }], expectedRevision: 0 }));
  assert.equal((await store.view('s')).revision, 0);
});

test('savePlan reserves revision before external commit and queues concurrent configuration', async t => {
  const { directory, store } = await fixture(t);
  const other = await createContextStore({ directory });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let externalCommits = 0;
  const save = store.savePlan('s', { representations: {}, unresolved: [], expectedRevision: 0, anchor: 'a', beforeCommit: async () => { entered(); await gate; externalCommits++; } });
  // A missing callback would finish the save and fail this assertion without hanging.
  await Promise.race([started, save]);
  assert.equal(externalCommits, 0);
  const configuration = other.configure('s', { settings: { maxSteps: 3 }, expectedRevision: 0 });
  release();
  await save;
  await assert.rejects(configuration, { code: 'REVISION_CONFLICT' });
  assert.equal(externalCommits, 1);
  await assert.rejects(store.savePlan('s', { representations: {}, unresolved: [], expectedRevision: 0, anchor: 'b', beforeCommit: () => { externalCommits++; } }), { code: 'REVISION_CONFLICT' });
  assert.equal(externalCommits, 1);
});
