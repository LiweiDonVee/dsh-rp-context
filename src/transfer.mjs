import { createHash } from 'node:crypto';
import { ContextError, validateSettings } from './core.mjs';
import { narrativeHistory } from './session.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && !!value.trim() && value.length <= 256;
const invalid = () => { throw new ContextError('RESTORE_PAYLOAD_INVALID', 'Invalid Context state or canonical source reference'); };
const exact = (value, keys) => { if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) invalid(); };
const strings = value => { if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) invalid(); };
const integer = value => Number.isSafeInteger(value) && value >= 0;

export function transferSessionIds(values) {
  if (!Array.isArray(values) || !values.length || values.some(value => !id(value)) || new Set(values).size !== values.length) invalid();
  return [...values].sort();
}
function representations(value) {
  if (!object(value)) invalid();
  for (const [key, item] of Object.entries(value)) {
    if (!key.trim()) invalid();
    exact(item, ['mode', 'summary']);
    if (!['full', 'summary', 'index'].includes(item.mode) || item.summary !== undefined && (typeof item.summary !== 'string' || !item.summary.trim())) invalid();
  }
}
function note(value) {
  if (value === null) return;
  exact(value, ['id', 'text', 'version', 'status', 'claimedBy']);
  if (!id(value.id) || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 64000 || !integer(value.version) || value.version < 1 || !['pending', 'claimed', 'consumed'].includes(value.status) || value.claimedBy !== undefined && !id(value.claimedBy)) invalid();
}
function sessionState(value) {
  exact(value, ['settings', 'baseline', 'plans', 'summaries', 'authorNote', 'authorNoteVersion', 'noteClaims']);
  if (!object(value.settings)) invalid();value.settings = validateSettings(value.settings);
  exact(value.baseline, ['representations', 'unresolved']);representations(value.baseline.representations);strings(value.baseline.unresolved);
  if (!Array.isArray(value.plans) || !object(value.summaries)) invalid();
  for (const plan of value.plans) { exact(plan, ['anchor', 'representations', 'unresolved']);if (!id(plan.anchor)) invalid();representations(plan.representations);strings(plan.unresolved); }
  for (const [key, text] of Object.entries(value.summaries)) if (!key.trim() || typeof text !== 'string' || !text.trim()) invalid();
  value.authorNote ??= null;value.authorNoteVersion ??= value.authorNote?.version ?? 0;value.noteClaims ??= {};
  note(value.authorNote);
  if (!integer(value.authorNoteVersion) || !object(value.noteClaims)) invalid();
  if (value.authorNote && value.authorNote.version > value.authorNoteVersion) invalid();
  for (const [claimId, claim] of Object.entries(value.noteClaims)) {
    exact(claim, ['note', 'status', 'anchor', 'outcomeAnchor', 'order']);note(claim.note);
    if (!id(claimId) || !claim.note || claim.note.claimedBy !== claimId || claim.note.version > value.authorNoteVersion || !['claimed', 'released', 'consumed'].includes(claim.status) || !id(claim.anchor) || !integer(claim.order) || claim.status === 'consumed' && !id(claim.outcomeAnchor) || claim.outcomeAnchor !== undefined && !id(claim.outcomeAnchor)) invalid();
  }
}
export function validateTransferState(state, sessionIds) {
  try {
    const ids = transferSessionIds(sessionIds), copy = structuredClone(state);
    exact(copy, ['schemaVersion', 'revision', 'payload']);exact(copy.payload, ['sessions']);
    if (copy.schemaVersion !== 1 || !integer(copy.revision) || !Array.isArray(copy.payload.sessions)) invalid();
    const actual = [];
    for (const item of copy.payload.sessions) { exact(item, ['sessionId', 'state']);actual.push(item.sessionId);sessionState(item.state); }
    if (JSON.stringify(transferSessionIds(actual)) !== JSON.stringify(ids)) invalid();
    return copy;
  } catch (error) { if (error.code === 'RESTORE_PAYLOAD_INVALID') throw error;invalid(); }
}
const stable = value => Array.isArray(value) ? value.map(stable) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
export const transferFingerprint = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');

export function canonicalContextState(state, view, { prune = false } = {}) {
  const copy = structuredClone(state), anchors = new Set(view.events.filter(event => event.type === 'assistant/message').map(event => event.data?.message?.id));
  const history = narrativeHistory(view, { includeInactive: true });
  const refs = new Set(history.flatMap(record => [record.id, record.source.presentationId]));
  const filterRefs = values => Object.fromEntries(Object.entries(values).filter(([key]) => {
    if (refs.has(key)) return true;if (!prune) invalid();return false;
  }));
  copy.baseline.representations = filterRefs(copy.baseline.representations);
  copy.plans = copy.plans.filter(plan => { if (anchors.has(plan.anchor)) return true;if (!prune) invalid();return false; }).map(plan => ({ ...plan, representations: filterRefs(plan.representations) }));
  copy.summaries = filterRefs(copy.summaries);
  copy.noteClaims = Object.fromEntries(Object.entries(copy.noteClaims ?? {}).filter(([, claim]) => {
    if (anchors.has(claim.anchor) && (claim.outcomeAnchor === undefined || anchors.has(claim.outcomeAnchor)) && (claim.status !== 'consumed' || history.some(record => record.anchor === claim.outcomeAnchor))) return true;if (!prune) invalid();return false;
  }));
  return copy;
}
