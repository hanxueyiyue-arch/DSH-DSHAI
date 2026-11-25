/**
 * 预算服务：金额单硬限额 + Token 软告警 + 储蓄结转。
 *
 * 0.5.0 的关键变化：
 * - **只有金额会阻断付费调用**。Token 仍统计、仍按保守值预留，但只产生
 *   `TOKEN_SOFT_LIMIT` / `TOKEN_ESTIMATE_LOW` 告警，不再抛 BUDGET_EXHAUSTED，
 *   也不再单独触发 Guard。
 * - 储蓄（结转）放在独立文件 `savings.json`，按批次（lot）记录来源日、剩余额度、
 *   预留与到期日；消费按最早到期优先分配，每份额度只使用一次。
 * - 预留时先占当日基础额度，超出部分占用储蓄批次；结算时按“当日已用金额超出
 *   基础限额的部分”核销储蓄，避免把同一份额度重复计入以后日期。
 * - uncertain 预留可在 Dashboard 对账：按实际用量结算、接受最坏入账、
 *   可信零消费释放、或用户接受风险后人工释放。
 * - Guard 仍持久化，只能由已验证用户显式清除。
 */

import { randomUUID } from 'node:crypto'

import { configSummary } from './config.js'
import { buildPriceTable, costMicros, dayKeyAt, resolvePrice } from './pricing.js'
import {
  DEFAULT_RETAIN_DAYS,
  allocateMicros,
  availableMicros,
  closeDays,
  consumeAvailable,
  consumeHolds,
  ensureDayRecord,
  expireLots,
  holdAllocation,
  markActive,
  previewSavings,
  reconcileHolds,
  releaseHolds,
  repairSavingsUsage,
  savingsView,
} from './savings.js'
import { addAudit, dayOf, daySummary, prune } from './state.js'

export const PUBLIC_METHODS = Object.freeze([
  'status',
  'quote',
  'reserve',
  'settle',
  'release',
  'recover',
  'configure',
  'authorizeOnce',
  'revokeException',
  'reservations',
  'withPaidCall',
  'migrateLegacy',
  'restoreBackup',
  'reconcile',
  'clearGuard',
  'savings',
  'requestTopUp',
  'topUps',
  'decideTopUp',
  'revokeTopUp',
])

const MAX_OUTPUT_TOKENS = 384_000
const ESTIMATE_TOKEN_BUFFER_MIN = 512
const ESTIMATE_TOKEN_BUFFER_RATIO = 0.15
const USAGE_KEYS = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']

class BudgetError extends Error {
  constructor(message, code, extra = {}) {
    super(message)
    this.name = 'BudgetError'
    this.code = code
    Object.assign(this, extra)
  }
}

function requireTrust(options, trustedSymbol) {
  if (typeof trustedSymbol !== 'symbol') {
    throw new BudgetError('预算插件未启用用户信任通道，无法执行该操作', 'APPROVAL_REQUIRED')
  }
  const actor = options?.actor
  if (options?.trust !== trustedSymbol || actor?.kind !== 'user' || actor?.authenticated !== true) {
    throw new BudgetError('该操作需要宿主认证的用户入口，插件内部不能绕过', 'APPROVAL_REQUIRED')
  }
}

function requireConfig(loaded) {
  if (loaded.config.config !== null) return loaded.config.config
  const detail = loaded.config.errors.length > 0 ? '（' + loaded.config.errors.join('；') + '）' : ''
  throw new BudgetError(
    loaded.config.exists ? '预算配置无效' + detail : '预算尚未配置，付费调用已被阻断',
    'BUDGET_NOT_CONFIGURED',
  )
}

function codeOf(error) {
  const raw = typeof error?.code === 'string' ? error.code : error?.name
  return typeof raw === 'string' && raw.length > 0 ? raw.slice(0, 60) : 'UNKNOWN'
}

function annotate(error, budget) {
  if (error === null || typeof error !== 'object') return error
  try {
    Object.defineProperty(error, 'budget', { value: budget, enumerable: false, configurable: true })
  } catch {
    // 某些冻结对象不可注解，忽略
  }
  return error
}

function requireUsage(usage) {
  if (usage === null || usage === undefined || typeof usage !== 'object' || Array.isArray(usage)) {
    throw new BudgetError('缺少 Provider 用量，不能按 0 结算', 'USAGE_MISSING')
  }
  const normalized = {}
  let present = 0
  let total = 0
  for (const key of USAGE_KEYS) {
    const value = usage[key]
    if (value === undefined) {
      normalized[key] = 0
      continue
    }
    present += 1
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new BudgetError(`用量字段 ${key} 必须是非负整数`, 'INVALID_USAGE', { field: key })
    }
    normalized[key] = value
    total += value
  }
  if (present === 0) throw new BudgetError('缺少 Provider 用量字段，不能按 0 结算', 'USAGE_MISSING')
  if (total === 0) throw new BudgetError('Provider 用量全为 0，不能据此结算', 'USAGE_MISSING')
  return normalized
}

function safeUsage(usageFrom, value) {
  try {
    const raw = typeof usageFrom === 'function' ? usageFrom(value) : value?.usage
    return requireUsage(raw)
  } catch {
    return null
  }
}

function estimateTokens(inputTokens, cacheReadTokens, outputTokens) {
  const base = inputTokens + cacheReadTokens + outputTokens
  const buffer = Math.max(ESTIMATE_TOKEN_BUFFER_MIN, Math.ceil(base * ESTIMATE_TOKEN_BUFFER_RATIO))
  return base + buffer
}

export function createBudgetService({
  storage,
  now = () => new Date(),
  log = null,
  trust: trustedSymbol = null,
  clockOverrides = false,
} = {}) {
  const service = {
    name: 'dsh-dshai-budget',
    version: '0.5.2',
  }
  const instanceId = `boot-${randomUUID()}`

  function tableOf(config) {
    return buildPriceTable(config?.prices)
  }

  function atOf(value) {
    if (value === undefined || value === null) return now()
    if (!clockOverrides) {
      throw new BudgetError('调用方不允许指定 at，预算时间由服务端时钟决定', 'INVALID_ARGUMENT')
    }
    const at = value instanceof Date ? value : new Date(value)
    if (!Number.isFinite(at.getTime())) throw new BudgetError('at 不是合法时间', 'INVALID_ARGUMENT')
    return at
  }

  async function loaded() {
    const [config, ledger, savings] = await Promise.all([
      storage.readConfig(),
      storage.readState(),
      storage.readSavings(),
    ])
    return { config, ledger, savings }
  }

  function requireHealthy(loadedResult) {
    if (loadedResult.ledger.kind === 'invalid') {
      throw new BudgetError(
        '预算账本无法读取（' + loadedResult.ledger.reason + '），已停止付费调用',
        'LEDGER_INVALID',
        { evidence: loadedResult.ledger.evidence ?? null },
      )
    }
    if (loadedResult.ledger.kind === 'legacy') {
      throw new BudgetError('预算账本仍是旧版美元 Schema，必须完成受控迁移后才能使用', 'LEDGER_LEGACY')
    }
    if (loadedResult.savings.kind === 'invalid') {
      throw new BudgetError(
        '储蓄账本无法读取（' + loadedResult.savings.reason + '），为避免重复消费已停止付费调用',
        'LEDGER_INVALID',
        { evidence: loadedResult.savings.evidence ?? null },
      )
    }
  }

  function savingsConfig(config) {
    return {
      enabled: config?.savings?.enabled === true,
      retainDays: config?.savings?.retainDays ?? DEFAULT_RETAIN_DAYS,
    }
  }

  /** 在写操作中推进“关闭历史日 → 结转批次 → 到期失效”。 */
  function advanceSavings(savings, state, config, at) {
    const { enabled, retainDays } = savingsConfig(config)
    const todayKey = dayKeyAt(at, config.timeZone)
    reconcileHolds(savings, state)
    repairSavingsUsage(savings, state, config.limits.cost.micros, todayKey)
    closeDays(savings, {
      state,
      todayKey,
      baseMicros: config.limits.cost.micros,
      enabled,
      retainDays,
      atIso: at.toISOString(),
    })
    expireTopUps(state, todayKey, at.toISOString())
    expireLots(savings, todayKey, at.toISOString())
    return todayKey
  }

  /**
   * 当日仍在进行中的预留实际占用的“基础额度”。
   * day.costMicrosReserved 记的是全额（基础 + 储蓄），直接拿它算基础余额会把
   * 储蓄预留也重复减掉，导致基础额度被低估、过早动用储蓄；这里只累加
   * reservation.baseMicros（旧账本没有该字段时按全额保守处理）。
   */
  function baseReservedOf(state, dayKey) {
    let total = 0
    for (const reservation of Object.values(state?.reservations ?? {})) {
      if (reservation.dayKey !== dayKey) continue
      if (reservation.status !== 'pending' && reservation.status !== 'uncertain') continue
      total += Number.isSafeInteger(reservation.baseMicros)
        ? reservation.baseMicros
        : reservation.worstCostMicros
    }
    return total
  }

  function topupReservedOf(state, dayKey) {
    let total = 0
    for (const reservation of Object.values(state?.reservations ?? {})) {
      if (reservation.dayKey !== dayKey) continue
      if (reservation.status !== 'pending' && reservation.status !== 'uncertain') continue
      total += Number.isSafeInteger(reservation.topupMicros) ? reservation.topupMicros : 0
    }
    return total
  }

  function topupApprovedOf(state, dayKey) {
    let total = 0
    for (const topup of Object.values(state?.topups ?? {})) {
      if (topup.dayKey !== dayKey || topup.status !== 'approved') continue
      total += topup.approvedMicros
    }
    return total
  }

  function topupUsedOf(state, dayKey) {
    let total = 0
    for (const topup of Object.values(state?.topups ?? {})) {
      if (topup.dayKey !== dayKey) continue
      total += topup.usedMicros
    }
    return total
  }

  /** 当日临时补额只在该计费日有效；跨日后未用完部分自动失效。 */
  function topupAvailableOf(state, dayKey) {
    return Math.max(0, topupApprovedOf(state, dayKey) - topupUsedOf(state, dayKey))
  }

  function consumeTopup(state, dayKey, amount) {
    const list = Object.values(state.topups ?? {})
      .filter((entry) => entry.dayKey === dayKey && entry.status === 'approved' && entry.approvedMicros > entry.usedMicros)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id))
    let left = Math.max(0, amount)
    for (const entry of list) {
      if (left <= 0) break
      const take = Math.min(entry.approvedMicros - entry.usedMicros, left)
      entry.usedMicros += take
      left -= take
    }
    return Math.max(0, amount) - left
  }

  function expireTopUps(state, todayKey, atIso) {
    let changed = 0
    for (const entry of Object.values(state.topups ?? {})) {
      if (entry.dayKey >= todayKey) continue
      if (entry.status !== 'pending' && entry.status !== 'approved') continue
      entry.status = 'expired'
      entry.decidedAt = entry.decidedAt ?? atIso
      entry.note = entry.note || '超过当日有效期，已自动失效'
      addAudit(state, 'budget-topup-expired', { at: atIso, detail: entry.id })
      changed += 1
    }
    return changed
  }

  function topupViewOf(state, todayKey, at) {
    const list = Object.values(state.topups ?? {})
      .filter((entry) => entry.dayKey === todayKey)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    const pending = list.filter((entry) => entry.status === 'pending').map((entry) => ({
      id: entry.id,
      taskId: entry.taskId,
      caller: entry.caller,
      reason: entry.reason,
      requestedMicros: entry.requestedMicros,
      createdAt: entry.createdAt,
      ageMinutes: Math.max(0, Math.floor((at.getTime() - Date.parse(entry.createdAt)) / 60_000)),
    }))
    const recent = list.slice(0, 12).map((entry) => ({
      id: entry.id,
      taskId: entry.taskId,
      caller: entry.caller,
      reason: entry.reason,
      requestedMicros: entry.requestedMicros,
      approvedMicros: entry.approvedMicros,
      usedMicros: entry.usedMicros,
      status: entry.status,
      createdAt: entry.createdAt,
      decidedAt: entry.decidedAt,
    }))
    const approvedMicros = topupApprovedOf(state, todayKey)
    const usedMicros = topupUsedOf(state, todayKey)
    const reservedMicros = topupReservedOf(state, todayKey)
    return {
      approvedMicros,
      usedMicros,
      reservedMicros,
      availableMicros: Math.max(0, approvedMicros - usedMicros - reservedMicros),
      pending,
      recent,
    }
  }

  function worstCase(config, options) {
    const at = options.at instanceof Date ? options.at : now()
    const provider = options.provider ?? 'deepseek'
    const model = options.model
    if (typeof model !== 'string' || model.length === 0) {
      throw new BudgetError('必须给出 model', 'INVALID_ARGUMENT')
    }
    const estimatedInputTokens = options.estimatedInputTokens
    const estimatedCacheReadTokens = options.estimatedCacheReadTokens ?? 0
    const maxOutputTokens = options.maxOutputTokens
    const price = resolvePrice(tableOf(config), provider, model)
    if (price === null) {
      throw new BudgetError('未配置 ' + provider + '/' + model + ' 的价格，无法做保守预估', 'UNKNOWN_PRICE')
    }
    if (typeof estimatedInputTokens !== 'number' || !Number.isSafeInteger(estimatedInputTokens) || estimatedInputTokens <= 0) {
      throw new BudgetError('estimatedInputTokens 必须是正整数', 'INVALID_ARGUMENT')
    }
    if (
      typeof estimatedCacheReadTokens !== 'number' ||
      !Number.isSafeInteger(estimatedCacheReadTokens) ||
      estimatedCacheReadTokens < 0
    ) {
    throw new BudgetError('estimatedCacheReadTokens 必须是非负整数', 'INVALID_ARGUMENT')
    }
    if (typeof maxOutputTokens !== 'number' || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) {
      throw new BudgetError('maxOutputTokens 必须是正整数', 'INVALID_ARGUMENT')
    }
    if (maxOutputTokens > MAX_OUTPUT_TOKENS) {
      throw new BudgetError(`maxOutputTokens 超过上限 ${MAX_OUTPUT_TOKENS}`, 'INVALID_ARGUMENT')
    }
    const tokens = estimateTokens(estimatedInputTokens, estimatedCacheReadTokens, maxOutputTokens)
    const priced = costMicros({
      table: tableOf(config),
      provider,
      model,
      usage: {
        inputTokens: estimatedInputTokens + estimatedCacheReadTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: maxOutputTokens,
      },
      at,
      holidays: config.holidays,
      conservative: true,
      roundUp: true,
    })
    return {
      tokens,
      costMicros: priced.micros,
      provider,
      model,
      priceSource: price.source,
      effectiveFrom: price.effectiveFrom,
    }
  }

  function activeExceptionList(state, at) {
    const nowMs = at.getTime()
    return Object.values(state.exceptions ?? {})
      .filter((entry) => entry.status === 'active' && entry.instanceId === instanceId)
      .filter((entry) => {
        const expires = Date.parse(entry.expiresAt)
        return Number.isFinite(expires) && expires > nowMs
      })
      .map((entry) => ({
        id: entry.id,
        provider: entry.provider,
        model: entry.model,
        maxWorstTokens: entry.maxWorstTokens,
        maxCostMicros: entry.maxCostMicros,
        taskId: entry.taskId,
        caller: entry.caller,
        expiresAt: entry.expiresAt,
        reason: entry.reason,
      }))
  }

  function statusOf({ config, state, savings, at, health }) {
    const { enabled, retainDays } = savingsConfig(config)
    const todayKey = config ? dayKeyAt(at, config.timeZone) : null
    const guard = state?.guard ?? { blocked: false, reason: null }
    const ledger = { health, blocked: health !== 'ok' }
    if (health !== 'ok' || config === null || state === null) {
      return {
        configured: config !== null,
        day: todayKey,
        ledger,
        enforcement: { tokens: 'advisory', cost: 'hard' },
        guard,
        limits: config === null ? null : {
          tokens: config.limits.tokens,
          cost: { micros: config.limits.cost.micros, currency: config.limits.cost.currency },
        },
        used: { tokens: 0, cost: { micros: 0, currency: 'CNY' } },
        reserved: { tokens: 0, cost: { micros: 0, currency: 'CNY' } },
        remaining: {
          tokens: 0,
          cost: { micros: 0, currency: 'CNY' },
          base: { micros: 0, currency: 'CNY' },
          topup: { micros: 0, currency: 'CNY' },
          savings: { micros: 0, currency: 'CNY' },
        },
        topup: {
          approvedMicros: 0,
          usedMicros: 0,
          reservedMicros: 0,
          availableMicros: 0,
          pending: [],
          recent: [],
        },
        blocked: {
          tokens: false,
          cost: true,
          reason: health === 'corrupt' ? 'LEDGER_INVALID' : health === 'legacy' ? 'LEDGER_LEGACY' : 'BUDGET_NOT_CONFIGURED',
        },
        warnings: [],
        savings: savingsView(savings ?? { lots: [], days: {}, activity: {}, startedDayKey: null, lastClosedDayKey: null }, todayKey ?? '1970-01-01', { enabled, retainDays }),
        uncertain: [],
        exceptions: [],
        reservations: 0,
      }
    }
    const preview = previewSavings(savings, {
      state,
      todayKey,
      baseMicros: config.limits.cost.micros,
      enabled,
      retainDays,
      atIso: at.toISOString(),
    })
    const used = state
      ? daySummary(state, todayKey)
      : { tokensUsed: 0, costMicrosUsed: 0, tokensReserved: 0, costMicrosReserved: 0 }
    const tokensLeft = Math.max(0, config.limits.tokens - used.tokensUsed - used.tokensReserved)
    const baseLeft = Math.max(
      0,
      config.limits.cost.micros - used.costMicrosUsed - baseReservedOf(state, todayKey),
    )
    const savingsLeft = enabled ? availableMicros(preview, todayKey) : 0
    const topupLeft = topupAvailableOf(state, todayKey) - topupReservedOf(state, todayKey)
    const topupAvailable = Math.max(0, topupLeft)
    const costLeft = baseLeft + topupAvailable + savingsLeft
    const guardBlocked = guard.blocked === true
    const costBlocked = guardBlocked || costLeft <= 0
    const warnings = []
    if (tokensLeft <= 0) {
      warnings.push({
        code: 'TOKEN_SOFT_LIMIT',
        message: 'Token 额度已用尽；按 0.5.0 规则只作提示，不阻断付费调用',
      })
    }
    const ttlMs = (config.reservationTtlMinutes ?? 30) * 60_000
    const uncertain = Object.values(state.reservations)
      .filter((entry) => entry.status === 'uncertain')
      .map((entry) => ({
        runId: entry.runId,
        status: entry.status,
        ageMinutes: Math.max(0, Math.floor((at.getTime() - Date.parse(entry.reservedAt)) / 60_000)),
        worstTokens: entry.worstTokens,
        worstCostMicros: entry.worstCostMicros,
        actualCostMicros: entry.actualCostMicros,
        note: entry.note,
      }))
    for (const entry of Object.values(state.reservations)) {
      if (entry.status !== 'pending') continue
      if (at.getTime() - Date.parse(entry.reservedAt) <= ttlMs) continue
      uncertain.push({
        runId: entry.runId,
        status: 'pending-overdue',
        ageMinutes: Math.floor((at.getTime() - Date.parse(entry.reservedAt)) / 60_000),
        worstTokens: entry.worstTokens,
        worstCostMicros: entry.worstCostMicros,
        actualCostMicros: null,
        note: '超过预留 TTL，等待 recover() 标记 uncertain',
      })
    }
    return {
      configured: true,
      day: todayKey,
      ledger,
      enforcement: { tokens: 'advisory', cost: 'hard' },
      guard: { blocked: guardBlocked, reason: guard.reason ?? null },
      limits: {
        tokens: config.limits.tokens,
        cost: { micros: config.limits.cost.micros, currency: config.limits.cost.currency },
      },
      used: { tokens: used.tokensUsed, cost: { micros: used.costMicrosUsed, currency: 'CNY' } },
      reserved: { tokens: used.tokensReserved, cost: { micros: used.costMicrosReserved, currency: 'CNY' } },
      remaining: {
        tokens: tokensLeft,
        cost: { micros: costLeft, currency: 'CNY' },
        base: { micros: baseLeft, currency: 'CNY' },
        topup: { micros: topupAvailable, currency: 'CNY' },
        savings: { micros: savingsLeft, currency: 'CNY' },
      },
      blocked: {
        tokens: false,
        cost: costBlocked,
        reason: guardBlocked ? 'PROTECTION_FAILED' : costBlocked ? 'COST_LIMIT' : null,
      },
      warnings,
      savings: savingsView(preview, todayKey, { enabled, retainDays }),
      topup: topupViewOf(state, todayKey, at),
      uncertain,
      exceptions: activeExceptionList(state, at),
      reservations: Object.keys(state.reservations).length,
    }
  }

  async function status() {
    const at = now()
    const loadedResult = await loaded()
    const state = loadedResult.ledger.kind === 'v2' ? loadedResult.ledger.state : null
    const savings = loadedResult.savings.kind === 'v1' ? loadedResult.savings.savings : null
    const health =
      loadedResult.ledger.kind === 'invalid' || loadedResult.savings.kind === 'invalid'
        ? 'corrupt'
        : loadedResult.ledger.kind === 'legacy'
          ? 'legacy'
          : 'ok'
    return statusOf({
      config: loadedResult.config.config,
      state,
      savings: savings ?? { lots: [], days: {}, activity: {}, startedDayKey: null, lastClosedDayKey: null },
      at,
      health,
    })
  }

  async function quote(options = {}) {
    const at = atOf(options.at)
    const loadedResult = await loaded()
    const config = requireConfig(loadedResult)
    const worst = worstCase(config, { ...options, at })
    return {
      ok: true,
      provider: worst.provider,
      model: worst.model,
      tokens: worst.tokens,
      cost: { micros: worst.costMicros, currency: 'CNY' },
      priceSource: worst.priceSource,
      effectiveFrom: worst.effectiveFrom,
      note: '按高峰价与最大输出保守估算，Token 含安全缓冲；实际结算以 Provider 返回的用量为准',
    }
  }

  async function reserve(options = {}) {
    if (typeof options.runId !== 'string' || options.runId.length === 0) {
      throw new BudgetError('runId 必须是非空字符串', 'INVALID_ARGUMENT')
    }
    const at = atOf(options.at)
    const loadedResult = await loaded()
    const config = requireConfig(loadedResult)
    requireHealthy(loadedResult)
    const worst = worstCase(config, { ...options, at })
    const { enabled, retainDays } = savingsConfig(config)
    const dayKey = dayKeyAt(at, config.timeZone)
    let pendingError = null
    let result = null

    await storage.updateAll((draft, savingsDraft) => {
      advanceSavings(savingsDraft, draft, config, at)
      markActive(savingsDraft, dayKey, at.toISOString())

      // 过期/重启失效的例外先归档。
      for (const entry of Object.values(draft.exceptions)) {
        if (entry.status !== 'active') continue
        const expires = Date.parse(entry.expiresAt)
        const bootChanged = entry.instanceId !== instanceId
        if (bootChanged || !Number.isFinite(expires) || expires <= at.getTime()) {
          entry.status = 'expired'
          addAudit(draft, 'budget-exception-expired', {
            at: at.toISOString(),
            detail: entry.id + ' ' + (bootChanged ? '实例已重启' : '已过期'),
          })
        }
      }

      if (draft.guard.blocked === true) {
        const matches = Object.values(draft.exceptions).filter((entry) => {
          if (entry.status !== 'active' || entry.instanceId !== instanceId) return false
          if (Date.parse(entry.expiresAt) <= at.getTime()) return false
          if (entry.provider !== worst.provider || entry.model !== worst.model) return false
          if (entry.taskId !== null && entry.taskId !== (options.taskId ?? null)) return false
          if (entry.caller !== null && entry.caller !== (options.caller ?? null)) return false
          if (worst.tokens > entry.maxWorstTokens) return false
          if (worst.costMicros > entry.maxCostMicros) return false
          return true
        })
        if (matches.length === 0) {
          pendingError = new BudgetError(
            `预算保护已触发（${draft.guard.reason ?? 'PROTECTION_FAILED'}），需要用户核查后清除 Guard 或授权一次性例外`,
            'PROTECTION_FAILED',
          )
          return
        }
      }

      if (draft.reservations[options.runId] !== undefined) {
        pendingError = new BudgetError(`预留 ${options.runId} 已存在`, 'RUN_EXISTS')
        return
      }

      const day = dayOf(draft, dayKey)
      const baseLeft = Math.max(
        0,
        config.limits.cost.micros - day.costMicrosUsed - baseReservedOf(draft, dayKey),
      )
      const topupLeft = Math.max(0, topupAvailableOf(draft, dayKey) - topupReservedOf(draft, dayKey))
      const totalLeft = baseLeft + topupLeft + (enabled ? availableMicros(savingsDraft, dayKey) : 0)
      if (worst.costMicros > totalLeft) {
        pendingError = new BudgetError(
          '金额额度不足：需要 ' + worst.costMicros + ' micros，可用 ' + totalLeft + ' micros' + (enabled ? '（含临时补额与储蓄）' : '（含临时补额）'),
          'BUDGET_EXHAUSTED',
          {
            dimension: 'cost',
            remaining: totalLeft,
            required: worst.costMicros,
            currency: 'CNY',
          },
        )
        return
      }

      // 消费顺序：当日基础额度 → 当日临时补额（当天到期）→ 储蓄（最早到期优先）。
      const baseTake = Math.min(worst.costMicros, baseLeft)
      const topupTake = Math.min(worst.costMicros - baseTake, topupLeft)
      const savingsNeed = Math.max(0, worst.costMicros - baseTake - topupTake)
      let allocation = []
      if (savingsNeed > 0 && enabled) {
        const planned = allocateMicros(savingsDraft, savingsNeed, dayKey)
        if (planned.shortfall > 0) {
          pendingError = new BudgetError('储蓄额度在分配时发生变化，请重试', 'BUDGET_EXHAUSTED', {
            dimension: 'cost',
            remaining: totalLeft - savingsNeed + planned.allocation.reduce((sum, item) => sum + item.micros, 0),
            required: worst.costMicros,
            currency: 'CNY',
          })
          return
        }
        allocation = planned.allocation
        holdAllocation(savingsDraft, options.runId, allocation)
      }

      // 例外消费：只允许一次，不解除 Guard、不增加额度。
      const exception = Object.values(draft.exceptions).find(
        (entry) =>
          entry.status === 'active' &&
          entry.instanceId === instanceId &&
          Date.parse(entry.expiresAt) > at.getTime() &&
          entry.provider === worst.provider &&
          entry.model === worst.model &&
          (entry.taskId === null || entry.taskId === (options.taskId ?? null)) &&
          (entry.caller === null || entry.caller === (options.caller ?? null)) &&
          worst.tokens <= entry.maxWorstTokens &&
          worst.costMicros <= entry.maxCostMicros,
      )
      if (exception !== undefined) {
        exception.status = 'used'
        exception.usedAt = at.toISOString()
        exception.usedRunId = options.runId
        addAudit(draft, 'budget-exception-consumed', {
          at: at.toISOString(),
          runId: options.runId,
          detail: exception.id,
        })
      }

      day.tokensReserved += worst.tokens
      day.costMicrosReserved += worst.costMicros
      draft.reservations[options.runId] = {
        runId: options.runId,
        sessionId: typeof options.sessionId === 'string' ? options.sessionId : null,
        taskId: typeof options.taskId === 'string' ? options.taskId.slice(0, 120) : null,
        caller: typeof options.caller === 'string' ? options.caller.slice(0, 80) : null,
        dayKey,
        provider: worst.provider,
        model: worst.model,
        worstTokens: worst.tokens,
        worstCostMicros: worst.costMicros,
        reservedAt: at.toISOString(),
        status: 'pending',
        settledAt: null,
        usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
        actualCostMicros: null,
        overshoot: false,
        note: '',
        baseMicros: baseTake,
        topupMicros: topupTake,
        savingsHolds: allocation.map((item) => ({ lotId: item.lotId, micros: item.micros })),
      }
      addAudit(draft, 'budget-reserved', {
        at: at.toISOString(),
        runId: options.runId,
        detail: `${worst.provider}/${worst.model} tokens=${worst.tokens} cost=${worst.costMicros} savings=${savingsNeed}`,
      })
      prune(draft, dayKey)
      result = {
        ok: true,
        reservationId: options.runId,
        day: dayKey,
        tokens: worst.tokens,
        cost: { micros: worst.costMicros, currency: 'CNY' },
        remaining: {
          tokens: Math.max(0, config.limits.tokens - day.tokensUsed - day.tokensReserved),
          cost: {
            micros:
              Math.max(0, config.limits.cost.micros - day.costMicrosUsed - baseReservedOf(draft, dayKey)) +
              Math.max(0, topupAvailableOf(draft, dayKey) - topupReservedOf(draft, dayKey)) +
              (enabled ? availableMicros(savingsDraft, dayKey) : 0),
            currency: 'CNY',
          },
        },
        fromTopupMicros: topupTake,
        savingsUsedMicros: savingsNeed,
      }
      return result
    })

    if (pendingError !== null) throw pendingError
    if (result === null) throw new BudgetError('预留未完成', 'INTERNAL_ERROR')
    return result
  }

  function applySpend(state, savings, reservation, actualMicros, config, atIso) {
    const dayKey = reservation.dayKey
    const day = dayOf(state, dayKey)
    const limit = config.limits.cost.micros
    day.costMicrosUsed += actualMicros

    // 临时补额先于储蓄消耗：当日实际支出超出基础限额的部分，优先由已批准的
    // 当日补额覆盖；仍有超出才核销储蓄批次。
    const approved = topupApprovedOf(state, dayKey)
    const desiredTopup = Math.min(approved, Math.max(0, day.costMicrosUsed - limit))
    const topupDelta = Math.max(0, desiredTopup - topupUsedOf(state, dayKey))
    if (topupDelta > 0) consumeTopup(state, dayKey, topupDelta)
    const usedTopup = topupUsedOf(state, dayKey)

    const record = ensureDayRecord(savings, dayKey, limit, atIso)
    const desired = Math.max(0, day.costMicrosUsed - limit - usedTopup)
    const delta = Math.max(0, desired - (record.usedFromSavings ?? 0))
    if (delta > 0) {
      let consumed = consumeHolds(savings, reservation.runId, delta)
      if (consumed < delta) consumed += consumeAvailable(savings, delta - consumed, dayKey)
      record.usedFromSavings = (record.usedFromSavings ?? 0) + consumed
    }
    releaseHolds(savings, reservation.runId)
    record.usedMicros = day.costMicrosUsed
    record.reservedMicros = day.costMicrosReserved
    record.active = true
    return { day, record, fromSavings: record.usedFromSavings ?? 0, fromTopup: usedTopup }
  }

  async function settle(options = {}) {
    if (typeof options.runId !== 'string' || options.runId.length === 0) {
      throw new BudgetError('runId 必须是非空字符串', 'INVALID_ARGUMENT')
    }
    const at = atOf(options.at)
    const usage = requireUsage(options.usage)
    const loadedResult = await loaded()
    requireHealthy(loadedResult)
    const config = requireConfig(loadedResult)
    const table = tableOf(config)
    let result = null

    await storage.updateAll((draft, savingsDraft) => {
      advanceSavings(savingsDraft, draft, config, at)
      const reservation = draft.reservations[options.runId]
      if (reservation === undefined) {
        throw new BudgetError(`预留 ${options.runId} 不存在`, 'RESERVATION_NOT_FOUND')
      }
      if (reservation.status === 'settled' || reservation.status === 'released') {
        result = { ok: true, applied: false, reason: `already-${reservation.status}`, runId: options.runId }
        return
      }
      const day = dayOf(draft, reservation.dayKey)
      day.tokensReserved = Math.max(0, day.tokensReserved - reservation.worstTokens)
      day.costMicrosReserved = Math.max(0, day.costMicrosReserved - reservation.worstCostMicros)

      const priced = costMicros({
        table,
        provider: reservation.provider,
        model: reservation.model,
        usage,
        at,
        holidays: config.holidays,
        conservative: false,
        roundUp: false,
      })

      if (priced === null) {
        day.tokensUsed += reservation.worstTokens
        applySpend(draft, savingsDraft, reservation, reservation.worstCostMicros, config, at.toISOString())
        reservation.status = 'uncertain'
        reservation.settledAt = at.toISOString()
        reservation.actualCostMicros = reservation.worstCostMicros
        reservation.note = '价格未知，按最坏情况入账'
        addAudit(draft, 'budget-settle-unpriced', { at: at.toISOString(), runId: options.runId })
        result = {
          ok: false,
          applied: true,
          uncertainty: true,
          reason: 'UNKNOWN_PRICE',
          runId: options.runId,
          reservedMicros: reservation.worstCostMicros,
        }
        return
      }

      const actualTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens
      day.tokensUsed += priced.tokens
      const applied = applySpend(draft, savingsDraft, reservation, priced.micros, config, at.toISOString())
      const costOvershoot = priced.micros > reservation.worstCostMicros
      const tokenOvershoot = actualTokens > reservation.worstTokens
      reservation.status = 'settled'
      reservation.settledAt = at.toISOString()
      reservation.usage = usage
      reservation.actualCostMicros = priced.micros
      reservation.overshoot = costOvershoot || tokenOvershoot
      if (costOvershoot) {
        reservation.note = '实际金额超过预留估算'
        draft.guard = { blocked: true, reason: 'OVERBUDGET' }
        addAudit(draft, 'budget-overshoot', {
          at: at.toISOString(),
          runId: options.runId,
          detail: `cost ${priced.micros} > ${reservation.worstCostMicros}`,
        })
      } else if (tokenOvershoot) {
        reservation.note = '实际 Token 超过预留估算（仅记录，不触发 Guard）'
        addAudit(draft, 'budget-token-estimate-low', {
          at: at.toISOString(),
          runId: options.runId,
          detail: `tokens ${actualTokens} > ${reservation.worstTokens}`,
        })
      }
      addAudit(draft, 'budget-settled', {
        at: at.toISOString(),
        runId: options.runId,
        detail: `tokens=${priced.tokens} cost=${priced.micros} fromSavings=${applied.fromSavings}`,
      })
      result = {
        ok: true,
        applied: true,
        runId: options.runId,
        tokens: priced.tokens,
        cost: { micros: priced.micros, currency: 'CNY' },
        window: priced.window,
        overshoot: reservation.overshoot,
        tokenOvershoot,
        fromSavingsMicros: applied.fromSavings,
      }
    })
    return result
  }

  async function release(options = {}) {
    if (typeof options.runId !== 'string' || options.runId.length === 0) {
      throw new BudgetError('runId 必须是非空字符串', 'INVALID_ARGUMENT')
    }
    const at = atOf(options.at)
    const loadedResult = await loaded()
    requireHealthy(loadedResult)
    let result = null
    await storage.updateAll((draft, savingsDraft) => {
      const reservation = draft.reservations[options.runId]
      if (reservation === undefined) {
        throw new BudgetError(`预留 ${options.runId} 不存在`, 'RESERVATION_NOT_FOUND')
      }
      if (reservation.status === 'settled' || reservation.status === 'released') {
        result = { ok: true, applied: false, reason: `already-${reservation.status}`, runId: options.runId }
        return
      }
      const used = USAGE_KEYS.reduce((sum, key) => sum + (reservation.usage?.[key] ?? 0), 0)
      if (used > 0) {
        throw new BudgetError('该预留已有用量，必须用 settle 结算，不能直接释放', 'HAS_USAGE_USE_SETTLE')
      }
      if (reservation.status === 'uncertain') {
        requireTrust(options, trustedSymbol)
      }
      const day = dayOf(draft, reservation.dayKey)
      day.tokensReserved = Math.max(0, day.tokensReserved - reservation.worstTokens)
      day.costMicrosReserved = Math.max(0, day.costMicrosReserved - reservation.worstCostMicros)
      releaseHolds(savingsDraft, options.runId)
      reservation.status = 'released'
      reservation.settledAt = at.toISOString()
      reservation.note = typeof options.reason === 'string' ? options.reason.slice(0, 200) : ''
      addAudit(draft, 'budget-released', {
        at: at.toISOString(),
        runId: options.runId,
        detail: reservation.note,
      })
      result = { ok: true, applied: true, runId: options.runId }
    })
    return result
  }

  async function recover(options = {}) {
    const at = atOf(options.at)
    const loadedResult = await loaded()
    if (loadedResult.ledger.kind === 'invalid' || loadedResult.ledger.kind === 'empty') {
      return { ok: true, changed: 0 }
    }
    requireHealthy(loadedResult)
    const config = loadedResult.config.config
    const ttlMinutes = config?.reservationTtlMinutes ?? 30
    const ttlMs = ttlMinutes * 60_000
    let changed = 0
    await storage.updateAll((draft, savingsDraft) => {
      if (config !== null) advanceSavings(savingsDraft, draft, config, at)
      markActive(savingsDraft, dayKeyAt(at, config?.timeZone ?? 'Asia/Shanghai'), at.toISOString())
      for (const reservation of Object.values(draft.reservations)) {
        if (reservation.status !== 'pending') continue
        if (at.getTime() - Date.parse(reservation.reservedAt) <= ttlMs) continue
        reservation.status = 'uncertain'
        reservation.note = '超过预留 TTL 未结算，按最坏情况继续占用额度'
        addAudit(draft, 'budget-uncertain', { at: at.toISOString(), runId: reservation.runId, detail: `ttl=${ttlMinutes}m` })
        changed += 1
      }
      reconcileHolds(savingsDraft, draft)
      return changed
    })
    return { ok: true, changed }
  }

  async function configure(options = {}) {
    requireTrust(options, trustedSymbol)
    if (options.limits === null || typeof options.limits !== 'object' || Array.isArray(options.limits)) {
      throw new BudgetError('limits 必须是对像', 'INVALID_ARGUMENT')
    }
    const at = now()
    const savings =
      options.savings === undefined
        ? { enabled: false, retainDays: DEFAULT_RETAIN_DAYS }
        : {
            enabled: options.savings?.enabled === true,
            retainDays: options.savings?.retainDays ?? DEFAULT_RETAIN_DAYS,
          }
    const raw = {
      version: 1,
      timeZone: options.timeZone,
      limits: options.limits,
      holidays: options.holidays ?? [],
      reservationTtlMinutes: options.reservationTtlMinutes,
      prices: options.prices ?? {},
      savings,
      setBy: options.actor?.id ?? 'user',
      setAt: at.toISOString(),
    }
    const written = await storage.writeConfig(raw)
    await storage.updateAll((draft) => {
      draft.configVersion += 1
      if (options.clearGuard === true) draft.guard = { blocked: false, reason: null }
      addAudit(draft, 'budget-configured', {
        at: at.toISOString(),
        detail: `tokens=${written.config.limits.tokens} cost=${written.config.limits.cost.micros} savings=${raw.savings.enabled}/${raw.savings.retainDays}`,
      })
    })
    return {
      ok: true,
      config: configSummary(written.config),
      backupFile: written.backupFile,
    }
  }

  async function authorizeOnce(options = {}) {
    requireTrust(options, trustedSymbol)
    const at = now()
    const provider = options.provider ?? 'deepseek'
    const model = options.model
    if (typeof model !== 'string' || model.length === 0) {
      throw new BudgetError('authorizeOnce 需要 provider 与 model', 'INVALID_ARGUMENT')
    }
    const maxWorstTokens = options.maxWorstTokens
    const maxCostMicros = options.maxCostMicros
    if (!Number.isSafeInteger(maxWorstTokens) || maxWorstTokens <= 0 || maxWorstTokens > 1_000_000_000) {
      throw new BudgetError('maxWorstTokens 必须是 1..1e9 的整数', 'INVALID_ARGUMENT')
    }
    if (!Number.isSafeInteger(maxCostMicros) || maxCostMicros <= 0 || maxCostMicros > 1_000_000_000_000) {
      throw new BudgetError('maxCostMicros 必须是 1..1e12 的整数', 'INVALID_ARGUMENT')
    }
    const expiresInMinutes = options.expiresInMinutes ?? 10
    if (!Number.isSafeInteger(expiresInMinutes) || expiresInMinutes < 1 || expiresInMinutes > 1440) {
      throw new BudgetError('expiresInMinutes 必须是 1..1440 之间', 'INVALID_ARGUMENT')
    }
    const exception = {
      id: `ex-${randomUUID()}`,
      instanceId,
      provider,
      model,
      maxWorstTokens,
      maxCostMicros,
      taskId: typeof options.taskId === 'string' ? options.taskId.slice(0, 120) : null,
      caller: typeof options.caller === 'string' ? options.caller.slice(0, 80) : null,
      createdAt: at.toISOString(),
      expiresAt: new Date(at.getTime() + expiresInMinutes * 60_000).toISOString(),
      reason: typeof options.reason === 'string' ? options.reason.slice(0, 200) : '',
      status: 'active',
      usedAt: null,
      usedRunId: null,
      actorId: options.actor?.id ?? 'user',
    }
    await storage.updateAll((draft) => {
      draft.exceptions[exception.id] = exception
      addAudit(draft, 'budget-exception-authorized', {
        at: at.toISOString(),
        detail: `${exception.id} ${provider}/${model} tokens<=${maxWorstTokens} cost<=${maxCostMicros}`,
      })
    })
    const fresh = await storage.readState()
    return {
      ok: true,
      exception,
      guard: fresh.state?.guard ?? { blocked: false, reason: null },
    }
  }

  async function revokeException(options = {}) {
    requireTrust(options, trustedSymbol)
    if (typeof options.id !== 'string' || options.id.length === 0) {
      throw new BudgetError('id 必须是非空字符串', 'INVALID_ARGUMENT')
    }
    const at = now()
    await storage.updateAll((draft) => {
      const exception = Object.values(draft.exceptions).find((entry) => entry.id === options.id)
      if (exception === undefined || exception.status !== 'active') {
        throw new BudgetError('例外不存在或已不可撤销', 'INVALID_ARGUMENT')
      }
      exception.status = 'revoked'
      addAudit(draft, 'budget-exception-revoked', { at: at.toISOString(), detail: exception.id })
    })
    return { ok: true, id: options.id, revoked: true }
  }

  async function migrateLegacy(options = {}) {
    requireTrust(options, trustedSymbol)
    const result = await storage.migrateLegacyToV2()
    return { ok: true, ...result }
  }

  async function restoreBackup(options = {}) {
    requireTrust(options, trustedSymbol)
    if (typeof options.file !== 'string' || options.file.length === 0) {
      throw new BudgetError('file 必须是非空字符串', 'INVALID_ARGUMENT')
    }
    await storage.restoreState(options.file)
    await storage.updateAll((draft) => {
      addAudit(draft, 'budget-restored', { at: now().toISOString(), detail: options.file.slice(-120) })
    })
    return { ok: true, restored: true }
  }

  async function reservations(options = {}) {
    const loadedResult = await loaded()
    const limit = Math.min(100, Math.max(1, Number.isSafeInteger(options.limit) ? options.limit : 20))
    if (loadedResult.ledger.kind !== 'v2') return []
    return Object.values(loadedResult.ledger.state.reservations)
      .sort((a, b) => b.reservedAt.localeCompare(a.reservedAt))
      .slice(0, limit)
      .map((entry) => ({ ...entry, usage: { ...entry.usage }, savingsHolds: entry.savingsHolds.map((item) => ({ ...item })) }))
  }

  async function savings() {
    const loadedResult = await loaded()
    const at = now()
    const config = loadedResult.config.config
    const state = loadedResult.ledger.kind === 'v2' ? loadedResult.ledger.state : null
    if (config === null || state === null) {
      return {
        enabled: false,
        retainDays: DEFAULT_RETAIN_DAYS,
        startedDayKey: null,
        lastClosedDayKey: null,
        availableMicros: 0,
        lots: [],
        days: [],
      }
    }
    const { enabled, retainDays } = savingsConfig(config)
    const todayKey = dayKeyAt(at, config.timeZone)
    const source = loadedResult.savings.kind === 'v1' ? loadedResult.savings.savings : null
    const preview =
      source === null
        ? { lots: [], days: {}, activity: {}, startedDayKey: null, lastClosedDayKey: null }
        : previewSavings(source, {
            state,
            todayKey,
            baseMicros: config.limits.cost.micros,
            enabled,
            retainDays,
            atIso: at.toISOString(),
          })
    return savingsView(preview, todayKey, { enabled, retainDays })
  }

  async function clearGuard(options = {}) {
    requireTrust(options, trustedSymbol)
    const at = now()
    let guard = { blocked: false, reason: null }
    await storage.updateAll((draft) => {
      const reason = typeof options.reason === 'string' ? options.reason.slice(0, 200) : ''
      draft.guard = { blocked: false, reason: null }
      addAudit(draft, 'budget-guard-cleared', {
        at: at.toISOString(),
        detail: reason.length > 0 ? reason : '用户确认解除保护',
      })
      guard = { ...draft.guard }
    })
    return { ok: true, guard }
  }

  async function reconcile(options = {}) {
    requireTrust(options, trustedSymbol)
    const runId = options.runId
    if (typeof runId !== 'string' || runId.length === 0) {
      throw new BudgetError('runId 必须是非空字符串', 'INVALID_ARGUMENT')
    }
    const mode = options.mode
    if (!['settle', 'accept', 'release-zero', 'release-risk'].includes(mode)) {
      throw new BudgetError('mode 必须是 settle、accept、release-zero 或 release-risk', 'INVALID_ARGUMENT')
    }
    const at = now()
    if (mode === 'settle') {
      const result = await settle({ runId, usage: options.usage, at: at.toISOString() })
      await storage.updateAll((draft) => {
        addAudit(draft, 'budget-reconciled-settle', {
          at: at.toISOString(),
          runId,
          detail: '按实际用量结算 uncertain 预留',
        })
      })
      return { ok: result.ok, mode, result }
    }
    if (mode === 'release-risk' && options.acceptRisk !== true) {
      throw new BudgetError('人工释放需要显式接受风险（acceptRisk=true）', 'INVALID_ARGUMENT')
    }
    const loadedResult = await loaded()
    requireHealthy(loadedResult)
    const config = requireConfig(loadedResult)
    let output = null
    await storage.updateAll((draft, savingsDraft) => {
      advanceSavings(savingsDraft, draft, config, at)
      const reservation = draft.reservations[runId]
      if (reservation === undefined) {
        throw new BudgetError(`预留 ${runId} 不存在`, 'RESERVATION_NOT_FOUND')
      }
      if (reservation.status === 'settled' || reservation.status === 'released') {
        output = { ok: true, mode, applied: false, reason: `already-${reservation.status}` }
        return
      }
      if (reservation.status === 'pending') {
        throw new BudgetError('只有 uncertain 预留需要人工对账', 'INVALID_ARGUMENT')
      }
      const day = draft.days[reservation.dayKey]
      if (day === undefined && !(mode === 'accept' && reservation.actualCostMicros !== null)) {
        throw new BudgetError(
          '该预留所属日期已不在账本保留窗口内，不能在线对账；请保留 uncertain 或从备份处理',
          'DAY_OUT_OF_RETENTION',
        )
      }

      if (mode === 'accept') {
        // 已经按最坏入账过（未知价格结算）→ 只收尾；尚未入账（TTL 超时）→ 先入账。
        if (reservation.actualCostMicros === null) {
          day.tokensUsed += reservation.worstTokens
          day.tokensReserved = Math.max(0, day.tokensReserved - reservation.worstTokens)
          day.costMicrosReserved = Math.max(0, day.costMicrosReserved - reservation.worstCostMicros)
          applySpend(draft, savingsDraft, reservation, reservation.worstCostMicros, config, at.toISOString())
          reservation.actualCostMicros = reservation.worstCostMicros
        } else {
          releaseHolds(savingsDraft, runId)
        }
        reservation.status = 'settled'
        reservation.settledAt = at.toISOString()
        reservation.note = '用户接受保守核销（按最坏情况）'
        addAudit(draft, 'budget-reconciled-accept', { at: at.toISOString(), runId })
        output = { ok: true, mode, applied: true, chargedMicros: reservation.actualCostMicros }
        return
      }

      // release-zero / release-risk：不结金额，释放当日预留与储蓄占用。
      if (reservation.actualCostMicros !== null) {
        throw new BudgetError('该预留已按最坏情况入账，不能再直接释放；请使用 accept 或 settle', 'INVALID_ARGUMENT')
      }
      day.tokensReserved = Math.max(0, day.tokensReserved - reservation.worstTokens)
      day.costMicrosReserved = Math.max(0, day.costMicrosReserved - reservation.worstCostMicros)
      releaseHolds(savingsDraft, runId)
      reservation.status = 'released'
      reservation.settledAt = at.toISOString()
      const reason = typeof options.reason === 'string' && options.reason.length > 0 ? options.reason.slice(0, 200) : ''
      reservation.note =
        mode === 'release-zero'
          ? '可信零消费释放' + (reason ? '（' + reason + '）' : '')
          : '用户接受风险后人工释放' + (reason ? '（' + reason + '）' : '')
      addAudit(draft, 'budget-reconciled-release', {
        at: at.toISOString(),
        runId,
        detail: `${mode} ${reason}`.trim(),
      })
      output = { ok: true, mode, applied: true }
    })
    return output
  }

  function publicTopUp(entry) {
    return {
      id: entry.id,
      dayKey: entry.dayKey,
      taskId: entry.taskId,
      caller: entry.caller,
      reason: entry.reason,
      requestedMicros: entry.requestedMicros,
      approvedMicros: entry.approvedMicros,
      usedMicros: entry.usedMicros,
      status: entry.status,
      createdAt: entry.createdAt,
      decidedAt: entry.decidedAt,
    }
  }

  /**
   * DSHAI 只能“申请”，不能批准。该方法刻意不要求用户身份，但会被
   * 每日待批准数量上限与 requestKey 幂等约束；真正增加额度只发生在
   * decideTopUp（需要宿主认证的用户入口）。
   */
  async function requestTopUp(options = {}) {
    const at = atOf(options.at)
    if (!Number.isSafeInteger(options.amountMicros) || options.amountMicros <= 0 || options.amountMicros > 1e12) {
      throw new BudgetError('amountMicros 必须是正的安全整数且不超过 1e12', 'INVALID_ARGUMENT')
    }
    const reason = typeof options.reason === 'string' ? options.reason.trim().slice(0, 200) : ''
    if (reason.length === 0) throw new BudgetError('申请必须给出理由', 'INVALID_ARGUMENT')
    const caller = typeof options.caller === 'string' && options.caller.length > 0 ? options.caller.slice(0, 80) : 'autonomy'
    const taskId = typeof options.taskId === 'string' && options.taskId.length > 0 ? options.taskId.slice(0, 120) : null
    const requestKey =
      typeof options.requestKey === 'string' && options.requestKey.length > 0
        ? options.requestKey.slice(0, 200)
        : `${caller}|${taskId ?? ''}|${options.amountMicros}|${reason}`
    const loadedResult = await loaded()
    const config = requireConfig(loadedResult)
    requireHealthy(loadedResult)
    const todayKey = dayKeyAt(at, config.timeZone)
    let output = null
    await storage.updateAll((draft, savingsDraft) => {
      advanceSavings(savingsDraft, draft, config, at)
      markActive(savingsDraft, todayKey, at.toISOString())
      expireTopUps(draft, todayKey, at.toISOString())
      const existing = Object.values(draft.topups).find(
        (entry) => entry.dayKey === todayKey && entry.requestKey === requestKey && entry.status !== 'expired',
      )
      if (existing !== undefined) {
        output = { ok: true, idempotent: true, topup: publicTopUp(existing) }
        return
      }
      const pending = Object.values(draft.topups).filter(
        (entry) => entry.dayKey === todayKey && entry.status === 'pending',
      ).length
      if (pending >= 5) {
        throw new BudgetError('当日待批准的补额申请过多，请先处理现有申请', 'TOPUP_PENDING_LIMIT')
      }
      const record = {
        id: `topup-${randomUUID()}`,
        requestKey,
        dayKey: todayKey,
        caller,
        taskId,
        reason,
        requestedMicros: options.amountMicros,
        approvedMicros: 0,
        status: 'pending',
        createdAt: at.toISOString(),
        decidedAt: null,
        decidedBy: null,
        usedMicros: 0,
        note: '',
      }
      draft.topups[record.id] = record
      addAudit(draft, 'budget-topup-requested', {
        at: at.toISOString(),
        detail: `${record.id} ${caller} ${options.amountMicros} ${reason}`.slice(0, 200),
      })
      output = { ok: true, idempotent: false, topup: publicTopUp(record) }
    })
    return output
  }

  async function topUps(options = {}) {
    const at = atOf(options.at)
    const loadedResult = await loaded()
    const config = loadedResult.config.config
    const state = loadedResult.ledger.kind === 'v2' ? loadedResult.ledger.state : null
    if (config === null || state === null) {
      return { ok: true, day: null, items: [] }
    }
    const todayKey = dayKeyAt(at, config.timeZone)
    const dayKey = typeof options.dayKey === 'string' ? options.dayKey : todayKey
    const limit = Math.min(100, Math.max(1, Number.isSafeInteger(options.limit) ? options.limit : 20))
    const items = Object.values(state.topups)
      .filter((entry) => entry.dayKey === dayKey)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, limit)
      .map((entry) => ({
        ...publicTopUp(entry),
        effectiveStatus:
          entry.dayKey < todayKey && (entry.status === 'pending' || entry.status === 'approved')
            ? 'expired'
            : entry.status,
      }))
    return { ok: true, day: dayKey, items }
  }

  async function decideTopUp(options = {}) {
    requireTrust(options, trustedSymbol)
    if (typeof options.id !== 'string' || options.id.length === 0) {
      throw new BudgetError('id 必须是非空字符串', 'INVALID_ARGUMENT')
    }
    const decision = options.decision
    if (decision !== 'approve' && decision !== 'reject') {
      throw new BudgetError('decision 必须是 approve 或 reject', 'INVALID_ARGUMENT')
    }
    const at = now()
    const loadedResult = await loaded()
    const config = requireConfig(loadedResult)
    requireHealthy(loadedResult)
    const todayKey = dayKeyAt(at, config.timeZone)
    const actorId = typeof options.actor?.id === 'string' ? options.actor.id.slice(0, 80) : 'user'
    let output = null
    await storage.updateAll((draft, savingsDraft) => {
      advanceSavings(savingsDraft, draft, config, at)
      const record = draft.topups[options.id]
      if (record === undefined) throw new BudgetError('补额申请不存在', 'TOPUP_NOT_FOUND')
      if (record.dayKey !== todayKey) {
        if (record.status === 'pending' || record.status === 'approved') {
          record.status = 'expired'
          record.note = '超过当日有效期，已自动失效'
          addAudit(draft, 'budget-topup-expired', { at: at.toISOString(), detail: record.id })
        }
        throw new BudgetError('该申请属于已结束的计费日，不能批准或拒绝', 'TOPUP_EXPIRED')
      }
      if (record.status !== 'pending') {
        if (record.status === 'approved' && decision === 'approve') {
          output = { ok: true, applied: false, topup: publicTopUp(record) }
          return
        }
        if (record.status === 'rejected' && decision === 'reject') {
          output = { ok: true, applied: false, topup: publicTopUp(record) }
          return
        }
        throw new BudgetError('该申请已经处理过', 'TOPUP_DECIDED')
      }
      if (decision === 'approve') {
        const amount = options.amountMicros ?? record.requestedMicros
        if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 1e12) {
          throw new BudgetError('批准金额必须是正的安全整数且不超过 1e12', 'INVALID_ARGUMENT')
        }
        record.approvedMicros = amount
        record.status = 'approved'
      } else {
        record.approvedMicros = 0
        record.status = 'rejected'
      }
      record.decidedAt = at.toISOString()
      record.decidedBy = actorId
      addAudit(draft, decision === 'approve' ? 'budget-topup-approved' : 'budget-topup-rejected', {
        at: at.toISOString(),
        detail: `${record.id} ${record.approvedMicros}`,
      })
      output = { ok: true, applied: true, topup: publicTopUp(record) }
    })
    return output
  }

  async function revokeTopUp(options = {}) {
    requireTrust(options, trustedSymbol)
    if (typeof options.id !== 'string' || options.id.length === 0) {
      throw new BudgetError('id 必须是非空字符串', 'INVALID_ARGUMENT')
    }
    const at = now()
    const loadedResult = await loaded()
    const config = requireConfig(loadedResult)
    requireHealthy(loadedResult)
    const todayKey = dayKeyAt(at, config.timeZone)
    let output = null
    await storage.updateAll((draft, savingsDraft) => {
      advanceSavings(savingsDraft, draft, config, at)
      const record = draft.topups[options.id]
      if (record === undefined) throw new BudgetError('补额申请不存在', 'TOPUP_NOT_FOUND')
      if (record.status === 'revoked') {
        output = { ok: true, applied: false, topup: publicTopUp(record) }
        return
      }
      if (record.status !== 'approved') {
        throw new BudgetError('只有已批准且未失效的临时额度可以撤销', 'TOPUP_DECIDED')
      }
      if (record.dayKey !== todayKey) {
        throw new BudgetError('该临时额度已过期', 'TOPUP_EXPIRED')
      }
      if (topupReservedOf(draft, record.dayKey) > 0) {
        throw new BudgetError('该临时额度仍被进行中的预留占用，不能撤销；请等预留结算或释放', 'TOPUP_IN_USE')
      }
      record.status = 'revoked'
      record.decidedAt = at.toISOString()
      record.note = typeof options.reason === 'string' ? options.reason.slice(0, 200) : '用户撤销'
      addAudit(draft, 'budget-topup-revoked', { at: at.toISOString(), detail: record.id })
      output = { ok: true, applied: true, topup: publicTopUp(record) }
    })
    return output
  }

  async function withPaidCall(options, run) {
    if (typeof run !== 'function') throw new BudgetError('run 必须是函数', 'INVALID_ARGUMENT')
    if (options?.usageFrom !== null && options?.usageFrom !== undefined && typeof options.usageFrom !== 'function') {
      throw new BudgetError('usageFrom 必须是函数', 'INVALID_ARGUMENT')
    }
    const onError = options?.onError ?? 'keep-pending'
    if (onError !== 'release' && onError !== 'keep-pending') {
      throw new BudgetError('onError 必须是 release 或 keep-pending', 'INVALID_ARGUMENT')
    }
    if (
      options?.requestStarted !== null &&
      options?.requestStarted !== undefined &&
      typeof options.requestStarted !== 'boolean' &&
      typeof options.requestStarted !== 'function'
    ) {
      throw new BudgetError('requestStarted 必须是布尔值或函数', 'INVALID_ARGUMENT')
    }
    const runId = typeof options?.runId === 'string' && options.runId.length > 0 ? options.runId : `paid-${randomUUID()}`
    const reservation = await reserve({ ...options, runId })
    let result
    try {
      result = await run({ runId, reservation })
    } catch (error) {
      const usage = safeUsage(options?.usageFrom, error)
      if (usage !== null) {
        const settled = await settle({ runId, usage, at: options?.at })
        throw annotate(error, { runId, accounting: 'settled', settled })
      }
      if (onError === 'release') {
        const proof =
          typeof options?.requestStarted === 'function'
            ? options.requestStarted(error)
            : options?.requestStarted === true
              ? true
              : options?.requestStarted === false
                ? false
                : null
        if (proof === false) {
          const released = await release({ runId, reason: `call-not-sent:${codeOf(error)}`, at: options?.at })
          throw annotate(error, { runId, accounting: 'released', released })
        }
        const pending = {
          runId,
          accounting: 'pending',
          note: '无法证明请求未发出，预留保持 pending；请走 recover/对账处理，不要按 0 结算',
        }
        throw annotate(error, pending)
      }
      const pending = { runId, accounting: 'pending' }
      throw annotate(error, pending)
    }
    const usage = safeUsage(options?.usageFrom, result)
    if (usage === null) {
      return {
        ok: true,
        runId,
        result,
        accounting: 'usage-missing',
        note: '未取得 Provider 用量：预留保持 pending，超过 TTL 后 recover() 会标记 uncertain，不会按 0 结算',
      }
    }
    const settled = await settle({ runId, usage, at: options?.at })
    return { ok: true, runId, result, settled }
  }

  Object.assign(service, {
    status,
    quote,
    reserve,
    settle,
    release,
    recover,
    configure,
    authorizeOnce,
    revokeException,
    reservations,
    withPaidCall,
    migrateLegacy,
    restoreBackup,
    reconcile,
    clearGuard,
    savings,
    requestTopUp,
    topUps,
    decideTopUp,
    revokeTopUp,
  })

  return service
}
