/**
 * 受控 co-cite 采集（T1g）。
 *
 * 这里只做一件事：把"某条经历在生成时明确引用了哪些既有记忆"翻译成一条
 * `co-cite` 关联事件。它不判断引用是否正确，也不产生任何新的记忆。
 *
 * 四条边界：
 *   1. **只认真实存在的记忆 ID**。未知 ID 一律丢弃并计数，绝不为了凑关联而补 ID。
 *   2. **至少一条引用**才建边（`owner + 1` 个 ID 已经是 `ids.length >= 2`）；没有引用就不写事件。
 *   3. **默认关闭**。只有 `DSH_BM_ASSOC_COLLECT=1` 才能写；生产环境不设这个变量即完全静止。
 *   4. **ep 必须稳定且 ≤64 字节**。`sourceEventId` 是重试/重启后都不变的经历编号，但它最长 160，
 *      超过事件格式的上限时用 SHA-256 前缀压缩——同一输入永远得到同一输出，幂等性不受影响。
 */
import { createHash } from 'node:crypto';

/** 一次经历最多带 16 条引用；再多说明调用方在"把整页记忆都贴上来"，不是引用。 */
export const MAX_CITES = 16;
/** 采集开关的环境变量名。默认不存在 = 关闭。 */
export const COLLECT_ENV = 'DSH_BM_ASSOC_COLLECT';
/** 事件格式对 ep 的上限（见 associations.js validateEvent）。 */
const EP_MAX = 64;
const ID_MAX = 120;

export function collectionEnabled(env = process.env) {
  return String(env?.[COLLECT_ENV] ?? '') === '1';
}

/**
 * 规范化引用列表。
 * `known` 是"当前确实存在的记忆 ID 集合"；未提供时**不做存在性过滤**（调用方必须自己保证）。
 * 返回 `{ ids, dropped }`，`dropped` 只用于观测，不参与建边。
 */
export function normalizeCites(cites, { ownerId = null, known = null } = {}) {
  const dropped = { invalid: 0, self: 0, unknown: 0, duplicate: 0, overflow: 0 };
  const rawList = Array.isArray(cites) ? cites : (cites == null ? [] : [cites]);
  const seen = new Set();
  const ids = [];
  for (const raw of rawList) {
    if (typeof raw !== 'string' && typeof raw !== 'number') { dropped.invalid += 1; continue; }
    const id = String(raw).trim();
    if (!id || id.length > ID_MAX) { dropped.invalid += 1; continue; }
    if (ownerId != null && id === String(ownerId)) { dropped.self += 1; continue; }
    if (known && !known.has(id)) { dropped.unknown += 1; continue; }
    if (seen.has(id)) { dropped.duplicate += 1; continue; }
    if (ids.length >= MAX_CITES) { dropped.overflow += 1; continue; }
    seen.add(id);
    ids.push(id);
  }
  return { ids, dropped };
}

/** 把经历编号压到事件格式允许的长度；短于上限时原样返回（便于人工对账）。 */
export function stableEpisodeId(sourceEventId) {
  const text = String(sourceEventId ?? '').trim();
  if (!text) return '';
  if (text.length <= EP_MAX) return text;
  return `h:${createHash('sha256').update(text).digest('hex').slice(0, 40)}`;
}

/**
 * 构造一条 co-cite 事件（不做 I/O）。
 * 返回 `{ event, ids, dropped, reason }`；`event === null` 时 `reason` 说明为什么没建事件。
 * 可能的原因：`missing-owner`、`missing-ep`、`no-cites`。
 */
export function buildCoCiteEvent({ ownerId, cites, sourceEventId, t, known = null, w } = {}) {
  const owner = ownerId == null ? '' : String(ownerId).trim();
  if (!owner) return { event: null, ids: [], dropped: null, reason: 'missing-owner' };
  const ep = stableEpisodeId(sourceEventId);
  if (!ep) return { event: null, ids: [], dropped: null, reason: 'missing-ep' };
  const { ids, dropped } = normalizeCites(cites, { ownerId: owner, known });
  if (!ids.length) return { event: null, ids, dropped, reason: 'no-cites' };
  const event = { t: Number.isFinite(t) ? t : Date.now(), kind: 'co-cite', ids: [owner, ...ids], ep };
  if (Number.isFinite(w)) event.w = w;
  return { event, ids, dropped, reason: null };
}
