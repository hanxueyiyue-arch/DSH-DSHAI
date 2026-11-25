export const DM_TEXT_MAX = 300;
export const DM_STATES = Object.freeze(['pending', 'sending', 'sent', 'unknown', 'failed']);
export const DM_LIMITS = Object.freeze({
  intents: 100,
  intentId: 80,
  // 不自动淘汰墓碑：容量满时拒绝新建 intent，避免旧 intentId 被复用后再次发送。
  tombstones: 2000,
  // 仅告警，不淘汰；墓碑满时 createIntent 仍 fail-closed。
  tombstoneWarn: 1600,
  archive: 200,
  audit: 100,
});

export class DmError extends Error {
  constructor(message, { code = 'DM_ERROR' } = {}) {
    super(message);
    this.name = 'DmError';
    this.code = code;
  }
}

const clean = (value, max) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
export function normalizeMid(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,24}$/.test(text)) return null;
  // B 站 UID 是十进制数字；数字/字符串/前导零统一成同一个十进制字符串。
  // 不做模糊匹配，避免把两个不同 UID 误判为同一人。
  return text.replace(/^0+(?=\d)/, '');
}
const mid = value => normalizeMid(value);
const iso = value => {
  const at = Number(value);
  return new Date(Number.isFinite(at) && at > 0 ? at : Date.now()).toISOString();
};
const isUser = actor => actor?.kind === 'user' && actor?.authenticated === true;

export function blankDmState() {
  return {
    version: 2,
    // ownerMid：用户本人绑定的 B 站 UID（收件人）
    ownerMid: null,
    // selfMid：助手登录账号的 UID（发件人）
    selfMid: null,
    intents: [],
    // 归档后仍保留的 intentId 幂等墓碑；归档不得让重复请求重新发送。
    tombstones: [],
    // 已归档的发送结果摘要，不含正文，不改变实际发送状态。
    archive: [],
    audit: [],
    lastCheckAt: null,
    pausedUntil: 0,
  };
}

function normalizeIntent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const intentId = clean(raw.intentId, DM_LIMITS.intentId);
  const text = String(raw.text ?? '').trim().slice(0, DM_TEXT_MAX);
  const receiver = mid(raw.receiver);
  const sender = mid(raw.sender);
  if (!intentId || !text || !receiver || !sender) return null;
  const status = DM_STATES.includes(raw.status) ? raw.status : 'pending';
  const resolution = raw.resolution && typeof raw.resolution === 'object' && isUser(raw.resolution.by)
    ? {
      by: { kind: 'user', authenticated: true, id: raw.resolution.by.id ? clean(raw.resolution.by.id, 40) : null },
      at: raw.resolution.at ? clean(raw.resolution.at, 40) : null,
      reason: raw.resolution.reason ? clean(raw.resolution.reason, 200) : '',
      from: raw.resolution.from ? clean(raw.resolution.from, 20) : null,
      to: raw.resolution.to ? clean(raw.resolution.to, 20) : null,
    }
    : null;
  return {
    intentId,
    text,
    receiver,
    sender,
    status,
    key: raw.key ? clean(raw.key, 80) : null,
    code: raw.code ? clean(raw.code, 60) : null,
    // platform = 平台返回/核实；manual = 用户人工处置；两者不得混淆。
    confirmedBy: ['platform', 'manual'].includes(raw.confirmedBy) ? raw.confirmedBy : null,
    verifyAttempts: Number.isFinite(Number(raw.verifyAttempts)) ? Math.max(0, Math.floor(Number(raw.verifyAttempts))) : 0,
    lastCheckedAt: raw.lastCheckedAt ? clean(raw.lastCheckedAt, 40) : null,
    resolution,
    createdAt: raw.createdAt ?? null,
    updatedAt: raw.updatedAt ?? null,
  };
}

function normalizeArchiveRow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const intentId = clean(raw.intentId, DM_LIMITS.intentId);
  if (!intentId) return null;
  return {
    intentId,
    status: DM_STATES.includes(raw.status) ? raw.status : 'unknown',
    code: raw.code ? clean(raw.code, 60) : null,
    createdAt: raw.createdAt ?? null,
    archivedAt: raw.archivedAt ?? null,
    resolution: raw.resolution ?? null,
  };
}

export function normalizeDmState(raw) {
  if (!raw || typeof raw !== 'object') return blankDmState();
  const state = blankDmState();
  state.ownerMid = mid(raw.ownerMid);
  state.selfMid = mid(raw.selfMid);
  state.lastCheckAt = typeof raw.lastCheckAt === 'string' ? clean(raw.lastCheckAt, 40) : null;
  state.pausedUntil = Number.isFinite(Number(raw.pausedUntil)) ? Math.max(0, Number(raw.pausedUntil)) : 0;
  const seen = new Set();
  state.intents = (Array.isArray(raw.intents) ? raw.intents : [])
    .map(normalizeIntent)
    .filter(intent => intent && !seen.has(intent.intentId) && seen.add(intent.intentId))
    .slice(-DM_LIMITS.intents);
  const tombstones = new Set();
  for (const id of Array.isArray(raw.tombstones) ? raw.tombstones : []) {
    const value = clean(id, DM_LIMITS.intentId);
    if (value) tombstones.add(value);
  }
  for (const intent of state.intents) tombstones.delete(intent.intentId);
  state.tombstones = [...tombstones];
  state.archive = (Array.isArray(raw.archive) ? raw.archive : [])
    .map(normalizeArchiveRow)
    .filter(Boolean)
    .slice(-DM_LIMITS.archive);
  state.audit = (Array.isArray(raw.audit) ? raw.audit : [])
    .filter(row => row && typeof row === 'object' && row.at && row.action)
    .map(row => ({
      at: clean(row.at, 40),
      action: clean(row.action, 40),
      intentId: row.intentId ? clean(row.intentId, DM_LIMITS.intentId) : null,
      actor: row.actor ? clean(row.actor, 40) : null,
      reason: row.reason ? clean(row.reason, 200) : '',
    }))
    .slice(-DM_LIMITS.audit);
  return state;
}

function pushAudit(state, { at, action, intentId = null, actor = null, reason = '' }) {
  state.audit = [...state.audit, {
    at, action, intentId, actor: actor ? String(actor).slice(0, 40) : null,
    reason: String(reason || '').slice(0, 200),
  }].slice(-DM_LIMITS.audit);
}

export function bindAccounts(rawState, { ownerMid, selfMid } = {}) {
  const state = normalizeDmState(rawState);
  const owner = mid(ownerMid);
  const self = mid(selfMid);
  if (!owner) throw new DmError('ownerMid 必须是用户绑定的 B 站 UID', { code: 'DM_OWNER_REQUIRED' });
  if (!self) throw new DmError('selfMid 必须是登录账号 UID', { code: 'DM_SELF_REQUIRED' });
  state.ownerMid = owner;
  state.selfMid = self;
  return state;
}

export function findIntent(state, intentId) {
  return state.intents.find(intent => intent.intentId === intentId) ?? null;
}

/**
 * 创建发送意图。
 * ownerMid（用户）是收件人，selfMid（登录账号）是发件人；两者相同则拒绝，平台不允许给自己发私信。
 * 归档后的 intentId 仍保留墓碑：重复请求只会返回 created:false，绝不重新发送。
 */
export function createIntent(rawState, { intentId, text, now = Date.now() } = {}) {
  const state = normalizeDmState(rawState);
  const id = clean(intentId, DM_LIMITS.intentId);
  if (!id) throw new DmError('intentId 不能为空', { code: 'DM_INTENT_REQUIRED' });
  if (!state.ownerMid || !state.selfMid) throw new DmError('尚未绑定 ownerMid / selfMid', { code: 'DM_BINDING_REQUIRED' });
  if (state.ownerMid === state.selfMid) throw new DmError('ownerMid 不能与登录账号 selfMid 相同', { code: 'DM_SELF_TARGET' });
  const body = String(text ?? '').trim();
  if (!body) throw new DmError('私信正文不能为空', { code: 'DM_TEXT_REQUIRED' });
  if (body.length > DM_TEXT_MAX) throw new DmError(`私信正文不能超过 ${DM_TEXT_MAX} 字`, { code: 'DM_TEXT_TOO_LONG' });
  const existing = findIntent(state, id);
  if (existing) {
    if (existing.text !== body) {
      throw new DmError('同一 intentId 的正文不一致，拒绝冲突请求', { code: 'DM_INTENT_CONFLICT' });
    }
    return { state, intent: existing, created: false };
  }
  if (state.tombstones.includes(id)) {
    const archived = state.archive.find(row => row.intentId === id) ?? null;
    return { state, intent: null, archived, created: false, duplicate: true };
  }
  const at = iso(now);
  const intent = {
    intentId: id, text: body, receiver: state.ownerMid, sender: state.selfMid,
    status: 'pending', key: null, code: null, confirmedBy: null, verifyAttempts: 0,
    lastCheckedAt: null, resolution: null, createdAt: at, updatedAt: at,
  };
  if (state.tombstones.length >= DM_LIMITS.tombstones) {
    throw new DmError('私信幂等墓碑已满，拒绝新建发送意图（不自动淘汰以免重复发送）', { code: 'DM_TOMBSTONE_FULL' });
  }
  state.intents = [...state.intents, intent].slice(-DM_LIMITS.intents);
  return { state, intent, created: true };
}

function transition(rawState, intentId, allowed, next, patch = {}, now, audit = null) {
  const state = normalizeDmState(rawState);
  const intent = findIntent(state, intentId);
  if (!intent) throw new DmError('找不到发送意图', { code: 'DM_INTENT_NOT_FOUND' });
  if (!allowed.includes(intent.status)) {
    throw new DmError(`不能从 ${intent.status} 转为 ${next}`, { code: 'DM_STATE_INVALID' });
  }
  const at = iso(now);
  state.intents = state.intents.map(row => row.intentId === intentId
    ? { ...row, ...patch, status: next, updatedAt: at }
    : row);
  if (audit) pushAudit(state, { at, ...audit, intentId });
  return { state, intent: findIntent(state, intentId) };
}

export function markSending(rawState, intentId, { now = Date.now() } = {}) {
  return transition(rawState, intentId, ['pending'], 'sending', {}, now, { action: 'dm-sending' });
}

export function markSent(rawState, intentId, { key = null, now = Date.now(), actor = 'platform' } = {}) {
  return transition(rawState, intentId, ['sending', 'unknown'], 'sent', {
    key: key ? clean(key, 80) : null, code: null, confirmedBy: 'platform', lastCheckedAt: iso(now),
  }, now, { action: 'dm-sent', actor });
}

/** 仅平台明确拒绝等可靠失败证据才可调用；超时/查不到不能走这里。 */
export function markFailed(rawState, intentId, { code = 'DM_SEND_FAILED', now = Date.now(), actor = 'platform' } = {}) {
  return transition(rawState, intentId, ['pending', 'sending', 'unknown'], 'failed', {
    code: clean(code, 60), confirmedBy: 'platform', lastCheckedAt: iso(now),
  }, now, { action: 'dm-failed', actor, reason: code });
}

export function markUnknown(rawState, intentId, { code = 'DM_TIMEOUT', now = Date.now() } = {}) {
  return transition(rawState, intentId, ['sending'], 'unknown', {
    code: clean(code, 60), lastCheckedAt: iso(now),
  }, now, { action: 'dm-unknown', reason: code });
}

/**
 * 重启恢复：崩溃/退出时停在 sending 的意图无法确认结果，超过 staleMs 一律转 unknown，
 * 不转 failed、不重发。近期 sending 保留，交给后续核实逻辑。
 */
export function recoverStaleSending(rawState, { now = Date.now(), staleMs = 60_000 } = {}) {
  let state = normalizeDmState(rawState);
  const stale = state.intents.filter(intent => intent.status === 'sending'
    && Date.parse(intent.updatedAt || 0) <= Number(now) - Math.max(1_000, Number(staleMs) || 60_000));
  for (const intent of stale) {
    state = transition(state, intent.intentId, ['sending'], 'unknown', {
      code: 'DM_RESTART_UNKNOWN', lastCheckedAt: iso(now),
    }, now, { action: 'dm-recover-unknown', reason: 'restart' }).state;
  }
  return { state, recovered: stale.length };
}

/**
 * 结果未知时核实：found=true 才转 sent。
 * 查不到、查询延迟、超时都只是“尚未确认”，无法作为失败证据，必须保持 unknown；
 * 绝不在这里转 failed，也绝不自动重发。人工处置走 resolveManually。
 */
export function resolveUnknown(rawState, intentId, { found = false, foundKey = null, now = Date.now() } = {}) {
  const state = normalizeDmState(rawState);
  const intent = findIntent(state, intentId);
  if (!intent) throw new DmError('找不到发送意图', { code: 'DM_INTENT_NOT_FOUND' });
  if (intent.status !== 'unknown') throw new DmError('只有 unknown 状态需要核实', { code: 'DM_STATE_INVALID' });
  if (found) return markSent(state, intentId, { key: foundKey, now, actor: 'verify' });
  return transition(state, intentId, ['unknown'], 'unknown', {
    verifyAttempts: intent.verifyAttempts + 1,
    lastCheckedAt: iso(now),
  }, now, { action: 'dm-verify-miss', reason: 'not-found-is-not-failure' });
}

/**
 * 人工处置：必须由已认证用户显式决定，与平台发送结果分开记录。
 * 只能处理 unknown；不允许借此把 pending/sending 直接改成 sent。
 */
export function resolveManually(rawState, intentId, { status, actor, reason = '', now = Date.now() } = {}) {
  if (!isUser(actor)) throw new DmError('人工处置只允许已认证用户', { code: 'DM_USER_REQUIRED' });
  if (status !== 'sent' && status !== 'failed') throw new DmError('人工处置只能标记 sent 或 failed', { code: 'DM_STATUS_INVALID' });
  const state = normalizeDmState(rawState);
  const intent = findIntent(state, intentId);
  if (!intent) throw new DmError('找不到发送意图', { code: 'DM_INTENT_NOT_FOUND' });
  if (intent.status !== 'unknown') throw new DmError('只有 unknown 可由人工处置', { code: 'DM_STATE_INVALID' });
  const at = iso(now);
  const resolution = {
    by: { kind: 'user', authenticated: true, id: actor.id ? String(actor.id).slice(0, 40) : null },
    at, reason: String(reason || '').slice(0, 200), from: 'unknown', to: status,
  };
  const patch = {
    resolution,
    confirmedBy: 'manual',
    code: status === 'failed' ? 'DM_MANUAL_FAILED' : null,
    lastCheckedAt: at,
  };
  state.intents = state.intents.map(row => row.intentId === intentId
    ? { ...row, ...patch, status, updatedAt: at }
    : row);
  pushAudit(state, { at, action: 'dm-manual-resolve', intentId, actor: actor.id || 'user', reason: `人工处置 ${status} ${reason}`.trim() });
  return { state, intent: findIntent(state, intentId) };
}

/**
 * 归档已终态（sent/failed）的旧意图：只移除正文，status 不变；
 * intentId 进入墓碑，重复请求仍会被识别。unknown 永不自动归档。
 */
export function archiveIntents(rawState, { before = Date.now(), now = Date.now() } = {}) {
  const state = normalizeDmState(rawState);
  const cutoff = Number.isFinite(Number(before)) ? Number(before) : Date.now();
  const at = iso(now);
  const keep = [];
  const moved = [];
  for (const intent of state.intents) {
    const terminal = intent.status === 'sent' || intent.status === 'failed';
    const stale = intent.updatedAt ? Date.parse(intent.updatedAt) <= cutoff : false;
    if (terminal && stale) {
      moved.push({
        intentId: intent.intentId, status: intent.status, code: intent.code,
        createdAt: intent.createdAt, archivedAt: at, resolution: intent.resolution ?? null,
      });
      state.tombstones = [...state.tombstones, intent.intentId].slice(-DM_LIMITS.tombstones);
    } else {
      keep.push(intent);
    }
  }
  state.intents = keep;
  state.archive = [...state.archive, ...moved].slice(-DM_LIMITS.archive);
  if (moved.length) pushAudit(state, { at, action: 'dm-archive', reason: `${moved.length} terminal intents` });
  return { state, archived: moved.length };
}

export function dmStatus(rawState) {
  const state = normalizeDmState(rawState);
  const counts = Object.fromEntries(DM_STATES.map(status => [status, 0]));
  for (const intent of state.intents) counts[intent.status] += 1;
  return {
    ownerMid: state.ownerMid,
    selfMid: state.selfMid,
    lastCheckAt: state.lastCheckAt,
    pausedUntil: state.pausedUntil,
    counts,
    total: state.intents.length,
    archived: state.archive.length,
    tombstones: state.tombstones.length,
    tombstoneCapacity: {
      used: state.tombstones.length,
      max: DM_LIMITS.tombstones,
      warnAt: DM_LIMITS.tombstoneWarn,
      warning: state.tombstones.length >= DM_LIMITS.tombstoneWarn,
    },
    unknown: state.intents
      .filter(intent => intent.status === 'unknown')
      .map(intent => ({
        intentId: intent.intentId, verifyAttempts: intent.verifyAttempts, lastCheckedAt: intent.lastCheckedAt,
      })),
  };
}
