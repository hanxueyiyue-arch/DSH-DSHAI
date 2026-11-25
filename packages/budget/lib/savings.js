/**
 * 储蓄（结转）账本：把每天未用完的金额额度按“批次（lot）”保存。
 *
 * 为什么单独记账：
 * - 日桶只有 used/reserved 四个字段，旧版解析器会白名单丢弃任何新字段；
 *   把结转放进独立文件，旧版 0.4.1 重新保存 state.json 时不会破坏已有批次。
 * - 每笔结转有独立来源日、剩余额、预留（held）与到期日，消费按“最早到期优先”
 *   分配；已经被后续日期消费掉的额度不会再次出现在“过去 K 天剩余”的累加里。
 *
 * 语义：
 * - 结转只来自**已结束的日**（今天尚未结束，不能提前结转）；
 * - 每天只能产生一个批次（id 固定为 `lot-<earnedDayKey>`），重复结算幂等；
 * - 批次在 `expiresOnDayKey` 当天 00:00 起失效；`retainDays=7` 表示
 *   来源日后第 1–7 天可用，第 8 天失效（expiresOnDayKey = earned + 8）；
 * - 只有被预算服务标记为“运行过”的日期（日桶存在或 activity 有记录）才可能
 *   产生结转；DSH 全天未运行不补发；
 * - `remainingMicros` 包含被预留占用的 `held`；可用额 = remaining − held。
 */

export const SAVINGS_SCHEMA = 1
export const SAVINGS_CURRENCY = 'CNY'
export const DEFAULT_RETAIN_DAYS = 7
export const MIN_RETAIN_DAYS = 1
export const MAX_RETAIN_DAYS = 30

const KEEP_DAY_RECORDS = 45
const KEEP_LOTS = 90

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonNegativeInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPositiveInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function isDayKey(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

/** 纯日期加减，按 UTC 计算，避免本地时区/夏令时影响。 */
export function dayKeyPlus(dayKey, days) {
  const [year, month, day] = dayKey.split('-').map(Number)
  const base = Date.UTC(year, month - 1, day) + days * 86_400_000
  return new Date(base).toISOString().slice(0, 10)
}

/** 空储蓄账本。 */
export function blankSavings(nowIso = new Date().toISOString()) {
  return {
    schema: SAVINGS_SCHEMA,
    currency: SAVINGS_CURRENCY,
    createdAt: nowIso,
    updatedAt: null,
    startedDayKey: null,
    lastClosedDayKey: null,
    days: {},
    lots: [],
    activity: {},
  }
}

function readDayRecord(dayKey, raw) {
  if (!isPlainObject(raw)) return null
  if (!isPositiveInt(raw.baseMicros)) return null
  if (!isNonNegativeInt(raw.usedMicros)) return null
  if (!isNonNegativeInt(raw.reservedMicros)) return null
  if (!isNonNegativeInt(raw.leftoverMicros)) return null
  if (!isNonNegativeInt(raw.grantedMicros)) return null
  if (typeof raw.active !== 'boolean') return null
  return {
    dayKey,
    baseMicros: raw.baseMicros,
    usedMicros: raw.usedMicros,
    reservedMicros: raw.reservedMicros,
    leftoverMicros: raw.leftoverMicros,
    grantedMicros: raw.grantedMicros,
    usedFromSavings: isNonNegativeInt(raw.usedFromSavings) ? raw.usedFromSavings : 0,
    active: raw.active,
    closedAt: typeof raw.closedAt === 'string' ? raw.closedAt : null,
  }
}

function readHolds(raw, lotId) {
  if (raw === undefined || raw === null) return {}
  if (!isPlainObject(raw)) throw new Error(`savings lot ${lotId} holds 不是对象`)
  const holds = {}
  for (const [runId, micros] of Object.entries(raw)) {
    if (runId === '__proto__' || runId.length === 0) continue
    if (!isPositiveInt(micros)) throw new Error(`savings lot ${lotId} holds.${runId} 非法`)
    holds[runId] = micros
  }
  return holds
}

function readLot(raw) {
  if (!isPlainObject(raw)) throw new Error('savings lot 不是对象')
  if (typeof raw.id !== 'string' || raw.id.length === 0) throw new Error('savings lot.id 缺失')
  if (!isDayKey(raw.earnedDayKey)) throw new Error(`savings lot ${raw.id} earnedDayKey 非法`)
  if (!isDayKey(raw.expiresOnDayKey)) throw new Error(`savings lot ${raw.id} expiresOnDayKey 非法`)
  if (!isPositiveInt(raw.amountMicros)) throw new Error(`savings lot ${raw.id} amountMicros 非法`)
  if (!isNonNegativeInt(raw.remainingMicros) || raw.remainingMicros > raw.amountMicros) {
    throw new Error(`savings lot ${raw.id} remainingMicros 非法`)
  }
  const holds = readHolds(raw.holds, raw.id)
  const held = heldOf({ holds })
  if (held > raw.remainingMicros) throw new Error(`savings lot ${raw.id} 的预留超过剩余额`)
  return {
    id: raw.id,
    earnedDayKey: raw.earnedDayKey,
    amountMicros: raw.amountMicros,
    remainingMicros: raw.remainingMicros,
    expiresOnDayKey: raw.expiresOnDayKey,
    holds,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
    expiredAt: typeof raw.expiredAt === 'string' ? raw.expiredAt : null,
  }
}

/**
 * 严格解析储蓄账本。
 * - 无文件：`{kind:'empty'}`
 * - 合法：`{kind:'v1', savings}`
 * - 损坏：`{kind:'invalid', reason}`（调用方 fail-closed，不当作 0）
 */
export function parseSavings(raw) {
  if (raw === null || raw === undefined) return { kind: 'empty' }
  if (!isPlainObject(raw)) return { kind: 'invalid', reason: 'savings 不是 JSON 对象' }
  if (raw.schema !== SAVINGS_SCHEMA) return { kind: 'invalid', reason: `不支持的 savings Schema：${String(raw.schema)}` }
  if (raw.currency !== SAVINGS_CURRENCY) return { kind: 'invalid', reason: 'savings 币种非法' }
  try {
    const savings = blankSavings(typeof raw.createdAt === 'string' ? raw.createdAt : new Date(0).toISOString())
    savings.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : null
    savings.startedDayKey = isDayKey(raw.startedDayKey) ? raw.startedDayKey : null
    savings.lastClosedDayKey = isDayKey(raw.lastClosedDayKey) ? raw.lastClosedDayKey : null
    if (raw.days !== undefined) {
      if (!isPlainObject(raw.days)) throw new Error('savings.days 不是对象')
      for (const [dayKey, value] of Object.entries(raw.days)) {
        if (!isDayKey(dayKey)) throw new Error(`savings.days 键非法：${dayKey}`)
        const record = readDayRecord(dayKey, value)
        if (record === null) throw new Error(`savings.days.${dayKey} 字段非法`)
        savings.days[dayKey] = record
      }
    }
    if (raw.lots !== undefined) {
      if (!Array.isArray(raw.lots)) throw new Error('savings.lots 不是数组')
      const seen = new Set()
      for (const value of raw.lots) {
        const lot = readLot(value)
        if (seen.has(lot.id)) throw new Error(`重复的 savings lot：${lot.id}`)
        seen.add(lot.id)
        savings.lots.push(lot)
      }
    }
    if (raw.activity !== undefined) {
      if (!isPlainObject(raw.activity)) throw new Error('savings.activity 不是对象')
      for (const [dayKey, at] of Object.entries(raw.activity)) {
        if (!isDayKey(dayKey)) continue
        if (typeof at === 'string') savings.activity[dayKey] = at
      }
    }
    return { kind: 'v1', savings }
  } catch (error) {
    return { kind: 'invalid', reason: error?.message ?? String(error) }
  }
}

/** 一个批次的预留总额。 */
export function heldOf(lot) {
  let total = 0
  for (const micros of Object.values(lot.holds ?? {})) total += micros
  return total
}

export function availableMicrosOf(lot) {
  return Math.max(0, lot.remainingMicros - heldOf(lot))
}

/** 当前可用的结转总额。 */
export function availableMicros(savings, todayKey) {
  let total = 0
  for (const lot of savings.lots) {
    if (lot.remainingMicros <= 0) continue
    if (todayKey >= lot.expiresOnDayKey) continue
    total += availableMicrosOf(lot)
  }
  return total
}

function sortLotsForSpending(lots) {
  return [...lots].sort((a, b) => {
    if (a.expiresOnDayKey !== b.expiresOnDayKey) return a.expiresOnDayKey.localeCompare(b.expiresOnDayKey)
    return a.earnedDayKey.localeCompare(b.earnedDayKey)
  })
}

/**
 * 按最早到期优先分配一笔需要从结转中支付的金额。
 * 返回 `{allocation:[{lotId, micros}], shortfall}`；不修改账本。
 */
export function allocateMicros(savings, needMicros, todayKey) {
  const want = Math.max(0, Number(needMicros) || 0)
  let left = want
  const allocation = []
  if (left === 0) return { allocation, shortfall: 0 }
  const candidates = sortLotsForSpending(
    savings.lots.filter((lot) => lot.remainingMicros > 0 && todayKey < lot.expiresOnDayKey),
  )
  for (const lot of candidates) {
    if (left <= 0) break
    const free = availableMicrosOf(lot)
    if (free <= 0) continue
    const take = Math.min(free, left)
    allocation.push({ lotId: lot.id, micros: take })
    left -= take
  }
  return { allocation, shortfall: left }
}

/** 为一次预留占用批次额度。 */
export function holdAllocation(savings, runId, allocation) {
  for (const { lotId, micros } of allocation) {
    const lot = savings.lots.find((item) => item.id === lotId)
    if (lot === undefined) continue
    lot.holds[runId] = (lot.holds[runId] ?? 0) + micros
  }
}

/** 释放某次预留占用的全部批次额度，返回释放的微元数。 */
export function releaseHolds(savings, runId) {
  let released = 0
  for (const lot of savings.lots) {
    const held = lot.holds[runId]
    if (held === undefined) continue
    released += held
    delete lot.holds[runId]
  }
  return released
}

/** 消费某次预留占用的批次额度；返回实际消费数（不超过占用量）。 */
export function consumeHolds(savings, runId, amountMicros) {
  let left = Math.max(0, Number(amountMicros) || 0)
  let consumed = 0
  const lots = sortLotsForSpending(savings.lots.filter((lot) => (lot.holds[runId] ?? 0) > 0))
  for (const lot of lots) {
    if (left <= 0) break
    const held = lot.holds[runId] ?? 0
    const take = Math.min(held, lot.remainingMicros, left)
    if (take <= 0) {
      delete lot.holds[runId]
      continue
    }
    lot.remainingMicros -= take
    const rest = held - take
    if (rest > 0) lot.holds[runId] = rest
    else delete lot.holds[runId]
    consumed += take
    left -= take
  }
  return consumed
}

/** 某次预留当前占用的批次数。 */
export function heldForRun(savings, runId) {
  let total = 0
  for (const lot of savings.lots) total += lot.holds[runId] ?? 0
  return total
}

/**
 * 回收“孤儿占用”：只保留仍处于 pending/uncertain 的预留的占用。
 * 旧版 0.4.1 重新保存 state.json 会丢掉 reservation.savingsHolds，
 * 这里保证那部分额度能回到可用余额，而不会永久卡死。
 */
export function reconcileHolds(savings, state) {
  const live = new Set()
  for (const reservation of Object.values(state?.reservations ?? {})) {
    if (reservation?.status === 'pending' || reservation?.status === 'uncertain') {
      live.add(reservation.runId)
    }
  }
  let released = 0
  for (const lot of savings.lots) {
    for (const runId of Object.keys(lot.holds)) {
      if (live.has(runId)) continue
      released += lot.holds[runId]
      delete lot.holds[runId]
    }
  }
  return released
}

/** 取（必要时创建）某天的储蓄日记录。 */
export function ensureDayRecord(savings, dayKey, baseMicros, atIso) {
  let record = savings.days[dayKey]
  if (record === undefined) {
    record = {
      dayKey,
      baseMicros: isPositiveInt(baseMicros) ? baseMicros : 0,
      usedMicros: 0,
      reservedMicros: 0,
      leftoverMicros: 0,
      grantedMicros: 0,
      usedFromSavings: 0,
      active: true,
      closedAt: null,
    }
    savings.days[dayKey] = record
  }
  if (record.closedAt === null) record.active = true
  return record
}

/** 从所有可用批次里直接扣减（用于实际消费超过预留占用的部分）。 */
export function consumeAvailable(savings, needMicros, todayKey) {
  let left = Math.max(0, Number(needMicros) || 0)
  let consumed = 0
  for (const lot of sortLotsForSpending(savings.lots.filter((item) => availableMicrosOf(item) > 0 && todayKey < item.expiresOnDayKey))) {
    if (left <= 0) break
    const take = Math.min(availableMicrosOf(lot), left)
    lot.remainingMicros -= take
    left -= take
    consumed += take
  }
  return consumed
}

/**
 * 升级修复：旧版 0.4.1 结算时不知道储蓄，会把全额计入 `day.costMicrosUsed`，
 * 但不会扣减批次；重新升级后这里只补“超过基础额度、且尚未记入 usedFromSavings”
 * 的差额，避免同一笔钱被二次使用。幂等：已记入的部分不会重复扣减。
 */
export function repairSavingsUsage(savings, state, baseMicros, todayKey) {
  const base = isPositiveInt(baseMicros) ? baseMicros : 0
  if (base <= 0) return 0
  const dayKeys = new Set([
    ...Object.keys(savings.days),
    ...Object.keys(state?.days ?? {}),
  ])
  let consumed = 0
  for (const dayKey of [...dayKeys].filter((key) => key <= todayKey).sort()) {
    const day = state?.days?.[dayKey]
    const record = savings.days[dayKey] ?? ensureDayRecord(savings, dayKey, base, savings.updatedAt)
    const used = isNonNegativeInt(day?.costMicrosUsed) ? day.costMicrosUsed : record.usedMicros
    const overflow = Math.max(0, used - base - (record.usedFromSavings ?? 0))
    if (overflow <= 0) continue
    const take = consumeAvailable(savings, overflow, todayKey)
    record.usedFromSavings = (record.usedFromSavings ?? 0) + take
    record.usedMicros = Math.max(record.usedMicros ?? 0, used)
    consumed += take
  }
  return consumed
}

function createLot(savings, dayKey, micros, retainDays, atIso) {
  const id = `lot-${dayKey}`
  const existing = savings.lots.find((lot) => lot.id === id)
  if (existing !== undefined) return existing
  const lot = {
    id,
    earnedDayKey: dayKey,
    amountMicros: micros,
    remainingMicros: micros,
    expiresOnDayKey: dayKeyPlus(dayKey, retainDays + 1),
    holds: {},
    createdAt: atIso,
    expiredAt: null,
  }
  savings.lots.push(lot)
  return lot
}

/**
 * 把 `lastClosedDayKey` 之后、`todayKey` 之前的每一天结算为历史记录。
 *
 * 依赖调用方传入的**当日配置**：baseMicros（每日金额限额）、enabled、
 * retainDays。历史日按当前限额回算，是刻意的简化（见报告风险一节）。
 */
export function closeDays(savings, { state, todayKey, baseMicros, enabled, retainDays, atIso }) {
  const base = isPositiveInt(baseMicros) ? baseMicros : 0
  const days = state?.days ?? {}
  if (enabled === true && savings.startedDayKey === null) savings.startedDayKey = todayKey
  if (savings.lastClosedDayKey === null) savings.lastClosedDayKey = dayKeyPlus(todayKey, -1)
  let cursor = dayKeyPlus(savings.lastClosedDayKey, 1)
  let steps = 0
  while (cursor < todayKey && steps < 400) {
    steps += 1
    const day = days[cursor]
    const active = day !== undefined || savings.activity[cursor] !== undefined
    const usedMicros = isNonNegativeInt(day?.costMicrosUsed) ? day.costMicrosUsed : 0
    const reservedMicros = isNonNegativeInt(day?.costMicrosReserved) ? day.costMicrosReserved : 0
    const leftover = active && base > 0 ? Math.max(0, base - usedMicros - reservedMicros) : 0
    const eligible =
      enabled === true &&
      savings.startedDayKey !== null &&
      cursor >= savings.startedDayKey &&
      leftover > 0
    let record = savings.days[cursor]
    if (record === undefined) {
      record = {
        dayKey: cursor,
        baseMicros: base,
        usedMicros,
        reservedMicros,
        leftoverMicros: leftover,
        grantedMicros: eligible ? leftover : 0,
        usedFromSavings: 0,
        active,
        closedAt: atIso,
      }
      savings.days[cursor] = record
    } else {
      record.baseMicros = base
      record.usedMicros = usedMicros
      record.reservedMicros = reservedMicros
      record.leftoverMicros = leftover
      if (eligible && record.grantedMicros === 0) record.grantedMicros = leftover
      record.active = active
      record.closedAt = record.closedAt ?? atIso
    }
    if (eligible) createLot(savings, cursor, leftover, retainDays, atIso)
    savings.lastClosedDayKey = cursor
    cursor = dayKeyPlus(cursor, 1)
  }
  savings.updatedAt = atIso
  pruneSavings(savings, todayKey)
  return savings
}

/** 让到期批次失效；已被预留的部分保留到预留结算/释放，避免凭空消失。 */
export function expireLots(savings, todayKey, atIso) {
  for (const lot of savings.lots) {
    if (todayKey < lot.expiresOnDayKey) continue
    const held = heldOf(lot)
    if (lot.remainingMicros !== held) {
      lot.remainingMicros = held
    }
    if (lot.remainingMicros === 0 && lot.expiredAt === null) lot.expiredAt = atIso
  }
  return savings
}

function pruneSavings(savings, todayKey) {
  const dayKeys = Object.keys(savings.days).sort()
  const keepFrom = dayKeyPlus(todayKey, -KEEP_DAY_RECORDS)
  for (const key of dayKeys) {
    if (key < keepFrom && key !== savings.startedDayKey) delete savings.days[key]
  }
  const activityKeys = Object.keys(savings.activity).sort()
  for (const key of activityKeys) {
    if (key < keepFrom) delete savings.activity[key]
  }
  // 已失效且没有剩余/占用的批次只保留最近一段，防止无限增长。
  const keepLotFrom = dayKeyPlus(todayKey, -KEEP_LOTS)
  savings.lots = savings.lots.filter(
    (lot) =>
      lot.remainingMicros > 0 ||
      heldOf(lot) > 0 ||
      lot.earnedDayKey >= keepLotFrom,
  )
}

/** 标记某天 DSH 运行过（用于区分“运行但未消费”与“全天未运行”）。 */
export function markActive(savings, dayKey, atIso) {
  savings.activity[dayKey] = atIso
  savings.updatedAt = atIso
  return savings
}

export function cloneSavings(savings) {
  return {
    ...savings,
    days: Object.fromEntries(Object.entries(savings.days).map(([key, value]) => [key, { ...value }])),
    lots: savings.lots.map((lot) => ({ ...lot, holds: { ...lot.holds } })),
    activity: { ...savings.activity },
  }
}

/**
 * 只读预览：按今日配置把昨日及更早的日结算一遍，但不写盘。
 * 用于 `status()` 在当天第一次写入之前就能显示正确的可用结转。
 */
export function previewSavings(savings, { state, todayKey, baseMicros, enabled, retainDays, atIso }) {
  const copy = cloneSavings(savings)
  closeDays(copy, { state, todayKey, baseMicros, enabled, retainDays, atIso })
  expireLots(copy, todayKey, atIso)
  return copy
}

/** 面向 UI/status 的视图（不包含内部 holds 键的敏感信息）。 */
export function savingsView(savings, todayKey, { enabled = false, retainDays = DEFAULT_RETAIN_DAYS } = {}) {
  const lots = savings.lots
    .filter((lot) => lot.remainingMicros > 0)
    .sort((a, b) => a.expiresOnDayKey.localeCompare(b.expiresOnDayKey) || a.earnedDayKey.localeCompare(b.earnedDayKey))
    .map((lot) => ({
      id: lot.id,
      earnedDayKey: lot.earnedDayKey,
      amountMicros: lot.amountMicros,
      remainingMicros: lot.remainingMicros,
      heldMicros: heldOf(lot),
      availableMicros: availableMicrosOf(lot),
      expiresOnDayKey: lot.expiresOnDayKey,
      expired: todayKey >= lot.expiresOnDayKey,
    }))
  const days = Object.values(savings.days)
    .sort((a, b) => b.dayKey.localeCompare(a.dayKey))
    .slice(0, 14)
  return {
    enabled: enabled === true,
    retainDays,
    startedDayKey: savings.startedDayKey,
    lastClosedDayKey: savings.lastClosedDayKey,
    availableMicros: availableMicros(savings, todayKey),
    lots,
    days,
  }
}
