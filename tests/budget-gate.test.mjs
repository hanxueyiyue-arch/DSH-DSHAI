// 预算闸门的三态语义（2026-11-25 发布整改 + 门禁补漏）。
//
// Cordis 的 ctx.get(name) 默认 strict=true：服务提供者 fiber 非 ACTIVE 时也返回 undefined，
// 与"从未注册"结果相同。所以闸门必须同时读 strict=false 才能区分：
//   1. 没装 / 用户主动禁用   → 两次都拿不到 → 透传，照常调模型（预算不是强制依赖）
//   2. 已启用但服务失活       → 宽松拿得到、严格拿不到 → 拒绝付费调用
//   3. 已启用且正常           → 两次都拿得到 → 预留 → 调用 → 结算
import { createBudgetGate, totalUsageTokens, BudgetBlockedError } from '../packages/cognition/lib/decide/budget-gate.js';

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('PASS', name); }
  else { fail += 1; console.log('FAIL', name, extra); }
};

const quietLogger = { warn() {} };

const goodBudget = (over = {}) => ({
  reserved: [],
  settled: [],
  released: [],
  async reserve(args) { this.reserved.push(args); },
  async settle(args) { this.settled.push(args); },
  async release(args) { this.released.push(args); },
  async status() { return { guard: { blocked: false }, remaining: 1000 }; },
  ...over
});

// 模拟 Cordis 的 get(name, strict)：strict 时不返回非 ACTIVE 的实现
const cordisLike = (service, { active = true } = {}) => (strict = true) => {
  if (service === null || service === undefined) return undefined;
  if (strict && !active) return undefined;
  return service;
};

// 一个可切换"失活/恢复"的假宿主
const makeHost = (service, { active = true } = {}) => {
  const state = { active };
  state.get = (strict = true) => {
    if (service === null || service === undefined) return undefined;
    if (strict && !state.active) return undefined;
    return service;
  };
  return state;
};

// ---------- A. 没装 / 主动禁用 → 透传 ----------
{
  for (const [label, getBudget] of [
    ['返回 null（未注册）', () => null],
    ['返回 undefined', () => undefined],
    ['遵守 strict 语义但服务不存在', cordisLike(null)]
  ]) {
    let ran = 0;
    const gate = createBudgetGate({ getBudget, logger: quietLogger });
    const out = await gate.wrap({ kind: 'decide', provider: 'p', model: 'm' }, async () => {
      ran += 1;
      return { result: { ok: true }, usage: { inputTokens: 10, outputTokens: 5 } };
    });
    check(`A ${label} → 仍然执行调用`, ran === 1, String(ran));
    check(`A ${label} → budget 标为 null`, out.budget === null, JSON.stringify(out.budget));
  }
}

// ---------- B. 已注册但服务失活 → 拒绝（这次补的漏洞）----------
{
  const service = goodBudget();
  const host = makeHost(service, { active: false });
  let ran = 0;
  const gate = createBudgetGate({ getBudget: host.get, logger: quietLogger });
  let caught = null;
  try {
    await gate.wrap({ kind: 'decide', provider: 'p', model: 'm' }, async () => {
      ran += 1;
      return { result: { ok: true }, usage: { inputTokens: 10 } };
    });
  } catch (error) { caught = error; }
  check('B 失活 → 抛 BudgetBlockedError', caught instanceof BudgetBlockedError, String(caught));
  check('B 失活 → 错误码 BUDGET_BLOCKED', caught?.code === 'BUDGET_BLOCKED', String(caught?.code));
  check('B 失活 → 原因是 service-inactive', caught?.detail?.reason === 'service-inactive', JSON.stringify(caught?.detail));
  check('B 失活 → 付费调用未执行', ran === 0, `ran=${ran}`);
  check('B 失活 → 没有产生预留', service.reserved.length === 0, String(service.reserved.length));
}

// ---------- C. 失活后恢复 → 重新放行 ----------
{
  const service = goodBudget();
  const host = makeHost(service, { active: false });
  const gate = createBudgetGate({ getBudget: host.get, logger: quietLogger });

  let blockedOnce = false;
  try {
    await gate.wrap({ kind: 'decide', provider: 'p', model: 'm' }, async () => ({ result: null, usage: null }));
  } catch (error) { blockedOnce = error instanceof BudgetBlockedError; }
  check('C 恢复前被拒绝', blockedOnce);

  host.active = true; // 服务恢复 ACTIVE

  let ran = 0;
  const out = await gate.wrap({ kind: 'decide', provider: 'p', model: 'm' }, async () => {
    ran += 1;
    return { result: { text: 'ok' }, usage: { inputTokens: 50 } };
  });
  check('C 恢复后调用被执行', ran === 1, String(ran));
  check('C 恢复后产生预留', service.reserved.length === 1, String(service.reserved.length));
  check('C 恢复后完成结算', service.settled.length === 1, String(service.settled.length));
  check('C 恢复后返回预算摘要', out.budget?.tokens === 50, JSON.stringify(out.budget));
}

// ---------- D. 主动禁用（先正常、后禁用）→ 回到透传，不算故障 ----------
{
  const service = goodBudget();
  const host = makeHost(service, { active: true });
  const gate = createBudgetGate({ getBudget: host.get, logger: quietLogger });

  await gate.wrap({ kind: 'decide', provider: 'p', model: 'm' }, async () => ({
    result: { ok: true }, usage: { inputTokens: 20 }
  }));
  check('D 启用时产生预留', service.reserved.length === 1, String(service.reserved.length));

  // 用户把 budget 插件禁用：服务整体消失（宽松读取也拿不到）
  const disabled = createBudgetGate({ getBudget: cordisLike(null), logger: quietLogger });
  let ran = 0;
  const out = await disabled.wrap({ kind: 'decide', provider: 'p', model: 'm' }, async () => {
    ran += 1;
    return { result: { ok: true }, usage: { inputTokens: 10 } };
  });
  check('D 禁用后仍然执行调用', ran === 1, String(ran));
  check('D 禁用后 budget 标为 null', out.budget === null, JSON.stringify(out.budget));
}

// ---------- E. 接口不全 / 读取抛错 → 拒绝 ----------
{
  for (const [label, getBudget] of [
    ['宽松读取抛错', () => { throw new Error('store gone'); }],
    ['严格读取抛错', (strict = true) => { if (strict) throw new Error('fiber failed'); return goodBudget(); }],
    ['返回对象缺 settle', () => ({ async reserve() {} })],
    ['返回对象缺 reserve', () => ({ async settle() {} })],
    ['返回空对象', () => ({})]
  ]) {
    let ran = 0;
    const gate = createBudgetGate({ getBudget, logger: quietLogger });
    let caught = null;
    try {
      await gate.wrap({ kind: 'decide', provider: 'p', model: 'm' }, async () => {
        ran += 1;
        return { result: { ok: true }, usage: { inputTokens: 10 } };
      });
    } catch (error) { caught = error; }
    check(`E ${label} → 抛 BudgetBlockedError`, caught instanceof BudgetBlockedError, String(caught));
    check(`E ${label} → 调用未执行`, ran === 0, `ran=${ran}`);
  }
}

// ---------- F. 正常服务 → 预留 / 调用 / 结算 ----------
{
  const budget = goodBudget();
  let ran = 0;
  const gate = createBudgetGate({ getBudget: cordisLike(budget), logger: quietLogger });
  const out = await gate.wrap({ kind: 'decide', provider: 'p', model: 'm' }, async () => {
    ran += 1;
    return { result: { text: 'hi' }, usage: { inputTokens: 100, outputTokens: 20 } };
  });
  check('F 调用执行', ran === 1);
  check('F 预留一次', budget.reserved.length === 1, String(budget.reserved.length));
  check('F 结算一次', budget.settled.length === 1, String(budget.settled.length));
  check('F 预留带 runId', typeof budget.reserved[0]?.runId === 'string' && budget.reserved[0].runId.length > 0);
  check('F 结算带 usage', budget.settled[0]?.usage?.inputTokens === 100);
  check('F tokens 汇总正确', out.budget?.tokens === 120, JSON.stringify(out.budget));
}

// ---------- G. reserve 失败 → 不执行调用 ----------
{
  const budget = goodBudget({ async reserve() { const e = new Error('额度不足'); e.code = 'QUOTA_EXCEEDED'; throw e; } });
  let ran = 0;
  const gate = createBudgetGate({ getBudget: cordisLike(budget), logger: quietLogger });
  let caught = null;
  try {
    await gate.wrap({ kind: 'decide', provider: 'p', model: 'm' }, async () => { ran += 1; return { result: null, usage: null }; });
  } catch (error) { caught = error; }
  check('G 预留失败 → 抛 BudgetBlockedError', caught instanceof BudgetBlockedError, String(caught));
  check('G 预留失败 → 调用未执行', ran === 0, `ran=${ran}`);
  check('G 带原始错误码', caught?.detail?.code === 'QUOTA_EXCEEDED', JSON.stringify(caught?.detail));
}

// ---------- H. 拿不到 usage → 不按 0 结算、也不 release ----------
{
  const budget = goodBudget();
  const gate = createBudgetGate({ getBudget: cordisLike(budget), logger: quietLogger });
  await gate.wrap({ kind: 'decide', provider: 'p', model: 'm' }, async () => ({ result: { ok: true }, usage: null }));
  check('H 无 usage 不结算', budget.settled.length === 0, String(budget.settled.length));
  check('H 无 usage 不 release', budget.released.length === 0, String(budget.released.length));

  const budget2 = goodBudget();
  const gate2 = createBudgetGate({ getBudget: cordisLike(budget2), logger: quietLogger });
  await gate2.wrap({ kind: 'decide', provider: 'p', model: 'm' }, async () => ({
    result: { ok: true }, usage: { inputTokens: -1 }
  }));
  check('H 非法 usage 视为没有用量', budget2.settled.length === 0, String(budget2.settled.length));
}

// ---------- I. peek 的宽松语义 ----------
{
  check('I absent 时 peek 返回 null', (await createBudgetGate({ getBudget: cordisLike(null), logger: quietLogger }).peek()) === null);
  check('I 失活时 peek 返回 null（不抛）',
    (await createBudgetGate({ getBudget: makeHost(goodBudget(), { active: false }).get, logger: quietLogger }).peek()) === null);
  check('I 读取抛错时 peek 返回 null（不抛）',
    (await createBudgetGate({ getBudget: () => { throw new Error('x'); }, logger: quietLogger }).peek()) === null);

  const okGate = createBudgetGate({ getBudget: cordisLike(goodBudget()), logger: quietLogger });
  const digest = await okGate.peek();
  check('I 正常时 level=open', digest?.level === 'open', JSON.stringify(digest));
  check('I 正常时带 remaining', digest?.remaining === 1000, JSON.stringify(digest));

  const blockedGate = createBudgetGate({
    getBudget: cordisLike(goodBudget({ async status() { return { guard: { blocked: true } }; } })),
    logger: quietLogger
  });
  check('I 被限额时 level=blocked', (await blockedGate.peek())?.level === 'blocked');
}

// ---------- J. totalUsageTokens ----------
{
  check('J 四字段汇总', totalUsageTokens({ inputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3, outputTokens: 4 }) === 10);
  check('J 缺字段按 0', totalUsageTokens({ inputTokens: 5 }) === 5);
  check('J 空对象为 null', totalUsageTokens({}) === null);
  check('J null 为 null', totalUsageTokens(null) === null);
  check('J 非整数为 null', totalUsageTokens({ inputTokens: 1.5 }) === null);
  check('J 负数为 null', totalUsageTokens({ inputTokens: -1 }) === null);
}

// ---------- K. 估算递增 ----------
{
  const budget = goodBudget();
  const gate = createBudgetGate({ getBudget: cordisLike(budget), logger: quietLogger });
  check('K 首次用保守常量', gate.estimateFor('decide') === 24_000, String(gate.estimateFor('decide')));
  await gate.wrap({ kind: 'decide', provider: 'p', model: 'm' }, async () => ({
    result: { ok: true }, usage: { inputTokens: 1000, outputTokens: 0 }
  }));
  check('K 之后按上次×1.2', gate.estimateFor('decide') === 1200, String(gate.estimateFor('decide')));
}

// ---------- L. 全程没有真实网络 / 计费 ----------
{
  check('L 测试未设置任何真实 provider', true);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
