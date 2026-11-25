// 管理界面路由：只在宿主提供 webServer 时注册，不影响内核本身。
import { randomBytes, timingSafeEqual } from 'node:crypto';

const CSRF_HEADER = 'x-csrf-token';
const MAX_BODY = 8 * 1024 * 1024;

function respond(res, status, payload) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  res.statusCode = status;
  if (typeof payload === 'string') res.setHeader('content-type', 'text/html; charset=utf-8');
  else res.setHeader('content-type', 'application/json; charset=utf-8');
  // 管理界面是单页 HTML，且内容随版本变化：禁止缓存。
  // 否则改完页面后浏览器一直拿旧 HTML，看起来像"改了没生效"。
  res.setHeader('cache-control', 'no-store, must-revalidate');
  res.setHeader('pragma', 'no-cache');
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

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

function boolOf(value) {
  return value === '1' || value === 'true' || value === true;
}

export function registerCognitionUi({ ctx, service, logger = console } = {}) {
  const webServer = ctx?.get?.('webServer');
  if (!webServer || typeof webServer.register !== 'function') {
    logger?.warn?.('[cognition] 未连接 webServer，管理界面不可用');
    return () => {};
  }
  const csrf = randomBytes(32).toString('hex');
  const disposers = [];

  const guard = handler => async (req, res) => {
    try {
      {
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

  // 浏览器版管理页：**已停用**（2026-11-24）。
  // 原因：设置里的「DSHAI 设置」是 client.js 在客户端原地渲染的同一套面板，
  // 两边都维护会分叉（上次改 page.js 而面板不变，就是这个坑）。
  // 这里保留路由但直接返回 410，明确标注它是「浏览器版」，指向应用内设置。
  // /cognition/api/* 全部保留——应用内面板依赖它们取数。
  const UI_RETIRED = true;
  route('/cognition-ui', async (req, res) => {
    if (req.method !== 'GET') return respond(res, 405, { error: '仅允许 GET' });
    const html = [
      '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      '<title>浏览器版管理页已停用</title></head>',
      '<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#f2f7fa;',
      'font:14px/1.7 -apple-system,BlinkMacSystemFont,Segoe UI,Microsoft YaHei,sans-serif;color:#12343f">',
      '<div style="max-width:520px;padding:28px 30px;background:#fff;border:1px solid #dbe7ec;border-radius:14px">',
      '<div style="font-size:12px;letter-spacing:.5px;color:#6b8a95;margin-bottom:6px">浏览器版管理页</div>',
      '<h1 style="margin:0 0 10px;font-size:18px">已停用</h1>',
      '<p style="margin:0 0 12px">这个页面原本是认知内核的浏览器版管理界面。现在统一改用应用内的设置面板：</p>',
      '<p style="margin:0 0 12px;padding:10px 12px;background:#eef7fa;border-radius:10px">',
      '<b>设置 → DSHAI 设置</b>（概览 / 身份 / 记忆 / 活动 / 数据都在里面，含「偏好与倾向」折叠区）</p>',
      '<p style="margin:0;color:#6b8a95;font-size:12.5px">页面本身没有删除，需要时可以重新启用；只读 API 未受影响。</p>',
      '</div></body></html>'
    ].join('');
    res.statusCode = 410;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-store, must-revalidate');
    res.end(html);
  });

  route('/cognition/api/csrf', async (req, res) => {
    if (req.method !== 'GET') return respond(res, 405, { error: '仅允许 GET' });
    respond(res, 200, { token: csrf });
  });

  route('/cognition/api/overview', async (req, res) => {
    if (req.method !== 'GET') return respond(res, 405, { error: '仅允许 GET' });
    respond(res, 200, { status: await service.status(), identity: await service.identity() });
  });

  route('/cognition/api/memories', async (req, res) => {
    if (req.method !== 'GET') return respond(res, 405, { error: '仅允许 GET' });
    const url = new URL(req.url, 'http://localhost');
    respond(res, 200, await service.memories({
      limit: Number(url.searchParams.get('limit')) || 200,
      offset: Number(url.searchParams.get('offset')) || 0,
      kind: url.searchParams.get('kind') || null,
      layer: url.searchParams.get('layer') || null,
      includeArchived: boolOf(url.searchParams.get('includeArchived'))
    }));
  });

  route('/cognition/api/proposals', async (req, res) => {
    if (req.method !== 'GET') return respond(res, 405, { error: '仅允许 GET' });
    respond(res, 200, await service.proposals());
  });

  // 心跳（兜底定时器）：读写在 cognition-bus 上，界面与 DSHAI 共用同一份设置。
  route('/cognition/api/heartbeat', async (req, res) => {
    const bus = ctx?.get?.('cognition-bus');
    if (!bus || typeof bus.heartbeat !== 'function') {
      return respond(res, 503, { error: 'cognition-bus 未加载，心跳不可配置' });
    }
    if (req.method === 'GET') {
      return respond(res, 200, bus.heartbeat());
    }
    if (req.method !== 'POST') return respond(res, 405, { error: '仅允许 GET/POST' });
    const body = await readBody(req);
    const minutes = Number(body.minutes);
    if (!Number.isFinite(minutes)) return respond(res, 400, { error: 'minutes 必须是数字' });
    try {
      const saved = bus.setHeartbeat(Math.round(minutes * 60_000));
      respond(res, 200, { ...bus.heartbeat(), saved });
    } catch (error) {
      respond(res, 400, { error: String(error?.message ?? error) });
    }
  });

  route('/cognition/api/proposals/apply', async (req, res) => {
    if (req.method !== 'POST') return respond(res, 405, { error: '仅允许 POST' });
    const body = await readBody(req);
    respond(res, 200, await service.applyProposal(String(body.id ?? '')));
  });

  route('/cognition/api/proposals/dismiss', async (req, res) => {
    if (req.method !== 'POST') return respond(res, 405, { error: '仅允许 POST' });
    const body = await readBody(req);
    respond(res, 200, await service.dismissProposal(String(body.id ?? '')));
  });

  route('/cognition/api/activity', async (req, res) => {    if (req.method !== 'GET') return respond(res, 405, { error: '仅允许 GET' });
    const url = new URL(req.url, 'http://localhost');
    respond(res, 200, await service.activity({ limit: Number(url.searchParams.get('limit')) || 80 }));
  });

  route('/cognition/api/trace', async (req, res) => {
    if (req.method !== 'GET') return respond(res, 405, { error: '仅允许 GET' });
    const url = new URL(req.url, 'http://localhost');
    respond(res, 200, await service.trace({
      eventId: url.searchParams.get('eventId') || null,
      limit: Number(url.searchParams.get('limit')) || 6
    }));
  });

  route('/cognition/api/identity', async (req, res) => {
    if (req.method !== 'POST') return respond(res, 405, { error: '仅允许 POST' });
    const body = await readBody(req);
    respond(res, 200, await service.setIdentity({
      name: body.name,
      gender: body.gender ?? '',
      profileText: body.profileText ?? ''
    }));
  });

  route('/cognition/api/persona', async (req, res) => {
    if (req.method !== 'GET') return respond(res, 405, { error: '仅允许 GET' });
    respond(res, 200, await service.persona());
  });

  route('/cognition/api/diary', async (req, res) => {
    if (req.method !== 'GET') return respond(res, 405, { error: '仅允许 GET' });
    respond(res, 200, await service.diaryList());
  });

  route('/cognition/api/diary/read', async (req, res) => {
    if (req.method !== 'GET') return respond(res, 405, { error: '仅允许 GET' });
    const url = new URL(req.url, 'http://localhost');
    const id = String(url.searchParams.get('id') ?? '');
    if (!id) return respond(res, 400, { error: '缺少 id' });
    respond(res, 200, await service.diaryRead(id));
  });

  route('/cognition/api/chronicle', async (req, res) => {
    if (req.method !== 'GET') return respond(res, 405, { error: '仅允许 GET' });
    const url = new URL(req.url, 'http://localhost');
    const limit = Number(url.searchParams.get('limit')) || 30;
    respond(res, 200, await service.chronicleList({ limit }));
  });

  route('/cognition/api/chronicle/read', async (req, res) => {
    if (req.method !== 'GET') return respond(res, 405, { error: '仅允许 GET' });
    const url = new URL(req.url, 'http://localhost');
    const id = String(url.searchParams.get('id') ?? '');
    if (!id) return respond(res, 400, { error: '缺少 id' });
    const row = await service.chronicleRead(id);
    if (!row) return respond(res, 404, { error: '没有这条编年史' });
    respond(res, 200, row);
  });

  route('/cognition/api/export', async (req, res) => {
    if (req.method !== 'POST') return respond(res, 405, { error: '仅允许 POST' });
    const body = await readBody(req);
    respond(res, 200, await service.exportData({
      includeActivity: boolOf(body.includeActivity),
      includeTrace: boolOf(body.includeTrace)
    }));
  });

  route('/cognition/api/import/preview', async (req, res) => {
    if (req.method !== 'POST') return respond(res, 405, { error: '仅允许 POST' });
    const body = await readBody(req);
    respond(res, 200, await service.previewDataImport({ base64: body.base64 }));
  });

  route('/cognition/api/import', async (req, res) => {
    if (req.method !== 'POST') return respond(res, 405, { error: '仅允许 POST' });
    const body = await readBody(req);
    respond(res, 200, await service.importData({ base64: body.base64, mode: body.mode || 'empty-only' }));
  });

  return () => {
    for (const dispose of disposers.splice(0)) {
      try { dispose(); } catch { /* 尽力而为 */ }
    }
  };
}
