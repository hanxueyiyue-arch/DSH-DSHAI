// 精力日收支回归测试（2026-11-24 调参）。
//
// 背景：线上真实负载约每天 103 次工具调用 + 58 次非工具活动，可恢复空闲约 18.9 小时。
// 旧表 resultOk=-1 → 消耗 108 点/天 vs 恢复 37.9 点/天，净亏 71 点/天，
// 精力长期在 20~50 徘徊（fatigueStart=60，于是长期处于疲劳态）。
//
// 这个测试锁三件事：
//   1. 单次成本就是调过的那组数（别人手滑改回去会被抓）；
//   2. 回能速率与空闲门槛**没有**跟着动（那是有意保持的）；
//   3. 用真实负载算出的日收支落在合理区间（既不会一天烧穿，也不会永远顶在 100）。
const COG = new URL('../packages/cognition/lib/', import.meta.url).href;
const { MOOD_EVENT_TABLE, sendEvent, resultEvent } = await import(`${COG}self/mood-events.js`);
const { MOOD_PARAMS, settleIdle, settle, fatigue } = await import(`${COG}self/mood.js`);

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('PASS', name); }
  else { fail += 1; console.log('FAIL', name, extra); }
};

// ---------- 1. 成本表 ----------
const expected = {
  reply: -0.05,
  proactive: -0.1,
  resultOk: -0.2,
  resultFail: -0.3,
  timeout: 0,
  positive: 0,
  negative: -0.2,
  careContinued: 0
};
for (const [kind, cost] of Object.entries(expected)) {
  check(`成本 ${kind} = ${cost}`, MOOD_EVENT_TABLE[kind]?.energyCost === cost, String(MOOD_EVENT_TABLE[kind]?.energyCost));
}

// ---------- 2. 事件构造走的是同一张表 ----------
check('sendEvent 被动回复 = -0.05',
  sendEvent({ actionId: 'a1', at: 1 })?.energyCost === -0.05);
check('sendEvent 主动开口 = -0.1',
  sendEvent({ actionId: 'a2', at: 1, proactive: true })?.energyCost === -0.1);
check('resultEvent 成功 = -0.2', resultEvent({ correlationId: 'c1', at: 1, ok: true })?.energyCost === -0.2);
check('resultEvent 失败 = -0.3', resultEvent({ correlationId: 'c2', at: 1, ok: false })?.energyCost === -0.3);

// ---------- 3. 回能与空闲门槛：有意保持不变 ----------
check('energyRecoveryPerHour 仍是 2（未改）', MOOD_PARAMS.energyRecoveryPerHour === 2, String(MOOD_PARAMS.energyRecoveryPerHour));
check('idleGraceMinutes 仍是 15（未改）', MOOD_PARAMS.idleGraceMinutes === 15, String(MOOD_PARAMS.idleGraceMinutes));
check('energyMax/Min 仍是 100/0', MOOD_PARAMS.energyMax === 100 && MOOD_PARAMS.energyMin === 0);
check('fatigueStart 仍是 60（未改）', MOOD_PARAMS.fatigueStart === 60, String(MOOD_PARAMS.fatigueStart));

// ---------- 4. 空闲回能行为 ----------
const HOUR = 3600_000;
function affectAt(energy, lastActivityAgoHours, now) {
  return {
    version: 2, valence: 0.4, arousal: 0.3, energy,
    lastActivityAt: now - lastActivityAgoHours * HOUR,
    at: now - lastActivityAgoHours * HOUR,
    processedEventIds: []
  };
}
{
  const now = 1_800_000_000_000;
  // 空闲 1 小时：前 15 分钟不算，只有 0.75 小时回能 → +1.5
  const a = settleIdle(affectAt(50, 1, now), { now }).affect;
  check('空闲 1 小时回 +1.5（15 分钟 grace）', Math.abs(a.energy - 51.5) < 0.01, String(a.energy));

  // 空闲 10 小时：9.75 小时 × 2 = +19.5
  const b = settleIdle(affectAt(50, 10, now), { now }).affect;
  check('空闲 10 小时回 +19.5', Math.abs(b.energy - 69.5) < 0.01, String(b.energy));

  // 刚活动完（还在 grace 内）不回能
  const c = settleIdle(affectAt(50, 0.1, now), { now }).affect;
  check('活动后 grace 内不回能', Math.abs(c.energy - 50) < 0.01, String(c.energy));

  // 回能不过 100
  const d = settleIdle(affectAt(95, 10, now), { now }).affect;
  check('回能封顶 100', Math.abs(d.energy - 100) < 1e-9, String(d.energy));
}

// ---------- 5. 一个事件真的只扣一次、不重复扣 ----------
{
  const now = 1_800_000_000_000;
  const start = { version: 2, valence: 0.4, arousal: 0.3, energy: 50, lastActivityAt: now - HOUR, at: now - HOUR, processedEventIds: [] };
  const ev = resultEvent({ correlationId: 'cx', at: now, ok: true });
  const once = settle(start, { now, events: [ev] });
  check('成功一次扣 0.2（含 1h 空闲 +1.5）', Math.abs(once.affect.energy - (50 + 1.5 - 0.2)) < 0.01, String(once.affect.energy));
  const twice = settle(once.affect, { now, events: [ev] });
  check('同一 id 不重复扣', Math.abs(twice.affect.energy - once.affect.energy) < 1e-9, String(twice.affect.energy));
}

// ---------- 6. 用真实负载算日收支 ----------
{
  const TOOL_CALLS_PER_DAY = 103;   // 2026-11-24 实测
  const LIGHT_ACTIONS_PER_DAY = 58; // owner-message + self-turn 实测
  const IDLE_HOURS_PER_DAY = 18.9;  // 相邻活动间隔扣除 15 分钟 grace 后的总和
  const spend = TOOL_CALLS_PER_DAY * 0.2 + LIGHT_ACTIONS_PER_DAY * 0.05;
  const gain = IDLE_HOURS_PER_DAY * MOOD_PARAMS.energyRecoveryPerHour;
  const net = gain - spend;
  console.log(`\n日收支：消耗 ${spend.toFixed(1)} / 恢复 ${gain.toFixed(1)} / 净 ${net >= 0 ? '+' : ''}${net.toFixed(1)} 点`);
  check('日消耗落在 20~35 点（不再一天烧穿 100）', spend >= 20 && spend <= 35, spend.toFixed(1));
  check('日净收支在 ±15 点以内（不会单向耗光，也不会永远顶格）', Math.abs(net) <= 15, net.toFixed(1));
  check('旧表同负载会净亏 70 点以上（说明这次确实是在修问题）',
    (IDLE_HOURS_PER_DAY * 2 - (TOOL_CALLS_PER_DAY * 1 + LIGHT_ACTIONS_PER_DAY * 0.1)) < -60);
}

// ---------- 7. 疲劳态阈值仍然是 60（说明 25 点确实算"很累"） ----------
check('energy=25 时疲劳度约 0.58', Math.abs(fatigue(25) - 0.5833) < 0.01, fatigue(25).toFixed(4));
check('energy=70 时无疲劳', fatigue(70) === 0, String(fatigue(70)));

console.log(`\n结果：pass=${pass} fail=${fail}`);
if (fail > 0) process.exitCode = 1;
