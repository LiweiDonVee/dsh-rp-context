import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ContextError, validateSettings } from './core.mjs';

const queues = new Map();
const fail = (code, message, status) => { throw new ContextError(code, message, status); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function identifier(value) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_REFERENCE', 'A nonempty identifier is required');
  return value;
}
const key = value => createHash('sha256').update(identifier(value)).digest('hex');
function anchors(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail('INVALID_ANCHOR', 'Active anchors must be an array');
  return new Set(value.map(identifier));
}
function representationMap(value) {
  if (!object(value)) fail('INVALID_REPRESENTATION', 'Representations must be an object');
  for (const [id, item] of Object.entries(value)) {
    identifier(id);
    if (!object(item) || !['full', 'summary', 'index'].includes(item.mode) || Object.keys(item).some(name => !['mode', 'summary'].includes(name)) || (item.summary !== undefined && (typeof item.summary !== 'string' || !item.summary.trim()))) fail('INVALID_REPRESENTATION', 'Invalid history representation');
  }
  return structuredClone(value);
}
function questions(value) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) fail('INVALID_PLAN', 'Unresolved matters must be text strings');
  return [...value];
}
const fresh = () => ({ settings: validateSettings({}), baseline: { representations: {}, unresolved: [] }, plans: [], summaries: {} });
function project(session, activeAnchors) {
  const active = anchors(activeAnchors);
  const selected = session.plans.filter(plan => active === undefined || active.has(plan.anchor)).at(-1) ?? session.baseline;
  return { settings: session.settings, representations: selected.representations, unresolved: selected.unresolved, summaries: session.summaries };
}

export async function createContextStore({ directory }) {
  identifier(directory);
  const root = resolve(directory);
  const queueKey = process.platform === 'win32' ? root.toLowerCase() : root;
  const statePath = join(root, 'state.json');
  async function readState() {
    try {
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      if (state.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 || !object(state.sessions)) fail('STORE_CORRUPT', 'Invalid context state', 500);
      return state;
    } catch (error) {
      if (error.code === 'ENOENT') return { schemaVersion: 1, revision: 0, sessions: {} };
      if (error instanceof SyntaxError) fail('STORE_CORRUPT', 'Invalid context state JSON', 500);
      throw error;
    }
  }
  function serial(action) {
    const result = (queues.get(queueKey) ?? Promise.resolve()).then(action);
    const settled = result.then(() => {}, () => {});
    queues.set(queueKey, settled);
    void settled.then(() => { if (queues.get(queueKey) === settled) queues.delete(queueKey); });
    return result;
  }
  async function persist(state) {
    await mkdir(root, { recursive: true });
    const temporary = join(root, `.context-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(state), { encoding: 'utf8', flag: 'wx' });
      await rename(temporary, statePath);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
  function mutate(expectedRevision, action) {
    return serial(async () => {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail('INVALID_REVISION', 'An explicit expectedRevision is required');
      const state = await readState();
      if (state.revision !== expectedRevision) fail('REVISION_CONFLICT', 'Context changed; reload before saving', 409);
      const result = await action(state);
      state.revision++;
      await persist(state);
      return structuredClone({ ...result, revision: state.revision });
    });
  }
  function session(state, sessionId) { return state.sessions[key(sessionId)] ??= fresh(); }
  return {
    view(sessionId, { activeAnchors } = {}) {
      return serial(async () => {
        const state = await readState();
        return structuredClone({ revision: state.revision, ...project(session(state, sessionId), activeAnchors) });
      });
    },
    configure(sessionId, { settings, expectedRevision } = {}) {
      return mutate(expectedRevision, state => {
        const record = session(state, sessionId);
        // Validate the patch as well as the merged settings; human configuration
        // cannot reach representations or canonical source data.
        validateSettings(settings);
        record.settings = validateSettings({ ...record.settings, ...settings });
        return project(record);
      });
    },
    savePlan(sessionId, { representations, unresolved, expectedRevision, anchor, beforeCommit } = {}) {
      return mutate(expectedRevision, async state => {
        identifier(anchor);
        const record = session(state, sessionId);
        record.plans.push({ anchor, representations: representationMap(representations), unresolved: questions(unresolved) });
        // Keep the context revision reserved while the optional independent DB
        // transaction commits. The callback must not call this store recursively.
        if (beforeCommit !== undefined) {
          if (typeof beforeCommit !== 'function') fail('INVALID_PLAN', 'beforeCommit must be a function');
          await beforeCommit();
        }
        return project(record);
      });
    },
    cacheSummaries(sessionId, { summaries, expectedRevision } = {}) {
      return mutate(expectedRevision, state => {
        if (!Array.isArray(summaries)) fail('INVALID_SUMMARY', 'Summaries must be an array');
        const record = session(state, sessionId);
        const ids = new Set();
        for (const item of summaries) {
          if (!object(item) || typeof item.id !== 'string' || !item.id.trim() || typeof item.summary !== 'string' || !item.summary.trim() || ids.has(item.id)) fail('INVALID_SUMMARY', 'Summaries require distinct canonical IDs and actual text');
          ids.add(item.id);
          Object.defineProperty(record.summaries, item.id, { value: item.summary, writable: true, enumerable: true, configurable: true });
        }
        return project(record);
      });
    },
    forkSession(fromId, toId, { activeAnchors, expectedRevision } = {}) {
      return mutate(expectedRevision, state => {
        const target = key(toId);
        if (fromId === toId || Object.hasOwn(state.sessions, target)) fail('SESSION_EXISTS', 'Fork requires an independent new child session', 409);
        const parent = state.sessions[key(fromId)] ?? fresh();
        const active = anchors(activeAnchors);
        const child = fresh();
        child.settings = structuredClone(parent.settings);
        // Preserve causal anchors across forks so a child can rewind further
        // into the inherited prefix instead of reviving a flattened plan.
        child.baseline = structuredClone(parent.baseline);
        child.plans = structuredClone(parent.plans.filter(plan => active === undefined || active.has(plan.anchor)));
        child.summaries = structuredClone(parent.summaries);
        state.sessions[target] = child;
        return project(child);
      });
    },
  };
}
