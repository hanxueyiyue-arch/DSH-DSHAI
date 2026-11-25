import { randomUUID } from 'node:crypto';
import { validateCredentials } from './vault.js';

export class LoginError extends Error {}

const PASSPORT = 'https://passport.bilibili.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const ALLOWED_ORIGINS = new Set([PASSPORT, 'https://account.bilibili.com']);
const TERMINAL = new Set(['success', 'expired', 'cancelled', 'error']);

const clipped = (value, max) => String(value ?? '').trim().slice(0, max);

/** 只读二维码登录状态机；Cookie / qrcode_key 永不进入返回值或日志。 */
export function createLogin({
  vault, verify, fetchImpl = globalThis.fetch, now = () => Date.now(),
  ttlMs = 180_000, intervalMs = 2_000, onAccount = () => {},
} = {}) {
  if (!vault || typeof verify !== 'function') throw new LoginError('登录组件缺少依赖');
  let current = null;
  let nextStart = 0;
  let disposed = false;

  function cookieHeader(session) {
    if (!session?.jar?.size) return null;
    return [...session.jar].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  function absorbCookies(session, response) {
    if (!session?.jar || typeof response?.headers?.getSetCookie !== 'function') return;
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(';', 1)[0];
      const index = pair.indexOf('=');
      if (index > 0) session.jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
  }

  async function passport(url, signal, session) {
    try {
      const cookie = cookieHeader(session);
      const response = await fetchImpl(url, {
        method: 'GET', redirect: 'follow',
        signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
        headers: {
          'user-agent': UA,
          accept: 'application/json, text/plain, */*',
          referer: `${PASSPORT}/login`,
          origin: PASSPORT,
          ...(cookie ? { cookie } : {}),
        },
      });
      absorbCookies(session, response);
      if (!response.ok || !response.body) {
        const retryable = response.status === 412 || response.status === 429 || response.status >= 500;
        const error = new LoginError('B 站登录请求失败，请稍后重试。');
        error.retryable = retryable;
        error.status = response.status;
        throw error;
      }
      const length = Number(response.headers.get('content-length'));
      if (length > 128 * 1024) throw new LoginError('登录响应异常，请重试。');
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 128 * 1024) { await reader.cancel().catch(() => {}); throw new LoginError('登录响应异常，请重试。'); }
        chunks.push(Buffer.from(value));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body?.code !== 0) throw new LoginError('B 站登录请求失败，请稍后重试。');
      return { data: body.data, response };
    } catch (error) {
      if (error instanceof LoginError) throw error;
      const wrapped = new LoginError(signal?.aborted ? '登录已取消。' : 'B 站登录请求失败，请稍后重试。');
      wrapped.retryable = !signal?.aborted;
      throw wrapped;
    }
  }

  function assertCurrent(session) {
    if (disposed || current !== session || session.controller.signal.aborted) throw new LoginError('登录流程已失效，请重新扫码。');
    if (now() >= session.expiresAt) { session.status = 'expired'; throw new LoginError('二维码已过期，请重新生成。'); }
  }

  function scrub(session) {
    session.key = null;
    session.qrContent = null;
  }

  function state(session) {
    if (!session) return { status: 'idle' };
    return {
      id: session.id, status: session.status,
      expiresAt: new Date(session.expiresAt).toISOString(),
      remainingMs: Math.max(0, session.expiresAt - now()),
      ...(session.retryAt ? { retryAt: new Date(session.retryAt).toISOString() } : {}),
      ...((session.status === 'waiting' || session.status === 'scanned') && session.qrContent ? { qrContent: session.qrContent } : {}),
      ...(session.account ? { account: { mid: session.account.mid, name: session.account.name } } : {}),
      ...(session.error ? { error: session.error } : {}),
    };
  }

  function scrubAndReturn(session) {
    if (TERMINAL.has(session.status)) scrub(session);
    return state(session);
  }

  async function start({ fresh = false } = {}) {
    if (disposed) throw new LoginError('登录服务已关闭。');
    // 单会话状态规则：waiting/scanned 未过期时复用；success 不回二维码；终态不复用。
    if (!fresh && current) {
      if (current.status === 'success') return state(current);
      if ((current.status === 'waiting' || current.status === 'scanned') && now() < current.expiresAt) {
        return state(current);
      }
    }
    if (now() < nextStart) throw new LoginError('请稍等两秒后再生成二维码。');
    nextStart = now() + intervalMs;
    cancel();
    const session = {
      id: randomUUID(), status: 'waiting', controller: new AbortController(), jar: new Map(), soft: 0,
      expiresAt: now() + ttlMs, nextPoll: now() + intervalMs, key: null, qrContent: null, error: null,
      retryStartedAt: null, retryAt: null, verifyRetries: 0,
    };
    current = session;
    try {
      const { data } = await passport(`${PASSPORT}/x/passport-login/web/qrcode/generate`, session.controller.signal, session);
      assertCurrent(session);
      let url;
      try { url = new URL(data?.url); } catch { throw new LoginError('二维码响应无效，请稍后重试。'); }
      if (!ALLOWED_ORIGINS.has(url.origin) || url.username || url.password
        || typeof data?.qrcode_key !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(data.qrcode_key)) {
        throw new LoginError('二维码响应无效，请稍后重试。');
      }
      session.key = data.qrcode_key;
      session.qrContent = url.href;
      assertCurrent(session);
      return state(session);
    } catch (error) {
      session.status = session.controller.signal.aborted ? 'cancelled' : 'error';
      session.error = error instanceof LoginError ? error.message : '二维码生成失败，请重试。';
      scrub(session);
      throw error instanceof LoginError ? error : new LoginError(session.error);
    }
  }

  async function verifyWithRetry(credentials, session) {
    try {
      return await verify(credentials, { signal: session.controller.signal });
    } catch (error) {
      const retryable = error?.retryable === true || error?.transient === true;
      if (!retryable || session.verifyRetries >= 1) throw error;
      session.verifyRetries += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return verify(credentials, { signal: session.controller.signal });
    }
  }

  async function pollOnce(session) {
    try {
      const url = new URL('/x/passport-login/web/qrcode/poll', PASSPORT);
      url.searchParams.set('qrcode_key', session.key);
      const { data, response } = await passport(url, session.controller.signal, session);
      assertCurrent(session);
      if (data?.code === 86101) session.status = 'waiting';
      else if (data?.code === 86090) session.status = 'scanned';
      else if (data?.code === 86038) session.status = 'expired';
      else if (data?.code === 0) {
        const values = {};
        for (const cookie of response.headers.getSetCookie()) {
          const pair = cookie.split(';', 1)[0];
          const split = pair.indexOf('=');
          const name = pair.slice(0, split).trim();
          if (['SESSDATA', 'bili_jct', 'buvid3'].includes(name)) values[name] = pair.slice(split + 1).trim();
        }
        const credentials = validateCredentials({ sessdata: values.SESSDATA, bili_jct: values.bili_jct, buvid3: values.buvid3 });
        const account = await verifyWithRetry(credentials, session);
        assertCurrent(session);
        await vault.save(credentials);
        session.account = { mid: clipped(account?.mid, 20), name: clipped(account?.name, 200) };
        session.status = 'success';
        try { await onAccount(session.account); } catch { /* 审计失败不改变登录结果 */ }
      } else throw new LoginError('无法识别登录状态，请重新扫码。');
    } catch (error) {
      // 旧会话的迟到结果不得写入新会话状态。
      if (current !== session) return state(session);
      const retryable = error?.retryable === true && !session.controller.signal.aborted;
      if (retryable) {
        if (session.retryStartedAt == null) session.retryStartedAt = now();
        const windowLeft = 30_000 - (now() - session.retryStartedAt);
        session.soft = (session.soft || 0) + 1;
        if (session.soft <= 6 && windowLeft > 0) {
          session.status = 'waiting';
          session.error = null;
          session.retryAt = now() + Math.min(4000, 500 * session.soft, windowLeft);
          session.nextPoll = session.retryAt;
          return scrubAndReturn(session);
        }
        session.error = '登录重试次数或时间窗口已用尽，请重新扫码。';
      }
      if (!TERMINAL.has(session.status)) {
        session.status = session.controller.signal.aborted ? 'cancelled' : 'error';
        if (!session.error) session.error = error instanceof LoginError ? error.message : '登录未保存，请重新扫码。';
      }
    }
    return scrubAndReturn(session);
  }

  async function poll(id) {
    const session = current;
    if (!session || session.id !== id) throw new LoginError('登录流程已失效，请重新扫码。');
    if (TERMINAL.has(session.status)) return scrubAndReturn(session);
    if (now() >= session.expiresAt) {
      session.status = 'expired'; session.controller.abort();
      return scrubAndReturn(session);
    }
    if (session.flight) return session.flight;
    if (now() < session.nextPoll) return state(session);
    session.nextPoll = now() + intervalMs;
    session.flight = pollOnce(session).finally(() => { session.flight = null; });
    return session.flight;
  }

  function cancel(id) {
    const session = current;
    if (!session || (id && session.id !== id)) return { status: 'cancelled' };
    if (!TERMINAL.has(session.status)) { session.status = 'cancelled'; session.error = null; }
    session.controller.abort();
    scrub(session);
    return state(session);
  }

  function dispose() {
    disposed = true;
    cancel();
    current = null;
  }

  return { start, poll, cancel, dispose, status: () => state(current) };
}
