const DEFAULT_TICK_MS = 60_000;
const MIN_TICK_MS = 1_000;
const MAX_DELAY_MS = 24 * 60 * 60 * 1000;

function eventFor(sequence, kind, clock, extra = {}) {
  return {
    id: `bus-${kind}-${clock()}-${sequence}`,
    type: 'tick',
    at: clock(),
    actor: { kind: 'system' },
    payload: { source: kind, ...extra }
  };
}

export function createIntervalScheduler({
  tickMs = DEFAULT_TICK_MS,
  // 每轮都问一次间隔，允许运行期被外部设置改变（心跳可配置）。
  tickMsOf = null,
  // 多时段：返回下一次绝对 tick 时间；返回 null 表示当前没有可 tick 的时段。
  nextTickAtOf = null,
  ingest,
  intervalPayload = { allowBrowse: true },
  capabilitiesOf = null,
  clock = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  logger = console
} = {}) {
  if (typeof ingest !== 'function') throw new Error('scheduler 需要 ingest 回调');
  const intervalMs = Number.isFinite(tickMs) ? Math.max(MIN_TICK_MS, tickMs) : DEFAULT_TICK_MS;
  const intervalExtra = intervalPayload && typeof intervalPayload === 'object' ? intervalPayload : {};

  function currentInterval() {
    if (typeof tickMsOf !== 'function') return intervalMs;
    try {
      const next = Number(tickMsOf());
      if (Number.isFinite(next)) return Math.max(MIN_TICK_MS, Math.min(24 * 60 * 60 * 1000, next));
    } catch { /* 取不到就用构造时的值 */ }
    return intervalMs;
  }

  function nextAt() {
    if (typeof nextTickAtOf !== 'function') return null;
    try {
      const raw = nextTickAtOf();
      if (raw === null || raw === undefined) return null;
      const at = Number(raw);
      return Number.isFinite(at) ? at : null;
    } catch {
      return null;
    }
  }

  function delayFor(at, now) {
    return Math.max(250, Math.min(at - now, MAX_DELAY_MS));
  }

  // 每次 tick 都带上"当前注册的工具目录"，内核据此决定这次能做什么。
  // 新增工具（QQ、发布视频……）不需要改内核，只要在总线上注册。
  function withCapabilities(extra = {}) {
    if (typeof capabilitiesOf !== 'function') return extra;
    try {
      const list = capabilitiesOf();
      return Array.isArray(list) ? { ...extra, capabilities: list } : extra;
    } catch {
      return extra;
    }
  }

  let interval = null;
  let running = false;
  let disposed = false;
  let ticks = 0;
  let wakes = 0;
  let dueAt = null;
  const timers = new Set();

  async function fire(kind, extra) {
    if (disposed) return;
    ticks += 1;
    try {
      await ingest(eventFor(ticks, kind, clock, extra));
    } catch (error) {
      logger?.warn?.(`scheduler tick 失败：${error?.message ?? error}`);
    }
  }

  function start() {
    if (disposed || running) return;
    running = true;

    const scheduleNext = () => {
      if (!running || disposed) return;
      if (typeof nextTickAtOf === 'function') {
        const at = nextAt();
        dueAt = at;
        const now = clock();
        interval = setTimer(loop, at === null ? 60_000 : delayFor(at, now));
      } else {
        dueAt = clock() + currentInterval();
        interval = setTimer(loop, currentInterval());
      }
      interval?.unref?.();
    };

    const loop = async () => {
      if (!running || disposed) return;
      // 计时器到点时 dueAt 就是"应该发生的那个 tick"；不要重新算 next（会算到下一次而永远跳过）。
      const due = dueAt;
      dueAt = null;
      const now = clock();
      if (due !== null && now >= due - 200) {
        await fire('interval', withCapabilities(intervalExtra));
      }
      if (running && !disposed) scheduleNext();
    };

    scheduleNext();
  }

  function stop() {
    running = false;
    dueAt = null;
    if (interval) {
      clearTimer(interval);
      interval = null;
    }
  }

  function schedule({ at, reason = null, correlationId = null } = {}) {
    if (disposed) throw Object.assign(new Error('scheduler 已释放'), { code: 'bus-scheduler-disposed' });
    const now = clock();
    if (!Number.isFinite(at)) throw Object.assign(new Error('唤醒时间必须是数字'), { code: 'wake-time-invalid' });
    if (at <= now) throw Object.assign(new Error('唤醒时间必须晚于当前'), { code: 'wake-time-not-future' });
    const delay = Math.min(at - now, MAX_DELAY_MS);
    wakes += 1;
    const scheduleId = `bus-wake-${wakes}`;
    const timer = setTimer(() => {
      timers.delete(timer);
      // wake 触发的 tick 同样带上能力目录：她约了时间醒来，就该有能力做事。
      fire('wake', withCapabilities({ reason, correlationId, scheduleId, ...intervalExtra }));
    }, delay);
    timer?.unref?.();
    timers.add(timer);
    return { ok: true, scheduleId, at: now + delay };
  }

  function dispose() {
    disposed = true;
    stop();
    for (const timer of timers) clearTimer(timer);
    timers.clear();
  }

  return {
    start,
    stop,
    schedule,
    dispose,
    tickMs: intervalMs,
    ticks: () => ticks,
    pending: () => timers.size,
    get disposed() {
      return disposed;
    }
  };
}
