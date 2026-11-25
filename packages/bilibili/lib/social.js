import { randomBytes } from 'node:crypto';

import {
  DmError, blankDmState, normalizeDmState, normalizeMid, bindAccounts, createIntent, findIntent,
  markSending, markSent, markFailed, markUnknown, dmStatus, recoverStaleSending,
  resolveManually as resolveManuallyImpl, archiveIntents,
} from './dm.js';

export const SOCIAL_SCOPES = Object.freeze(['dm:owner']);
export const SOCIAL_CAPABILITIES = Object.freeze(['read', 'send']);
export const SOCIAL_GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// 每日私信发送条数上限。0 = 不设上限（用户 2026-11-21 决定取消）。
// 保留机制本身：显式配置仍可设 1–10000 的条数上限。
export const SOCIAL_DAILY_SEND_MAX = 0;

// 显式 0 表示“不使用固定每日条数”；默认值见上面的常量。负数/非整数拒绝，避免配置
// 解析时把 0 或空字符串悄悄恢复成默认值。
export function normalizeDailySendMax(value, fallback = SOCIAL_DAILY_SEND_MAX) {
  if (value === undefined || value === null || value === '') value = fallback;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 0 || limit > 10_000) {
    throw new SocialError('dailySendMax 必须是 0–10000 的整数；0 表示不设每日条数上限', {
      code: 'SOCIAL_DAILY_LIMIT_INVALID',
    });
  }
  return limit;
}

export class SocialError extends Error {
  constructor(message, { code = 'SOCIAL_ERROR' } = {}) {
    super(message);
    this.name = 'SocialError';
    this.code = code;
  }
}

const isUser = actor => actor?.kind === 'user' && actor?.authenticated === true;
const dayKey = at => new Date(at).toISOString().slice(0, 10);

// 旧 grant 没有 capabilities 字段，只能读；绝不能因为代码升级而自动获得发送权限。
function grantCapabilities(grant) {
  const values = Array.isArray(grant?.capabilities) ? grant.capabilities : ['read'];
  return [...new Set(values)].filter(value => SOCIAL_CAPABILITIES.includes(value));
}

function requireCapability(grant, operation) {
  if (!operation) return grant;
  if (!grantCapabilities(grant).includes(operation)) {
    const error = operation === 'send'
      ? new SocialError('当前社交授权不包含发送权限，请重新签发完整授权', { code: 'SOCIAL_SEND_NOT_GRANTED' })
      : new SocialError('当前社交授权不包含读取权限，请重新签发完整授权', { code: 'SOCIAL_READ_NOT_GRANTED' });
    throw error;
  }
  return grant;
}

function normalizeCursor(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new SocialError('分页游标格式无效，停止读取', { code: 'SOCIAL_CURSOR_INVALID' });
  }
  const text = String(value).trim();
  if (!text || text.length > 200) {
    throw new SocialError('分页游标格式无效，停止读取', { code: 'SOCIAL_CURSOR_INVALID' });
  }
  return text;
}

function publicGrant(grant) {
  return {
    id: grant.id,
    scopes: [...grant.scopes],
    capabilities: grantCapabilities(grant),
    grantedBy: 'user',
    grantedAt: new Date(grant.grantedAt).toISOString(),
    // 会话级授权没有固定到期时间：有效期由登录会话、登出与进程重启决定。
    // 对外用 null 表示“随会话”，而不是伪造一个未来的时间点。
    expiresAt: Number.isFinite(grant.expiresAt) ? new Date(grant.expiresAt).toISOString() : null,
    source: grant.source === 'login-session' ? 'login-session' : 'manual',
    dailySendMax: grant.dailySendMax,
    selfMid: grant.selfMid ?? null,
  };
}

/**
 * 受限社交权限与发送服务（fake transport 用于测试；real transport 默认关闭）。
 * 用户签发 grant token，token 只在本进程内有效，不落盘、不进模型上下文。
 * 注意：这是进程内 API 约定，不是跨插件安全沙箱；真正的边界是宿主只加载可信插件。
 * actor.kind 只用于防止误调用，不能证明调用者身份。
 */
export function createSocialService({
  transport, persist = null, beforeSend = null, now = () => Date.now(),
  ttlMs = SOCIAL_GRANT_TTL_MS, dailySendMax = SOCIAL_DAILY_SEND_MAX,
} = {}) {
  const defaultDailySendMax = normalizeDailySendMax(dailySendMax);
  let state = blankDmState();
  const grants = new Map();
  // 同一运行期内记录用过的分页游标；重复游标立即停止，避免无限翻页。
  const readCursors = new Set();
  // 进程实例标识：grant 只在签发它的 DSH 运行期内有效。grants 本身也是进程内
  // Map，重启自然清空；runId 让“同进程内另一个 service 实例”也不能冒用。
  const runId = randomBytes(9).toString('base64url');
  const save = () => { if (typeof persist === 'function') persist(state); };
  const snapshot = () => normalizeDmState(state);

  function transportStats() {
    return transport?.stats && typeof transport.stats === 'object' ? { ...transport.stats } : null;
  }

  function transportInfo() {
    if (!transport) {
      return { kind: 'unavailable', real: false, enabled: false, readEnabled: false, sendEnabled: false };
    }
    const kind = transport.kind === 'real' ? 'real' : 'fake';
    if (kind === 'real') {
      const readEnabled = transport.readEnabled === true;
      const sendEnabled = transport.sendEnabled === true;
      return { kind, real: true, enabled: readEnabled || sendEnabled, readEnabled, sendEnabled };
    }
    const enabled = transport.enabled !== false;
    return { kind, real: false, enabled, readEnabled: enabled, sendEnabled: enabled };
  }

  function requireGrant(grant) {
    if (!grant || grant.runId !== runId || !Array.isArray(grant.scopes) || !grant.scopes.includes('dm:owner')) {
      throw new SocialError('社交权限无效或已撤销', { code: 'SOCIAL_GRANT_INVALID' });
    }
    return grant;
  }

  function assertTransport(operation) {
    const info = transportInfo();
    if (info.kind === 'unavailable') {
      throw new SocialError('私信通道不可用', { code: 'SOCIAL_TRANSPORT_UNAVAILABLE' });
    }
    if (operation === 'send') {
      const blockedUntil = Number(transport?.sendBlockedUntil?.() || 0);
      if (blockedUntil > Number(now())) {
        throw new SocialError('私信发送处于平台退避期，未创建发送意图', {
          code: 'SOCIAL_SEND_BACKOFF',
        });
      }
    }
    if (info.kind !== 'real') return;
    // 读、写独立门禁：只读验证时 readEnabled=true、sendEnabled=false；发送必须
    // 在创建 intent 之前被拒绝，不能靠 grant/actor 绕过。
    if (!info.readEnabled && !info.sendEnabled) {
      throw new SocialError('真实私信通道未启用，拒绝收发', { code: 'SOCIAL_TRANSPORT_DISABLED' });
    }
    if (operation === 'send' && !info.sendEnabled) {
      throw new SocialError('真实私信发送未启用，拒绝发送', { code: 'SOCIAL_SEND_DISABLED' });
    }
    if (operation === 'read' && !info.readEnabled) {
      throw new SocialError('真实私信读取未启用，拒绝读取', { code: 'SOCIAL_READ_DISABLED' });
    }
  }

  function load(raw) {
    state = normalizeDmState(raw);
    return state;
  }

  function recover({ staleMs = 60_000 } = {}) {
    const result = recoverStaleSending(state, { now: Number(now()), staleMs });
    state = result.state;
    if (result.recovered) save();
    return { recovered: result.recovered };
  }

  function bind({ ownerMid, selfMid } = {}) {
    state = bindAccounts(state, { ownerMid, selfMid });
    save();
    return { ownerMid: state.ownerMid, selfMid: state.selfMid };
  }

  // 统一签发：手动授权与登录自动授权共用同一份 grant 结构，避免两套语义。
  function issueGrant({ scopes, capabilities, expiresAt, selfMid, dailySendMax: limit, source }) {
    const grantedAt = Number(now());
    const id = randomBytes(9).toString('base64url');
    const token = randomBytes(18).toString('base64url');
    const normalizedCapabilities = [...new Set(capabilities ?? SOCIAL_CAPABILITIES)]
      .filter(capability => SOCIAL_CAPABILITIES.includes(capability));
    const grant = {
      id,
      token,
      scopes: [...new Set(scopes)].filter(scope => SOCIAL_SCOPES.includes(scope)),
      capabilities: normalizedCapabilities,
      grantedBy: 'user',
      grantedAt,
      expiresAt,
      dailySendMax: normalizeDailySendMax(limit, defaultDailySendMax),
      day: dayKey(grantedAt),
      used: 0,
      // 与签发时的登录账号绑定；换号/注销后即使 token 未撤销也不可用。
      selfMid: normalizeMid(selfMid),
      // 只在签发它的 DSH 运行期内有效；重启后 Map 清空，runId 也阻止跨实例复用。
      runId,
      source,
    };
    if (!grant.scopes.length) throw new SocialError('没有可授予的社交权限', { code: 'SOCIAL_SCOPE_INVALID' });
    if (!grant.capabilities.length) throw new SocialError('没有可授予的社交能力', { code: 'SOCIAL_CAPABILITY_INVALID' });
    // 同一 scope 只保留一个有效授权，避免“多授权”歧义。
    for (const [key, existing] of grants) {
      if (existing.scopes.some(scope => grant.scopes.includes(scope))) grants.delete(key);
    }
    grants.set(token, grant);
    return { token, grant: publicGrant(grant) };
  }

  function mint({
    actor, selfMid = null, scopes = SOCIAL_SCOPES, capabilities = SOCIAL_CAPABILITIES,
    ttlMs: life = ttlMs, dailySendMax: limit = defaultDailySendMax,
  } = {}) {
    if (!isUser(actor)) {
      throw new SocialError('只有已认证用户可以授予社交权限', { code: 'SOCIAL_USER_REQUIRED' });
    }
    return issueGrant({
      scopes,
      capabilities,
      selfMid,
      dailySendMax: limit,
      expiresAt: Number(now()) + Math.max(60_000, Number(life) || ttlMs),
      source: 'manual',
    });
  }

  // 登录自动授权：只有登录成功后的内部流程可以调用。
  // 它不接受 actor，也不接受调用方可填的 source 字符串，因此无法被 Agent 或
  // 公开方法“传一个字符串”绕过用户校验；是否可调用由 service 的内部登录分支决定。
  // 有效期不设固定时长，随登录会话存在（登出、进程重启、紧急撤销即失效）。
  function mintFromLogin({
    selfMid, ownerMid, scopes = SOCIAL_SCOPES, capabilities = SOCIAL_CAPABILITIES,
    validate, dailySendMax: limit = defaultDailySendMax,
  } = {}) {
    const self = normalizeMid(selfMid);
    const owner = normalizeMid(ownerMid);
    if (!self || !owner) {
      throw new SocialError('登录自动授权需要已完成的用户/账号绑定', { code: 'SOCIAL_BINDING_REQUIRED' });
    }
    if (self === owner) {
      throw new SocialError('用户账号与登录账号相同，拒绝自动授权', { code: 'SOCIAL_BINDING_CONFLICT' });
    }
    // 最终同步校验：必须由调用方提供，且必须在 issueGrant 之前、无 await 地执行。
    // 没有校验器就拒绝签发，避免“漏传参数即静默失去保护”。
    if (typeof validate !== 'function') {
      throw new SocialError('登录自动授权缺少会话校验器，拒绝签发', { code: 'SOCIAL_GRANT_UNVALIDATED' });
    }
    let verdict = false;
    try {
      verdict = validate({ selfMid: self, ownerMid: owner }) === true;
    } catch {
      verdict = false;
    }
    if (!verdict) {
      throw new SocialError('登录会话已切换、登出或撤销，拒绝签发授权', { code: 'SOCIAL_GRANT_STALE' });
    }
    return issueGrant({
      scopes,
      capabilities,
      selfMid: self,
      dailySendMax: normalizeDailySendMax(limit, defaultDailySendMax),
      expiresAt: Number.POSITIVE_INFINITY,
      source: 'login-session',
    });
  }

  function revoke(token) {
    return { revoked: grants.delete(String(token || '')) };
  }

  function revokeAll() {
    const count = grants.size;
    grants.clear();
    return { revoked: count };
  }

  function listGrants() {
    const at = Number(now());
    return [...grants.values()]
      .filter(grant => grant.expiresAt > at && grant.runId === runId)
      .map(grant => ({ ...publicGrant(grant), used: grant.used, day: grant.day }));
  }

  function bindCheck(grant, selfMid) {
    if (selfMid == null) return grant;
    if (grant.selfMid == null) return grant;
    if (normalizeMid(grant.selfMid) !== normalizeMid(selfMid)) {
      throw new SocialError('社交授权与当前登录账号不一致，请撤销后重授', { code: 'SOCIAL_ACCOUNT_MISMATCH' });
    }
    return grant;
  }

  function authorize(token, scope, { selfMid = null, operation = null } = {}) {
    const grant = grants.get(String(token || ''));
    const at = Number(now());
    if (!grant || grant.runId !== runId) {
      throw new SocialError('社交权限无效或已撤销', { code: 'SOCIAL_GRANT_INVALID' });
    }
    if (grant.expiresAt <= at) {
      grants.delete(grant.id);
      throw new SocialError('社交权限已过期', { code: 'SOCIAL_GRANT_EXPIRED' });
    }
    if (!grant.scopes.includes(scope)) {
      throw new SocialError('社交权限不包含该操作', { code: 'SOCIAL_SCOPE_DENIED' });
    }
    requireCapability(grant, operation);
    return bindCheck(grant, selfMid);
  }

  function activeGrant(scope, { selfMid = null, operation = null } = {}) {
    const at = Number(now());
    const active = [...grants.values()].filter(grant =>
      grant.runId === runId && grant.expiresAt > at && grant.scopes.includes(scope));
    if (!active.length) throw new SocialError('没有有效的社交授权', { code: 'SOCIAL_GRANT_MISSING' });
    if (active.length > 1) throw new SocialError('存在多个有效社交授权，请先撤销后重授', { code: 'SOCIAL_GRANT_AMBIGUOUS' });
    requireCapability(active[0], operation);
    return bindCheck(active[0], selfMid);
  }

  async function sendWithGrant(grant, { intentId, text } = {}) {
    // 通道不可用 / 真实通道未启用时，必须在落 intent 之前拒绝。
    requireGrant(grant);
    assertTransport('send');
    const at = Number(now());
    const day = dayKey(at);
    if (grant.day !== day) { grant.day = day; grant.used = 0; }
    if (grant.dailySendMax > 0 && grant.used >= grant.dailySendMax) {
      throw new SocialError('今日社交发送次数已达上限', { code: 'SOCIAL_DAILY_LIMIT' });
    }

    const created = createIntent(state, { intentId, text, now: at });
    state = created.state;
    if (!created.created) {
      save();
      return { duplicate: true, intent: created.intent ?? created.archived ?? null };
    }

    state = markSending(state, intentId, { now: at }).state;
    grant.used += 1;
    // 发送前先落盘 sending 意图；崩溃后由 recover() 转 unknown，绝不靠内存重发。
    if (typeof beforeSend === 'function') await beforeSend(snapshot());
    let status = 'unknown';
    try {
      if (!transport || typeof transport.sendOwnerMessage !== 'function') {
        throw new SocialError('私信通道不可用', { code: 'SOCIAL_TRANSPORT_UNAVAILABLE' });
      }
      const result = await transport.sendOwnerMessage({
        receiverMid: state.ownerMid, selfMid: state.selfMid, text: created.intent.text, intentId,
      });
      if (result?.ok === true) {
        state = markSent(state, intentId, { key: result.key ?? null, now: at }).state;
        status = 'sent';
      } else if (result?.unknown === true) {
        state = markUnknown(state, intentId, { code: result.code || 'DM_UNKNOWN', now: at }).state;
      } else {
        state = markFailed(state, intentId, { code: result?.code || 'DM_SEND_FAILED', now: at }).state;
        status = 'failed';
      }
    } catch (error) {
      // 只有平台明确拒绝（definitive）才 failed；超时/网络/未知一律保持 unknown。
      const definitive = error?.definitive === true;
      if (definitive) {
        state = markFailed(state, intentId, { code: error?.code || 'DM_SEND_FAILED', now: at }).state;
        status = 'failed';
      } else {
        state = markUnknown(state, intentId, { code: error?.code || 'DM_TIMEOUT', now: at }).state;
      }
    }
    save();
    return { duplicate: false, status, intent: findIntent(state, intentId) };
  }

  async function sendOwnerMessage({ token, intentId, text, selfMid = null } = {}) {
    return sendWithGrant(authorize(token, 'dm:owner', { selfMid, operation: 'send' }), { intentId, text });
  }

  async function sendAsGranted({ intentId, text, selfMid = null } = {}) {
    return sendWithGrant(activeGrant('dm:owner', { selfMid, operation: 'send' }), { intentId, text });
  }

  async function receiveWithGrant(grant, { cursor = null, size = 20 } = {}) {
    requireGrant(grant);
    assertTransport('read');
    if (typeof transport.fetchOwnerMessages !== 'function') {
      throw new SocialError('私信通道不可用', { code: 'SOCIAL_TRANSPORT_UNAVAILABLE' });
    }
    const ownerMid = normalizeMid(state.ownerMid);
    if (!ownerMid) {
      throw new SocialError('请先绑定 ownerMid，才能接收私信', { code: 'SOCIAL_BINDING_REQUIRED' });
    }
    const pageCursor = normalizeCursor(cursor);
    if (pageCursor) {
      if (readCursors.has(pageCursor)) {
        throw new SocialError('分页游标重复，停止读取', { code: 'SOCIAL_CURSOR_REPEATED' });
      }
      readCursors.add(pageCursor);
    }
    const result = await transport.fetchOwnerMessages({
      talkerMid: ownerMid, cursor: pageCursor, size: Math.max(1, Math.min(20, Number(size) || 20)),
    });
    if (!result || !Array.isArray(result.messages)) {
      throw new SocialError('私信读取响应无效，停止读取', { code: 'SOCIAL_READ_INVALID' });
    }
    const nextCursor = normalizeCursor(result?.cursor);
    if (nextCursor && nextCursor === pageCursor) {
      throw new SocialError('分页游标未前进，停止读取', { code: 'SOCIAL_CURSOR_REPEATED' });
    }
    // 单页上限：客户端最多处理前 20 条，不自动翻页补足。
    // truncated 只在“服务端确实多给了”时才为 true；“刚好 20 条”不算截断。
    const pageMessages = result.messages.slice(0, 20);
    const truncated = result.messages.length > 20;
    const selfMid = normalizeMid(grant?.selfMid) || normalizeMid(state.selfMid);
    const received = { owner: 0, self: 0, other: 0, unknown: 0 };
    const messages = [];
    for (const message of pageMessages) {
      const from = normalizeMid(message?.from);
      if (!from) {
        received.unknown += 1;
        continue;
      }
      if (from === ownerMid) {
        received.owner += 1;
        messages.push({
          key: String(message?.key ?? '').slice(0, 80),
          from,
          at: Number(message?.at) || 0,
          text: String(message?.text ?? '').slice(0, 2000),
        });
        continue;
      }
      // 非用户消息只计数，不保留正文；self 与 other 分开统计，避免把“自己”
      // 或无法解析的发送者笼统称为“陌生人”。
      if (selfMid && from === selfMid) received.self += 1;
      else received.other += 1;
    }
    // cursor 必须用 transport 的原始分页游标，不能按过滤后的最后一条用户消息重算，
    // 否则中间夹着陌生人的分页会跳过更早的用户消息。
    return {
      messages,
      cursor: nextCursor,
      ignored: received.self + received.other + received.unknown,
      received,
      scan: {
        scanned: pageMessages.length,
        ownerMatched: received.owner,
        strangersFiltered: received.other,
        truncated,
        scope: truncated ? 'first-page-truncated' : 'first-page',
      },
    };
  }

  async function receiveOwnerMessages({ token, cursor = null, size = 20, selfMid = null } = {}) {
    return receiveWithGrant(authorize(token, 'dm:owner', { selfMid, operation: 'read' }), { cursor, size });
  }

  async function receiveAsGranted({ cursor = null, size = 20, selfMid = null } = {}) {
    return receiveWithGrant(activeGrant('dm:owner', { selfMid, operation: 'read' }), { cursor, size });
  }

  function resolveManually(intentId, { status, actor, reason = '' } = {}) {
    const result = resolveManuallyImpl(state, intentId, { status, actor, reason, now: Number(now()) });
    state = result.state;
    save();
    return { intent: result.intent };
  }

  function archive({ before = Number(now()) } = {}) {
    const result = archiveIntents(state, { before, now: Number(now()) });
    state = result.state;
    save();
    return { archived: result.archived };
  }

  return {
    load, bind, mint, mintFromLogin, revoke, revokeAll, listGrants, sendOwnerMessage, sendAsGranted,
    receiveOwnerMessages, receiveAsGranted, resolveManually, archive,
    recover, snapshot, transportInfo, transportStats, status: () => dmStatus(state),
  };
}
