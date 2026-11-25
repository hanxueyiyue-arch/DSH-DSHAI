import { BROWSER_UA } from './client.js';
import { cookieHeader } from './vault.js';
import { signWbi } from './wbi.js';
import { DM_ENDPOINTS, SocialTransportError } from './social-transport.js';

const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav';
const MESSAGE_REFERER = 'https://message.bilibili.com/';
const MESSAGE_ORIGIN = 'https://message.bilibili.com';
const WBI_TTL_MS = 10 * 60 * 1000;
const ALLOWED_URLS = new Set(Object.values(DM_ENDPOINTS));

/**
 * 隔离真实私信请求适配器：只实现 B 站网页端使用的 HTTP/WBI 细节，不做重试，
 * 不记录 Cookie 或正文。仅供显式 socialTransport:'real-read' 的隔离宿主使用；
 * 默认不启用发送。
 */
export function createSocialRequest({
  account, fetchImpl = globalThis.fetch, now = () => Date.now(), timeoutMs = 15_000,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new SocialTransportError('真实私信请求适配器缺少 fetch', {
      code: 'SOCIAL_TRANSPORT_REQUEST_REQUIRED', definitive: true,
    });
  }

  let navCache = null;
  const stats = { total: 0, nav: 0, messages: 0, send: 0 };

  function credentials() {
    const cached = typeof account?.credentials === 'function' ? account.credentials() : null;
    if (!cached?.sessdata || !cached?.bili_jct) {
      throw new SocialTransportError('尚未登录 B 站，无法读取私信', {
        code: 'SOCIAL_LOGIN_REQUIRED', definitive: true,
      });
    }
    return cached;
  }

  function headers(cookie, extra = {}) {
    return {
      'User-Agent': BROWSER_UA,
      Referer: MESSAGE_REFERER,
      Origin: MESSAGE_ORIGIN,
      Accept: 'application/json, text/plain, */*',
      Cookie: cookie,
      ...extra,
    };
  }

  async function fetchJson(url, init) {
    stats.total += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 15_000));
    try {
      const response = await fetchImpl(url, { ...init, signal: controller.signal, redirect: 'manual' });
      const status = Number(response?.status) || 0;
      let body = null;
      try { body = await response.json(); } catch { body = null; }
      return { status, code: body?.code ?? null, data: body?.data ?? null };
    } catch (error) {
      throw new SocialTransportError('私信请求未能确认结果', {
        code: error?.code || 'DM_NETWORK_ERROR', definitive: false,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function ensureNav() {
    if (navCache && navCache.at + WBI_TTL_MS > Number(now())) return navCache.images;
    const cached = credentials();
    const result = await fetchJson(NAV_URL, {
      method: 'GET',
      headers: headers(cookieHeader(cached)),
    });
    stats.nav += 1;
    const images = result?.data?.wbi_img;
    if (result?.status !== 200 || result?.code !== 0 || !images?.img_url || !images?.sub_url) {
      throw new SocialTransportError('无法获取 WBI 签名密钥', {
        code: 'DM_NAV_FAILED', definitive: false,
      });
    }
    navCache = { images: { img_url: images.img_url, sub_url: images.sub_url }, at: Number(now()) };
    return navCache.images;
  }

  async function request({ endpoint, method, url, payload } = {}) {
    const target = String(url || DM_ENDPOINTS[endpoint] || '');
    if (!ALLOWED_URLS.has(target)) {
      throw new SocialTransportError('私信请求地址不在允许列表', {
        code: 'DM_ENDPOINT_DENIED', definitive: true,
      });
    }
    const cached = credentials();
    const cookie = cookieHeader(cached);
    const upper = String(method || 'GET').toUpperCase();

    if (upper === 'GET') {
      const images = await ensureNav();
      const query = signWbi(payload || {}, images, Number(now()));
      stats[endpoint === 'messages' ? 'messages' : 'send'] += 1;
      return fetchJson(`${target}?${query}`, {
        method: 'GET',
        headers: headers(cookie),
      });
    }

    if (upper !== 'POST') {
      throw new SocialTransportError('不支持的私信请求方法', {
        code: 'DM_METHOD_DENIED', definitive: true,
      });
    }
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(payload || {})) {
      if (value == null) continue;
      form.set(key, String(value));
    }
    if (!form.has('csrf')) form.set('csrf', String(cached.bili_jct));
    stats[endpoint === 'messages' ? 'messages' : 'send'] += 1;
    return fetchJson(target, {
      method: 'POST',
      headers: headers(cookie, { 'Content-Type': 'application/x-www-form-urlencoded' }),
      body: form.toString(),
    });
  }

  request.stats = stats;
  return request;
}
