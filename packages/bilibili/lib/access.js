import { randomUUID } from 'node:crypto';

export const SCOPES = Object.freeze({
  content: 'content:popular',
  login: 'login',
});
const KNOWN = new Set(Object.values(SCOPES));

export class AccessError extends Error {
  constructor(message, { code = 'ACCESS_REQUEST_REQUIRED', requestId = null } = {}) {
    super(message);
    this.name = 'AccessError';
    this.code = code;
    this.requestId = requestId;
  }
}

const clipped = (value, max) => String(value ?? '').trim().slice(0, max);

/**
 * 运行会话级许可：runId 每次插件启动重新生成，许可只保存在内存，
 * 从不从 state.json 恢复；进程重启/崩溃后旧许可不可能生效。
 * 持久化的只有审计历史（不含凭据、不含可复用许可）。
 */
export function createAccess({
  now = () => Date.now(),
  runId = randomUUID(),
  store = null,
  requestTtlMs = 24 * 3600 * 1000,
  maxRequests = 50,
} = {}) {
  let permission = null;
  const requests = [];
  let suppressed = null;
  let readyPromise = null;

  /**
   * 用户的“以后不要再申请，直到我解除”属于持续指令，需要跨进程读取；
   * 未知状态时保持 unknown，入口层按失败安全处理（不自动创建申请）。
   */
  function ready() {
    if (readyPromise) return readyPromise;
    if (!store?.readState) { suppressed = false; readyPromise = Promise.resolve(); return readyPromise; }
    readyPromise = (async () => {
      try {
        const state = await store.readState();
        suppressed = Boolean(state?.account?.preference?.requestsDisabled);
      } catch { suppressed = true; } // 读不到状态时不冒险新建申请
    })();
    return readyPromise;
  }

  function requestsSuppressed() { return suppressed === true; }

  async function record(type, extra = {}) {
    if (!store?.updateState) return;
    await store.updateState(state => {
      state.account ??= { mid: null, name: null, at: null, lastLoginAt: null, history: [] };
      state.account.history.push({ type, runId, at: new Date(now()).toISOString(), ...extra });
      state.account.history = state.account.history.slice(-100);
    });
  }

  const prune = () => {
    const cutoff = now() - requestTtlMs;
    for (const item of requests) {
      if (item.status === 'pending' && item.createdAt < cutoff) item.status = 'expired';
    }
    while (requests.length > maxRequests) {
      const idx = requests.findIndex(item => item.status !== 'pending');
      requests.splice(idx >= 0 ? idx : 0, 1);
    }
  };

  const publicRequest = item => ({
    id: item.id, scopes: [...item.scopes], reason: item.reason, needLogin: item.needLogin,
    status: item.status, createdAt: new Date(item.createdAt).toISOString(),
    expiresAt: new Date(item.expiresAt).toISOString(),
    ...(item.decidedAt ? { decidedAt: new Date(item.decidedAt).toISOString() } : {}),
  });

  function granted(scopes) {
    return permission !== null
      && permission.runId === runId
      && scopes.every(scope => permission.scopes.includes(scope));
  }

  function requestAccess({ scopes = [SCOPES.content], reason = '', needLogin = false } = {}) {
    const wanted = [...new Set((Array.isArray(scopes) ? scopes : [scopes]).map(String))];
    if (!wanted.length || wanted.some(scope => !KNOWN.has(scope))) throw new AccessError('未知的访问范围', { code: 'INVALID_SCOPE' });
    prune();
    // 同范围、同登录要求的待处理申请直接复用：重复 tick / 崩溃恢复不得重复投递。
    const duplicate = requests.find(item => item.status === 'pending'
      && item.needLogin === needLogin
      && item.scopes.length === wanted.length
      && wanted.every(scope => item.scopes.includes(scope)));
    if (duplicate) return publicRequest(duplicate);
    const item = {
      id: `req-${randomUUID().slice(0, 8)}`,
      scopes: wanted, reason: clipped(reason, 300), needLogin: needLogin === true,
      status: 'pending', createdAt: now(), expiresAt: now() + requestTtlMs,
    };
    requests.push(item);
    prune();
    void record('access-requested', { requestId: item.id, scopes: wanted }).catch(() => {});
    return publicRequest(item);
  }

  function findPending(requestId) {
    prune();
    const item = requests.find(row => row.id === requestId);
    if (!item) throw new AccessError('找不到这条访问申请', { code: 'REQUEST_NOT_FOUND' });
    if (item.status === 'pending' && item.createdAt <= now() - requestTtlMs) item.status = 'expired';
    return item;
  }

  function assertUser(actor) {
    if (!actor || actor.kind !== 'user' || actor.authenticated !== true) {
      throw new AccessError('只有通过身份验证的用户才能批准或撤销访问', { code: 'APPROVAL_REQUIRED' });
    }
    if (actor.sessionId && actor.sessionId !== runId) {
      throw new AccessError('批准来自其他运行会话，不能用于当前会话', { code: 'SESSION_MISMATCH' });
    }
  }

  async function approve({ requestId, actor } = {}) {
    assertUser(actor);
    const item = findPending(requestId);
    if (item.status !== 'pending') throw new AccessError(`该申请已结束（${item.status}）`, { code: 'REQUEST_NOT_PENDING', requestId: item.id });
    item.status = 'approved';
    item.decidedAt = now();
    permission = {
      runId, scopes: [...item.scopes], requestId: item.id,
      approvedAt: now(), needLogin: item.needLogin,
    };
    await record('access-approved', { requestId: item.id, scopes: item.scopes });
    return publicRequest(item);
  }

  async function deny({ requestId, actor, reason = '' } = {}) {
    assertUser(actor);
    const item = findPending(requestId);
    if (item.status !== 'pending') throw new AccessError(`该申请已结束（${item.status}）`, { code: 'REQUEST_NOT_PENDING', requestId: item.id });
    item.status = 'denied';
    item.decidedAt = now();
    await record('access-denied', { requestId: item.id, scopes: item.scopes, reason: clipped(reason, 100) });
    return publicRequest(item);
  }

  /**
   * 登录成功后的直接授权：扫码属于用户主动动作，不再额外走 pending/approve。
   * 只允许已认证用户；授权仅存在当前运行内存，重启即失效。
   */
  async function grant({ scopes = [SCOPES.content], actor, reason = '' } = {}) {
    assertUser(actor);
    const wanted = [...new Set((Array.isArray(scopes) ? scopes : [scopes]).map(String))];
    if (!wanted.length || wanted.some(scope => !KNOWN.has(scope))) {
      throw new AccessError('未知的访问范围', { code: 'INVALID_SCOPE' });
    }
    permission = {
      runId, scopes: wanted, requestId: null,
      approvedAt: now(), needLogin: false, source: 'login',
    };
    await record('access-granted', { scopes: wanted, reason: clipped(reason, 120) });
    return { scopes: wanted, grantedAt: new Date(permission.approvedAt).toISOString() };
  }

  async function revoke() {
    if (!permission) return { revoked: false };
    const requestId = permission.requestId;
    permission = null;
    const item = requestId ? requests.find(row => row.id === requestId) : null;
    if (item && item.status === 'approved') item.status = 'revoked';
    await record('access-revoked', { requestId, reason: requestId ? '' : 'logout' });
    return { revoked: true, requestId };
  }

  function requireAccess(scopes, { reason = '', needLogin = false } = {}) {
    const wanted = Array.isArray(scopes) ? scopes : [scopes];
    if (granted(wanted)) return;
    const item = requestAccess({ scopes: wanted, reason, needLogin });
    throw new AccessError('需要用户批准本次自主访问', { requestId: item.id });
  }

  function snapshot() {
    prune();
    return {
      granted: permission === null ? null : {
        scopes: [...permission.scopes], requestId: permission.requestId,
        approvedAt: new Date(permission.approvedAt).toISOString(),
      },
      pending: requests.filter(item => item.status === 'pending').map(publicRequest),
      requestsDisabled: suppressed === true,
    };
  }

  async function persistPreference(requestsDisabled, reason) {
    if (!store?.updateState) return;
    await store.updateState(state => {
      state.account ??= { mid: null, name: null, at: null, lastLoginAt: null, history: [] };
      state.account.preference = {
        requestsDisabled,
        reason: clipped(reason, 200),
        at: new Date(now()).toISOString(),
        runId,
      };
    });
  }

  async function suppressRequests({ actor, reason = '' } = {}) {
    assertUser(actor);
    await ready();
    suppressed = true;
    await persistPreference(true, reason);
    await record('requests-suppressed', { reason: clipped(reason, 100) });
    return { requestsDisabled: true };
  }

  async function resumeRequests({ actor } = {}) {
    assertUser(actor);
    await ready();
    suppressed = false;
    await persistPreference(false, '');
    await record('requests-resumed', {});
    return { requestsDisabled: false };
  }

  function dispose() {
    const requestId = permission?.requestId ?? null;
    permission = null;
    if (requestId) void record('access-revoked', { requestId, reason: 'session-end' }).catch(() => {});
    for (const item of requests) {
      if (item.status === 'pending') item.status = 'expired';
    }
  }

  return {
    runId, requestAccess, approve, deny, revoke, grant, requireAccess, snapshot, granted, dispose,
    ready, requestsSuppressed, suppressRequests, resumeRequests,
  };
}
