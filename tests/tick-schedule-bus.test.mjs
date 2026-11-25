// bus 集成：时段表 + heartbeat.set 只改当前段 + tick.schedule 只读
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BUS = new URL('../packages/bus/lib/index.js', import.meta.url).href;
const S = await import(new URL('../packages/bus/lib/tick-schedule.js', import.meta.url).href);

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('PASS', name); }
  else { fail += 1; console.log('FAIL', name, extra); }
};

const home = mkdtempSync(join(tmpdir(), 'tick-bus-'));
process.env.DSH_HOME = home;

function makeCtx() {
  const provided = new Map();
  const ALLOWED = new Set(['get', 'provide', 'plugin', 'effect', 'on', 'emit', 'logger']);
  const ctx = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return undefined;
      if (!ALLOWED.has(prop)) throw new Error(`cannot get property "${String(prop)}" without inject`);
      if (prop === 'get') return () => null;
      if (prop === 'provide') return (key, value) => { provided.set(key, value); };
      if (prop === 'plugin' || prop === 'effect' || prop === 'on' || prop === 'emit') return () => undefined;
      if (prop === 'logger') return { info() {}, warn() {}, error() {} };
      return undefined;
    }
  });
  return { ctx, provided };
}

try {
  const { ctx, provided } = makeCtx();
  const busModule = await import(BUS);
  busModule.apply(ctx, {
    scheduler: { enabled: true, tickMs: 30 * 60_000 },
    ownerSession: { enabled: false }
  });
  const facade = provided.get('cognition-bus');
  check('cognition-bus 已注册', Boolean(facade));

  const caps = facade.capabilities().map(c => c.tool);
  check('能力含 heartbeat.set 与 tick.schedule', caps.includes('heartbeat.set') && caps.includes('tick.schedule'), JSON.stringify(caps));

  // 默认单段：00:00–24:00 / 30 分钟；下一次 = 下一个 30 分钟边界
  const schedTool = facade.capabilities().find(c => c.tool === 'tick.schedule');
  check('tick.schedule 只读', schedTool?.readOnly === true, JSON.stringify(schedTool));

  facade.bus.bind({ onEvent: async () => ({ accepted: true }) });
  const verdict = facade.bus.canInvoke('tick.schedule', {});
  const listing = await verdict.tool.invoke({});
  check('tick.schedule 可调用', listing?.ok === true, JSON.stringify(listing));
  check('默认 1 段', listing?.segments?.length === 1, JSON.stringify(listing));
  check('默认 30 分钟', listing?.segments?.[0]?.tickMs === 30 * 60_000);
  const expectedNext = S.nextTickAt(S.defaultSegments(30 * 60_000), Date.now());
  check('下一次 tick 为下一个 30 分钟边界', listing?.nextTickAt === new Date(expectedNext).toISOString(), `${listing?.nextTickAt} vs ${new Date(expectedNext).toISOString()}`);

  // 当前段改 45 分钟
  const set1 = await facade.bus.submit({ type: 'invoke', tool: 'heartbeat.set', args: { minutes: 45 }, correlationId: 'c1' });
  check('heartbeat.set 成功', set1?.ok === true, JSON.stringify(set1));
  const file = join(home, 'dsh-dshai', 'bus', 'settings.json');
  let saved = JSON.parse(readFileSync(file, 'utf8'));
  check('设置文件写 segments', Array.isArray(saved.segments) && saved.segments.length === 1, JSON.stringify(saved));
  check('当前段改为 45 分钟', saved.segments[0].tickMs === 45 * 60_000, JSON.stringify(saved));

  // 两段：只改“当前段”，夜间段不动
  const night = { start: '00:00', end: '08:00', tickMs: 2 * 60 * 60_000 };
  const day = { start: '08:00', end: '24:00', tickMs: 30 * 60_000 };
  writeFileSync(file, JSON.stringify({ segments: [night, day] }, null, 2), 'utf8');
  const set2 = await facade.bus.submit({ type: 'invoke', tool: 'heartbeat.set', args: { minutes: 60 }, correlationId: 'c2' });
  check('两段时 heartbeat.set 成功', set2?.ok === true, JSON.stringify(set2));
  saved = JSON.parse(readFileSync(file, 'utf8'));
  check('仍是两段', saved.segments.length === 2, JSON.stringify(saved));
  // 不能假设"当前段就是白天段"：测试在 00:00–08:00 之间跑时，当前段是夜间段。
  // 按真实小时判断哪一段是当前段，再断言"另一段没被改"。
  const hour = new Date().getHours();
  const currentIndex = hour < 8 ? 0 : 1;
  const otherIndex = currentIndex === 0 ? 1 : 0;
  const expectedOther = currentIndex === 0 ? day.tickMs : night.tickMs;
  check('非当前段没有被改', saved.segments[otherIndex].tickMs === expectedOther,
    JSON.stringify({ hour, currentIndex, other: saved.segments[otherIndex] }));
  check('只改了当前段', saved.segments[currentIndex].tickMs === 60 * 60_000,
    JSON.stringify({ hour, currentIndex, current: saved.segments[currentIndex] }));

  facade.dispose();
} finally {
  rmSync(home, { recursive: true, force: true });
  delete process.env.DSH_HOME;
}

console.log(`\n结果：pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);


