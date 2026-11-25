// 唤醒时段设置页 API：读写都经过 cognition-bus facade，不直接碰状态文件。
import { randomBytes, timingSafeEqual } from 'node:crypto';

const CSRF_HEADER = 'x-csrf-token';
const MAX_BODY = 256 * 1024;

function respond(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(body);
}

function tokenMatches(value, expected) {
  if (typeof value !== 'string' || value.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(value), Buffer.from(expected));
  } catch {
    return false;
  }
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  return JSON.parse(text.replace(/^\uFEFF/, ''));
}

export function registerBusUi({ ctx, facade, logger = console } = {}) {
  const webServer = ctx?.get?.('webServer');
  if (!webServer || typeof webServer.register !== 'function') {
    logger?.warn?.('[bus] 未连接 webServer，唤醒时段设置页不可用');
    return () => {};
  }
  const csrf = randomBytes(32).toString('hex');
  const disposers = [];

  const guard = handler => async (req, res) => {
    try {
      const connection = ctx?.get?.('connection');
      if (typeof connection?.requestRejection !== 'function') {
        return respond(res, 503, { error: 'DSH 权限验证不可用' });
      }
      const rejected = connection.requestRejection(req);
      if (rejected !== undefined && rejected !== null && rejected !== false) {
        res.statusCode = typeof rejected === 'number' ? rejected : 403;
        res.end();
        return;
      }
      if (req.method !== 'GET' && !tokenMatches(req.headers?.[CSRF_HEADER], csrf)) {
        return respond(res, 403, { error: 'CSRF 验证失败：请刷新页面后重试' });
      }
      await handler(req, res);
    } catch (error) {
      respond(res, 400, { error: String(error?.message || error) });
    }
  };

  const route = (path, handler) => {
    const dispose = webServer.register({ kind: 'exact', path, handler: guard(handler) });
    if (typeof dispose !== 'function') throw new Error('webServer.register 未返回 disposer');
    disposers.push(dispose);
  };

  route('/bus/api/csrf', async (req, res) => {
    if (req.method !== 'GET') return respond(res, 405, { error: '仅允许 GET' });
    respond(res, 200, { token: csrf });
  });

  route('/bus/api/schedule', async (req, res) => {
    if (req.method === 'GET') return respond(res, 200, facade.schedule());
    if (req.method !== 'POST') return respond(res, 405, { error: '仅允许 GET/POST' });
    const body = await readJson(req);
    if (!Array.isArray(body?.segments)) return respond(res, 400, { error: 'segments 必须是数组' });
    facade.setSchedule(body.segments);
    respond(res, 200, facade.schedule());
  });

  route('/bus/api/current-tick', async (req, res) => {
    if (req.method !== 'POST') return respond(res, 405, { error: '仅允许 POST' });
    const body = await readJson(req);
    const minutes = Number(body?.minutes);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
      return respond(res, 400, { error: 'minutes 必须是 1–1440' });
    }
    const target = facade.setHeartbeat(minutes * 60_000);
    respond(res, 200, { ok: true, ...target, schedule: facade.schedule() });
  });

  return () => {
    for (const dispose of disposers) {
      try { dispose(); } catch { /* 忽略重复释放 */ }
    }
  };
}
