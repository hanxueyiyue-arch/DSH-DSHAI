// 公共插件骨架：承接内核意图，执行 send/invoke/wake，并把回执送回内核。
// 只依赖内核的公开契约（意图与 tool-result），不依赖 DSH 宿主。

export const BUS_VERSION = 1;

function errorOf(code, error) {
  const detail = String(error?.message ?? error ?? code).slice(0, 300);
  return {
    code,
    message: detail === code ? code : `[${code}] ${detail}`
  };
}

export function createCognitionBus({ clock = () => Date.now(), prefix = 'bus', logger = console } = {}) {
  const tools = new Map();
  let transport = null;
  let scheduler = null;
  let service = null;
  let policy = null;
  let disposed = false;
  let sequence = 0;
  const submitted = [];

  function assertActive() {
    if (disposed) throw new Error('cognition bus 已释放');
  }

  function registerTool(name, {
    invoke,
    readOnly = true,
    description = '',
    args = null,
    cost = 'free',
    selfService = false,
    limits = null
  } = {}) {
    assertActive();
    if (typeof name !== 'string' || name.length === 0) throw new Error('工具名不能为空');
    if (typeof invoke !== 'function') throw new Error(`工具 ${name} 缺少 invoke`);
    tools.set(name, {
      name,
      invoke,
      readOnly: readOnly === true,
      description,
      args,
      cost,
      selfService: selfService === true,
      limits
    });
  }

  function unregisterTool(name) {
    tools.delete(name);
  }

  function setTransport(send) {
    transport = typeof send === 'function' ? send : null;
  }

  function setScheduler(schedule) {
    scheduler = typeof schedule === 'function' ? schedule : null;
  }

  function setPolicy(fn) {
    policy = typeof fn === 'function' ? fn : null;
  }

  function canInvoke(name, context = {}) {
    const tool = tools.get(name);
    if (!tool) return { ok: false, reason: 'bus-tool-not-found' };
    if (policy) {
      const verdict = policy({ tool, context });
      if (verdict === true) return { ok: true, tool };
      if (verdict === false) return { ok: false, reason: 'bus-tool-denied', tool };
      if (verdict && verdict.ok === true) return { ok: true, tool };
      return { ok: false, reason: verdict?.reason ?? 'bus-tool-denied', tool };
    }
    // 写操作默认拒绝；但"只影响她自己的运行参数"这类自服务工具放行，
    // 它们不对外界产生副作用（例如调整心跳间隔）。
    if (!tool.readOnly && !tool.selfService) return { ok: false, reason: 'bus-write-tool-not-allowed', tool };
    return { ok: true, tool };
  }

  function capabilities() {
    return [...tools.values()].map(({ name, readOnly, selfService, description, args, cost }) => ({
      tool: name,
      readOnly,
      ...(selfService === true ? { selfService: true } : {}),
      description,
      args,
      cost
    }));
  }

  function receipt(intent, ok, result, error) {
    sequence += 1;
    const payload = { correlationId: intent.correlationId, ok, intentType: intent.type };
    if (result !== undefined) payload.result = result;
    if (error) payload.error = error;
    return {
      id: `${prefix}-tool-${clock()}-${sequence}`,
      type: 'tool-result',
      at: clock(),
      actor: { kind: 'tool' },
      payload
    };
  }

  async function deliver(event) {
    if (!service) throw new Error('cognition bus 还没有 bind 到内核');
    await service.onEvent(event);
  }

  async function submit(intent) {
    if (!intent || typeof intent !== 'object' || typeof intent.type !== 'string') {
      throw new Error('cognition bus 只接受意图对象');
    }
    submitted.push(intent);
    try {
      if (intent.type === 'send') {
        if (!transport) throw Object.assign(new Error('没有配置传输'), { code: 'bus-transport-missing' });
        const result = await transport(intent);
        if (result?.ok === false) throw Object.assign(new Error('发送失败'), { code: 'bus-execution-failed' });
        await deliver(receipt(intent, true, result));
        return { ok: true };
      }

      if (intent.type === 'invoke') {
        const verdict = canInvoke(intent.tool, { intent });
        if (!verdict.ok) {
          const error = errorOf(verdict.reason, verdict.reason === 'bus-tool-not-found'
            ? `工具不在目录：${intent.tool}`
            : `工具不允许调用：${intent.tool}`);
          await deliver(receipt(intent, false, null, error));
          return { ok: false, error: error.code };
        }
        const result = await verdict.tool.invoke(intent.args ?? {}, { clock });
        if (result?.ok === false) throw Object.assign(new Error(result.error?.message ?? '工具执行失败'), { code: 'bus-execution-failed' });
        await deliver(receipt(intent, true, result));
        return { ok: true };
      }

      if (intent.type === 'wake') {
        if (!scheduler) throw Object.assign(new Error('没有配置调度器'), { code: 'bus-scheduler-missing' });
        if (!(Number.isFinite(intent.wakeAt) && intent.wakeAt > clock())) {
          throw Object.assign(new Error('唤醒时间必须晚于当前'), { code: 'wake-time-not-future' });
        }
        const result = await scheduler({ at: intent.wakeAt, reason: intent.reason ?? null, correlationId: intent.correlationId });
        await deliver(receipt(intent, true, result));
        return { ok: true };
      }

      throw Object.assign(new Error(`未知意图类型：${intent.type}`), { code: 'bus-execution-failed' });
    } catch (error) {
      const code = error?.code ?? 'bus-execution-failed';
      await deliver(receipt(intent, false, null, errorOf(code, error)));
      return { ok: false, error: code };
    }
  }

  function bind(target) {
    if (!target || typeof target.onEvent !== 'function') throw new Error('bind 需要内核服务');
    service = target;
    return () => {
      service = null;
    };
  }

  async function ingest(event) {
    if (!service) throw new Error('cognition bus 还没有 bind 到内核');
    return service.onEvent(event);
  }

  async function dispose() {
    disposed = true;
    service = null;
    transport = null;
    scheduler = null;
    tools.clear();
  }

  return {
    busVersion: BUS_VERSION,
    registerTool,
    unregisterTool,
    setTransport,
    setScheduler,
    setPolicy,
    canInvoke,
    capabilities,
    submit,
    bind,
    ingest,
    dispose,
    submitted,
    get disposed() {
      return disposed;
    },
    get logger() {
      return logger;
    }
  };
}
