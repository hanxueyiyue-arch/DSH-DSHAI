// 记忆维护（S3.9）：只做可逆的归档，不删除原文。
// 低风险自动：测试残留、完全重复、过期替代、过老的低价值痕迹、容量软预算。
// 语义相近只给建议，不自动合并。

import { brainStrength } from './brainmem.js';
import { lexemes } from './memory.js';

const DAY_MS = 86_400_000;

export const DEFAULT_MAINTENANCE = Object.freeze({
  archiveRatio: 0.85,
  maxAgeDays: 180,
  supersededGraceDays: 30,
  maxProposals: 10
});

const text = value => String(value ?? '').trim().toLowerCase();

function ageDaysOf(row, now) {
  const at = Number(row?.createdAt ?? row?.occurredAt);
  return Number.isFinite(at) ? (now - at) / DAY_MS : 0;
}

function strengthOf(row, now) {
  try {
    return Number(brainStrength(row, now)?.strength) || 0;
  } catch {
    return 0;
  }
}

// 日记引用过的记忆不归档：写进日记就等于重新讲了一遍，不该“过期”。
export function protectedIdsOf(diaryIndex = [], extra = []) {
  const ids = new Set(extra);
  for (const entry of Array.isArray(diaryIndex) ? diaryIndex : []) {
    for (const id of Array.isArray(entry?.memoryIds) ? entry.memoryIds : []) ids.add(id);
    for (const id of Array.isArray(entry?.ids) ? entry.ids : []) ids.add(id);
  }
  return ids;
}

export function planMaintenance(
  memories,
  { now = Date.now(), capacity = 5000, diaryIndex = [], keepIds = [], rules = DEFAULT_MAINTENANCE } = {}
) {
  const conf = { ...DEFAULT_MAINTENANCE, ...rules };
  const rows = (Array.isArray(memories) ? memories : []).filter(row => row && row.id);
  const protectedIds = protectedIdsOf(diaryIndex, keepIds);
  const archive = [];
  const archived = new Set();

  const add = (row, reason) => {
    if (!row?.id || archived.has(row.id) || protectedIds.has(row.id)) return;
    archived.add(row.id);
    archive.push({ id: row.id, reason, title: row.title ?? null });
  };

  // 1. 测试残留
  for (const row of rows) {
    if (row.kind === 'test' || row.isTest === true) add(row, 'test-residue');
  }

  // 2. 完全重复：保留强度最高的那份
  const groups = new Map();
  for (const row of rows) {
    if (archived.has(row.id)) continue;
    const key = `${text(row.kind)}|${text(row.title)}|${text(row.content)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ordered = [...group].sort(
      (a, b) => strengthOf(b, now) - strengthOf(a, now) || String(a.id).localeCompare(String(b.id))
    );
    for (const row of ordered.slice(1)) add(row, 'duplicate');
  }

  // 3. 被替代且过了宽限期
  for (const row of rows) {
    if (archived.has(row.id) || !row.supersededBy) continue;
    const at = Number(row.supersededAt ?? row.updatedAt ?? row.createdAt);
    if (Number.isFinite(at) && now - at > conf.supersededGraceDays * DAY_MS) add(row, 'superseded-expired');
  }

  // 4. 过老、低价值的痕迹
  for (const row of rows) {
    if (archived.has(row.id) || protectedIds.has(row.id)) continue;
    const importance = Number(row.importance) || 3;
    if (
      ageDaysOf(row, now) > conf.maxAgeDays &&
      importance < 5 &&
      strengthOf(row, now) < 0.1
    ) {
      add(row, 'aged-trace');
    }
  }

  // 5. 容量软预算：到 85% 就先沉最低强度的，不等到写满
  const target = Math.max(1, Math.floor(capacity * conf.archiveRatio));
  let active = rows.filter(row => !archived.has(row.id));
  if (active.length > target) {
    const candidates = active
      .filter(row => !protectedIds.has(row.id))
      .sort((a, b) => strengthOf(a, now) - strengthOf(b, now));
    for (const row of candidates) {
      if (active.length <= target) break;
      if ((Number(row.importance) || 3) >= 5) continue;
      add(row, 'capacity');
      active = active.filter(item => item.id !== row.id);
    }
  }

  // 6. 语义相近只给建议，不自动合并
  const proposals = [];
  const proposed = new Set();
  for (let i = 0; i < rows.length && proposals.length < conf.maxProposals; i += 1) {
    const a = rows[i];
    if (archived.has(a.id)) continue;
    const ta = new Set([...lexemes(`${a.title ?? ''} ${a.tags ?? ''}`)]);
    if (ta.size === 0) continue;
    for (let j = i + 1; j < rows.length && proposals.length < conf.maxProposals; j += 1) {
      const b = rows[j];
      if (archived.has(b.id)) continue;
      const pairKey = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
      if (proposed.has(pairKey)) continue;
      const tb = new Set([...lexemes(`${b.title ?? ''} ${b.tags ?? ''}`)]);
      if (tb.size === 0) continue;
      let overlap = 0;
      for (const token of ta) if (tb.has(token)) overlap += 1;
      const union = ta.size + tb.size - overlap;
      const score = union > 0 ? overlap / union : 0;
      if (score >= 0.6) {
        proposed.add(pairKey);
        proposals.push({
          ids: [a.id, b.id],
          titles: [a.title ?? null, b.title ?? null],
          reason: 'similar-title',
          score: Number(score.toFixed(2))
        });
      }
    }
  }

  return {
    archive,
    proposals,
    protectedIds: [...protectedIds],
    target,
    activeAfter: active.length
  };
}
