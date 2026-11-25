import { updateState, dateKey, clipped } from './storage.js';
import { cookieHeader } from './vault.js';
import { signWbi } from './wbi.js';

// 唯一外联点：固定根域名 + 只读路径；不使用 Cookie（仅 nav 校验时携带）、不跟随重定向、不接受自定义 URL。
export const API_ORIGIN = 'https://api.bilibili.com';
export const ALLOWED_PATHS = Object.freeze([
  '/x/web-interface/popular',
  '/x/web-interface/view',
  '/x/v2/reply',
  '/x/web-interface/nav',
  '/x/web-interface/wbi/search/type',
  '/x/space/wbi/arc/search',
  '/x/player/wbi/v2',
  '/x/v2/reply/main',
  '/x/v2/reply/reply',
  '/x/v1/dm/list.so',
  '/x/frontend/finger/spi',
]);
const PATHS = new Set(ALLOWED_PATHS);
const WBI_TTL_MS = 10 * 60 * 1000;

// 兼容 B 站网页端的请求头。平台会校验 Referer/UA 与登录态，缺失时 WBI 接口更容易返回 -352。
export const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const BROWSER_REFERER = 'https://www.bilibili.com/';

// B 站风控的常见表现：HTTP 412/429，或 HTTP 200 但 body.code 为下列值之一。
const RISK_CODES = new Set([-412, -352, -799, -509, -10403]);
const HOUR_MS = 60 * 60 * 1000;

export class BiliTrafficError extends Error {
  constructor(message, code = 'BILI_TRAFFIC_PAUSED') {
    super(message);
    this.name = 'BiliTrafficError';
    this.code = code;
  }
}

// WBI 业务码 -352/-403 先抛给 signed()，允许换一次密钥重试；仍失败再进入全局暂停。
export class BiliRiskError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'BiliRiskError';
    this.code = Number(code);
  }
}

function retryAfterMs(response, nowMs) {
  const value = response?.headers?.get?.('retry-after');
  if (!value) return 0;
  if (/^\d+(\.\d+)?$/.test(value.trim())) return Math.max(0, Number(value) * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : 0;
}

export function createBiliClient({
  readHourly = 300,
  readDaily = 2000,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  spacingMs = 3000,
  backoffBaseMs = 5 * 60 * 1000,
  backoffMaxMs = 30 * 60 * 1000,
} = {}) {
  let queue = Promise.resolve();
  let nextTime = 0;

  const hourlyLimit = Number.isFinite(readHourly) && readHourly > 0 ? readHourly : 300;
  const dailyLimit = Number.isFinite(readDaily) && readDaily > 0 ? readDaily : 2000;

  async function pauseForRisk(reason, retryMs = 0) {
    const nowMs = now();
    let until = 0;
    await updateState(state => {
      const streak = Math.min(8, Number(state.traffic?.streak || 0) + 1);
      const wait = Math.max(retryMs, Math.min(backoffMaxMs, backoffBaseMs * 2 ** (streak - 1)));
      until = nowMs + wait;
      state.traffic = { until, streak, reason: clipped(reason, 120), endpoint: state.traffic?.endpoint || null };
    });
    return until;
  }

  async function request(path, params, signal, { credentials = null, parse = 'json', allowCodes = [], query = null, riskMode = 'pause' } = {}) {
    if (!PATHS.has(path)) throw new Error('未获准的接口路径');
    const run = queue.then(async () => {
      const waitMs = Math.max(0, nextTime - now());
      if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
      if (signal?.aborted) throw new Error('请求已取消');
      await updateState(state => {
        const nowMs = now();
        const day = dateKey();
        if (state.quota?.day !== day) {
          state.quota = { day, used: 0, hourStart: nowMs, hourUsed: 0 };
        }
        if (!Number.isFinite(state.quota.hourStart) || nowMs - state.quota.hourStart >= HOUR_MS) {
          state.quota.hourStart = nowMs;
          state.quota.hourUsed = 0;
        }
        state.quota.used = Number(state.quota.used) || 0;
        state.quota.hourUsed = Number(state.quota.hourUsed) || 0;
        if (Number(state.traffic?.until) > nowMs) {
          throw new BiliTrafficError(
            `B站请求保护暂停中：${state.traffic.reason || '平台风控'}，${new Date(state.traffic.until).toLocaleString('zh-CN')} 后自动恢复`,
            'BILI_TRAFFIC_PAUSED',
          );
        }
        if (state.quota.hourUsed >= hourlyLimit) {
          throw new BiliTrafficError(`本小时 B站请求已达上限（${hourlyLimit} 次），请在下一个整点后重试`, 'BILI_READ_BUDGET_HOURLY');
        }
        if (state.quota.used >= dailyLimit) {
          throw new BiliTrafficError(`今日 B站请求已达上限（${dailyLimit} 次），请明天再试`, 'BILI_READ_BUDGET_DAILY');
        }
        state.quota.hourUsed += 1;
        state.quota.used += 1;
      });
      nextTime = now() + spacingMs;
      const url = new URL(path, API_ORIGIN);
      if (query) url.search = query;
      else for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      timer.unref?.();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      try {
        const response = await fetchImpl(url, {
          method: 'GET', redirect: 'error', signal: controller.signal,
          headers: {
            Accept: 'application/json',
            'User-Agent': BROWSER_UA,
            Referer: BROWSER_REFERER,
            ...(credentials ? { Cookie: cookieHeader(credentials) } : {}),
          },
        });
        if (response.status === 412 || response.status === 429) {
          const retryMs = retryAfterMs(response, now());
          const until = await pauseForRisk(`B站 HTTP ${response.status}`, retryMs);
          throw new BiliTrafficError(`B站触发风控（HTTP ${response.status}），已暂停请求至 ${new Date(until).toLocaleString('zh-CN')}`);
        }
        if (!response.ok) throw new Error(`B站 HTTP ${response.status}`);
        const length = Number(response.headers.get('content-length'));
        if (length > 1_000_000) throw new Error('响应超过安全大小限制');
        if (!response.body) throw new Error('无响应体');
        const reader = response.body.getReader();
        let bytes = 0;
        const parts = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 1_000_000) { await reader.cancel(); throw new Error('响应超过安全大小限制'); }
          parts.push(value);
        }
        const merged = new Uint8Array(bytes);
        let pos = 0;
        for (const part of parts) { merged.set(part, pos); pos += part.length; }
        const text = new TextDecoder().decode(merged);
        if (parse === 'text') return text;
        const json = JSON.parse(text);
        if (RISK_CODES.has(Number(json.code))) {
          if (riskMode === 'throw') throw new BiliRiskError(`B站接口 code ${json.code}`, json.code);
          const until = await pauseForRisk(`B站接口 code ${json.code}`, 0);
          throw new BiliTrafficError(`B站触发风控（code ${json.code}），已暂停请求至 ${new Date(until).toLocaleString('zh-CN')}`);
        }
        if (json.code !== 0 && !allowCodes.includes(Number(json.code))) throw new Error(`B站接口返回 ${json.code}: ${clipped(json.message, 100)}`);
        await updateState(state => {
          if (state.traffic && (state.traffic.streak > 0 || Number(state.traffic.until) > 0)) {
            state.traffic = { until: 0, streak: 0, reason: null, endpoint: null };
          }
        });
        return json.data;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    });
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async function popular(count = 5, signal) {
    const size = Math.max(1, Math.min(5, Math.floor(count) || 5));
    const data = await request('/x/web-interface/popular', { pn: 1, ps: size }, signal);
    return (data?.list || []).slice(0, size).map(item => ({
      bvid: clipped(item.bvid, 20), title: clipped(item.title, 140),
      owner: clipped(item.owner?.name, 60), description: clipped(item.desc, 200),
      url: `https://www.bilibili.com/video/${clipped(item.bvid, 20)}`,
      tname: clipped(item.tname, 40),
    }));
  }

  async function view(bvid, signal) {
    if (!/^BV[A-Za-z0-9]{10}$/.test(bvid)) throw new Error('只支持合法格式的 BV 号');
    const data = await request('/x/web-interface/view', { bvid }, signal);
    return {
      bvid, aid: data.aid, cid: Number(data.cid) || null, title: clipped(data.title, 160),
      owner: clipped(data.owner?.name, 80), description: clipped(data.desc, 1200),
      durationSeconds: data.duration, playCount: data.stat?.view,
      tname: clipped(data.tname, 40),
      pages: (data.pages || []).slice(0, 20).map(p => clipped(p.part, 80)),
      url: `https://www.bilibili.com/video/${bvid}`,
    };
  }

  async function comments(aid, signal) {
    if (!Number.isSafeInteger(aid) || aid <= 0) throw new Error('非法的 av 号');
    const data = await request('/x/v2/reply', { type: 1, oid: aid, pn: 1, ps: 5, sort: 2 }, signal);
    return (data?.replies || []).slice(0, 5).map(item => ({
      author: clipped(item.member?.uname, 40), text: String(item.content?.message ?? ''),
    }));
  }

  // UP 主视频列表：WBI 签名只读接口；不下载、不播放，只返回公开元数据。
  async function listUserVideos(mid, { limit = 20, order = 'pubdate', signal, credentials = null } = {}) {
    const userId = String(mid ?? '').trim();
    if (!/^\d{1,20}$/.test(userId)) throw new Error('mid 必须是纯数字');
    const size = Math.max(1, Math.min(50, Math.floor(Number(limit) || 20)));
    const sort = ['pubdate', 'click'].includes(order) ? order : 'pubdate';
    const data = await signed('/x/space/wbi/arc/search', {
      mid: userId, ps: size, pn: 1, order: sort,
    }, signal, { credentials });
    return (data?.list?.vlist || []).slice(0, size).map(item => ({
      bvid: clipped(item.bvid, 20),
      title: clipped(item.title, 200),
      description: clipped(item.description, 2000),
      mid: userId,
      created: Number(item.created) || 0,
      durationSeconds: seconds(item.length),
      stats: {
        view: Number(item.play) || 0,
        danmaku: Number(item.video_review) || 0,
        reply: Number(item.comment) || 0,
      },
      url: `https://www.bilibili.com/video/${clipped(item.bvid, 20)}`,
    }));
  }

  async function nav(credentials, signal) {
    if (!credentials) throw new Error('没有可用的登录凭证');
    const data = await request('/x/web-interface/nav', {}, signal, { credentials });
    const mid = typeof data?.mid === 'number' ? data.mid : Number(data?.mid);
    if (data?.isLogin !== true || !Number.isSafeInteger(mid) || mid <= 0) {
      throw new Error('B 站登录状态无效，请重新扫码');
    }
    return { mid: String(mid), name: clipped(data.uname, 200) };
  }

  // ---- WBI 签名（搜索/播放器接口需要）----
  let wbiCache = { at: 0, images: null };
  async function wbiImages(credentials, signal) {
    if (wbiCache.images && Date.now() - wbiCache.at < WBI_TTL_MS) return wbiCache.images;
    const data = await request('/x/web-interface/nav', {}, signal, { allowCodes: [-101], credentials });
    const images = data?.wbi_img;
    if (!images?.img_url || !images?.sub_url) throw new Error('WBI 签名密钥不可用，请稍后重试');
    wbiCache = { at: Date.now(), images };
    return images;
  }
  async function signed(path, params, signal, { credentials = null } = {}) {
    const images = await wbiImages(credentials, signal);
    try {
      return await request(path, {}, signal, {
        query: signWbi(params, images), credentials, riskMode: 'throw',
      });
    } catch (error) {
      // -352 是账号/IP 风控门：立即暂停，不刷新密钥、不追加请求。
      // -403 不视为密钥失效，按普通业务错误停止并上报，避免盲目重试。
      if (error instanceof BiliRiskError) {
        const until = await pauseForRisk(`B站接口 code ${error.code}`, 0);
        throw new BiliTrafficError(`B站触发风控（code ${error.code}），已暂停请求至 ${new Date(until).toLocaleString('zh-CN')}`);
      }
      throw error;
    }
  }

  const plain = (value, max) => clipped(String(value ?? '').replace(/<[^>]*>/g, ''), max);
  const seconds = value => {
    if (Number.isFinite(Number(value))) return Math.max(0, Math.floor(Number(value)));
    const match = String(value ?? '').match(/^(\d+):(\d{1,2})$/);
    return match ? Number(match[1]) * 60 + Number(match[2]) : 0;
  };

  async function search(keyword, { limit = 5, order = 'totalrank', signal, credentials = null } = {}) {
    const size = Math.max(1, Math.min(10, Math.floor(Number(limit) || 5)));
    const data = await signed('/x/web-interface/wbi/search/type', {
      search_type: 'video', keyword: String(keyword ?? '').trim().slice(0, 80), order, page: 1,
    }, signal, { credentials });
    return (data?.result ?? []).slice(0, size).map(item => ({
      bvid: clipped(item.bvid, 20),
      title: plain(item.title, 200),
      owner: plain(item.author, 60),
      mid: clipped(item.mid, 24),
      description: plain(item.description, 200),
      duration: seconds(item.duration),
      pubdate: Number(item.pubdate) || 0,
      stats: {
        view: Number(item.play) || 0,
        danmaku: Number(item.video_review) || 0,
        reply: Number(item.review) || 0,
      },
      tname: plain(item.typename, 40),
      url: `https://www.bilibili.com/video/${clipped(item.bvid, 20)}`,
    }));
  }

  async function player(bvid, cid, signal, credentials = null) {
    if (!/^BV[A-Za-z0-9]{10}$/.test(bvid)) throw new Error('只支持合法格式的 BV 号');
    if (!Number.isSafeInteger(Number(cid)) || Number(cid) <= 0) throw new Error('非法的 cid');
    const data = await signed('/x/player/wbi/v2', { bvid, cid: Number(cid) }, signal, { credentials });
    return {
      aid: Number(data?.aid) || null,
      cid: Number(data?.cid) || Number(cid),
      duration: seconds(data?.duration),
      subtitles: (data?.subtitle?.subtitles ?? []).slice(0, 20).map(track => ({
        lan: clipped(track.lan, 20),
        lan_doc: clipped(track.lan_doc, 40),
        subtitle_url: clipped(track.subtitle_url, 500),
        ai_status: Number(track.ai_status) || 0,
      })),
    };
  }

  async function commentsMain(aid, { ps = 10, mode = 3, signal, credentials = null } = {}) {
    if (!Number.isSafeInteger(Number(aid)) || Number(aid) <= 0) throw new Error('非法的 av 号');
    const size = Math.max(1, Math.min(20, Math.floor(Number(ps) || 10)));
    const data = await request('/x/v2/reply/main', {
      type: 1, oid: Number(aid), mode: Number(mode) === 2 ? 2 : 3, ps: size, next: 0,
    }, signal, { credentials });
    return (data?.replies ?? []).slice(0, size).map(item => ({
      rpid: String(item.rpid ?? ''),
      author: clipped(item.member?.uname, 40),
      text: String(item.content?.message ?? ''),
      like: Number(item.like) || 0,
      ctime: Number(item.ctime) || 0,
    }));
  }

  async function danmakuXml(cid, signal, credentials = null) {
    if (!Number.isSafeInteger(Number(cid)) || Number(cid) <= 0) throw new Error('非法的 cid');
    return request('/x/v1/dm/list.so', { oid: Number(cid) }, signal, { parse: 'text', credentials });
  }

  // 扫码轮询不一定下发 buvid3；缺失时向 B 站申请一次设备标识，失败也不伪造。
  async function ensureBuvid(credentials, signal) {
    if (!credentials || credentials.buvid3) return credentials;
    try {
      const data = await request('/x/frontend/finger/spi', {}, signal, { credentials });
      const buvid3 = String(data?.b_3 ?? '').trim();
      if (!buvid3) return credentials;
      return { ...credentials, buvid3 };
    } catch {
      return credentials;
    }
  }

  // 字幕正文是签名 CDN 链接：只允许 hdslb.com，不带 Cookie，不做重定向。
  // player/v2 可能返回 "//aisubtitle.hdslb.com/..." 这种协议相对地址，先补 https:。
  async function subtitleBody(url, signal) {
    const raw = String(url ?? '').trim();
    const normalized = raw.startsWith('//') ? `https:${raw}` : raw;
    const target = new URL(normalized);
    if (target.protocol !== 'https:' || !/(^|\.)hdslb\.com$/i.test(target.hostname)) {
      throw new Error('字幕地址不在允许的域名内');
    }
    const response = await fetchImpl(target, {
      method: 'GET', redirect: 'error', signal,
      headers: {
        Accept: 'application/json', 'User-Agent': BROWSER_UA, Referer: BROWSER_REFERER,
      },
    });
    if (!response.ok) throw new Error(`字幕 HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 1_000_000) throw new Error('字幕响应超过安全大小限制');
    return JSON.parse(text);
  }

  return { popular, view, comments, listUserVideos, nav, search, player, commentsMain, danmakuXml, subtitleBody, ensureBuvid };
}
