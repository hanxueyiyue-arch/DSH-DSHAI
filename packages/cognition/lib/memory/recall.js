// 记忆召回适配：只读、归档不参与、返回证据。
// 复用迁移来的 BM25/分层/字符预算实现，不写任何状态。

import { cycleRecall } from './brainmem-v2.js';
import { interestBoost } from '../self/drives.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// role 分层：action 记录（"执行发送/我对用户说……"）同质又高频，默认不进正排，
// 否则任何对话查询都会被它们挤满。只有查询明显在问行为/承诺时才放行。
const ACTION_INTENT = /我说过|我说了|你说过|做过|干了|上次说|之前说|答应|承诺|汇报|报备/;
export function roleAllows(row, query) {
  if (!row || row.kind !== 'action') return true;
  return ACTION_INTENT.test(String(query ?? ''));
}

// recency：被回忆起过的记忆应当"更新"，而不是只看创建时间。
function recencyAt(row) {
  const recalled = Number(row?.lastRecalledAt);
  if (Number.isFinite(recalled) && recalled > 0) return recalled;
  const occurred = Number(row?.occurredAt);
  if (Number.isFinite(occurred)) return occurred;
  const created = Date.parse(row?.createdAt ?? '');
  return Number.isFinite(created) ? created : 0;
}


// BM25（词法）+ recency + importance 融合；只重排，不改变证据的只读性质。
// 传入 behavior 时，最近在意的话题/好奇心会获得小幅偏置，但不改变证据。
export function recallMemories(rows, query, { now = Date.now(), limit = 5, maxChars = 800, includeTest = false, drives = null } = {}) {
  const active = (Array.isArray(rows) ? rows : [])
    .filter(row => row && !row.archivedAt && !row.supersededBy)
    .filter(row => roleAllows(row, query));
  const base = cycleRecall(active, String(query ?? ''), {
    limit: Math.min(10, Math.max(limit * 2, 8)),
    maxChars: Math.max(maxChars, 1200),
    now,
    includeTest,
    debug: false
  });
  const byId = new Map(active.map(row => [row.id, row]));
  const ranked = base.items
    .map(item => {
      const row = byId.get(item.id) ?? {};
      const at = recencyAt(row);
      const recency = Number.isFinite(at) ? Math.exp(-Math.max(0, now - at) / (90 * DAY_MS)) : 0;
      const importance = Math.min(1, Math.max(0, (Number(row.importance) || 3) / 5));
      const lexical = Math.min(1, Math.max(0, Number(item.score) || 0));
      const drive =
        drives === null || drives === undefined
          ? 0
          : interestBoost(drives, Array.isArray(row.tags) ? row.tags : String(row.tags ?? '').split(/\s+/));
      const base = drives === null || drives === undefined
        ? 0.65 * lexical + 0.2 * recency + 0.15 * importance
        : 0.55 * lexical + 0.17 * recency + 0.13 * importance + 0.15 * drive;
      return {
        ...item,
        drive: Number(drive.toFixed(3)),
        score: Number(base.toFixed(3))
      };
    })
    .sort((a, b) => b.score - a.score);

  const items = [];
  const topicHits = {};
  let used = 0;
  for (const item of ranked) {
    if (items.length >= limit) break;
    const size = JSON.stringify(item).length;
    if (items.length > 0 && used + size > maxChars) break;
    items.push(item);
    used += size;
    for (const topic of String(item.tags ?? '').split(/\s+/).filter(Boolean)) {
      topicHits[topic] = (topicHits[topic] || 0) + 1;
    }
  }
  return {
    ...base,
    items,
    topicHits,
    truncated: base.truncated || items.length < ranked.length,
    charBudget: maxChars
  };
}

export function emptyRecall(query = '') {
  return {
    readOnly: true,
    evidenceOnly: true,
    query: String(query ?? ''),
    items: [],
    topicHits: {},
    truncated: false,
    charBudget: 0,
    degraded: 'no-query'
  };
}

export function cuesFromRecall(recall) {
  const topics = Object.entries(recall?.topicHits ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([topic, count]) => ({ topic, count }));
  const drivers = (recall?.items ?? []).slice(0, 3).map(item => ({
    id: item.id,
    title: item.title,
    score: item.score,
    recallLevel: item.recallLevel,
    kind: item.kind,
    layer: item.layer
  }));
  return { drivers, topics };
}
