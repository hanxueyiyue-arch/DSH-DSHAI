// 说话习惯：按“维度”组织，core 每轮常驻，context 只在对应情境出现。
// 只作决策的轻背景，不触发动作、不当规则、不写进人格。

export const SPEAK_HABIT_LIMIT = 20;
export const SPEAK_HABIT_MIN_CONFIDENCE = 0.55;
export const SPEAK_HABIT_MAX_EVIDENCE = 20;
export const SPEAK_CORE_LIMIT = 3;
export const SPEAK_CONTEXT_LIMIT = 2;
export const SPEAK_CONTEXTS = Object.freeze(['comfort', 'explain', 'casual', 'task', 'owner_low', 'not_push']);

function cleanText(value, limit) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

export function normalizeSpeakHabits(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const id = cleanText(item.id, 64);
    const label = cleanText(item.label, 40);
    const statement = cleanText(item.statement, 160);
    if (!id || !label || !statement || seen.has(id)) continue;
    seen.add(id);
    const dimension = cleanText(item.dimension, 32) || label;
    const scope = item.scope === 'context' ? 'context' : 'core';
    const contexts = (Array.isArray(item.contexts) ? item.contexts : [])
      .map(value => cleanText(value, 24).toLowerCase())
      .filter(value => SPEAK_CONTEXTS.includes(value));
    out.push({
      id,
      label,
      statement,
      dimension,
      scope,
      contexts: scope === 'context' ? [...new Set(contexts)] : [],
      confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0)),
      evidence: (Array.isArray(item.evidence) ? item.evidence : []).filter(value => typeof value === 'string').slice(-SPEAK_HABIT_MAX_EVIDENCE),
      createdAt: Number(item.createdAt) || 0,
      updatedAt: Number(item.updatedAt) || 0
    });
  }
  return out.slice(-SPEAK_HABIT_LIMIT);
}

function sameDimension(a, b) {
  return cleanText(a, 32).toLowerCase() === cleanText(b, 32).toLowerCase();
}

/**
 * 合并一条反思产出：同 dimension（或同 label）视为同一条。
 * 证据取并集，置信取高，contexts 取并集。
 */
export function mergeSpeakHabits(existing, incoming, { now = Date.now(), allowedEvidence = null } = {}) {
  const items = normalizeSpeakHabits(existing);
  const applied = [];
  const skipped = [];
  for (const raw of Array.isArray(incoming) ? incoming : []) {
    const label = cleanText(raw?.label, 40);
    const statement = cleanText(raw?.statement, 160);
    const dimension = cleanText(raw?.dimension, 32) || label;
    const evidence = (Array.isArray(raw?.evidence) ? raw.evidence : [])
      .filter(value => typeof value === 'string' && (!allowedEvidence || allowedEvidence.has(value)))
      .slice(-SPEAK_HABIT_MAX_EVIDENCE);
    if (!label || !statement) { skipped.push({ label, reason: 'empty' }); continue; }
    if (evidence.length === 0) { skipped.push({ label, reason: 'no-evidence' }); continue; }
    const confidence = Math.max(0.4, Math.min(0.8, Number(raw?.confidence) || 0.55));
    const scope = raw?.scope === 'context' ? 'context' : 'core';
    const contexts = scope === 'context'
      ? [...new Set((Array.isArray(raw?.contexts) ? raw.contexts : [])
          .map(value => cleanText(value, 24).toLowerCase())
          .filter(value => SPEAK_CONTEXTS.includes(value)))]
      : [];
    const hit = items.find(item => sameDimension(item.dimension, dimension) || item.label === label);
    if (hit) {
      hit.statement = statement;
      hit.confidence = Math.max(hit.confidence, confidence);
      hit.evidence = [...new Set([...hit.evidence, ...evidence])].slice(-SPEAK_HABIT_MAX_EVIDENCE);
      hit.updatedAt = now;
      if (scope === 'context' && contexts.length > 0) {
        hit.scope = 'context';
        hit.contexts = [...new Set([...(hit.contexts ?? []), ...contexts])];
      }
      applied.push({ label, action: 'updated', dimension: hit.dimension });
    } else {
      items.push({
        id: `speak-${now}-${items.length}`,
        label,
        statement,
        dimension,
        scope,
        contexts,
        confidence,
        evidence,
        createdAt: now,
        updatedAt: now
      });
      applied.push({ label, action: 'created', dimension });
    }
  }
  return { items: items.slice(-SPEAK_HABIT_LIMIT), applied, skipped };
}

export function speakContextsFor({ event = null, affect = null } = {}) {
  const contexts = new Set();
  const text = event?.type === 'owner-message' ? String(event?.payload?.text ?? '') : '';
  if (/难受|烦|累|不开心|难过|焦虑|生气|委屈|崩溃|想哭/.test(text)) contexts.add('comfort');
  if (/为什么|怎么|如何|解释|原理|区别|原因/.test(text)) contexts.add('explain');
  if (/哈哈|笑|玩|晚安|早安|睡了|随便聊|没事/.test(text)) contexts.add('casual');
  if (event?.type === 'tick' || event?.type === 'self-turn') contexts.add('task');
  if (Number(affect?.valence) < -0.2) contexts.add('owner_low');
  return [...contexts];
}

export function activeSpeakHabits(self, { contexts = [], limit = SPEAK_CONTEXT_LIMIT + SPEAK_CORE_LIMIT, minConfidence = SPEAK_HABIT_MIN_CONFIDENCE } = {}) {
  const items = normalizeSpeakHabits(self?.speakHabits).filter(item => item.confidence >= minConfidence);
  const wanted = new Set((Array.isArray(contexts) ? contexts : []).map(value => String(value).toLowerCase()));
  const core = items
    .filter(item => item.scope !== 'context')
    .sort((a, b) => b.confidence - a.confidence || (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, SPEAK_CORE_LIMIT);
  const contextual = items
    .filter(item => item.scope === 'context' && item.contexts.some(context => wanted.has(context)))
    .sort((a, b) => b.confidence - a.confidence || (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, SPEAK_CONTEXT_LIMIT);
  const out = [];
  const seen = new Set();
  for (const item of [...core, ...contextual]) {
    if (seen.has(item.dimension)) continue;
    seen.add(item.dimension);
    out.push({
      id: item.id,
      label: item.label,
      statement: item.statement,
      dimension: item.dimension,
      confidence: item.confidence
    });
  }
  return out.slice(0, limit);
}
