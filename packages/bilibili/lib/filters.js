export class FilterError extends Error {
  constructor(message, { code = 'CONTENT_FILTERED', reason = null } = {}) {
    super(message);
    this.name = 'FilterError';
    this.code = code;
    this.reason = reason;
  }
}

export const FILTER_LIMITS = Object.freeze({ items: 20, text: 40 });
export const FILTER_CODES = Object.freeze({
  KEYWORD_EXCLUDED: 'FILTER_KEYWORD_EXCLUDED',
  KEYWORD_NOT_INCLUDED: 'FILTER_KEYWORD_NOT_INCLUDED',
  UPPER_EXCLUDED: 'FILTER_UPPER_EXCLUDED',
  UPPER_NOT_INCLUDED: 'FILTER_UPPER_NOT_INCLUDED',
  CATEGORY_EXCLUDED: 'FILTER_CATEGORY_EXCLUDED',
  CATEGORY_NOT_INCLUDED: 'FILTER_CATEGORY_NOT_INCLUDED',
  METADATA_UNKNOWN: 'FILTER_METADATA_UNKNOWN',
});

const clean = value => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, FILTER_LIMITS.text);
const list = value => (Array.isArray(value) ? value : [])
  .map(clean).filter(Boolean).slice(0, FILTER_LIMITS.items);
const uniq = rows => [...new Set(rows)];
const matches = (haystack, needle) => haystack.includes(needle);

export function blankFilters() {
  return {
    enabled: false,
    // null = 旧配置（按 include 是否存在推断 allow/deny）；'deny' = include 仅排序。
    mode: null,
    keywordsInclude: [],
    keywordsExclude: [],
    uppersInclude: [],
    uppersExclude: [],
    categoriesInclude: [],
    categoriesExclude: [],
    updatedAt: null,
    updatedBy: null,
  };
}

export function normalizeFilters(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: input.enabled === true,
    mode: ['off', 'deny', 'allow'].includes(input.mode) ? input.mode : null,
    keywordsInclude: uniq(list(input.keywordsInclude)),
    keywordsExclude: uniq(list(input.keywordsExclude)),
    uppersInclude: uniq(list(input.uppersInclude)),
    uppersExclude: uniq(list(input.uppersExclude)),
    categoriesInclude: uniq(list(input.categoriesInclude)),
    categoriesExclude: uniq(list(input.categoriesExclude)),
    updatedAt: typeof input.updatedAt === 'string' ? clean(input.updatedAt) : null,
    updatedBy: typeof input.updatedBy === 'string' ? clean(input.updatedBy) : null,
  };
}

export function filtersConfigured(filters) {
  if (!filters || filters.enabled !== true) return false;
  return ['keywordsInclude', 'keywordsExclude', 'uppersInclude', 'uppersExclude',
    'categoriesInclude', 'categoriesExclude'].some(key => Array.isArray(filters[key]) && filters[key].length > 0);
}

/**
 * 在“已取得最小必要公开元数据”之后执行。返回：
 * - { ok: true }
 * - { ok: false, code, reason, unknown }
 *
 * 分区包含只作为排序偏好，永远不做准入；分区排除和关键词/UP 排除仍是硬规则。
 * 已启用硬规则所需的分区元数据缺失时返回 unknown=true（调用方必须 fail-closed），
 * 不允许把未知元数据当成“通过”。
 */
export function evaluateVideo(video, filters) {
  if (!filtersConfigured(filters)) return { ok: true };
  if (filters.mode === 'off') return { ok: true };
  // deny 模式：关键词/UP include 只作为排序偏好，不作为准入 allowlist；exclude 仍然硬执行。
  const denyOnly = filters.mode === 'deny';
  const title = String(video?.title ?? '').toLocaleLowerCase();
  const owner = String(video?.owner ?? '').toLocaleLowerCase();
  const category = String(video?.tname ?? video?.category ?? '').toLocaleLowerCase();
  const lower = rows => rows.map(row => row.toLocaleLowerCase());
  const kIn = lower(filters.keywordsInclude);
  const kOut = lower(filters.keywordsExclude);
  const uIn = lower(filters.uppersInclude);
  const uOut = lower(filters.uppersExclude);
  const cOut = lower(filters.categoriesExclude);

  if (kOut.some(word => matches(title, word))) {
    return { ok: false, code: FILTER_CODES.KEYWORD_EXCLUDED, reason: '标题命中排除关键词' };
  }
  if (!denyOnly && kIn.length && !kIn.some(word => matches(title, word))) {
    return { ok: false, code: FILTER_CODES.KEYWORD_NOT_INCLUDED, reason: '标题未命中允许关键词' };
  }
  if (uOut.length && uOut.some(name => matches(owner, name))) {
    return { ok: false, code: FILTER_CODES.UPPER_EXCLUDED, reason: 'UP 主命中排除名单' };
  }
  if (!denyOnly && uIn.length && !uIn.some(name => matches(owner, name))) {
    return { ok: false, code: FILTER_CODES.UPPER_NOT_INCLUDED, reason: 'UP 主不在允许名单' };
  }
  // 分区包含（categoriesInclude）只用于发现排序，不参与这里的准入/排除判断。
  if (cOut.length) {
    if (!category) {
      return {
        ok: false, code: FILTER_CODES.METADATA_UNKNOWN, unknown: true,
        reason: '已启用分区排除，但当前元数据缺少分区信息',
      };
    }
    if (cOut.some(name => category === name || matches(category, name))) {
      return { ok: false, code: FILTER_CODES.CATEGORY_EXCLUDED, reason: '分区命中排除名单' };
    }
  }
  return { ok: true };
}

export function applyFilters(videos, filters) {
  const rows = Array.isArray(videos) ? videos : [];
  if (!filtersConfigured(filters)) return { allowed: rows, blocked: [] };
  const allowed = [];
  const blocked = [];
  for (const video of rows) {
    const verdict = evaluateVideo(video, filters);
    if (verdict.ok) allowed.push(video);
    else blocked.push({
      bvid: video?.bvid ?? null,
      title: video?.title ?? null,
      code: verdict.code,
      reason: verdict.reason,
      unknown: verdict.unknown === true,
    });
  }
  return { allowed, blocked };
}

export function requireUser(actor) {
  if (!actor || actor.kind !== 'user' || actor.authenticated !== true) {
    throw new FilterError('只有通过身份验证的用户才能修改内容限制', { code: 'FILTERS_REQUIRE_USER' });
  }
}
