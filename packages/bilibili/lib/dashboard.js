/**
 * Bilibili 独立设置页后端：只暴露 JSON API。
 *
 * 该界面只通过 bilibili 服务工作，不依赖 BrainMem / Autonomy / UI 插件；
 * 缺少 Autonomy 时仅隐藏“自主申请来源”说明，账号与手动功能不受影响。
 *
 * 安全边界与旧 Dashboard 一致：宿主鉴权 + 每进程 CSRF + 8 KiB 请求体上限；
 * 返回值不含 Cookie / Token / 二维码 key。
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AccessError, LoginError } from './account.js';
import { encodeQr, toMatrixRows } from './qr.js';

// The raw QR payload is a one-time login secret. It is encoded into a local
// module matrix; the panel renders it as plain SVG rectangles. The raw payload
// and original URL never leave this process (no text fallback in the response).
function sanitizeLogin(login) {
  if (!login || typeof login !== 'object') return login ?? null;
  const { qrContent, ...rest } = login;
  if (qrContent && (login.status === 'waiting' || login.status === 'scanned')) {
    try {
      rest.qr = toMatrixRows(encodeQr(qrContent));
    } catch {
      rest.qr = null;
    }
  }
  return rest;
}

const CSRF_HEADER = 'x-dsh-dshai-csrf';
const MAX_BODY = 8_192;
const STATUS_PATH = '/dsh-dshai/bilibili/api/state';
const CONTROL_PATH = '/dsh-dshai/bilibili/api/control';

const USER = Object.freeze({ kind: 'user', authenticated: true, id: 'dashboard-session' });

// 隔离单次真实发送：每个宿主进程最多尝试一次，失败也不允许再次调用。
let sendOnceUsed = false;

// Minimal diagnostics: request/status lines only. Never contains QR payloads,
// cookies or tokens, so it is safe to read back when the panel misbehaves.
function debugLog(line) {
  try {
    const home = process.env.DSH_HOME;
    if (!home) return; // only inside a real DSH runtime; keeps tests side-effect free
    const dir = join(home, 'dsh-dshai', 'bilibili');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'panel-debug.log');
    if (existsSync(file) && statSync(file).size > 65536) appendFileSync(file, `--- rotated ${new Date().toISOString()} ---\n`);
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch { /* diagnostics must never break the panel */ }
}


function respond(res, status, value) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.end(JSON.stringify(value));
  debugLog(`respond ${status}`);
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('请求体超过 8 KiB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function tokenMatches(provided, expected) {
  if (typeof provided !== 'string' || !/^[0-9a-f]{64}$/.test(provided)) return false;
  return timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new Error(`${name} 无效`);
  }
  return value;
}

/**
 * 注册 Bilibili 设置页 API。返回 disposer；webServer 不可用时静默跳过。
 */
export function registerBilibiliDashboard(ctx, { getService, adminSession, log = () => {} } = {}) {
  const webServer = ctx?.get?.('webServer') || ctx?.webServer;
  if (!webServer || typeof webServer.register !== 'function') {
    log('[dsh-dshai-bilibili-dashboard] 未连接 webServer，设置页 API 不可用；账号与手动功能不受影响');
    return () => {};
  }
  const csrfToken = randomBytes(32).toString('hex');
  const adminActor = Object.freeze({ ...USER, adminSession });
  const disposers = [];

  const guard = handler => async (req, res) => {
    try {
      const connection = ctx?.get?.('connection') || ctx?.connection;
      if (typeof connection?.requestRejection !== 'function') {
        return respond(res, 503, { error: 'DSH 权限验证不可用' });
      }
      const rejected = connection.requestRejection(req);
      if (rejected !== undefined && rejected !== null && rejected !== false) {
        res.statusCode = typeof rejected === 'number' ? rejected : 403;
        res.end();
        debugLog(`guard rejected ${res.statusCode}`);
        return;
      }
      if (req.method !== 'GET' && !tokenMatches(req.headers?.[CSRF_HEADER], csrfToken)) {
        return respond(res, 403, { error: 'CSRF 验证失败：请刷新页面后重试' });
      }
      await handler(req, res);
    } catch (error) {
      const status = error instanceof AccessError || error instanceof LoginError ? 409 : 400;
      debugLog(`error ${error?.name || 'Error'} code=${error?.code ?? '-'} msg=${String(error?.message || error).slice(0, 80)}`);
      respond(res, status, {
        error: String(error?.message || error),
        code: error?.code ?? null,
        requestId: error?.requestId ?? null,
      });
    }
  };

  const route = (path, handler) => {
    let dispose;
    try {
      dispose = webServer.register({ kind: 'exact', path, handler: guard(handler) });
    } catch (error) {
      for (const registered of disposers) { try { registered?.(); } catch { /* 回滚尽力而为 */ } }
      disposers.length = 0;
      throw error;
    }
    if (typeof dispose !== 'function') {
      for (const registered of disposers) { try { registered?.(); } catch { /* 回滚尽力而为 */ } }
      disposers.length = 0;
      throw new Error('webServer.register 未返回 disposer');
    }
    disposers.push(dispose);
  };

  route(STATUS_PATH, async (req, res) => {
    if (req.method !== 'GET') return respond(res, 405, { error: '仅允许 GET' });
    const service = getService?.();
    if (!service) return respond(res, 503, { error: 'Bilibili 服务未连接' });
    const access = await service.accessState();
    const quota = await service.quota();
    const summary = await service.summary();
    const filters = typeof service.getFilters === 'function' ? await service.getFilters() : null;
    const social = typeof service.socialStatus === 'function' ? await service.socialStatus() : null;
    const policy = typeof service.policyStatus === 'function' ? await service.policyStatus() : null;
    const capabilityList = typeof service.capabilities === 'function' ? await service.capabilities() : null;
    // 登录状态优先从同一份 access 快照读取，避免“login 已成功、account 还是 null”的撕裂响应。
    const accessLogin = access?.login;
    const login = sanitizeLogin(accessLogin && typeof accessLogin === 'object'
      ? accessLogin
      : await service.loginStatus());
    debugLog(`state login=${login?.status || 'none'} qr=${Boolean(login?.qr)} pending=${Array.isArray(access?.pending) ? access.pending.length : 0} granted=${Boolean(access?.granted)} filters=${Boolean(filters?.enabled)}`);
    respond(res, 200, {
      ok: true,
      csrfToken,
      data: {
        version: service.version,
        readHourly: summary?.readHourly ?? null,
        readDaily: summary?.readDaily ?? null,
        traffic: summary?.traffic ?? null,
        access,
        login,
        quota,
        filters,
        social,
        policy,
        capabilities: capabilityList,
        counts: {
          observations: summary?.observationCount ?? 0,
          drafts: summary?.draftCount ?? 0,
        },
        services: {
          account: true,
          autonomy: Boolean(ctx?.get?.('autonomy')),
        },
        rules: {
          sessionBound: '浏览权限随登录自动授予，只对当前 DSH 运行会话有效；重启后必须重新扫码。',
          loginSeparate: '登录成功即开放只读浏览；退出登录会撤销全部 B 站操作权限并中止在途请求。',
          legacyCredential: '旧版凭证文件不会被读取、迁移或覆盖；存在旧文件也必须重新扫码。',
          filters: '内容限制按标题、UP 主排除执行；分区偏好只参与排序，分区排除命中即排除；启用分区排除时缺少分区信息视为未通过。',
          social: '私信仅支持发给绑定的用户 UID；社交授权由用户签发，可立即撤销；模型没有私信写工具。',
          policy: 'Policy 是长期能力限制，与会话登录分开；首次安装需用户手动初始化。Policy 丢失/损坏时受保护操作默认拒绝，需用户从本页恢复。',
        },
      },
    });
  });

  route(CONTROL_PATH, async (req, res) => {
    if (req.method !== 'POST') return respond(res, 405, { error: '仅允许 POST' });
    if (!String(req.headers?.['content-type'] || '').startsWith('application/json')) {
      return respond(res, 415, { error: '只接受 JSON' });
    }
    const service = getService?.();
    if (!service) return respond(res, 503, { error: 'Bilibili 服务未连接' });
    const input = await readBody(req);
    const action = input.action;
    debugLog(`control action=${String(action)}`);

    if (action === 'request-login') {
      const request = await service.requestAccess({ scopes: ['login'], reason: '用户从设置页申请登录 B 站账号', needLogin: true, actor: adminActor });
      return respond(res, 200, { ok: true, request });
    }
    if (action === 'request-content') {
      const request = await service.requestAccess({ scopes: ['content:popular'], reason: '用户从设置页申请自主浏览公开内容', actor: adminActor });
      return respond(res, 200, { ok: true, request });
    }
    if (action === 'approve') {
      const result = await service.approveAccess({ requestId: requireString(input.requestId, 'requestId'), actor: adminActor });
      return respond(res, 200, { ok: true, result });
    }
    if (action === 'deny') {
      const result = await service.denyAccess({ requestId: requireString(input.requestId, 'requestId'), actor: adminActor, reason: '用户从设置页拒绝' });
      return respond(res, 200, { ok: true, result });
    }
    if (action === 'revoke') {
      const result = await service.revokeAccess({ actor: adminActor });
      return respond(res, 200, { ok: true, result });
    }
    if (action === 'browse-once') {
      // 一键受控浏览：仍走 scheduled 门禁（须当前运行会话已批准 content:popular），
      // 且不向 Autonomy 交接，避免把本轮测试写成自主经历。
      const result = await service.observePopular({ count: 1, method: 'scheduled', handOff: false });
      return respond(res, 200, {
        ok: true,
        result: {
          method: result.method,
          count: result.videos.length,
          filtered: result.filtered ?? 0,
          titles: result.videos.map(v => v.title).slice(0, 3),
          observedAt: result.observedAt,
        },
      });
    }
    if (action === 'filters-set') {
      const result = await service.setFilters({ filters: input.filters, actor: adminActor });
      return respond(res, 200, { ok: true, filters: result.filters });
    }
    if (action === 'filters-clear') {
      const result = await service.setFilters({ filters: {}, actor: adminActor });
      return respond(res, 200, { ok: true, filters: result.filters });
    }
    if (action === 'filters-mode') {
      const result = await service.setFilterMode({ mode: input.mode, actor: adminActor });
      return respond(res, 200, { ok: true, filters: result.filters });
    }
    if (action === 'policy-init') {
      const result = await service.initializePolicy({ actor: adminActor, policy: input.policy });
      return respond(res, 200, { ok: true, ...result });
    }
    if (action === 'policy-set') {
      const result = await service.updatePolicy({
        capabilityId: requireString(input.capabilityId, 'capabilityId'),
        state: requireString(input.state, 'state'),
        actor: adminActor,
      });
      return respond(res, 200, { ok: true, ...result });
    }
    if (action === 'policy-recover') {
      const result = await service.recoverPolicy({
        mode: requireString(input.mode, 'mode'),
        confirm: typeof input.confirm === 'string' ? input.confirm : '',
        actor: adminActor,
      });
      return respond(res, 200, { ok: true, ...result });
    }
    if (action === 'social-bind') {
      const result = await service.socialBind({ ownerMid: input.ownerMid, selfMid: input.selfMid, actor: adminActor });
      return respond(res, 200, { ok: true, social: result });
    }
    if (action === 'social-grant') {
      const result = await service.socialGrant({
        scopes: input.scopes,
        ttlMs: input.ttlMs,
        capabilities: input.capabilities,
        dailySendMax: input.dailySendMax,
        actor: adminActor,
      });
      return respond(res, 200, { ok: true, ...result });
    }
    if (action === 'social-revoke') {
      const result = await service.socialRevoke({ actor: adminActor });
      return respond(res, 200, { ok: true, ...result });
    }
    if (action === 'social-resolve') {
      const result = await service.socialResolve({
        intentId: input.intentId, status: input.status, actor: adminActor, reason: input.reason,
      });
      return respond(res, 200, { ok: true, ...result });
    }
    if (action === 'social-read-once') {
      // 隔离验证专用：只有进程环境显式打开才存在；单次、最多 10 条、失败不重试。
      if (process.env.BILI_F6_READ_ONCE !== '1') {
        return respond(res, 403, { error: '一次性私信读取未启用' });
      }
      const result = await service.socialReceive({ actor: { kind: 'autonomy' }, size: 10 });
      // 只返回计数/游标/请求数等元数据，绝不返回私信正文。
      return respond(res, 200, {
        ok: true,
        meta: {
          messages: Array.isArray(result.messages) ? result.messages.length : 0,
          ignored: Number(result.ignored) || 0,
          received: result.received && typeof result.received === 'object' ? {
            owner: Number(result.received.owner) || 0,
            self: Number(result.received.self) || 0,
            other: Number(result.received.other) || 0,
            unknown: Number(result.received.unknown) || 0,
          } : null,
          hasCursor: Boolean(result.cursor),
          requestStats: result.requestStats && typeof result.requestStats === 'object' ? result.requestStats : null,
        },
      });
    }
    if (action === 'social-send-once') {
      // 隔离验证专用：进程环境显式打开、每进程最多一次、无自动重试。
      if (process.env.BILI_F6_SEND_ONCE !== '1') {
        return respond(res, 403, { error: '一次性私信发送未启用' });
      }
      if (sendOnceUsed) {
        return respond(res, 409, { error: '本次宿主进程已执行过一次性私信发送' });
      }
      const intentId = requireString(input.intentId, 'intentId');
      if (!/^[A-Za-z0-9_-]{8,80}$/.test(intentId)) {
        return respond(res, 400, { error: 'intentId 格式无效' });
      }
      const text = typeof input.text === 'string' ? input.text.trim() : '';
      if (!text || text.length > 300) {
        return respond(res, 400, { error: 'text 必须为 1-300 字符' });
      }
      sendOnceUsed = true;
      try {
        const result = await service.socialSend({ actor: { kind: 'autonomy' }, intentId, text });
        return respond(res, 200, {
          ok: result?.status === 'sent',
          status: result?.status ?? (result?.duplicate ? 'duplicate' : 'unknown'),
          duplicate: result?.duplicate === true,
          intentId,
          keyPresent: Boolean(result?.intent?.key),
          requestStats: result?.requestStats ?? null,
        });
      } catch (error) {
        return respond(res, 200, {
          ok: false,
          status: 'not_sent',
          intentId,
          code: error?.code || 'SOCIAL_SEND_ERROR',
          requestStats: null,
        });
      }
    }
    if (action === 'suppress') {
      const reason = typeof input.reason === 'string' ? input.reason.slice(0, 200) : '用户从设置页要求暂停申请';
      const result = await service.suppressRequests({ actor: adminActor, reason });
      return respond(res, 200, { ok: true, result });
    }
    if (action === 'resume') {
      const result = await service.resumeRequests({ actor: adminActor });
      return respond(res, 200, { ok: true, result });
    }
    if (action === 'login-start') {
      const result = await service.startLogin({ actor: adminActor });
      return respond(res, 200, { ok: true, login: sanitizeLogin(result) });
    }
    if (action === 'login-poll') {
      const result = await service.pollLogin(requireString(input.loginId, 'loginId'), { actor: adminActor });
      return respond(res, 200, { ok: true, login: sanitizeLogin(result) });
    }
    if (action === 'login-cancel') {
      const result = await service.cancelLogin(requireString(input.loginId, 'loginId'), { actor: adminActor });
      return respond(res, 200, { ok: true, login: result });
    }
    if (action === 'logout') {
      const result = await service.logout({ actor: adminActor });
      return respond(res, 200, { ok: true, result });
    }
    return respond(res, 400, { error: '不支持的操作' });
  });

  return () => {
    for (const dispose of disposers) {
      try { dispose?.(); } catch {}
    }
  };
}
