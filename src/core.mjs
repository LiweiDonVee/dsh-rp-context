export class ContextError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ContextError';
    this.code = code;
    this.status = status;
  }
}
const fail = (code, message, status) => { throw new ContextError(code, message, status); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const modes = new Set(['full', 'summary', 'index']);

export function validateSettings(value = {}) {
  const defaults = { enabled: true, recentTurns: 5, maxChars: 24000, maxSteps: 8 };
  if (!object(value) || Object.keys(value).some(key => !Object.hasOwn(defaults, key))) fail('INVALID_SETTINGS', 'Only context settings may be configured');
  const result = { ...defaults, ...value };
  if (typeof result.enabled !== 'boolean') fail('INVALID_SETTINGS', 'enabled must be a boolean');
  for (const [key, maximum] of [['recentTurns', 1000], ['maxChars', 1000000], ['maxSteps', 32]]) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 1 || result[key] > maximum) fail('INVALID_SETTINGS', `${key} must be an integer from 1 to ${maximum}`);
  }
  return result;
}

function sourceRef(source) {
  if (!object(source) || !nonempty(source.assistantMessageId)) fail('INVALID_HISTORY', 'History requires a canonical source.assistantMessageId reference');
  for (const name of ['sessionId', 'callId', 'presentationId']) if (source[name] !== undefined && !nonempty(source[name])) fail('INVALID_HISTORY', `Invalid source ${name}`);
  const sequence = value => Number.isSafeInteger(value) && value >= 0;
  for (const name of ['callSeq', 'resultSeq', 'baseResultSeq']) if (source[name] !== undefined && !sequence(source[name])) fail('INVALID_HISTORY', `Invalid source ${name}`);
  if (source.presentationId !== undefined && (!sequence(source.callSeq) || !sequence(source.baseResultSeq) || !sequence(source.resultSeq) || source.baseResultSeq <= source.callSeq || source.resultSeq < source.baseResultSeq)) fail('INVALID_HISTORY', 'Invalid canonical narrative revision');
  if (source.sourceEventSeqs !== undefined && (!Array.isArray(source.sourceEventSeqs) || !source.sourceEventSeqs.every(sequence))) fail('INVALID_HISTORY', 'Invalid source event sequence references');
  try { return JSON.parse(JSON.stringify(source)); } catch { fail('INVALID_HISTORY', 'History source must be serializable'); }
}

export function buildHistory(history, { recentTurns = 5, representations = {} } = {}) {
  validateSettings({ recentTurns });
  if (!Array.isArray(history) || !object(representations)) fail('INVALID_HISTORY', 'History must be an array and representations an object');
  const seen = new Set();
  const sources = new Set();
  const records = history.map(item => {
    if (!object(item) || !nonempty(item.id) || !nonempty(item.anchor) || !Number.isSafeInteger(item.turn) || item.turn < 0 || typeof item.action !== 'string' || typeof item.text !== 'string' || (item.summary !== undefined && !nonempty(item.summary))) fail('INVALID_HISTORY', 'Invalid formal narrative record');
    if (seen.has(item.id)) fail('DUPLICATE_ID', `Duplicate history ID: ${item.id}`);
    seen.add(item.id);
    const source = sourceRef(item.source);
    if (source.presentationId !== undefined && item.id !== JSON.stringify([source.presentationId, source.resultSeq])) fail('INVALID_HISTORY', 'Narrative ID must identify its canonical result revision');
    const sourceKey = JSON.stringify([source.sessionId ?? '', source.assistantMessageId, source.callSeq ?? null, source.resultSeq ?? null]);
    if (sources.has(sourceKey)) fail('DUPLICATE_ID', 'Duplicate canonical narrative source');
    sources.add(sourceKey);
    if (source.assistantMessageId !== item.anchor) fail('INVALID_HISTORY', 'History anchor must identify its canonical source message');
    return { id: item.id, anchor: item.anchor, turn: item.turn, action: item.action, text: item.text, ...(typeof item.factReceiptId === 'string' ? { factReceiptId: item.factReceiptId } : {}), ...(item.summary === undefined ? {} : { summary: item.summary }), source };
  });
  for (const id of Object.keys(representations)) if (!seen.has(id)) fail('INVALID_REFERENCE', `Representation refers to inactive history: ${id}`);
  const recent = new Set([...new Set(records.map(item => item.turn))].sort((a, b) => a - b).slice(-recentTurns));
  return records.map(item => {
    const chosen = Object.hasOwn(representations, item.id) ? representations[item.id] : undefined;
    if (chosen !== undefined && (!object(chosen) || !modes.has(chosen.mode) || Object.keys(chosen).some(key => !['mode', 'summary'].includes(key)) || (chosen.summary !== undefined && !nonempty(chosen.summary)))) fail('INVALID_REPRESENTATION', `Invalid representation for ${item.id}`);
    const mode = chosen?.mode ?? (recent.has(item.turn) ? 'full' : 'summary');
    const summary = chosen?.summary ?? item.summary;
    const content = mode === 'full' ? item.text : mode === 'summary' ? summary ?? '' : JSON.stringify({ id: item.id, turn: item.turn, source: item.source });
    return { ...item, ...(summary === undefined ? {} : { summary }), mode, content, ...(mode === 'summary' && summary === undefined ? { needsSummary: true } : {}) };
  });
}

/** Legacy presentation IDs apply only to the unchanged original result. */
export function projectHistoryState(history, state) {
  const active = values => Object.fromEntries(history.flatMap(record => {
    const original = record.source?.resultSeq === record.source?.baseResultSeq ? record.source?.presentationId : undefined;
    const key = Object.hasOwn(values ?? {}, record.id) ? record.id : original !== undefined && Object.hasOwn(values ?? {}, original) ? original : undefined;
    return key === undefined ? [] : [[record.id, structuredClone(values[key])]];
  }));
  return { ...state, representations: active(state.representations), summaries: active(state.summaries) };
}

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function compileMaterials({ history, databaseEntries = [], notes = '', unresolved = [], maxChars = 24000 }) {
  if (!Array.isArray(history) || !Array.isArray(databaseEntries) || typeof notes !== 'string' || !Array.isArray(unresolved) || unresolved.some(item => typeof item !== 'string') || !Number.isSafeInteger(maxChars) || maxChars < 1) fail('INVALID_MATERIAL', 'Invalid material input');
  const seen = new Set();
  const projected = history.map(item => {
    if (!object(item) || !nonempty(item.id) || !modes.has(item.mode) || typeof item.content !== 'string') fail('INVALID_MATERIAL', 'Invalid history representation');
    if (seen.has(item.id)) fail('DUPLICATE_ID', 'Duplicate history material');
    seen.add(item.id);
    if (item.needsSummary || (item.mode === 'summary' && !nonempty(item.content))) fail('MISSING_SUMMARY', `An actual summary is required for ${item.id}`, 409);
    return { id: item.id, mode: item.mode, content: item.content, source: sourceRef(item.source) };
  });
  const material = JSON.parse(JSON.stringify({ history: projected, entries: databaseEntries, guidance: notes, unresolved, recentProse: history.filter(item => item.mode === 'full').map(item => item.content), chars: 0 }));
  // chars includes the serialized chars field itself; settle its digit count.
  while (material.chars !== JSON.stringify(material).length) material.chars = JSON.stringify(material).length;
  if (material.chars > maxChars) fail('MATERIAL_BUDGET', `Required material needs ${material.chars} characters; budget is ${maxChars}`, 409);
  return freeze(material);
}
