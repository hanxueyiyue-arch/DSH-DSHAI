// 绝对时间调度：到点必须 fire 一次，不能重新算 next 后跳过
import { createIntervalScheduler } from '../packages/bus/lib/scheduler.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, extra); } };

function harness(nextValues) {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  const fired = [];
  const setTimer = (fn, ms) => {
    const id = ++seq;
    timers.set(id, { fn, at: now + ms });
    return { id, unref() {} };
  };
  const clearTimer = id => { timers.delete(id?.id ?? id); };
  const scheduler = createIntervalScheduler({
    nextTickAtOf: () => nextValues.shift() ?? null,
    ingest: async event => { fired.push(event.at); },
    clock: () => now,
    setTimer,
    clearTimer,
    logger: { warn() {} }
  });
  return { scheduler, fired, timers, setNow: v => { now = v; }, now: () => now };
}

async function runTimer(t) {
  const entry = [...t.timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
  if (!entry) return null;
  const [id, timer] = entry;
  t.timers.delete(id);
  t.setNow(timer.at);
  await timer.fn();
  return timer.at;
}

{
  const t = harness([1000, 2000, 3000, 4000]);
  t.scheduler.start();
  check('首个计时器在 1000', [...t.timers.values()][0]?.at === 1000);
  await runTimer(t);
  check('到点 fire 一次', t.fired.length === 1 && t.fired[0] === 1000, JSON.stringify(t.fired));
  check('下一个排到 2000', [...t.timers.values()][0]?.at === 2000, JSON.stringify([...t.timers.values()]));
  await runTimer(t);
  check('第二次到点也 fire', t.fired.length === 2 && t.fired[1] === 2000, JSON.stringify(t.fired));
  t.scheduler.stop();
}

{
  const t = harness([null, 70_000, 130_000]);
  t.scheduler.start();
  check('无 tick 时 60s 后重查', [...t.timers.values()][0]?.at === 60_000, JSON.stringify([...t.timers.values()]));
  await runTimer(t);
  check('重查不 fire', t.fired.length === 0, JSON.stringify(t.fired));
  check('查到 70s 后再排', [...t.timers.values()][0]?.at === 70_000, JSON.stringify([...t.timers.values()]));
  await runTimer(t);
  check('70s 到点 fire', t.fired.length === 1 && t.fired[0] === 70_000, JSON.stringify(t.fired));
  t.scheduler.stop();
}

console.log(`\n结果：pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
