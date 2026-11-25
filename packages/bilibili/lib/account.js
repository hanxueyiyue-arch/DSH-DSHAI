import { randomUUID } from 'node:crypto';
import { AccessError, SCOPES, createAccess } from './access.js';
import { createLogin, LoginError } from './login.js';
import { createCredentialVault } from './vault.js';

export { AccessError, LoginError, SCOPES };

/**
 * Bilibili 账号/许可编排：登录状态（凭证）与自主浏览许可（运行会话）分离。
 * Step 4 起凭证只存在于当前进程内存；重启后不读取旧 credentials.bin，也不恢复上次账号。
 * 本模块任何返回值都不包含 Cookie / Token。
 */
export function createAccount({
  client, store, vaultFile,
  now = () => Date.now(),
  fetchImpl = globalThis.fetch,
  runId = randomUUID(),
  vault = null, access = null, login = null, loginOptions = {},
} = {}) {
  const creds = vault ?? createCredentialVault({ now });
  const accessApi = access ?? createAccess({ now, runId, store });
  let account = null;

  async function persistLogin(next) {
    account = { mid: String(next.mid), name: next.name ?? null };
    // 扫码即授权：登录成功自动开放本次运行的只读浏览，不再另走审批。
    await accessApi.grant({
      scopes: [SCOPES.content],
      actor: { kind: 'user', authenticated: true },
      reason: '扫码登录成功，自动授予本次运行只读浏览',
    });
    if (!store?.updateState) return;
    await store.updateState(state => {
      state.account ??= { mid: null, name: null, at: null, lastLoginAt: null, history: [] };
      state.account.mid = account.mid;
      state.account.name = account.name;
      state.account.lastLoginAt = new Date(now()).toISOString();
      state.account.history.push({
        type: 'login-success', runId, at: state.account.lastLoginAt, mid: account.mid,
      });
      state.account.history = state.account.history.slice(-100);
    });
  }

  const loginApi = login ?? createLogin({
    vault: creds, verify: credentials => client.nav(credentials), fetchImpl, now,
    ...loginOptions, onAccount: persistLogin,
  });

  async function accessState() {
    // 只读当前进程内存；旧 state.account 仅作为历史审计，不作为登录态恢复来源。
    const hasCredentials = creds.hasCached() === true;
    await accessApi.ready();
    const snap = accessApi.snapshot();
    const rawLogin = loginApi.status();
    // 登出后 login 状态机停在 success；没有凭证时不再对外报告“登录成功”。
    const login = !hasCredentials && rawLogin?.status === 'success'
      ? { status: 'idle' }
      : rawLogin;
    return {
      granted: snap.granted,
      pending: snap.pending,
      requestsDisabled: snap.requestsDisabled,
      login,
      hasCredentials,
      hasBuvid3: Boolean(typeof creds.cached === 'function' ? creds.cached()?.buvid3 : null),
      account,
    };
  }

  async function requestAccess({ scopes = [SCOPES.content], reason = '', needLogin = false } = {}) {
    await accessApi.ready();
    if (accessApi.requestsSuppressed()) {
      throw new AccessError('用户已要求暂停新的浏览申请，直到用户解除。', { code: 'ACCESS_REQUEST_SUPPRESSED' });
    }
    return accessApi.requestAccess({ scopes, reason, needLogin });
  }

  async function approveAccess({ requestId, actor, note = '' } = {}) {
    return accessApi.approve({ requestId, actor });
  }

  async function denyAccess({ requestId, actor, reason = '' } = {}) {
    return accessApi.deny({ requestId, actor, reason });
  }

  async function revokeAccess() {
    return accessApi.revoke();
  }

  /**
   * 登录即授权：只允许已认证用户在设置页发起扫码；扫码成功自动授予只读浏览。
   * Agent/其他插件不能自行发起登录，也不能绕开登录直接读内容。
   */
  async function startLogin({ requestId = null, actor = null, fresh = false } = {}) {
    const trusted = actor?.kind === 'user' && actor.authenticated === true;
    if (!trusted) {
      throw new AccessError('请在设置页点击“扫码登录”；登录即授权本次运行的只读浏览。', { code: 'LOGIN_REQUIRED' });
    }
    // fresh 必须透传：退出登录后旧会话仍是 success 终态，不透传会复用旧会话而不生成新二维码。
    return loginApi.start({ fresh });
  }

  async function pollLogin(id) {
    return loginApi.poll(id);
  }

  function cancelLogin(id) {
    return loginApi.cancel(id);
  }

  async function logout() {
    // 撤销先于清凭证：撤销失败也必须清凭证，避免“退出登录后仍有权限”。
    loginApi.cancel();
    let revoked = false;
    try {
      revoked = (await accessApi.revoke()).revoked === true;
    } finally {
      await creds.clear();
      account = null;
    }
    if (store?.updateState) {
      await store.updateState(state => {
        state.account ??= { mid: null, name: null, at: null, lastLoginAt: null, history: [] };
        state.account.mid = null;
        state.account.name = null;
        state.account.history.push({ type: 'logout', runId, at: new Date(now()).toISOString() });
        state.account.history = state.account.history.slice(-100);
      });
    }
    return { loggedOut: true, revoked };
  }

  async function suppressRequests({ actor, reason = '' } = {}) {
    return accessApi.suppressRequests({ actor, reason });
  }

  async function resumeRequests({ actor } = {}) {
    return accessApi.resumeRequests({ actor });
  }

  async function requireContentAccess(reason = '自主浏览热门视频列表') {
    await accessApi.ready();
    if (creds.hasCached() !== true) {
      throw new AccessError('尚未登录 B 站，无法浏览内容。请先在设置页扫码登录。', { code: 'ACCESS_LOGIN_REQUIRED' });
    }
    accessApi.requireAccess([SCOPES.content], { reason });
  }

  function dispose() {
    accessApi.dispose();
    loginApi.dispose();
  }

  return {
    get runId() { return accessApi.runId; },
    accessState, requestAccess, approveAccess, denyAccess, revokeAccess,
    suppressRequests, resumeRequests,
    loginStatus: () => loginApi.status(),
    startLogin, pollLogin, cancelLogin, logout,
    requireContentAccess,
    hasContentAccess: () => accessApi.granted([SCOPES.content]),
    hasCredentials: () => creds.hasCached() === true,
    credentials: () => (typeof creds.cached === 'function' ? creds.cached() : null),
    // 只补运行期会话字段（如 buvid3），合并后仍只保存在内存。
    async updateCredentials(patch = {}) {
      const current = typeof creds.cached === 'function' ? creds.cached() : null;
      if (!current) return null;
      await creds.save({ ...current, ...patch });
      return creds.cached();
    },
    dispose,
  };
}
