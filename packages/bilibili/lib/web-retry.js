// Dashboard 注册重试：webServer 可能晚于插件就绪，也可能只提供了半个对象。
// 只有 register 是可调用函数、且注册函数返回 disposer 时才算成功。
export function createWebRetry({
  getWebServer,
  register,
  log = () => {},
  initialDelay = 250,
  maxDelay = 5_000,
  timers = { setTimeout, clearTimeout },
} = {}) {
  let dispose = null;
  let timer = null;
  let stopped = false;
  let delay = initialDelay;

  const tryRegister = () => {
    if (stopped || dispose) return dispose;
    const web = getWebServer();
    if (!web || typeof web.register !== 'function') return null;
    try {
      const registered = register(web);
      if (typeof registered === 'function') dispose = registered;
    } catch (error) {
      log(error);
    }
    return dispose;
  };

  const schedule = () => {
    if (stopped || dispose) return;
    timer = timers.setTimeout(() => {
      timer = null;
      tryRegister();
      if (stopped || dispose) return;
      delay = Math.min(delay * 2, maxDelay);
      schedule();
    }, delay);
    timer?.unref?.();
  };

  const start = () => {
    tryRegister();
    if (!dispose) schedule();
  };

  const stop = () => {
    stopped = true;
    if (timer) timers.clearTimeout(timer);
    timer = null;
    const registered = dispose;
    dispose = null;
    registered?.();
  };

  return {
    start,
    stop,
    tryRegister,
    get dispose() { return dispose; },
    get delay() { return delay; },
  };
}
