// 蒸馏适配器契约：distillTurn 必须返回**数组**，且必须把 usage 交回预算闸门。
//
// 2026-11-24 实测到的两个连带故障（都已在这条测试里钉住）：
//   1. distillOnce 返回裸数组 → gate.wrap 取 outcome.result/usage 都是 undefined
//      → 预留永不结算（每条白占 0.0512 元，一天亏 1.2~1.5 元额度）
//      → 且 distillTurn 把 { result, budget } 整个对象返回，调用方 Array.isArray 为假
//      → 提炼结果被丢弃（库里 observation-distilled 记忆 0 条，而原料 94 条）。
//   2. 所以正确形状是 { result: items[], usage }，distillTurn 只把 result 交出去。
//
// 测试走真实入口 + 假宿主，断言"gate 实际收到什么"和"调用方实际拿到什么"。
const COG = new URL('../packages/cognition/lib/', import.meta.url).href;
const { createHostDistillTurn } = await import(`${COG}decide/host-distill.js`);

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('PASS', name); }
  else { fail += 1; console.log('FAIL', name, extra); }
};

const USAGE = { inputTokens: 21000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 900 };
const ITEMS = [{ fromId: 'obs-1', title: '示例主题', content: '我看了内共生假说的动画。', tags: ['生物'] }];

// 假宿主：followup 时同步触发 assistant/message 事件（带 usage）和内容
function fakeCtx(items = ITEMS, usage = USAGE, emitUsage = true) {
  const listeners = [];
  return {
    get: key => (key === 'agents' ? {
      create: async ({ sessionId }) => ({
        agent: {
          session: { id: sessionId },
          ctx: {},
          followup: async () => {
            for (const fn of listeners) {
              if (emitUsage) {
                fn({ id: sessionId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: JSON.stringify({ items }) }], usage } } });
              } else {
                fn({ id: sessionId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: JSON.stringify({ items }) }] } } });
              }
            }
          },
          whenIdle: async () => {}
        },
        dispose: async () => {}
      })
    } : undefined),
    on: (name, handler) => { listeners.push(handler); return () => {}; }
  };
}

// ---------- 1. 没有预算闸门：返回数组 ----------
{
  const distillTurn = createHostDistillTurn({ ctx: fakeCtx(), logger: { warn() {} } });
  const out = await distillTurn({ observations: [{ id: 'obs-1', title: '内共生', content: '原文' }] });
  check('无闸门时返回数组（不是 {result,budget} 对象）', Array.isArray(out), typeof out);
  check('无闸门时结果内容正确', Array.isArray(out) && out[0]?.fromId === 'obs-1', JSON.stringify(out));
}

// ---------- 2. 有闸门：调用方拿到数组，gate 拿到 usage ----------
{
  let captured = null;
  const budgetGate = {
    wrap: async (meta, run) => {
      captured = await run();               // 模拟真实 gate：先跑 run，再看 outcome
      return { result: captured?.result ?? null, budget: { level: 'open' } };
    }
  };
  const distillTurn = createHostDistillTurn({ ctx: fakeCtx(), budgetGate, logger: { warn() {} } });
  const out = await distillTurn({ observations: [{ id: 'obs-1', title: '内共生', content: '原文' }] });

  check('有闸门时调用方拿到的仍是数组', Array.isArray(out), typeof out);
  check('有闸门时结果内容正确', Array.isArray(out) && out[0]?.title === '示例主题', JSON.stringify(out));
  check('gate 收到的 outcome 带 result 字段', Array.isArray(captured?.result), typeof captured?.result);
  check('gate 收到的 outcome 带 usage（否则永不结算）', captured?.usage !== null && captured?.usage !== undefined, String(captured?.usage));
  check('usage 四个字段齐全', ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'].every(k => Number.isFinite(captured?.usage?.[k])), JSON.stringify(captured?.usage));
  check('usage 总量不为 0（gate 用 totalUsageTokens 判断能否结算）', (captured.usage.inputTokens + captured.usage.outputTokens) > 0);
}

// ---------- 3. 宿主没给 usage：返回结果仍然可用，但 usage 为 null（由 gate 走待对账） ----------
{
  let captured = null;
  const budgetGate = { wrap: async (meta, run) => { captured = await run(); return { result: captured?.result ?? null, budget: null }; } };
  const distillTurn = createHostDistillTurn({ ctx: fakeCtx(ITEMS, USAGE, false), budgetGate, logger: { warn() {} } });
  const out = await distillTurn({ observations: [{ id: 'obs-1', title: 'x', content: 'y' }] });
  check('无 usage 时结果不受影响', Array.isArray(out) && out.length === 1);
  check('无 usage 时显式返回 null（不是 undefined，便于 gate 判断）', captured?.usage === null, String(captured?.usage));
}

// ---------- 4. 提炼器的提示词仍然禁止写「用户」相关内容 ----------
{
  console.log(`\n结果：pass=${pass} fail=${fail}`);
  if (fail > 0) process.exitCode = 1;
}
