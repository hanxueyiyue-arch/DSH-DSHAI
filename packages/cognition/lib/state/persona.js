// 人设卡：初设锁定 + 当前派生视图（不落盘）。
// 规则来自 V0.5.0-ALGORITHM-UPGRADE-DESIGN.md §4.10：
//   - 初设（姓名/性别/初始人设）确认后锁定，日常路径不可改；
//   - "当前人格"是派生视图，不保存第二份；
//   - 变更只追加 history，不覆盖。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const PERSONA_SCHEMA = 1;
const DAY = 24 * 60 * 60 * 1000;

function personaFile(store) {
  return join(store.root, 'persona.json');
}

export function loadPersona(store) {
  try {
    const raw = JSON.parse(readFileSync(personaFile(store), 'utf8'));
    if (raw && raw.schema === PERSONA_SCHEMA) return raw;
  } catch { /* 没有文件或损坏：走初始化 */ }
  return null;
}

function writePersona(store, persona) {
  const file = personaFile(store);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(JSON.stringify(persona, null, 2) + '\n', 'utf8'));
  return persona;
}

/**
 * 首次运行：把 self.json 里的身份写成人设卡的"初设"，并立即锁定。
 * 之后任何写入都走 appendHistory / 离线修复，不再改 initial。
 *
 * 例外：身份**不完整**（缺姓名或缺性别）时不锁定、也不落盘，
 * 让用户能在设置页完成一次性初始化；否则人设卡会在用户还没填之前就被锁死。
 */
export function ensurePersona(store, { now = Date.now() } = {}) {
  const existing = loadPersona(store);
  if (existing) return existing;
  const identity = store.self?.identity ?? {};
  const name = typeof identity.name === 'string' && identity.name.trim() ? identity.name.trim() : null;
  const gender = typeof identity.gender === 'string' && identity.gender.trim() ? identity.gender.trim() : null;
  const profileText = typeof identity.profileText === 'string' ? identity.profileText : '';
  if (!name || !gender) {
    // 未初始化：返回空人设卡，不写文件，等 setIdentity 补齐后再锁定。
    return {
      schema: PERSONA_SCHEMA,
      initializedAt: null,
      initial: null,
      locked: false,
      lockedAt: null,
      history: [],
      version: 0
    };
  }
  const initial = { name, gender, profileText };
  const persona = {
    schema: PERSONA_SCHEMA,
    initializedAt: now,
    initial,
    locked: true,
    lockedAt: now,
    history: [{ at: now, source: 'initial-lock', initial }],
    version: 1
  };
  return writePersona(store, persona);
}

export function appendHistory(store, entry) {
  const persona = ensurePersona(store);
  const next = {
    ...persona,
    history: [...(Array.isArray(persona.history) ? persona.history : []), { at: entry.at ?? Date.now(), ...entry }],
    version: (persona.version ?? 0) + 1
  };
  return writePersona(store, next);
}

/**
 * 当前人格：派生视图，不落盘。
 * 模板摘要（不调模型、零成本）：近 N 天高重要度记忆的条数、高频标签、代表性标题。
 */
export function derivedPersona(store, { now = Date.now(), days = 90, minImportance = 3, limit = 3 } = {}) {
  const since = now - days * DAY;
  const rows = (Array.isArray(store.memory?.memories) ? store.memory.memories : []).filter(row => {
    if (!row || row.archivedAt || row.supersededBy) return false;
    if (!['fact', 'action', 'insight', 'observation'].includes(row.kind)) return false;
    const at = Number(row.occurredAt ?? Date.parse(row.createdAt ?? ''));
    if (!Number.isFinite(at) || at < since) return false;
    return Number(row.importance ?? 0) >= minImportance || row.kind === 'insight';
  });
  const tagCount = new Map();
  for (const row of rows) {
    for (const tag of Array.isArray(row.tags) ? row.tags : String(row.tags ?? '').split(/\s+/)) {
      const key = String(tag ?? '').trim();
      if (!key) continue;
      tagCount.set(key, (tagCount.get(key) ?? 0) + 1);
    }
  }
  const topics = [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([tag, count]) => ({ tag, count }));
  const recent = rows
    .slice()
    .sort((a, b) => (Number(b.occurredAt ?? Date.parse(b.createdAt ?? '')) || 0) - (Number(a.occurredAt ?? Date.parse(a.createdAt ?? '')) || 0))
    .slice(0, limit);
  const summary = [
    `近 ${days} 天有 ${rows.length} 条高重要度记忆`,
    topics.length ? `常出现的话题：${topics.map(t => t.tag).join('、')}` : '还没有稳定的话题',
    recent.length ? `最近在意：${recent.map(row => String(row.title ?? '').slice(0, 24)).join('；')}` : ''
  ].filter(Boolean).join('。');
  return {
    summary,
    windowDays: days,
    basedOn: {
      memories: rows.length,
      facts: rows.filter(row => row.kind === 'fact').length,
      actions: rows.filter(row => row.kind === 'action').length,
      insights: rows.filter(row => row.kind === 'insight').length
    },
    topics,
    evidence: recent.map(row => row.id).filter(Boolean)
  };
}

export function personaView(store, options = {}) {
  const persona = ensurePersona(store, options);
  return {
    schema: persona.schema,
    locked: persona.locked === true,
    lockedAt: persona.lockedAt ?? null,
    initializedAt: persona.initializedAt ?? null,
    initial: persona.initial ?? null,
    history: Array.isArray(persona.history) ? persona.history.slice(-20) : [],
    derived: derivedPersona(store, options)
  };
}
