/**
 * 预算配置：由用户（或可信配置维护者）写入，插件自身绝不修改。
 *
 * 没有有效配置时，`configured` 为 false，付费自主调用默认禁止。
 */

import { normalizePriceEntry } from './pricing.js'
import { DEFAULT_RETAIN_DAYS, MAX_RETAIN_DAYS, MIN_RETAIN_DAYS } from './savings.js'

/** 金额固定以人民币微元计；不再接受美元或汇率换算。 */
const CURRENCY = 'CNY'

/** 校验 IANA 时区。 */
export function validTimeZone(value) {
  if (typeof value !== 'string' || value.length === 0) return false
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: value }).format(new Date(0))
    return true
  } catch {
    return false
  }
}

/** 校验 `YYYY-MM-DD`。 */
export function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

/**
 * 归一化并校验配置。返回 `{config, errors}`；`config` 为 null 表示不可用。
 *
 * 硬限额必须由用户显式设置：tokens 与 cost 都必须为正数，缺一即视为
 * “未完成配置”，而不是“无限额度”。
 */
export function normalizeConfig(raw) {
  const errors = []
  if (raw === null || typeof raw !== 'object') {
    return { config: null, errors: ['配置为空或不是对象'] }
  }
  if (raw.version !== undefined && raw.version !== 1) errors.push(`不支持的配置版本：${raw.version}`)
  // 默认北京时间（UTC+8）；IANA 标识是 Asia/Shanghai，库里没有 Asia/Beijing。
  const timeZone = validTimeZone(raw.timeZone) ? raw.timeZone : 'Asia/Shanghai'
  const limits = raw.limits !== null && typeof raw.limits === 'object' ? raw.limits : {}
  const tokens = limits.tokens
  const cost = limits.cost !== null && typeof limits.cost === 'object' ? limits.cost : null
  if (!positiveInteger(tokens)) errors.push('limits.tokens 必须是正整数')
  if (cost === null) {
    errors.push('limits.cost 缺失')
  } else if (!positiveInteger(cost.micros)) {
    errors.push('limits.cost.micros 必须是正整数')
  } else if (cost.currency !== CURRENCY) {
    errors.push('limits.cost.currency 仅支持 CNY（人民币微元）')
  }
  const currency = CURRENCY
  const holidays = Array.isArray(raw.holidays) ? raw.holidays.filter(validDate) : []
  const ttl = raw.reservationTtlMinutes
  const reservationTtlMinutes = Number.isSafeInteger(ttl) && ttl > 0 && ttl <= 1440 ? ttl : 30
  const prices = {}
  if (raw.prices !== null && typeof raw.prices === 'object') {
    for (const [provider, models] of Object.entries(raw.prices)) {
      if (models === null || typeof models !== 'object') continue
      for (const [model, entry] of Object.entries(models)) {
        const normalized = normalizePriceEntry(entry)
        if (normalized === null) {
          errors.push(`价格项 ${provider}/${model} 缺少 source/effectiveFrom 或费率非法`)
          continue
        }
        prices[provider] ??= {}
        prices[provider][model] = normalized
      }
    }
  }
  // 储蓄结转：缺省关闭（正式配置不会因为升级自动开始结转）。
  // 旧版 0.4.1 的 normalizeConfig 只输出白名单字段，会忽略 savings，因此回退安全。
  let savings = { enabled: false, retainDays: DEFAULT_RETAIN_DAYS }
  if (raw.savings !== undefined) {
    if (raw.savings === null || typeof raw.savings !== 'object' || Array.isArray(raw.savings)) {
      errors.push('savings 必须是对象')
    } else {
      const enabled = raw.savings.enabled === true
      const retainDays = raw.savings.retainDays ?? DEFAULT_RETAIN_DAYS
      if (!Number.isSafeInteger(retainDays) || retainDays < MIN_RETAIN_DAYS || retainDays > MAX_RETAIN_DAYS) {
        errors.push(`savings.retainDays 必须是 ${MIN_RETAIN_DAYS}–${MAX_RETAIN_DAYS} 的整数`)
      } else {
        savings = { enabled, retainDays }
      }
    }
  }
  if (errors.length > 0) return { config: null, errors }
  return {
    config: {
      version: 1,
      timeZone,
      limits: { tokens, cost: { micros: cost.micros, currency } },
      holidays,
      reservationTtlMinutes,
      prices,
      savings,
      setBy: typeof raw.setBy === 'string' ? raw.setBy.slice(0, 64) : 'user',
      setAt: typeof raw.setAt === 'string' ? raw.setAt : null,
    },
    errors: [],
  }
}

/** 供 status 使用的配置摘要，不含价格表原文。 */
export function configSummary(config) {
  if (config === null) return { configured: false }
  return {
    configured: true,
    timeZone: config.timeZone,
    limits: {
      tokens: config.limits.tokens,
      cost: { micros: config.limits.cost.micros, currency: config.limits.cost.currency },
    },
    holidays: config.holidays.length,
    reservationTtlMinutes: config.reservationTtlMinutes,
    savings: {
      enabled: config.savings?.enabled === true,
      retainDays: config.savings?.retainDays ?? DEFAULT_RETAIN_DAYS,
    },
    setBy: config.setBy,
    setAt: config.setAt,
  }
}
