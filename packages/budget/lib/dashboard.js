/**
 * Budget 独立设置页后端：只暴露 JSON API，不渲染 HTML。
 *
 * 安全边界：
 * - 所有请求先经过宿主 connection.requestRejection（与旧 Dashboard 相同）；
 * - 非 GET 请求必须带本进程生成的 CSRF 令牌；
 * - 只通过 Budget 服务读写预算，不直接改其他插件的数据；
 * - 响应绝不包含凭证或原始配置中的价格表原文之外的用户敏感内容。
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { configSummary } from './config.js';
import { DEFAULT_PRICES } from './pricing.js';

const CSRF_HEADER = 'x-dsh-dshai-csrf';
const MAX_BODY = 8_192;
const STATUS_PATH = '/dsh-dshai/budget/api/state';
const CONTROL_PATH = '/dsh-dshai/budget/api/control';

function respond(res, status, value) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.end(JSON.stringify(value));
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

/** 价格表摘要：只展示公开定价，便于用户理解峰谷。 */
function priceRows() {
  return Object.entries(DEFAULT_PRICES).flatMap(([provider, models]) => Object.entries(models).map(([model, entry]) => ({
    provider,
    model,
    peak: entry.peak,
    offPeak: entry.offPeak,
    source: entry.source,
    effectiveFrom: entry.effectiveFrom,
  })));
}

function configFrom(input, current) {
  if (!input || typeof input !== 'object') throw new Error('缺少配置内容');
  const limits = input.limits && typeof input.limits === 'object' ? input.limits : {};
  const tokens = limits.tokens;
  const costMicros = limits.costMicros;
  return {
    version: 1,
    timeZone: input.timeZone || current?.timeZone || 'Asia/Shanghai',
    limits: {
      tokens,
      cost: { micros: costMicros, currency: 'CNY' },
    },
    holidays: current?.holidays ?? [],
    reservationTtlMinutes: current?.reservationTtlMinutes ?? 30,
    prices: current?.prices ?? {},
    savings: {
      enabled:
        input.savings && typeof input.savings === 'object'
          ? input.savings.enabled === true
          : current?.savings?.enabled === true,
      retainDays:
        input.savings && typeof input.savings === 'object'
          ? (input.savings.retainDays ?? current?.savings?.retainDays ?? 7)
          : (current?.savings?.retainDays ?? 7),
    },
  };
}

/**
 * 注册 Budget 设置页 API。返回 disposer；webServer / connection 不可用时静默跳过。
 */
export function registerBudgetDashboard(ctx, { getBudget, getStorage, trust = null, log = () => {} } = {}) {
  const webServer = ctx?.get?.('webServer') || ctx?.webServer;
  if (!webServer || typeof webServer.register !== 'function') {
    log('[dsh-dshai-budget-dashboard] 未连接 webServer，设置页 API 不可用；预算核心功能不受影响');
    return () => {};
  }
  const csrfToken = randomBytes(32).toString('hex');
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
        return;
      }
      if (req.method !== 'GET' && !tokenMatches(req.headers?.[CSRF_HEADER], csrfToken)) {
        return respond(res, 403, { error: 'CSRF 验证失败：请刷新页面后重试' });
      }
      await handler(req, res);
    } catch (error) {
      respond(res, 400, { error: String(error?.message || error), code: error?.code ?? null });
    }
  };

  const route = (path, handler) => {
    disposers.push(webServer.register({ kind: 'exact', path, handler: guard(handler) }));
  };

  route(STATUS_PATH, async (req, res) => {
    if (req.method !== 'GET') return respond(res, 405, { error: '仅允许 GET' });
    const budget = getBudget?.();
    if (!budget) return respond(res, 503, { error: 'Budget 服务未连接' });
    const status = await budget.status();
    const loaded = getStorage ? await getStorage().readConfig() : { config: null };
    respond(res, 200, {
      ok: true,
      csrfToken,
      data: {
        version: budget.version,
        status,
        config: configSummary(loaded?.config ?? null),
        pricing: priceRows(),
        services: { budget: true },
        notice: '0.5.2：金额是唯一硬拦截，Token 仅统计与告警；储蓄结转按批次计算，可在本页开启并设置保留天数。',
      },
    });
  });

  route(CONTROL_PATH, async (req, res) => {
    if (req.method !== 'POST') return respond(res, 405, { error: '仅允许 POST' });
    if (!String(req.headers?.['content-type'] || '').startsWith('application/json')) {
      return respond(res, 415, { error: '只接受 JSON' });
    }
    const budget = getBudget?.();
    if (!budget) return respond(res, 503, { error: 'Budget 服务未连接' });
    const input = await readBody(req);
    const actor = { kind: 'user', authenticated: true, id: 'dashboard-session' };

    if (input.action === 'migrate-legacy') {
      const result = await budget.migrateLegacy({ actor, trust });
      return respond(res, 200, { ok: true, result });
    }
    if (input.action === 'restore-backup') {
      if (typeof input.file !== 'string' || !input.file) {
        return respond(res, 400, { error: '缺少备份文件名', code: 'INVALID_ARGUMENT' });
      }
      const result = await budget.restoreBackup({ file: input.file, actor, trust });
      return respond(res, 200, { ok: true, result });
    }
    if (input.action === 'authorize-once') {
      if (typeof input.model !== 'string' || !input.model) {
        return respond(res, 400, { error: '缺少模型', code: 'INVALID_ARGUMENT' });
      }
      const result = await budget.authorizeOnce({
        actor,
        trust,
        provider: typeof input.provider === 'string' && input.provider ? input.provider : 'deepseek',
        model: input.model,
        maxWorstTokens: input.maxWorstTokens,
        maxCostMicros: input.maxCostMicros,
        taskId: typeof input.taskId === 'string' ? input.taskId : null,
        caller: typeof input.caller === 'string' ? input.caller : null,
        expiresInMinutes: input.expiresInMinutes,
        reason: typeof input.reason === 'string' ? input.reason : '',
      });
      return respond(res, 200, { ok: true, result });
    }
    if (input.action === 'revoke-exception') {
      if (typeof input.id !== 'string' || !input.id) {
        return respond(res, 400, { error: '缺少例外 id', code: 'INVALID_ARGUMENT' });
      }
      const result = await budget.revokeException({ actor, trust, id: input.id });
      return respond(res, 200, { ok: true, result });
    }
    if (input.action === 'decide-topup') {
      if (typeof input.id !== 'string' || !input.id) {
        return respond(res, 400, { error: '缺少补额申请 id', code: 'INVALID_ARGUMENT' });
      }
      const result = await budget.decideTopUp({
        actor,
        trust,
        id: input.id,
        decision: input.decision,
        amountMicros: input.amountMicros,
      });
      return respond(res, 200, { ok: true, result });
    }
    if (input.action === 'revoke-topup') {
      if (typeof input.id !== 'string' || !input.id) {
        return respond(res, 400, { error: '缺少补额申请 id', code: 'INVALID_ARGUMENT' });
      }
      const result = await budget.revokeTopUp({
        actor,
        trust,
        id: input.id,
        reason: typeof input.reason === 'string' ? input.reason : '',
      });
      return respond(res, 200, { ok: true, result });
    }
    if (input.action === 'clear-guard') {
      const result = await budget.clearGuard({
        actor,
        trust,
        reason: typeof input.reason === 'string' ? input.reason : '',
      });
      return respond(res, 200, { ok: true, result });
    }
    if (input.action === 'reconcile') {
      if (typeof input.runId !== 'string' || !input.runId) {
        return respond(res, 400, { error: '缺少 runId', code: 'INVALID_ARGUMENT' });
      }
      const result = await budget.reconcile({
        actor,
        trust,
        runId: input.runId,
        mode: input.mode,
        usage: input.usage && typeof input.usage === 'object' ? input.usage : null,
        acceptRisk: input.acceptRisk === true,
        reason: typeof input.reason === 'string' ? input.reason : '',
      });
      return respond(res, 200, { ok: true, result });
    }
    if (input.action !== 'configure') return respond(res, 400, { error: '不支持的操作' });

    const current = getStorage ? (await getStorage().readConfig())?.config ?? null : null;
    const next = configFrom(input, current);
    const result = await budget.configure({
      actor,
      trust,
      limits: next.limits,
      timeZone: next.timeZone,
      holidays: next.holidays,
      reservationTtlMinutes: next.reservationTtlMinutes,
      prices: next.prices,
      savings: next.savings,
    });
    respond(res, 200, { ok: true, config: result.config });
  });

  return () => {
    for (const dispose of disposers) {
      try { dispose?.(); } catch {}
    }
  };
}
