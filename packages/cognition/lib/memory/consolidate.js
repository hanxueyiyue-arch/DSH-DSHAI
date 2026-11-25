// 高风险巩固只产出“建议”，不自动改记忆：同主题聚合、近似合并、冲突观察。
// 低风险清理仍在 maintenance 的自动规则里；这里只负责 proposals 队列。

import { addMemory } from './write.js';
import { lexemes } from './memory.js';

export const PROPOSAL_LIMIT = 5;const GENERIC_TAGS = new Set(['行为', '对话', '情绪', '日程', '抽取', '更正', '用户', '称呼', '请求', '承诺', '视频']);

function tagList(row) {
  const tags = row?.tags;
  if (Array.isArray(tags)) return tags.filter(item => typeof item === 'string');
  if (typeof tags === 'string') return tags.split(/[\s,，]+/).filter(Boolean);
  return [];
}

function titleSimilarity(a, b) {
  const left = [...lexemes(a)].filter(token => token.length === 2);
  const right = new Set([...lexemes(b)].filter(token => token.length === 2));
  if (left.length === 0 || right.size === 0) return 0;
  const hit = left.filter(token => right.has(token)).length;
  return hit / Math.max(left.length, right.size);
}

function proposalOf(action, rows, now, reason) {
  const ids = rows.map(row => row.id);
  return {
    id: `prop-${action}-${now}-${ids[0]}`,
    action,
    memoryIds: ids,
    title: rows[0]?.title ?? '记忆整理',
    content: rows.map(row => row.title).join(' / ').slice(0, 300),
    reason,
    createdAt: now
  };
}

export function planProposals(memories, { now = Date.now(), limit = PROPOSAL_LIMIT } = {}) {
  const active = (Array.isArray(memories) ? memories : []).filter(
    row => row && !row.archivedAt && !row.supersededBy && row.kind !== 'test'
  );
  const proposals = [];
  const used = new Set();

  // 同主题 ≥3 条：抽象成一条更高层的记忆（只建议）。
  const byTopic = new Map();
  for (const row of active) {
    const tag = tagList(row).find(item => !GENERIC_TAGS.has(item));
    if (!tag) continue;
    const list = byTopic.get(tag) ?? [];
    list.push(row);
    byTopic.set(tag, list);
  }
  for (const [tag, rows] of byTopic) {
    if (rows.length < 3 || proposals.length >= limit) continue;
    const ids = rows.map(row => row.id);
    if (ids.some(id => used.has(id))) continue;
    const proposal = proposalOf('abstract', rows, now, `同一主题「${tag}」已有 ${rows.length} 条`);
    proposal.title = `关于${tag}`;
    proposal.content = `${tag}：${rows.map(row => row.title).join('；')}`.slice(0, 500);
    proposals.push(proposal);
    ids.forEach(id => used.add(id));
  }

  // 近似标题：合并建议（不动手）。
  for (let i = 0; i < active.length && proposals.length < limit; i += 1) {
    const a = active[i];
    if (used.has(a.id)) continue;
    for (let j = i + 1; j < active.length && proposals.length < limit; j += 1) {
      const b = active[j];
      if (used.has(b.id) || b.kind !== a.kind) continue;
      if (titleSimilarity(a.title, b.title) < 0.66) continue;
      proposals.push(proposalOf('merge', [a, b], now, '标题高度相似，可能是同一件事'));
      used.add(a.id);
      used.add(b.id);
      break;
    }
  }

  return proposals;
}

export function applyProposal(state, id, { now = Date.now(), capacity = 5000, timeZone = '' } = {}) {
  const list = Array.isArray(state?.proposals) ? state.proposals : [];
  const proposal = list.find(item => item.id === id);
  if (!proposal) return { ok: false, error: 'proposal-not-found' };
  const rows = (state.memories ?? []).filter(row => proposal.memoryIds.includes(row.id) && !row.archivedAt);
  if (rows.length < 2) return { ok: false, error: 'proposal-stale' };
  const created = addMemory(
    state,
    {
      kind: 'fact',
      layer: 'semantic',
      title: proposal.title || '整理后的记忆',
      content: proposal.content || rows.map(row => row.content).join('\n'),
      tags: ['整合', ...new Set(rows.flatMap(tagList))].slice(0, 8),
      importance: Math.max(...rows.map(row => Number(row.importance) || 3)),
      source: {
        level: 'consolidation',
        memoryIds: rows.map(row => row.id),
        proposalId: proposal.id
      },
      occurredAt: now
    },
    { now, capacity, timeZone }
  );
  if (!created.ok) return created;
  const iso = new Date(now).toISOString();
  for (const row of rows) {
    row.supersededBy = created.id;
    row.supersededAt = iso;
    row.updatedAt = iso;
  }
  state.proposals = list.filter(item => item.id !== id);
  return { ok: true, id: created.id, superseded: rows.map(row => row.id) };
}

export function dismissProposal(state, id) {
  const list = Array.isArray(state?.proposals) ? state.proposals : [];
  const before = list.length;
  state.proposals = list.filter(item => item.id !== id);
  return { ok: state.proposals.length < before };
}

/**
 * P8 低风险自动整理：只处理“同一用户消息/同一经历、正文完全一致”的重复事实。
 * 不删除原始记忆，只给后出现的重复项打 supersededBy；可回退、可审计。
 */
export function planDedupe(memories, { now = Date.now() } = {}) {
  const rows = (Array.isArray(memories) ? memories : []).filter(
    row => row && !row.archivedAt && !row.supersededBy && row.kind !== 'test' && row.kind !== 'insight'
  );
  const groups = new Map();
  for (const row of rows) {
    const content = String(row.content ?? '').trim();
    if (!content) continue;
    const source = row.source ?? {};
    const origin = source.messageId ?? source.episodeId ?? source.actionId ?? source.eventId ?? 'legacy';
    const key = `${row.kind}|${origin}|${content}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const operations = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const ordered = [...list].sort((a, b) => Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0));
    const keep = ordered[0];
    for (const duplicate of ordered.slice(1)) {
      operations.push({
        keepId: keep.id,
        duplicateId: duplicate.id,
        reason: 'exact-duplicate',
        createdAt: now
      });
    }
  }
  return operations;
}
