import { FILTER_CODES, FilterError, requireUser } from './filters.js';

export { FILTER_CODES };

export const POLICY_LIMITS = Object.freeze({ items: 30, text: 60 });
export const POLICY_MODES = Object.freeze(['off', 'deny', 'allow']);
export const POLICY_OVERRIDE_TTL_MS = 24 * 60 * 60 * 1000;

const clean = value => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, POLICY_LIMITS.text);
const list = value => (Array.isArray(value) ? value : [])
  .map(clean).filter(Boolean).slice(0, POLICY_LIMITS.items);
const uniq = rows => [...new Set(rows)];

function policyHasRules(policy) {
  return ['keywordsExclude', 'uppersExclude', 'categoriesExclude'].some(key => policy.hard[key].length > 0)
    || ['keywordsInclude', 'uppersInclude', 'categoriesInclude'].some(key => policy.soft[key].length > 0);
}

export function blankPolicy() {
  return {
    mode: 'off',
    hard: { keywordsExclude: [], uppersExclude: [], categoriesExclude: [] },
    soft: { keywordsInclude: [], uppersInclude: [], categoriesInclude: [] },
    // 旧 filters 迁移时保留“分区未知即拒绝”的行为；新策略默认不因未知元数据拦截。
    strictMetadata: false,
    override: null,
    updatedAt: null,
    updatedBy: null,
  };
}

/**
 * 旧 filters 的迁移：
 * - 未启用 → off
 * - 有 include → allow（保留旧 allowlist 行为，不静默改变）
 * - 只有 exclude → deny
 */
export function policyFromFilters(filters) {
  const input = filters && typeof filters === 'object' ? filters : {};
  const policy = blankPolicy();
  policy.hard.keywordsExclude = uniq(list(input.keywordsExclude));
  policy.hard.uppersExclude = uniq(list(input.uppersExclude));
  policy.hard.categoriesExclude = uniq(list(input.categoriesExclude));
  policy.soft.keywordsInclude = uniq(list(input.keywordsInclude));
  policy.soft.uppersInclude = uniq(list(input.uppersInclude));
  policy.soft.categoriesInclude = uniq(list(input.categoriesInclude));
  policy.updatedAt = typeof input.updatedAt === 'string' ? clean(input.updatedAt) : null;
  policy.updatedBy = typeof input.updatedBy === 'string' ? clean(input.updatedBy) : null;
  // 分区包含只做排序偏好：不触发 allowlist，也不因分区未知而 fail-closed。
  policy.strictMetadata = policy.hard.categoriesExclude.length > 0;
  if (POLICY_MODES.includes(input.mode)) {
    policy.mode = input.mode;
    return policy;
  }
  if (input.enabled !== true) return policy;
  const hasInclude = ['keywordsInclude', 'uppersInclude']
    .some(key => policy.soft[key].length > 0);
  policy.mode = hasInclude ? 'allow' : 'deny';
  return policy;
}

function normalizeOverride(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const bvid = clean(raw.bvid);
  const until = Number(raw.until);
  if (!bvid || !Number.isFinite(until)) return null;
  return {
    bvid,
    until,
    reason: clean(raw.reason) || '用户一次性放行',
    actor: raw.actor && typeof raw.actor === 'object' ? { kind: clean(raw.actor.kind) } : null,
  };
}

export function normalizePolicy(raw) {
  if (!raw || typeof raw !== 'object') return blankPolicy();
  const isNewShape = raw.hard || raw.soft || raw.mode !== undefined;
  if (!isNewShape) return policyFromFilters(raw);
  const policy = blankPolicy();
  policy.mode = POLICY_MODES.includes(raw.mode) ? raw.mode : 'off';
  for (const key of ['keywordsExclude', 'uppersExclude', 'categoriesExclude']) {
    policy.hard[key] = uniq(list(raw.hard?.[key]));
  }
  for (const key of ['keywordsInclude', 'uppersInclude', 'categoriesInclude']) {
    policy.soft[key] = uniq(list(raw.soft?.[key]));
  }
  policy.strictMetadata = raw.strictMetadata === true;
  policy.override = normalizeOverride(raw.override);
  policy.updatedAt = typeof raw.updatedAt === 'string' ? clean(raw.updatedAt) : null;
  policy.updatedBy = typeof raw.updatedBy === 'string' ? clean(raw.updatedBy) : null;
  if (policy.mode !== 'off' && !policyHasRules(policy)) policy.mode = 'off';
  return policy;
}

export function policyConfigured(raw) {
  const policy = normalizePolicy(raw);
  return policy.mode !== 'off' && policyHasRules(policy);
}

export function overrideActive(policy, bvid, now = Date.now()) {
  return Boolean(policy?.override && policy.override.bvid === bvid && policy.override.until > now);
}

/**
 * 内容策略求值。返回 { ok, decision, score, reasons, code?, unknown? }。
 * - 硬规则（关键词/UP/分区 exclude）始终执行。
 * - soft include 默认只加分；只有 mode='allow' 时关键词/UP include 才做准入。
 * - 分区包含（categoriesInclude）永远只加分，不做准入。
 * - 只有启用分区排除时缺少分区元数据 → fail-closed；分区偏好缺失只影响排序。
 */
export function evaluateContent(item, rawPolicy, { now = Date.now() } = {}) {
  const policy = normalizePolicy(rawPolicy);
  if (policy.mode === 'off' || !policyHasRules(policy)) {
    return { ok: true, decision: 'allow', score: 0, reasons: [] };
  }
  const bvid = String(item?.bvid ?? '');
  if (overrideActive(policy, bvid, now)) {
    return { ok: true, decision: 'allow', score: 0, reasons: ['用户一次性放行'] };
  }
  const title = String(item?.title ?? '').toLocaleLowerCase();
  const owner = String(item?.owner?.name ?? item?.owner ?? '').toLocaleLowerCase();
  const category = String(item?.tname ?? item?.category ?? '').toLocaleLowerCase();
  const lower = rows => rows.map(row => row.toLocaleLowerCase());
  const kOut = lower(policy.hard.keywordsExclude);
  const uOut = lower(policy.hard.uppersExclude);
  const cOut = lower(policy.hard.categoriesExclude);
  const kIn = lower(policy.soft.keywordsInclude);
  const uIn = lower(policy.soft.uppersInclude);
  const cIn = lower(policy.soft.categoriesInclude);
  const reasons = [];

  if (kOut.some(word => title.includes(word))) {
    return { ok: false, decision: 'deny', code: FILTER_CODES.KEYWORD_EXCLUDED, reason: '标题命中排除关键词', reasons: ['硬规则：标题排除'] };
  }
  if (uOut.length && uOut.some(name => owner.includes(name))) {
    return { ok: false, decision: 'deny', code: FILTER_CODES.UPPER_EXCLUDED, reason: 'UP 主命中排除名单', reasons: ['硬规则：UP 排除'] };
  }
  // 分区包含只参与排序；只有分区排除需要 fail-closed。
  const categoryRule = cOut.length > 0;
  if (categoryRule && !category) {
    return { ok: false, decision: 'deny', code: FILTER_CODES.METADATA_UNKNOWN, unknown: true, reason: '已启用分区排除，但缺少分区信息', reasons: ['硬规则：分区未知'] };
  }
  if (cOut.length && category && cOut.some(name => category === name || category.includes(name))) {
    return { ok: false, decision: 'deny', code: FILTER_CODES.CATEGORY_EXCLUDED, reason: '分区命中排除名单', reasons: ['硬规则：分区排除'] };
  }

  if (policy.mode === 'allow') {
    if (kIn.length && !kIn.some(word => title.includes(word))) {
      return { ok: false, decision: 'deny', code: FILTER_CODES.KEYWORD_NOT_INCLUDED, reason: '标题未命中允许关键词', reasons: ['准入：关键词未命中'] };
    }
    if (uIn.length && !uIn.some(name => owner.includes(name))) {
      return { ok: false, decision: 'deny', code: FILTER_CODES.UPPER_NOT_INCLUDED, reason: 'UP 主不在允许名单', reasons: ['准入：UP 不在名单'] };
    }
  }

  let score = 0;
  const kHit = kIn.some(word => title.includes(word));
  const uHit = uIn.some(name => owner.includes(name));
  const cHit = cIn.some(name => category === name || category.includes(name));
  if (kHit) { score += 4; reasons.push('偏好：关键词命中'); }
  if (uHit) { score += 4; reasons.push('偏好：UP 命中'); }
  if (cHit) { score += 3; reasons.push('偏好：分区命中'); }
  if (categoryRule && !category) reasons.push('元数据：分区未知，未参与排序');
  return { ok: true, decision: 'allow', score: Math.min(12, score), reasons };
}

export function addOverride(rawPolicy, { bvid, reason = '', actor, now = Date.now(), ttlMs = POLICY_OVERRIDE_TTL_MS } = {}) {
  requireUser(actor);
  const id = clean(bvid);
  if (!id) throw new FilterError('缺少 bvid', { code: 'FILTER_OVERRIDE_BVID_REQUIRED' });
  const policy = normalizePolicy(rawPolicy);
  const ttl = Number.isFinite(Number(ttlMs)) ? Math.max(60_000, Number(ttlMs)) : POLICY_OVERRIDE_TTL_MS;
  policy.override = {
    bvid: id,
    until: now + ttl,
    reason: clean(reason) || '用户一次性放行',
    actor: { kind: 'user' },
  };
  policy.updatedAt = new Date(now).toISOString();
  return policy;
}

export function clearOverride(rawPolicy) {
  const policy = normalizePolicy(rawPolicy);
  policy.override = null;
  return policy;
}
