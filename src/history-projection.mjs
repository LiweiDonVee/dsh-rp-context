import { ContextError, buildHistory, sourceRef } from './core.mjs';
import { narrativeHistory } from './session.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && !!value.trim();
const unavailable = () => { throw new ContextError('EFFECTIVE_HISTORY_UNAVAILABLE', 'The effective story history is unavailable; restore the required LastStep and Database capabilities before preparing materials', 503); };
const unique = values => [...new Set(values)];

/** Material evidence only. Owner selection and canonical note proof remain independent. */
export function validateHistoryProjection(value) {
  if (!object(value) || Object.keys(value).some(key => !['schemaVersion', 'projectionKey', 'selectedPresentationIds', 'activeFactReceiptIds'].includes(key)) || value.schemaVersion !== 1 || !id(value.projectionKey)) unavailable();
  for (const key of ['selectedPresentationIds', 'activeFactReceiptIds']) if (!Array.isArray(value[key]) || value[key].some(item => !id(item)) || unique(value[key]).length !== value[key].length) unavailable();
  return structuredClone(value);
}

export function validateHistoryRefs(value) {
  if (!Array.isArray(value)) unavailable();
  const result = value.map(ref => sourceRef(ref)), ids = result.map(ref => JSON.stringify([ref.presentationId, ref.resultSeq]));
  if (result.some(ref => !id(ref.presentationId)) || unique(ids).length !== ids.length) unavailable();
  return result;
}

export function ownerNarratives(records) {
  if (!Array.isArray(records)) unavailable();
  const history = records.map(record => ({ ...structuredClone(record), anchor: record.ref?.assistantMessageId, source: structuredClone(record.ref) }));
  buildHistory(history);
  return history;
}

/** Capture once, before any asynchronous material work; never reconstruct from later state. */
export function captureStoryHistory(response) {
  const value = structuredClone(response);
  if (!object(value) || value.schemaVersion !== 1 || !id(value.projectionKey) || !Array.isArray(value.folded)) unavailable();
  let history;
  try { history = ownerNarratives(value.records); } catch { unavailable(); }
  const groups = new Set(), selectedIds = new Set();
  for (const group of value.folded) {
    if (!object(group) || !id(group.groupId) || group.factRoundId !== undefined && !id(group.factRoundId)
      || group.activeFactReceiptId !== null && !id(group.activeFactReceiptId) || group.selectedPresentationId !== null && !id(group.selectedPresentationId)
      || typeof group.pendingFacts !== 'boolean' || !Array.isArray(group.versions)) unavailable();
    if (groups.has(group.groupId)) unavailable();groups.add(group.groupId);
    for (const version of group.versions) if (!object(version) || !id(version.presentationId) || version.factReceiptId !== undefined && !id(version.factReceiptId) || !Number.isSafeInteger(version.resultSeq) || version.resultSeq < 0) unavailable();
    if (group.selectedPresentationId !== null) {
      const selected = history.filter(record => record.source.presentationId === group.selectedPresentationId);
      if (selected.length !== 1 || selectedIds.has(group.selectedPresentationId) || (selected[0].factReceiptId ?? null) !== group.activeFactReceiptId
        || !group.versions.some(version => version.presentationId === group.selectedPresentationId && version.resultSeq === selected[0].source.resultSeq && version.factReceiptId === selected[0].factReceiptId)) unavailable();
      selectedIds.add(group.selectedPresentationId);
    }
  }
  if (history.length !== selectedIds.size) unavailable();
  const historyProjection = validateHistoryProjection({ schemaVersion: 1, projectionKey: value.projectionKey,
    selectedPresentationIds: unique(history.map(record => record.source.presentationId)),
    activeFactReceiptIds: unique(value.folded.map(group => group.activeFactReceiptId).filter(value => value !== null)) });
  return { history, historyProjection };
}

export function hasNarrativeRevisions(view) {
  const accepted = new Set(narrativeHistory(view).map(record => record.source.baseResultSeq));
  return view.events.some(event => {
    const record = accepted.has(event.seq) ? event.data?.meta?.rpLastStep?.record : undefined;
    return record?.narrativeVersion !== undefined || record?.factRoundId !== undefined;
  });
}

export { unavailable as effectiveHistoryUnavailable };
