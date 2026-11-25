// 公共插件：把内核交出的意图执行掉，并把回执送回内核。
// 装配工具目录、意图入口、延迟绑定，以及最小调度器（tick/wake）；
// 不主动联网，发送与工具执行仍由 transport / 工具实现决定。

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createCognitionBus } from './bus.js';
import { createBilibiliBrowseTool } from './tools/bilibili.js';
import { createBilibiliExtraTools } from './tools/bilibili-extra.js';
import { createIntervalScheduler } from './scheduler.js';
import {
  MAX_SEGMENTS, MIN_TICK_MS, MAX_TICK_MS, clampTick, normalizeSegments, nextTickAt,
  segmentAt, readStoredSegments, writeStoredSegments, segmentView
} from './tick-schedule.js';
import { createOwnerSession } from './channels/owner-session.js';
import { createIntentIssuer } from './intent-issuer.js';
import * as IntentKeyPlugin from './intent-key.js';

export { createCognitionBus, BUS_VERSION } from './bus.js';export { createBilibiliBrowseTool, mapPopularItem } from './tools/bilibili.js';
export { createIntervalScheduler } from './scheduler.js';
export { createOwnerSession } from './channels/owner-session.js';

/**
 * 解析本次会话是否应用历史闸门（sinceMs）。
 * once=true（默认）：只有第一次（标记文件不存在）才返回 sinceMs 并写入标记，之后一律返回 0。
 * 删除 <baseDir>/dsh-dshai/bus/owner-session-state.json 即可重新武装。
 */
export function resolveHistoryCutoff({ sinceMs = 0, once = true, baseDir = process.cwd() } = {}) {
  if (!Number.isFinite(sinceMs) || sinceMs <= 0) return 0;
  if (!once) return sinceMs;
  const marker = join(baseDir, 'dsh-dshai', 'bus', 'owner-session-state.json');
  if (existsSync(marker)) return 0;
  try {
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, Buffer.from(JSON.stringify({
      historyCutoffAppliedAt: sinceMs,
      appliedAt: new Date().toISOString(),
      note: '删除本文件可重新武装历史闸门'
    }) + '\n', 'utf8'));
  } catch { /* 写不了标记就退化为每次都生效，安全优先 */ }
  return sinceMs;
}

// 兼容旧的“单一心跳”接口；新配置以 tick 时段表（settings.json.segments）为准。
const HEARTBEAT_MIN_MS = MIN_TICK_MS;
const HEARTBEAT_MAX_MS = MAX_TICK_MS;

function heartbeatFile() {
  const base = process.env.DSH_HOME || process.cwd();
  return join(base, 'dsh-dshai', 'bus', 'settings.json');
}

export function clampHeartbeat(ms) {
  return clampTick(ms);
}

export function readHeartbeatMs(fallback) {
  try {
    const parsed = JSON.parse(readFileSync(heartbeatFile(), 'utf8'));
    if (Array.isArray(parsed?.segments) && parsed.segments.length === 1) {
      const tickMs = clampTick(parsed.segments[0]?.tickMs);
      if (tickMs !== null) return tickMs;
    }
    const legacy = clampTick(parsed?.tickMs);
    if (legacy !== null) return legacy;
  } catch { /* 没有文件或损坏都按默认 */ }
  return fallback;
}

// 兼容旧调用：写成单段（会覆盖多段，仅供旧测试/旧接口使用）。
export function writeHeartbeatMs(ms) {
  const clamped = clampTick(ms);
  if (clamped === null) throw new Error('心跳间隔必须是数字（毫秒）');
  writeStoredSegments([{ start: '00:00', end: '24:00', tickMs: clamped }]);
  return clamped;
}

export const name = 'dsh-dshai-bus';
export const version = '0.0.12';
export const BUS_SERVICE = 'cognition-bus';
export const INTENTS_KEY = 'cognition-intents';

/**
 * 诊断日志：把"自动启动为什么没跑起来"落盘。
 * 之前 tryAutoStartOwnerSession 的 catch 是空的，任何失败都不可见。
 *
 * 注意：绝不能读 ctx.baseDir —— 那是需要 inject 声明的服务属性，
 * 未声明时访问会直接抛错，插件会变成 fiberPhase=failed。
 * 因此只用环境变量 / cwd / 临时目录。
 */
function diagDirs() {
  const dirs = [];
  if (process.env.DSH_HOME) dirs.push(join(process.env.DSH_HOME, 'dsh-dshai', 'bus'));
  try { dirs.push(join(process.cwd(), 'dsh-dshai', 'bus')); } catch { /* cwd 不可用时跳过 */ }
  dirs.push(join(tmpdir(), 'dshai-bus'));
  return dirs;
}

function createDiag() {
  const candidates = diagDirs();

  function write(entry) {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n';
    for (const dir of candidates) {
      try {
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, 'diag.log'), line);
        return dir;
      } catch { /* 换下一个候选目录 */ }
    }
    return null;
  }

  // 启动时清空上一次的诊断，只保留本次运行。
  for (const dir of candidates) {
    try { writeFileSync(join(dir, 'diag.log'), ''); break; } catch { /* 换下一个 */ }
  }

  return write;
}


function normalizeOptions(raw) {
  const config = raw && typeof raw === 'object' ? raw : {};
  const tools = config.tools && typeof config.tools === 'object' ? config.tools : {};
  const allowTools = Array.isArray(config.allowTools)
    ? config.allowTools.filter(name => typeof name === 'string' && name.length > 0)
    : null;
  const scheduler = config.scheduler && typeof config.scheduler === 'object' ? config.scheduler : {};
  const ownerSession = config.ownerSession && typeof config.ownerSession === 'object' ? config.ownerSession : {};
  const sendMode = ownerSession.sendMode === 'real' ? 'real' : 'dry-run';
  return {
    prefix: typeof config.prefix === 'string' && config.prefix.length > 0 ? config.prefix : 'bus',
    tools: {
      bilibili: tools.bilibili !== false,
      timeoutMs: Number.isFinite(tools.timeoutMs) ? tools.timeoutMs : 10_000
    },
    allowTools,
    scheduler: {
      enabled: scheduler.enabled === true,
      tickMs: Number.isFinite(scheduler.tickMs) ? scheduler.tickMs : 60_000,
      // 多时段初始值；settings.json 存在时以运行配置为准。
      segments: Array.isArray(scheduler.segments) ? scheduler.segments : null,
      // tick 默认带 allowBrowse：cognition 只在 tick 且带此标记时才会把
      // bilibili.browse 放进 capabilities，她才能自己"去看一眼"。
      allowBrowse: scheduler.allowBrowse !== false
    },
    ownerSession: {
      enabled: ownerSession.enabled === true,
      ownerMid: typeof ownerSession.ownerMid === 'string' ? ownerSession.ownerMid.trim() : '',
      pollMs: Number.isFinite(ownerSession.pollMs) ? ownerSession.pollMs : 10_000,
      size: Number.isFinite(ownerSession.size) ? ownerSession.size : 10,
      sendMode,
      // 历史闸门：早于此时刻（毫秒）的消息一律忽略，避免开机时把旧测试私信当新消息回复。
      sinceMs: Number.isFinite(ownerSession.sinceMs) ? ownerSession.sinceMs : 0,
      // 默认只生效一次：第一次会话用它挡住历史消息，之后重启不再生效。
      sinceMsOnce: ownerSession.sinceMsOnce !== false,
      // 自适应轮询：最近有来往用 pollMs，空闲降到 idlePollMs，失败指数退避。
      adaptive: ownerSession.adaptive !== false,
      idlePollMs: Number.isFinite(ownerSession.idlePollMs) ? ownerSession.idlePollMs : 60_000,
      activeWindowMs: Number.isFinite(ownerSession.activeWindowMs) ? ownerSession.activeWindowMs : 120_000,
      backoffMaxMs: Number.isFinite(ownerSession.backoffMaxMs) ? ownerSession.backoffMaxMs : 300_000,
      retryMs: Number.isFinite(ownerSession.retryMs) ? ownerSession.retryMs : 10_000
    }
  };
}

export function apply(ctx, rawConfig = {}) {
  const config = normalizeOptions(rawConfig);
  const bus = createCognitionBus({ prefix: config.prefix });
  const intentIssuer = createIntentIssuer({ provider: 'dsh-dshai-autonomy' });
  const diag = createDiag();

  // 记录"插件实际收到并归一化后的配置"。补丁层是整体替换 config，
  // 少写一个字段就会静默变默认值——这一行就是为了让那种情况立刻可见。
  diag({
    step: 'apply',
    effective: {
      prefix: config.prefix,
      scheduler: config.scheduler,
      ownerSession: {
        enabled: config.ownerSession.enabled,
        ownerMid: config.ownerSession.ownerMid,
        pollMs: config.ownerSession.pollMs,
        size: config.ownerSession.size,
        sendMode: config.ownerSession.sendMode,
        sinceMs: config.ownerSession.sinceMs,
        sinceMsOnce: config.ownerSession.sinceMsOnce,
        retryMs: config.ownerSession.retryMs
      }
    },
    rawOwnerSession: rawConfig && typeof rawConfig === 'object' ? rawConfig.ownerSession ?? null : null,
    dshHomeSet: Boolean(process.env.DSH_HOME)
  });

  // ---- tick 时段表 ----
  const initialSchedule = normalizeSegments(config.scheduler.segments, {
    fallbackTickMs: config.scheduler.tickMs
  });
  let segments = initialSchedule.segments;
  if (!initialSchedule.ok) {
    diag({ step: 'tick-schedule-invalid', errors: initialSchedule.errors.slice(0, 6) });
  }
  const storedSchedule = readStoredSegments({ fallbackTickMs: config.scheduler.tickMs });
  if (storedSchedule.segments) {
    segments = storedSchedule.segments;
  } else if (storedSchedule.errors?.length) {
    diag({ step: 'tick-schedule-invalid', source: 'settings.json', errors: storedSchedule.errors.slice(0, 6) });
  }
  let scheduleErrorLogged = false;
  // 每次都读 settings.json：用户手动改文件、DSHAI 改当前段都能即时生效；
  // 非法配置保留上一份有效值，绝不让进程启动失败。
  function loadSegments() {
    const stored = readStoredSegments({ fallbackTickMs: config.scheduler.tickMs });
    if (stored.segments) {
      segments = stored.segments;
      scheduleErrorLogged = false;
    } else if (stored.errors?.length && !scheduleErrorLogged) {
      scheduleErrorLogged = true;
      diag({ step: 'tick-schedule-invalid', source: 'settings.json', errors: stored.errors.slice(0, 6) });
    }
    return segments;
  }
  function currentSegment(now = Date.now()) {
    return segmentAt(loadSegments(), now);
  }
  function setCurrentSegmentTick(ms) {
    const clamped = clampTick(ms);
    if (clamped === null) throw new Error('tick 间隔必须是 1 分钟到 24 小时之间的数字');
    const now = Date.now();
    const list = loadSegments().map(seg => ({ ...seg }));
    const target = segmentAt(list, now);
    if (!target) throw new Error('当前时间不在任何 tick 时段内');
    target.tickMs = clamped;
    segments = writeStoredSegments(list);
    diag({ step: 'tick-set', via: 'current-segment', segment: segmentView(target), at: new Date(now).toISOString() });
    return target;
  }

  if (config.tools.bilibili) {    bus.registerTool('bilibili.browse', createBilibiliBrowseTool({
      timeoutMs: config.tools.timeoutMs,
      getService: () => (typeof ctx.get === 'function' ? ctx.get('bilibili') : null)
    }));

    // 她的能力目录里原来只有"看热门"；把 B 站其余只读能力也接进来。
    // 都由 bilibili 插件提供（登录态/风控/内容许可都在插件内部），总线只做适配。
    for (const tool of createBilibiliExtraTools({
      getService: () => (typeof ctx.get === 'function' ? ctx.get('bilibili') : null)
    })) {
      bus.registerTool(tool.name, {
        readOnly: tool.readOnly === true,
        cost: tool.cost ?? 'free',
        description: tool.description,
        args: tool.args,
        invoke: tool.invoke
      });
    }
  }

  // 她自己也能调心跳：只能改“当前所在时段”的间隔，不碰时段边界。
  bus.registerTool('heartbeat.set', {
    readOnly: false,
    selfService: true,
    cost: 'free',
    description: '调整“当前 tick 时段”的唤醒间隔，单位分钟，1-1440。只影响自己多久被叫醒一次，不对外界做任何事；不能修改时段边界。',
    args: { minutes: [1, 1440] },
    async invoke(args = {}) {
      try {
        const target = setCurrentSegmentTick(Number(args?.minutes) * 60_000);
        diag({ step: 'heartbeat-set', via: 'tool', tickMs: target.tickMs });
        return {
          ok: true,
          tool: 'heartbeat.set',
          tickMs: target.tickMs,
          minutes: Math.round(target.tickMs / 60_000),
          segment: segmentView(target)
        };
      } catch (error) {
        return { ok: false, error: { code: 'heartbeat-set-failed', message: String(error?.message ?? error).slice(0, 160) } };
      }
    }
  });

  // 只读：让她知道一天怎么分段、当前在哪一段、下一次什么时候醒。
  bus.registerTool('tick.schedule', {
    readOnly: true,
    cost: 'free',
    description: '查看自己的 tick 时段表：各段起止、间隔、当前段和下一次 tick 时间。',
    args: {},
    async invoke() {
      const list = loadSegments();
      const now = Date.now();
      const current = segmentAt(list, now);
      const next = nextTickAt(list, now);
      return {
        ok: true,
        tool: 'tick.schedule',
        segments: list.map(segmentView),
        current: current ? segmentView(current) : null,
        nextTickAt: next ? new Date(next).toISOString() : null
      };
    }
  });

  if (config.allowTools) {
    const allowed = new Set(config.allowTools);
    bus.setPolicy(({ tool }) => (allowed.has(tool.name)
      ? { ok: true }
      : { ok: false, reason: 'bus-tool-denied' }));
  }

  let bound = false;
  function bindIfPossible() {
    if (bound) return true;
    const service = typeof ctx.get === 'function' ? ctx.get('cognition') : null;
    if (!service) return false;
    bus.bind(service);
    bound = true;
    return true;
  }

  async function submit(intent) {
    if (!bindIfPossible()) {
      throw new Error('cognition bus 尚未绑定：cognition 服务不存在或还没有加载');
    }
    return bus.submit(intent);
  }

  let scheduler = null;
  if (config.scheduler.enabled) {
    scheduler = createIntervalScheduler({
      tickMs: config.scheduler.tickMs,
      // 由时段表决定下一次绝对 tick；settings.json 改动无需重启。
      nextTickAtOf: () => nextTickAt(loadSegments(), Date.now()),
      intervalPayload: config.scheduler.allowBrowse ? { allowBrowse: true } : {},
      // 内核不再硬编码工具名：每次 tick/wake 都把当前工具目录随事件下发。
      capabilitiesOf: () => bus.capabilities(),
      ingest: async (event) => {
        if (!bindIfPossible()) return;
        await bus.ingest(event);
      }
    });
    bus.setScheduler(scheduler.schedule);
  }

  let ownerSession = null;
  let autoRetry = null;

  // sinceMs 的"只生效一次"：用标记文件记录已用过闸门。
  // 删除该文件即可重新武装（下次启动会再次挡掉早于 sinceMs 的消息）。
  function sessionCutoff() {
    return resolveHistoryCutoff({
      sinceMs: config.ownerSession.sinceMs,
      once: config.ownerSession.sinceMsOnce,
      // 同样不读 ctx.baseDir：未声明 inject 时访问会抛错。
      baseDir: process.env.DSH_HOME || process.cwd()
    });
  }

  function startOwnerSession(options = {}) {
    if (ownerSession) throw new Error('owner session 已经启动');
    const bili = typeof ctx.get === 'function' ? ctx.get('bilibili') : null;
    if (!bili) throw new Error('bilibili 服务不存在，无法启动 owner session');
    if (!bindIfPossible()) throw new Error('cognition 服务不存在，无法启动 owner session');
    ownerSession = createOwnerSession({
      bili,
      facade,
      getService: () => (typeof ctx.get === 'function' ? ctx.get('cognition') : null),
      sinceMs: sessionCutoff(),
      adaptive: config.ownerSession.adaptive,
      idlePollMs: config.ownerSession.idlePollMs,
      activeWindowMs: config.ownerSession.activeWindowMs,
      backoffMaxMs: config.ownerSession.backoffMaxMs,
      capabilitiesOf: () => bus.capabilities(),
      onDiag: diag,
      logger: console,
      ...options
    });
    bus.setTransport(ownerSession.transport);
    ownerSession.start();
    return ownerSession;
  }

  function stopOwnerSession() {
    if (!ownerSession) return;
    ownerSession.stop();
    ownerSession = null;
  }

  let autoStarting = false;

  async function tryAutoStartOwnerSession() {
    if (!config.ownerSession.enabled || ownerSession || autoStarting) {
      if (!ownerSession && !autoStarting) {
        diag({ step: 'auto-skip', reason: 'ownerSession.enabled 不是 true', enabled: config.ownerSession.enabled });
      }
      return;
    }
    const bili = typeof ctx.get === 'function' ? ctx.get('bilibili') : null;
    const cognitionBound = bindIfPossible();
    if (!bili || !cognitionBound) {
      diag({ step: 'auto-missing-service', hasBili: Boolean(bili), cognitionBound });
      return;
    }
    autoStarting = true;
    try {
      const status = await bili.socialStatus();
      diag({
        step: 'auto-status',
        active: status?.active ?? null,
        bindingValid: status?.bindingValid ?? null,
        grants: Array.isArray(status?.grants) ? status.grants.length : (status?.grants ?? null),
        revoked: status?.revoked ?? null,
        ownerMid: status?.ownerMid ?? null,
        selfMid: status?.selfMid ?? null,
        sessionId: status?.sessionId ?? null
      });
      if (!status?.active || !status?.bindingValid) {
        diag({ step: 'auto-blocked', reason: 'active 或 bindingValid 为假', active: status?.active ?? null, bindingValid: status?.bindingValid ?? null });
        return;
      }
      if (ownerSession) return;
      const ownerMid = config.ownerSession.ownerMid || String(status.ownerMid ?? '');
      if (!/^\d{5,20}$/.test(ownerMid)) {
        diag({ step: 'auto-blocked', reason: 'ownerMid 非法', ownerMid });
        return;
      }
      const sessionId = status.sessionId ?? null;
      startOwnerSession({
        ownerMid,
        pollMs: config.ownerSession.pollMs,
        size: config.ownerSession.size,
        sendMode: config.ownerSession.sendMode,
        readIntent: () => {
          const intentId = `bus-read-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const intent = intentIssuer.issue({
            decisionId: intentId,
            intentId,
            capabilityId: 'dm.read',
            targetMid: ownerMid,
            sessionId
          });
          return { intent, intentId };
        },
        sendIntent: ({ text }) => {
          const intentId = `bus-send-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const intent = intentIssuer.issue({
            decisionId: intentId,
            intentId,
            capabilityId: 'dm.send',
            targetMid: ownerMid,
            text,
            sessionId
          });
          return { intent, intentId };
        }
      });
      diag({ step: 'auto-started', ownerMid });
    } catch (error) {
      diag({
        step: 'auto-error',
        message: String(error?.message ?? error).slice(0, 300),
        code: error?.code ?? null,
        stack: String(error?.stack ?? '').split('\n').slice(0, 3).join(' | ')
      });
    } finally {
      autoStarting = false;
    }
  }

  function dispose() {
    if (autoRetry) {
      clearInterval(autoRetry);
      autoRetry = null;
    }
    stopOwnerSession();
    scheduler?.dispose();
    scheduler = null;
    bus.dispose();
  }

  const facade = {
    name,
    version,
    bus,
    submit,
    startOwnerSession,
    stopOwnerSession,
    ownerSessionStatus: () => (ownerSession ? ownerSession.status() : null),
    bind: () => {
      if (!bindIfPossible() && !bound) throw new Error('cognition 服务不存在或还没有加载');
      return bound;
    },
    status: () => ({
      bound,
      capabilities: bus.capabilities(),
      submitted: bus.submitted.length,
      ownerSession: {
        enabled: config.ownerSession.enabled,
        running: ownerSession !== null,
        sendMode: config.ownerSession.sendMode,
        state: ownerSession ? ownerSession.status() : null
      },
      scheduler: scheduler
        ? { enabled: true, tickMs: scheduler.tickMs, ticks: scheduler.ticks(), pending: scheduler.pending() }
        : { enabled: false }
    }),
    capabilities: () => bus.capabilities(),
    heartbeat: () => {
      const current = currentSegment();
      return {
        tickMs: current?.tickMs ?? null,
        current: current ? segmentView(current) : null,
        segments: loadSegments().map(segmentView),
        minMs: HEARTBEAT_MIN_MS,
        maxMs: HEARTBEAT_MAX_MS,
        schedulerEnabled: Boolean(scheduler)
      };
    },
    setHeartbeat: ms => {
      const target = setCurrentSegmentTick(ms);
      return { tickMs: target.tickMs, segment: segmentView(target) };
    },
    schedule: () => {
      const list = loadSegments();
      const now = Date.now();
      const current = segmentAt(list, now);
      const next = nextTickAt(list, now);
      return {
        segments: list.map(segmentView),
        current: current ? segmentView(current) : null,
        nextTickAt: next ? new Date(next).toISOString() : null,
        now: new Date(now).toISOString()
      };
    },
    setSchedule: rawSegments => {
      const checked = normalizeSegments(rawSegments, { fallbackTickMs: config.scheduler.tickMs });
      if (!checked.ok) throw new Error(checked.errors.join('；'));
      segments = writeStoredSegments(checked.segments);
      diag({ step: 'tick-schedule-set', via: 'ui', segments: segments.map(segmentView) });
      return { segments: segments.map(segmentView) };
    },
    registerTool: (...args) => bus.registerTool(...args),
    setTransport: (...args) => bus.setTransport(...args),
    setScheduler: (...args) => bus.setScheduler(...args),
    setPolicy: (...args) => bus.setPolicy(...args),
    dispose
  };

  ctx.plugin(IntentKeyPlugin, { publicInfo: intentIssuer.publicInfo });
  ctx.provide(INTENTS_KEY, { submit });
  ctx.provide(BUS_SERVICE, facade);
  scheduler?.start();
  diag({
    step: 'boot',
    schedulerStarted: Boolean(scheduler),
    schedulerTickMs: config.scheduler.tickMs,
    ownerSessionEnabled: config.ownerSession.enabled,
    retryMs: config.ownerSession.retryMs
  });

  if (config.ownerSession.enabled) {
    autoRetry = setInterval(() => { void tryAutoStartOwnerSession(); }, config.ownerSession.retryMs);
    autoRetry.unref?.();
    void tryAutoStartOwnerSession();
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => dispose());
  }

  return dispose;
}
