import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ContextError, validateSettings } from './core.mjs';
import { transferSessionIds, validateRestoreEnvelope, validateTransferState, transferFingerprint } from './transfer.mjs';

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
const fresh = () => ({ settings: validateSettings({}), baseline: { representations: {}, unresolved: [] }, plans: [], summaries: {}, authorNote: null, authorNoteVersion: 0, noteClaims: {} });
function projectAuthorNote(session, active, presentations) {
  if (!session.authorNote) return null;
  const note = { ...session.authorNote, status: 'pending' };delete note.claimedBy;
  const claim = Object.values(session.noteClaims ?? {}).filter(item => item.note.id === note.id && item.note.version === note.version && (active === undefined || active.has(item.anchor))).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).at(-1);
  if (claim?.status === 'claimed' || claim?.status === 'consumed' && (active === undefined || active.has(claim.outcomeAnchor)) && (presentations === undefined || presentations.has(claim.outcomeAnchor))) {
    note.status = claim.status;note.claimedBy = claim.note.claimedBy;
  }
  return note;
}
function project(session, activeAnchors, activePresentationAnchors) {
  const active = anchors(activeAnchors);
  const selected = session.plans.filter(plan => active === undefined || active.has(plan.anchor)).at(-1) ?? session.baseline;
  return { settings: session.settings, representations: selected.representations, unresolved: selected.unresolved, summaries: session.summaries, authorNote: projectAuthorNote(session, active, anchors(activePresentationAnchors)) };
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
    contentRevision() { return serial(async () => ({ revision: (await readState()).revision })); },
    exportState(sessionIds) {
      const ids = transferSessionIds(sessionIds);
      return serial(async () => {
        const state = await readState();
        return validateTransferState({ schemaVersion: 1, revision: state.revision, payload: { sessions: ids.map(sessionId => ({ sessionId, state: session(state, sessionId) })) } }, ids);
      });
    },
    preflightRestore(sessionIds, input) {
      return serial(async () => {
        try {
          const transfer = validateTransferState(input, sessionIds), state = await readState();
          const conflicts = transfer.payload.sessions.filter(item => {
            if (!Object.hasOwn(state.sessions, key(item.sessionId))) return false;
            const current = validateTransferState({ schemaVersion: 1, revision: state.revision, payload: { sessions: [{ sessionId: item.sessionId, state: state.sessions[key(item.sessionId)] }] } }, [item.sessionId]);
            return transferFingerprint(current.payload.sessions[0].state) !== transferFingerprint(item.state);
          }).map(item => ({ code: 'RESTORE_ID_CONFLICT', id: item.sessionId }));
          return { supported: conflicts.length === 0, conflicts, requirements: [] };
        } catch (error) {
          if (error.code !== 'RESTORE_PAYLOAD_INVALID') throw error;
          return { supported: false, conflicts: [{ code: error.code, id: 'context' }], requirements: [] };
        }
      });
    },
    restoreState({ restoreId, sessionIds, state: input, expectedRevision, signal, validateSources }) {
      const envelope = validateRestoreEnvelope({ restoreId, sessionIds, state: input, expectedRevision });
      const fingerprint = transferFingerprint({ sessionIds: envelope.sessionIds, state: envelope.state });
      return serial(async () => {
        signal?.throwIfAborted();
        const state = await readState(), journalKey = key(restoreId), previous = state.restores?.[journalKey];
        if (previous) {
          if (previous.fingerprint !== fingerprint) fail('RESTORE_ID_CONFLICT', 'Restore ID already owns a different Context payload or session set', 409);
          return structuredClone(previous.result);
        }
        const transfer = validateTransferState(envelope.state, envelope.sessionIds);
        if (state.revision !== expectedRevision) fail('REVISION_CONFLICT', 'Context changed; retry the restore explicitly', 409);
        for (const item of transfer.payload.sessions) if (Object.hasOwn(state.sessions, key(item.sessionId))) fail('RESTORE_ID_CONFLICT', 'Context state already exists for a restored session', 409);
        await validateSources?.(transfer, envelope.sessionIds);
        signal?.throwIfAborted();
        for (const item of transfer.payload.sessions) state.sessions[key(item.sessionId)] = structuredClone(item.state);
        const result = { revision: state.revision + 1, restoredSessionIds: envelope.sessionIds };
        (state.restores ??= {})[journalKey] = { fingerprint, result };
        state.revision++;
        signal?.throwIfAborted();await persist(state);
        return structuredClone(result);
      });
    },
    view(sessionId, { activeAnchors, activePresentationAnchors } = {}) {
      return serial(async () => {
        const state = await readState();
        return structuredClone({ revision: state.revision, ...project(session(state, sessionId), activeAnchors, activePresentationAnchors) });
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
    setAuthorNote(sessionId, { text, expectedRevision } = {}) {
      return mutate(expectedRevision, state => {
        if (typeof text !== 'string' || text.length > 64000) fail('INVALID_AUTHOR_NOTE', 'Author note must be text of at most 64000 characters');
        const record = session(state, sessionId);
        record.authorNoteVersion = (record.authorNoteVersion ?? record.authorNote?.version ?? 0) + 1;
        record.authorNote = text.trim() ? { id: record.authorNote?.id ?? randomUUID(), text, version: record.authorNoteVersion, status: 'pending' } : null;
        return { note: record.authorNote };
      });
    },
    authorNoteClaim(sessionId, claimId) {
      identifier(claimId);
      return serial(async () => {
        const state = await readState(), claims = session(state, sessionId).noteClaims ?? {};
        return structuredClone(Object.hasOwn(claims, claimId) ? claims[claimId].note : null);
      });
    },
    authorNoteClaims(sessionId) {
      return serial(async () => structuredClone(session(await readState(), sessionId).noteClaims ?? {}));
    },
    cacheAuthorNoteOutcome(sessionId, { claimId, noteId, version, outcomeAnchor, presentationId }) {
      identifier(claimId);identifier(presentationId);
      return serial(async () => {
        const state = await readState(), claims = session(state, sessionId).noteClaims ?? {}, claim = Object.hasOwn(claims, claimId) ? claims[claimId] : undefined;
        if (claim?.status !== 'consumed' || claim.note.id !== noteId || claim.note.version !== version || claim.outcomeAnchor !== outcomeAnchor || claim.outcomePresentationId !== undefined) return { revision: state.revision };
        claim.outcomePresentationId = presentationId;state.revision++;
        await persist(state);
        return { revision: state.revision };
      });
    },
    capturePreparation(sessionId, { presentationId, anchor, activeAnchors, activePresentationAnchors } = {}) {
      identifier(presentationId);identifier(anchor);
      return serial(async () => {
        const state = await readState(), record = session(state, sessionId);
        const claims = record.noteClaims ??= {}, existing = Object.hasOwn(claims, presentationId) ? claims[presentationId] : undefined;
        const active = anchors(activeAnchors), pending = projectAuthorNote(record, active, anchors(activePresentationAnchors));
        let note = existing?.status === 'claimed' && (active === undefined || active.has(existing.anchor)) ? existing.note : null;
        if (!note && record.settings.enabled && existing?.status !== 'consumed' && pending?.status === 'pending' && (!existing || existing.note.id === pending.id && existing.note.version === pending.version)) {
          note = { ...pending, status: 'claimed', claimedBy: presentationId };
          record.authorNote = note;
          Object.defineProperty(claims, presentationId, { value: { note: structuredClone(note), status: 'claimed', anchor, order: state.revision + 1 }, enumerable: true, writable: true, configurable: true });
          state.revision++;
          await persist(state);
        }
        return structuredClone({ revision: state.revision, ...project(record, activeAnchors, activePresentationAnchors), authorNote: note });
      });
    },
    presentationOutcome(sessionId, { presentationId, claimId = presentationId, status, anchor } = {}) {
      identifier(presentationId);identifier(claimId);
      if (!['accepted', 'failed-before-freeze', 'failed-after-freeze'].includes(status)) fail('INVALID_OUTCOME', 'Unknown presentation outcome');
      if (status === 'accepted') identifier(anchor);
      return serial(async () => {
        const state = await readState(), record = session(state, sessionId), claims = record.noteClaims ?? {};
        const claim = Object.hasOwn(claims, claimId) ? claims[claimId] : undefined;
        const next = status === 'accepted' ? 'consumed' : status === 'failed-before-freeze' ? 'released' : 'claimed';
        if (claim && claim.status !== 'consumed' && next !== 'claimed' && claim.status !== next) {
          claim.status = next;
          if (next === 'consumed') { claim.outcomeAnchor = anchor;claim.outcomePresentationId = presentationId; }
          if (record.authorNote?.id === claim.note.id && record.authorNote.version === claim.note.version) {
            record.authorNote = { ...claim.note, status: next === 'consumed' ? 'consumed' : 'pending' };
            if (next === 'released') delete record.authorNote.claimedBy;
          }
          state.revision++;
          await persist(state);
        }
        return structuredClone({ revision: state.revision, note: record.authorNote ?? null });
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
    forkSession(fromId, toId, { activeAnchors, activePresentationAnchors, expectedRevision } = {}) {
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
        const pending = projectAuthorNote(parent, active, anchors(activePresentationAnchors));
        if (pending?.status === 'pending') {
          child.authorNote = { id: randomUUID(), text: pending.text, version: 1, status: 'pending' };
          child.authorNoteVersion = 1;
        }
        state.sessions[target] = child;
        return project(child);
      });
    },
  };
}
