import { evaluateContent, normalizePolicy } from './policy.js';

export const DISCOVER_LIMITS = Object.freeze({ limit: 20, title: 200, owner: 60, category: 40 });

const clip = (value, max) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const num = value => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

/** 把 popular/search/dynamic 的原始条目归一成同一种候选。 */
export function normalizeCandidate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const bvid = clip(raw.bvid, 20);
  if (!bvid) return null;
  const owner = raw.owner && typeof raw.owner === 'object'
    ? { mid: clip(raw.owner.mid, 24), name: clip(raw.owner.name, DISCOVER_LIMITS.owner) }
    : { mid: clip(raw.mid, 24), name: clip(raw.owner ?? raw.author, DISCOVER_LIMITS.owner) };
  const stat = raw.stats && typeof raw.stats === 'object' ? raw.stats : (raw.stat ?? {});
  return {
    bvid,
    title: clip(raw.title, DISCOVER_LIMITS.title),
    owner,
    tname: clip(raw.tname, DISCOVER_LIMITS.category),
    duration: num(raw.duration),
    pubdate: num(raw.pubdate),
    stats: { view: num(stat.view), danmaku: num(stat.danmaku), reply: num(stat.reply) },
  };
}

/** 热度按“每分钟弹幕密度”计，刻意不用播放量做权重。 */
export function scoreCandidate(candidate, rawPolicy, { now = Date.now() } = {}) {
  const policy = normalizePolicy(rawPolicy);
  const verdict = evaluateContent(candidate, policy, { now });
  if (!verdict.ok) return { ok: false, score: 0, verdict };
  const minutes = Math.max(1, candidate.duration / 60);
  const density = candidate.stats.danmaku / minutes;
  const heat = 3 * Math.log10(1 + density);
  const score = Math.round((heat + verdict.score) * 1000) / 1000;
  return { ok: true, score, verdict };
}

function reasonKey(verdict) {
  return verdict.reasons.filter(reason => reason.startsWith('偏好：')).join('|') || '';
}

/**
 * 纯排序：去重、去已看、内容策略、热度 + 偏好、多样性上限。
 * 不发请求，不做“已看/已赞”的平台查询。
 */
export function rankCandidates(rows, rawPolicy, {
  limit = 10, seen = [], now = Date.now(), maxPerReason = 2, maxNoHit = 3,
} = {}) {
  const policy = normalizePolicy(rawPolicy);
  const seenSet = new Set((Array.isArray(seen) ? seen : [...(seen ?? [])]).map(String));
  const size = Math.max(1, Math.min(DISCOVER_LIMITS.limit, Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 10));
  const items = [];
  const blocked = [];
  const byBvid = new Set();
  const perReason = new Map();
  let noHit = 0;

  for (const raw of Array.isArray(rows) ? rows : []) {
    const candidate = normalizeCandidate(raw);
    if (!candidate || byBvid.has(candidate.bvid)) continue;
    byBvid.add(candidate.bvid);
    if (seenSet.has(candidate.bvid)) {
      blocked.push({ bvid: candidate.bvid, title: candidate.title, code: 'DISCOVER_SEEN', reason: '已看过' });
      continue;
    }
    const result = scoreCandidate(candidate, policy, { now });
    if (!result.ok) {
      blocked.push({
        bvid: candidate.bvid, title: candidate.title,
        code: result.verdict.code ?? 'DISCOVER_BLOCKED',
        reason: result.verdict.reason ?? '内容策略拒绝',
        unknown: result.verdict.unknown === true,
      });
      continue;
    }
    const key = reasonKey(result.verdict);
    if (key) {
      const count = perReason.get(key) ?? 0;
      if (count >= maxPerReason) {
        blocked.push({ bvid: candidate.bvid, title: candidate.title, code: 'DISCOVER_DIVERSITY', reason: '同类偏好命中过多' });
        continue;
      }
      perReason.set(key, count + 1);
    } else {
      if (noHit >= maxNoHit) {
        blocked.push({ bvid: candidate.bvid, title: candidate.title, code: 'DISCOVER_DIVERSITY', reason: '无偏好命中条数已达上限' });
        continue;
      }
      noHit += 1;
    }
    items.push({ ...candidate, score: result.score, reasons: result.verdict.reasons });
  }

  items.sort((a, b) => (b.score - a.score) || a.bvid.localeCompare(b.bvid));
  return { items: items.slice(0, size), blocked };
}
