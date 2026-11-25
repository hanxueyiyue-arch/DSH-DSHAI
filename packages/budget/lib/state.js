/**
 * 预算状态的纯函数部分：严格解析、默认结构、日桶与预留记录。
 *
 * 安全约束：
 * - 账本损坏、字段非法或 Schema 不受支持时**不能被当作空账本**；
 *   `parseState()` 返回 `invalid`，由 service 进入 fail-closed。
 * - v1 账本（美元口径）单独识别为 `legacy`，不自动解释为人民币；
 *   只有确认无消费时才允许受控迁移。
 * - 所有金额统一为人民币微元（`costMicros`），不再做汇率换算。
 */

/** 当前账本 Schema（v2 = 人民币微元）。 */
export const SCHEMA = 2;

/** 旧版账本 Schema（美元微元，0.2.x）。 */
export const LEGACY_SCHEMA = 1;

/** 金额单位固定为人民币微元。 */
export const CURRENCY = 'CNY';

/** 每日桶保留天数（仅用于审计展示，不参与限额计算）。 */
export const KEEP_DAYS = 14;

/** 已结束预留记录保留条数。 */
export const KEEP_FINISHED_RESERVATIONS = 200;

const RESERVATION_STATUS = new Set(['pending', 'settled', 'released', 'uncertain']);

/** 校验错误：由调用方转成 BudgetError/存储错误，不静默丢弃。 */
function invalid(message) {
  const error = new Error(message);
  error.code = 'LEDGER_INVALID';
  throw error;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonNegativeInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** 空状态（v2）。 */
export function blankState() {
  return {
    schema: SCHEMA,
    currency: CURRENCY,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    configVersion: 0,
    days: {},
    reservations: {},
    exceptions: {},
    // 0.5.1：当日临时补额申请。旧版解析器会忽略该顶层键，降级后临时额度
    // 自然消失（只会收紧可用额度，不会重复支出）；升级回来时从备份恢复记录。
    topups: {},
    audit: [],
    guard: { blocked: false, reason: null },
  };
}

/** 单次例外状态。 */
export const EXCEPTION_STATUS = new Set(['active', 'used', 'expired', 'revoked']);

/** 临时补额申请状态（0.5.1）。 */
export const TOPUP_STATUS = new Set(['pending', 'approved', 'rejected', 'revoked', 'expired']);

function readTopUp(raw) {
  if (!isPlainObject(raw)) invalid('topup 不是对象');
  if (typeof raw.id !== 'string' || raw.id.length === 0) invalid('topup.id 缺失');
  if (typeof raw.dayKey !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.dayKey)) invalid(`topup.${raw.id}.dayKey 非法`);
  if (typeof raw.requestKey !== 'string' || raw.requestKey.length === 0 || raw.requestKey.length > 200) {
    invalid(`topup.${raw.id}.requestKey 非法`);
  }
  if (typeof raw.caller !== 'string' || raw.caller.length === 0 || raw.caller.length > 80) invalid(`topup.${raw.id}.caller 非法`);
  if (raw.taskId !== null && raw.taskId !== undefined && typeof raw.taskId !== 'string') invalid(`topup.${raw.id}.taskId 非法`);
  if (typeof raw.reason !== 'string' || raw.reason.length === 0 || raw.reason.length > 200) invalid(`topup.${raw.id}.reason 非法`);
  if (!isPositiveInt(raw.requestedMicros) || raw.requestedMicros > 1e12) invalid(`topup.${raw.id}.requestedMicros 非法`);
  if (!isNonNegativeInt(raw.approvedMicros) || raw.approvedMicros > 1e12) {
    invalid(`topup.${raw.id}.approvedMicros 非法`);
  }
  if (!TOPUP_STATUS.has(raw.status)) invalid(`topup.${raw.id}.status 非法`);
  if (typeof raw.createdAt !== 'string' || !Number.isFinite(Date.parse(raw.createdAt))) invalid(`topup.${raw.id}.createdAt 非法`);
  if (raw.decidedAt !== null && raw.decidedAt !== undefined) {
    if (typeof raw.decidedAt !== 'string' || !Number.isFinite(Date.parse(raw.decidedAt))) invalid(`topup.${raw.id}.decidedAt 非法`);
  }
  if (!isNonNegativeInt(raw.usedMicros) || raw.usedMicros > raw.approvedMicros) invalid(`topup.${raw.id}.usedMicros 非法`);
  return {
    id: raw.id,
    requestKey: raw.requestKey,
    dayKey: raw.dayKey,
    caller: raw.caller,
    taskId: typeof raw.taskId === 'string' ? raw.taskId.slice(0, 120) : null,
    reason: raw.reason,
    requestedMicros: raw.requestedMicros,
    approvedMicros: raw.approvedMicros,
    status: raw.status,
    createdAt: raw.createdAt,
    decidedAt: typeof raw.decidedAt === 'string' ? raw.decidedAt : null,
    decidedBy: typeof raw.decidedBy === 'string' ? raw.decidedBy.slice(0, 80) : null,
    usedMicros: raw.usedMicros,
    note: typeof raw.note === 'string' ? raw.note.slice(0, 200) : '',
  };
}

function readException(raw) {
  if (!isPlainObject(raw)) invalid('exception 不是对象');
  if (typeof raw.id !== 'string' || raw.id.length === 0) invalid('exception.id 缺失');
  if (typeof raw.provider !== 'string' || raw.provider.length === 0) invalid(`exception.${raw.id}.provider 非法`);
  if (typeof raw.model !== 'string' || raw.model.length === 0) invalid(`exception.${raw.id}.model 非法`);
  if (!isPositiveInt(raw.maxWorstTokens) || !isPositiveInt(raw.maxCostMicros)) invalid(`exception.${raw.id} 的额度非法`);
  if (!EXCEPTION_STATUS.has(raw.status)) invalid(`exception.${raw.id}.status 非法`);
  if (typeof raw.createdAt !== 'string' || !Number.isFinite(Date.parse(raw.createdAt))) invalid(`exception.${raw.id}.createdAt 非法`);
  if (typeof raw.expiresAt !== 'string' || !Number.isFinite(Date.parse(raw.expiresAt))) invalid(`exception.${raw.id}.expiresAt 非法`);
  return {
    id: raw.id,
    instanceId: typeof raw.instanceId === 'string' && raw.instanceId.length > 0 ? raw.instanceId : null,
    provider: raw.provider,
    model: raw.model,
    maxWorstTokens: raw.maxWorstTokens,
    maxCostMicros: raw.maxCostMicros,
    taskId: typeof raw.taskId === 'string' ? raw.taskId.slice(0, 120) : null,
    caller: typeof raw.caller === 'string' ? raw.caller.slice(0, 80) : null,
    createdAt: raw.createdAt,
    expiresAt: raw.expiresAt,
    reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 120) : '',
    status: raw.status,
    usedAt: typeof raw.usedAt === 'string' ? raw.usedAt : null,
    usedRunId: typeof raw.usedRunId === 'string' ? raw.usedRunId : null,
    actorId: typeof raw.actorId === 'string' ? raw.actorId.slice(0, 80) : null,
  };
}

/** 空日桶。 */
export function blankDay() {
  return { tokensUsed: 0, costMicrosUsed: 0, tokensReserved: 0, costMicrosReserved: 0 };
}

function readDay(raw, key) {
  if (!isPlainObject(raw)) invalid(`days.${key} 不是对象`);
  for (const field of ['tokensUsed', 'costMicrosUsed', 'tokensReserved', 'costMicrosReserved']) {
    if (!isNonNegativeInt(raw[field])) invalid(`days.${key}.${field} 必须是非负整数`);
  }
  return {
    tokensUsed: raw.tokensUsed,
    costMicrosUsed: raw.costMicrosUsed,
    tokensReserved: raw.tokensReserved,
    costMicrosReserved: raw.costMicrosReserved,
  };
}

function readUsageStrict(raw, runId) {
  if (!isPlainObject(raw)) invalid(`reservation.${runId}.usage 不是对象`);
  for (const field of ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']) {
    if (!isNonNegativeInt(raw[field])) invalid(`reservation.${runId}.usage.${field} 必须是非负整数`);
  }
  return {
    inputTokens: raw.inputTokens,
    cacheReadTokens: raw.cacheReadTokens,
    cacheWriteTokens: raw.cacheWriteTokens,
    outputTokens: raw.outputTokens,
  };
}

function readReservation(raw) {
  if (!isPlainObject(raw)) invalid('reservation 不是对象');
  if (typeof raw.runId !== 'string' || raw.runId.length === 0) invalid('reservation.runId 缺失');
  if (!RESERVATION_STATUS.has(raw.status)) invalid(`reservation.${raw.runId}.status 非法`);
  if (typeof raw.dayKey !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.dayKey)) invalid(`reservation.${raw.runId}.dayKey 非法`);
  if (!isNonNegativeInt(raw.worstTokens) || !isNonNegativeInt(raw.worstCostMicros)) {
    invalid(`reservation.${raw.runId} 的预留额度非法`);
  }
  if (typeof raw.reservedAt !== 'string' || !Number.isFinite(Date.parse(raw.reservedAt))) {
    invalid(`reservation.${raw.runId}.reservedAt 非法`);
  }
  if (raw.actualCostMicros !== null && raw.actualCostMicros !== undefined && !isNonNegativeInt(raw.actualCostMicros)) {
    invalid(`reservation.${raw.runId}.actualCostMicros 非法`);
  }
  if (raw.baseMicros !== null && raw.baseMicros !== undefined && !isNonNegativeInt(raw.baseMicros)) {
    invalid(`reservation.${raw.runId}.baseMicros 非法`);
  }
  // 0.5.1 新增：本次预留占用的当日临时补额部分。缺失时按 0 处理，
  // 保证 0.4.1/0.5.0 账本仍可读（旧账本没有临时额度）。
  if (raw.topupMicros !== null && raw.topupMicros !== undefined && !isNonNegativeInt(raw.topupMicros)) {
    invalid(`reservation.${raw.runId}.topupMicros 非法`);
  }
  // 0.5.0 新增：本次预留占用的储蓄批次。缺失时视为空数组，
  // 保证 0.4.1 账本与旧版重存后的账本仍可读（孤儿占用由 reconcileHolds 回收）。
  let savingsHolds = [];
  if (raw.savingsHolds !== undefined) {
    if (!Array.isArray(raw.savingsHolds)) invalid(`reservation.${raw.runId}.savingsHolds 不是数组`);
    for (const item of raw.savingsHolds) {
      if (!isPlainObject(item) || typeof item.lotId !== 'string' || !isPositiveInt(item.micros)) {
        invalid(`reservation.${raw.runId}.savingsHolds 条目非法`);
      }
      savingsHolds.push({ lotId: item.lotId, micros: item.micros });
    }
  }
  return {
    runId: raw.runId,
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : null,
    taskId: typeof raw.taskId === 'string' ? raw.taskId.slice(0, 120) : null,
    caller: typeof raw.caller === 'string' ? raw.caller.slice(0, 80) : null,
    dayKey: raw.dayKey,
    provider: typeof raw.provider === 'string' ? raw.provider : 'unknown',
    model: typeof raw.model === 'string' ? raw.model : 'unknown',
    worstTokens: raw.worstTokens,
    worstCostMicros: raw.worstCostMicros,
    reservedAt: raw.reservedAt,
    status: raw.status,
    settledAt: typeof raw.settledAt === 'string' ? raw.settledAt : null,
    usage: readUsageStrict(raw.usage, raw.runId),
    actualCostMicros: raw.actualCostMicros === undefined ? null : raw.actualCostMicros,
    overshoot: raw.overshoot === true,
    note: typeof raw.note === 'string' ? raw.note.slice(0, 200) : '',
    baseMicros: raw.baseMicros === undefined ? null : raw.baseMicros,
    topupMicros: raw.topupMicros === undefined ? null : raw.topupMicros,
    savingsHolds,
  };
}

function readAudit(raw) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) invalid('audit 不是数组');
  return raw
    .filter((entry) => isPlainObject(entry) && typeof entry.type === 'string')
    .slice(-200)
    .map((entry) => ({
      type: entry.type.slice(0, 48),
      at: typeof entry.at === 'string' ? entry.at : new Date(0).toISOString(),
      runId: typeof entry.runId === 'string' ? entry.runId : null,
      detail: typeof entry.detail === 'string' ? entry.detail.slice(0, 200) : '',
    }));
}

function readGuard(raw) {
  if (raw === undefined) return { blocked: false, reason: null };
  if (!isPlainObject(raw)) invalid('guard 不是对象');
  if (typeof raw.blocked !== 'boolean') invalid('guard.blocked 必须是布尔值');
  return {
    blocked: raw.blocked,
    reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 120) : null,
  };
}

/** 严格解析 v2 状态；任何字段非法都抛错（fail-closed）。 */
function parseV2(raw) {
  if (raw.schema !== SCHEMA) invalid(`不支持的账本 Schema：${raw.schema}`);
  if (raw.currency !== CURRENCY) invalid(`账本币种非法：${raw.currency}（只接受 ${CURRENCY}）`);
  const state = blankState();
  if (typeof raw.createdAt === 'string') state.createdAt = raw.createdAt;
  if (raw.createdAt !== undefined && typeof raw.createdAt !== 'string') invalid('createdAt 非法');
  if (raw.updatedAt !== undefined && raw.updatedAt !== null && typeof raw.updatedAt !== 'string') invalid('updatedAt 非法');
  if (typeof raw.updatedAt === 'string') state.updatedAt = raw.updatedAt;
  if (!isNonNegativeInt(raw.configVersion)) invalid('configVersion 必须是非负整数');
  state.configVersion = raw.configVersion;
  if (!isPlainObject(raw.days)) invalid('days 不是对象');
  for (const [key, value] of Object.entries(raw.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) invalid(`days 键非法：${key}`);
    state.days[key] = readDay(value, key);
  }
  if (!isPlainObject(raw.reservations)) invalid('reservations 不是对象');
  for (const value of Object.values(raw.reservations)) {
    const reservation = readReservation(value);
    if (state.reservations[reservation.runId] !== undefined) invalid(`重复的 runId：${reservation.runId}`);
    state.reservations[reservation.runId] = reservation;
  }
  if (raw.exceptions !== undefined) {
    if (!isPlainObject(raw.exceptions)) invalid('exceptions 不是对象');
    for (const value of Object.values(raw.exceptions)) {
      const exception = readException(value);
      if (state.exceptions[exception.id] !== undefined) invalid(`重复的 exception.id：${exception.id}`);
      state.exceptions[exception.id] = exception;
    }
  }
  if (raw.topups !== undefined) {
    if (!isPlainObject(raw.topups)) invalid('topups 不是对象');
    for (const value of Object.values(raw.topups)) {
      const topup = readTopUp(value);
      if (state.topups[topup.id] !== undefined) invalid(`重复的 topup.id：${topup.id}`);
      state.topups[topup.id] = topup;
    }
  }
  state.audit = readAudit(raw.audit);
  state.guard = readGuard(raw.guard);
  return state;
}

/**
 * 分类读取账本原文：
 * - `{kind:'empty'}`：没有文件
 * - `{kind:'v2', state}`：当前 Schema
 * - `{kind:'legacy', raw}`：v1 美元账本，禁止直接消费
 * - `{kind:'invalid', reason}`：损坏或字段非法
 */
export function parseState(raw) {
  if (raw === null || raw === undefined) return { kind: 'empty' };
  if (!isPlainObject(raw)) return { kind: 'invalid', reason: '账本不是 JSON 对象' };
  try {
    if (raw.schema === SCHEMA) return { kind: 'v2', state: parseV2(raw) };
    if (raw.schema === LEGACY_SCHEMA) return { kind: 'legacy', raw };
    return { kind: 'invalid', reason: `不支持的账本 Schema：${String(raw.schema)}` };
  } catch (error) {
    return { kind: 'invalid', reason: error?.message ?? String(error) };
  }
}

/** 旧账本是否已有消费/未结算占用（非零即视为有历史）。 */
export function legacyHasConsumption(raw) {
  if (!isPlainObject(raw)) return true;
  const days = isPlainObject(raw.days) ? Object.values(raw.days) : [];
  for (const day of days) {
    if (!isPlainObject(day)) return true;
    if ((day.tokensUsed ?? 0) > 0 || (day.costMicrosUsed ?? 0) > 0) return true;
    if ((day.tokensReserved ?? 0) > 0 || (day.costMicrosReserved ?? 0) > 0) return true;
  }
  const reservations = isPlainObject(raw.reservations) ? Object.values(raw.reservations) : [];
  return reservations.length > 0;
}

/** 兼容出口：返回 v2 状态或空状态（仅供旧调用方展示，不用于写入）。 */
export function normalizeState(raw) {
  const parsed = parseState(raw);
  return parsed.kind === 'v2' ? parsed.state : blankState();
}

/** 取某天的桶；不存在时创建。 */
export function dayOf(state, dayKey) {
  if (state.days[dayKey] === undefined) state.days[dayKey] = blankDay();
  return state.days[dayKey];
}

/** 追加审计记录（最多 200 条）。 */
export function addAudit(state, type, { at, runId = null, detail = '' } = {}) {
  state.audit.push({
    type: String(type).slice(0, 48),
    at: at ?? new Date().toISOString(),
    runId,
    detail: String(detail).slice(0, 200),
  });
  if (state.audit.length > 200) state.audit = state.audit.slice(-200);
}

/** 修剪历史日桶与已结束的预留记录。 */
export function prune(state, nowDayKey) {
  // 仍被 pending/uncertain 预留引用的日桶不能删：否则对账时 dayOf 会复活一个
  // 空的历史日桶，把历史用量记成当日新账。宁可多留几天，也不静默造账。
  const referenced = new Set(
    Object.values(state.reservations)
      .filter((reservation) => reservation.status === 'pending' || reservation.status === 'uncertain')
      .map((reservation) => reservation.dayKey),
  );
  const keys = Object.keys(state.days).sort();
  const removable = keys.filter((key) => key !== nowDayKey && !referenced.has(key));
  let overBy = keys.length - KEEP_DAYS;
  for (const key of removable) {
    if (overBy <= 0) break;
    delete state.days[key];
    overBy -= 1;
  }
  const finished = Object.values(state.reservations)
    .filter((reservation) => reservation.status !== 'pending' && reservation.status !== 'uncertain')
    .sort((a, b) => String(a.reservedAt).localeCompare(String(b.reservedAt)));
  const excess = finished.length - KEEP_FINISHED_RESERVATIONS;
  for (let index = 0; index < excess; index += 1) {
    delete state.reservations[finished[index].runId];
  }
  // 例外：保留 active 与最近记录，其余过期/已用/撤销的只保留最近 20 条。
  const exceptions = Object.values(state.exceptions ?? {}).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const kept = [];
  for (const exception of exceptions) {
    if (exception.status === 'active') { kept.push(exception); continue; }
    if (kept.filter((item) => item.status !== 'active').length >= 20) continue;
    kept.push(exception);
  }
  state.exceptions = Object.fromEntries(kept.map((item) => [item.id, item]));
}

/** 当天仍占用额度的预留（pending/uncertain）。 */
export function activeReservations(state, dayKey) {
  return Object.values(state.reservations).filter(
    (reservation) => reservation.dayKey === dayKey && (reservation.status === 'pending' || reservation.status === 'uncertain'),
  );
}

/** 汇总某天实际/预留/剩余。 */
export function daySummary(state, dayKey) {
  const day = state.days[dayKey] ?? blankDay();
  return {
    dayKey,
    tokensUsed: day.tokensUsed,
    costMicrosUsed: day.costMicrosUsed,
    tokensReserved: day.tokensReserved,
    costMicrosReserved: day.costMicrosReserved,
  };
}
