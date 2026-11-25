/**
 * DeepSeek 价格表与峰谷时段。
 *
 * 设计约束：
 * - 金额统一用“微元”（1e-6 CNY）整数，避免浮点误差；不再使用美元口径；
 * - 价格表不是写死的常量：默认值来自官方文档（人民币/百万 tokens），可由用户配置覆盖；
 * - 未知模型 / 未知价格返回 null，由调用方失败安全处理；
 * - 峰谷时段按官方规则：北京时间周一至周五 09:00–12:00、14:00–18:00
 *   （即 UTC 01:00–04:00 与 06:00–10:00），扣除中国法定节假日；其余为空闲，
 *   空闲价约为高峰价的一半。
 */

/** 1 元 = 1_000_000 微元。 */
export const MICRO_CNY = 1_000_000;

/**
 * Provider 别名：官方账号/API key 两个入口指向同一 DeepSeek 官方价格表。
 * 价格表本身按服务商品牌（deepseek）维护，路由名（deepseek-account、
 * deepseek-official）只作为入口别名，避免同一模型出现两份价格来源。
 */
const PROVIDER_ALIASES = Object.freeze({
  'deepseek-account': 'deepseek',
  'deepseek-official': 'deepseek',
});

/** 每 1M token 的价格（人民币元），高峰/空闲分开。 */
export const DEFAULT_PRICES = Object.freeze({
  deepseek: {
    'deepseek-flash': {
      peak: { cacheRead: 0.04, cacheMiss: 2, output: 8, cacheWrite: 0 },
      offPeak: { cacheRead: 0.02, cacheMiss: 1, output: 4, cacheWrite: 0 },
      source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
      effectiveFrom: '2026-11-01',
    },
    'deepseek-v4-pro': {
      peak: { cacheRead: 0.3, cacheMiss: 9, output: 27, cacheWrite: 0 },
      offPeak: { cacheRead: 0.15, cacheMiss: 4.5, output: 13.5, cacheWrite: 0 },
      source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
      effectiveFrom: '2026-11-01',
    },
  },
});

// 北京时间（UTC+8）。IANA 时区库里没有 `Asia/Beijing`：中国自 1949 年起统一单一时区，
// 该库用 `Asia/Shanghai` 作为中国标准时间的标识，所以这两个名字指的是**同一个时区**。
const SHANGHAI = 'Asia/Shanghai';

/** 高峰时段（UTC 分钟数，左闭右开）。 */
const PEAK_WINDOWS = Object.freeze([
  [1 * 60, 4 * 60],
  [6 * 60, 10 * 60],
]);

/** 取 IANA 时区下的 YYYY-MM-DD；失败返回 null。 */
export function dateKeyIn(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const pick = (type) => parts.find((part) => part.type === type)?.value;
    const year = pick('year');
    const month = pick('month');
    const day = pick('day');
    if (!year || !month || !day) return null;
    return `${year}-${month}-${day}`;
  } catch {
    return null;
  }
}

/** 预算日界：按配置时区的本地日期。 */
export function dayKeyAt(date, timeZone = SHANGHAI) {
  return dateKeyIn(new Date(date), timeZone) ?? new Date(date).toISOString().slice(0, 10);
}

/** UTC 星期几，0 = 周日。 */
function utcWeekday(date) {
  return new Date(date).getUTCDay();
}

/**
 * 是否处于高峰时段。
 *
 * @param {number|Date} at 时间点
 * @param {{holidays?: string[]}} [options] 中国法定节假日（北京时间 UTC+8 的日期）
 */
export function isPeakAt(at, { holidays = [] } = {}) {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return true; // 时间未知时按高峰（失败安全）
  const weekday = utcWeekday(date);
  if (weekday === 0 || weekday === 6) return false;
  const shanghaiDate = dateKeyIn(date, SHANGHAI);
  if (shanghaiDate && Array.isArray(holidays) && holidays.includes(shanghaiDate)) return false;
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  return PEAK_WINDOWS.some(([start, end]) => minutes >= start && minutes < end);
}

/** 返回高峰或空闲的价格档位。 */
export function priceWindowAt(at, options) {
  return isPeakAt(at, options) ? 'peak' : 'offPeak';
}

/**
 * 合并默认价格与用户覆盖，返回 `{provider: {model: entry}}`。
 * 覆盖项必须自带 source 与 effectiveFrom，避免出现无来源价格。
 */
export function buildPriceTable(overrides) {
  const table = {};
  for (const [provider, models] of Object.entries(DEFAULT_PRICES)) {
    table[provider] = { ...models };
  }
  if (overrides === null || typeof overrides !== 'object') return table;
  for (const [provider, models] of Object.entries(overrides)) {
    if (models === null || typeof models !== 'object') continue;
    table[provider] ??= {};
    for (const [model, entry] of Object.entries(models)) {
      const normalized = normalizePriceEntry(entry);
      if (normalized !== null) table[provider][model] = normalized;
    }
  }
  return table;
}

/** 校验一条价格；不合法返回 null。 */
export function normalizePriceEntry(entry) {
  if (entry === null || typeof entry !== 'object') return null;
  if (entry.currency !== undefined && entry.currency !== 'CNY') return null;
  const peak = normalizeRates(entry.peak);
  const offPeak = normalizeRates(entry.offPeak);
  if (peak === null || offPeak === null) return null;
  const source = typeof entry.source === 'string' && entry.source.length > 0 ? entry.source : null;
  const effectiveFrom = typeof entry.effectiveFrom === 'string' ? entry.effectiveFrom : null;
  if (source === null || effectiveFrom === null) return null;
  return { peak, offPeak, source, effectiveFrom };
}

/** 同时接受紧凑字段（cacheRead）与旧版 per-million 字段（cacheReadPerMillion）。 */
const RATE_ALIASES = Object.freeze({
  cacheRead: ['cacheRead', 'cacheReadPerMillion'],
  cacheMiss: ['cacheMiss', 'cacheMissPerMillion'],
  output: ['output', 'outputPerMillion'],
  cacheWrite: ['cacheWrite', 'cacheWritePerMillion'],
});

/**
 * 价格条目必须显式给出 cacheRead / cacheMiss / output 三项，缺失即视为
 * 无效条目（避免“缺字段默认 0”把收费模型变成免费模型）。cacheWrite 可省略，
 * 省略时按 0 处理（当前官方无缓存写入费用）。
 */
function normalizeRates(rates) {
  if (rates === null || typeof rates !== 'object') return null;
  const normalized = {};
  for (const [field, aliases] of Object.entries(RATE_ALIASES)) {
    const present = aliases.filter((alias) => rates[alias] !== undefined);
    if (present.length === 0) {
      if (field === 'cacheWrite') {
        normalized[field] = 0;
        continue;
      }
      return null;
    }
    const value = rates[present[0]];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
    normalized[field] = value;
  }
  return normalized;
}

/** 精确取一条价格；未知返回 null（Provider 别名只在直接命中失败后回退）。 */
export function resolvePrice(table, provider, model) {
  if (table === null || typeof table !== 'object') return null;
  const direct = table[provider];
  if (direct !== null && direct !== undefined && direct[model] !== undefined) return direct[model];
  const alias = PROVIDER_ALIASES[provider];
  if (alias === undefined) return null;
  const byAlias = table[alias];
  if (byAlias === null || byAlias === undefined) return null;
  const entry = byAlias[model];
  return entry === undefined ? null : entry;
}

/** 保守费率：同一模型取高峰与空闲中的较大值（金额预留用）。 */
export function worstRates(entry) {
  if (entry === null) return null;
  const fields = ['cacheRead', 'cacheMiss', 'output', 'cacheWrite'];
  const rates = {};
  for (const field of fields) rates[field] = Math.max(entry.peak[field], entry.offPeak[field]);
  return rates;
}

/**
 * 把一次用量换算成整数微元。
 *
 * `inputTokens` 是“未命中缓存的输入”，缓存读取与写入分别有独立价格；
 * 不接收“totalTokens”，防止把已包含在总量里的缓存/推理 token 重复计算。
 *
 * @param {{table:object, provider:string, model:string, usage:object, at:number|Date,
 *          holidays?:string[], conservative?:boolean, roundUp?:boolean}} input
 * @returns {{micros:number, window:'peak'|'offPeak', price:object}|null}
 */
export function costMicros({ table, provider, model, usage, at, holidays = [], conservative = false, roundUp = false }) {
  const entry = resolvePrice(table, provider, model);
  if (entry === null) return null;
  const window = conservative ? 'peak' : priceWindowAt(at, { holidays });
  const rates = conservative ? worstRates(entry) : entry[window];
  const uncached = count(usage?.inputTokens);
  const cacheRead = count(usage?.cacheReadTokens);
  const cacheWrite = count(usage?.cacheWriteTokens);
  const output = count(usage?.outputTokens);
  const raw =
    uncached * rates.cacheMiss +
    cacheRead * rates.cacheRead +
    cacheWrite * rates.cacheWrite +
    output * rates.output;
  const micros = roundUp ? Math.ceil(raw - 1e-9) : Math.max(0, Math.round(raw));
  return { micros, window, price: rates, tokens: uncached + cacheRead + cacheWrite + output };
}

/** 非负安全整数；非法值按 0。 */
export function count(value) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.floor(number);
}

/** 正整数；非法返回 null。 */
export function positiveInteger(value) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/** 非负整数；非法返回 null。 */
export function nonNegativeInteger(value) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}
