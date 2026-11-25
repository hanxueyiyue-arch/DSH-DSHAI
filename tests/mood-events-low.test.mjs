// 低敏感事件表：单次变化幅度与结算结果
const COG = new URL('../packages/cognition/lib/', import.meta.url).href;
const M = await import(`${COG}self/mood.js`);
const E = await import(`${COG}self/mood-events.js`);

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('PASS', name); }
  else { fail += 1; console.log('FAIL', name, extra); }
};

const table = {
  resultOk: [0.03, 0.02],
  resultFail: [-0.03, 0.02],
  positive: [0.07, 0.02],
  negative: [-0.06, 0.015],
  timeout: [-0.03, 0.02],
  careContinued: [0.02, 0]
};

for (const [kind, [dV, dA]] of Object.entries(table)) {
  const row = E.MOOD_EVENT_TABLE[kind];
  check(`${kind} 幅度`, row?.dV === dV && row?.dA === dA, JSON.stringify(row));
}

// 精力 70 时 F=0，正面/负面不放大；验证单次结算
const now = Date.now();
const base = M.blankAffect(now);
base.energy = 70;
base.valence = 0.2;
base.arousal = 0.3;
base.at = now;
base.lastActivityAt = now;

const pos = M.settle(base, { now: now + 1000, events: [E.feedbackEvent({ actionId: 'a1', at: now + 1000, feedback: 'explicit-positive' })] }).affect;
check('明确肯定只 +0.07', Math.abs(pos.valence - 0.27) < 1e-3, String(pos.valence));
check('明确肯定激活 +0.02', Math.abs(pos.arousal - 0.32) < 1e-3, String(pos.arousal));

const ok = M.settle(base, { now: now + 1000, events: [E.resultEvent({ correlationId: 'c1', at: now + 1000, ok: true })] }).affect;
check('工具成功只 +0.03', Math.abs(ok.valence - 0.23) < 1e-3, String(ok.valence));

const neg = M.settle(base, { now: now + 1000, events: [E.feedbackEvent({ actionId: 'a2', at: now + 1000, feedback: 'explicit-negative' })] }).affect;
check('明确否定只 -0.06', Math.abs(neg.valence - 0.14) < 1e-3, String(neg.valence));

console.log(`\n结果：pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);

