// 预算闸门：把宿主的 budget 服务包在一次付费模型调用外面（预留 → 调用 → 结算）。
//
// 设计约束：
//   1. budget 插件**没装或用户主动禁用**时整体透传，cognition 行为与之前完全一致
//      —— 预算不是强制依赖，不装也能正常调模型。
//   2. budget **已启用但服务拿不到**（get 抛错、或返回的接口不全）时，**拒绝付费调用**，
//      抛 BUDGET_BLOCKED。绝不能把"预算服务坏了"当成"没有预算"来处理 —— 那等于静默放行。
//   3. 估算输入 token 不靠人工填写：按调用类型记住上次实耗，用 ceil(上次 × 1.2) 当本次预估；
//      首次没有历史时用保守常量（依据历史最坏预留 23359）。
//   4. 预留失败（额度不足 / 未配置 / 账本损坏）不执行付费调用，抛 BUDGET_BLOCKED，
//      由 decide/model-decide 回落确定性策略，并记录 decision-fallback。
//   5. 结算只认真实 usage；拿不到 usage 时**不释放预留**，保持 pending 交给 Budget
//      的 TTL / recover / 对账处理。绝不能把"未取得 usage"等同于"费用为零"。

import { randomUUID } from 'node:crypto';

const BOOTSTRAP_ESTIMATE_TOKENS = 24_000;
const ESTIMATE_GROWTH = 1.2;
const MIN_ESTIMATE_TOKENS = 512;
const USAGE_KEYS = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'];

/** 汇总 Provider 用量；字段缺失按 0，非法值返回 null（视为没有用量）。 */
export function totalUsageTokens(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  let total = 0;
  let present = false;
  for (const key of USAGE_KEYS) {
    const value = usage[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
    total += value;
    present = true;
  }
  return present ? total : null;
}

export class BudgetBlockedError extends Error {
  constructor(message, detail = null) {
    super(message);
    this.name = 'BudgetBlockedError';
    this.code = 'BUDGET_BLOCKED';
    if (detail) this.detail = detail;
  }
}

export function createBudgetGate({
  getBudget = () => null,
  clock = () => Date.now(),
  logger = null
} = {}) {
  // kind -> 上次成功结算的真实 token 总数
  const lastUsed = new Map();

  /**
   * 解析预算服务，返回三态之一：
   *   { state: 'absent' }  —— 从未注册（没装 / 用户在 profile 里禁用）—— 允许付费调用
   *   { state: 'ok', budget } —— 已注册且提供者 ACTIVE —— 走预留/结算
   *   { state: 'broken', reason } —— 已注册但取不到可用的实现 —— 拒绝付费调用
   *
   * 为什么要读两次：
   * Cordis 的 ctx.get(name) 默认 strict=true，服务提供者 fiber 不是 ACTIVE 时同样返回
   * undefined —— 与"从未注册"结果一模一样。只读一次会把"失活的预算服务"误判成"没装"，
   * 于是静默放行付费调用。所以同时读 strict=false：拿得到实现说明注册过，
   * 再拿 strict=true 判断它当前是否可用。
   */
  function resolveService() {
    let loose;
    let strict;
    try {
      loose = getBudget(false);
    } catch (error) {
      logger?.warn?.('[cognition] 读取 budget 注册表失败，拒绝付费调用', { error: error?.message });
      return { state: 'broken', reason: `get-error:${error?.message ?? error}` };
    }
    // 宽松读取也拿不到 → 确实没有这个服务（没装或已禁用）。
    if (loose === null || loose === undefined) return { state: 'absent' };

    try {
      strict = getBudget(true);
    } catch (error) {
      logger?.warn?.('[cognition] 读取 budget 服务失败，拒绝付费调用', { error: error?.message });
      return { state: 'broken', reason: `get-error:${error?.message ?? error}` };
    }
    // 注册过但当前不是 ACTIVE（pending / disposing / failed）—— 视为故障，不放行。
    if (strict === null || strict === undefined) {
      logger?.warn?.('[cognition] budget 服务已注册但当前不可用（提供者非 ACTIVE），拒绝付费调用');
      return { state: 'broken', reason: 'service-inactive' };
    }
    if (typeof strict.reserve !== 'function' || typeof strict.settle !== 'function') {
      logger?.warn?.('[cognition] budget 服务接口不全（缺 reserve/settle），拒绝付费调用', {
        hasReserve: typeof strict.reserve === 'function',
        hasSettle: typeof strict.settle === 'function'
      });
      return { state: 'broken', reason: 'incomplete-interface' };
    }
    return { state: 'ok', budget: strict };
  }

  function estimateFor(kind) {
    const previous = lastUsed.get(kind);
    if (!Number.isFinite(previous) || previous <= 0) return BOOTSTRAP_ESTIMATE_TOKENS;
    return Math.max(MIN_ESTIMATE_TOKENS, Math.ceil(previous * ESTIMATE_GROWTH));
  }

  /** 事件打标用：预算不可读时返回 null，绝不让预算故障阻断认知循环本身。 */
  async function peek() {
    const resolved = resolveService();
    if (resolved.state !== 'ok') return null;
    const budget = resolved.budget;
    if (typeof budget.status !== 'function') return null;
    try {
      const status = await budget.status();
      const blocked = status?.guard?.blocked === true || status?.blocked === true;
      return {
        level: blocked ? 'blocked' : 'open',
        remaining: status?.remaining ?? null,
        asOf: new Date(clock()).toISOString()
      };
    } catch (error) {
      logger?.warn?.('[cognition] 预算状态读取失败，按可用处理', { error: error?.message });
      return null;
    }
  }

  /**
   * 包住一次付费调用。run 必须返回 { result, usage }。
   * 返回 { result, budget }；run 抛错时先结算再原样抛出。
   */
  async function wrap({ kind, provider, model, maxOutputTokens = null }, run) {
    const resolved = resolveService();
    if (resolved.state === 'absent') {
      // 预算没装或用户主动禁用：照常调用，不作为失败。
      const outcome = await run();
      return { result: outcome?.result ?? null, budget: null };
    }
    if (resolved.state === 'broken') {
      // 预算装了但坏了：宁可这轮不调用，也不静默放行。
      throw new BudgetBlockedError(`预算服务不可用（${resolved.reason}），拒绝发起付费调用`, {
        reason: resolved.reason
      });
    }
    const budget = resolved.budget;

    const runId = `cognition-${kind}-${randomUUID()}`;
    const estimatedInputTokens = estimateFor(kind);

    try {
      await budget.reserve({
        runId,
        provider,
        model,
        estimatedInputTokens,
        ...(Number.isFinite(maxOutputTokens) && maxOutputTokens > 0 ? { maxOutputTokens } : {}),
        caller: 'cognition',
        taskId: kind
      });
    } catch (error) {
      throw new BudgetBlockedError(`预算预留失败：${error?.message ?? error}`, {
        code: error?.code ?? null,
        runId,
        estimatedInputTokens
      });
    }

    let outcome = null;
    let failure = null;
    try {
      outcome = await run();
    } catch (error) {
      failure = error;
    }

    const usage = outcome?.usage ?? null;
    const tokens = totalUsageTokens(usage);
    try {
      if (tokens !== null) {
        await budget.settle({ runId, usage });
        lastUsed.set(kind, tokens);
      } else {
        // 没有可信 usage：预留保持 pending，不 release、不按 0 结算。
        // Budget 会按 TTL 标成 pending-overdue，后续由 recover/对账处理。
        logger?.warn?.('[cognition] 模型调用未返回可信 usage，预留保持 pending 等待对账', {
          kind,
          runId
        });
      }
    } catch (error) {
      logger?.warn?.('[cognition] 预算结算失败，预留可能进入 uncertain', {
        error: error?.message,
        runId
      });
    }

    if (failure) throw failure;
    return {
      result: outcome?.result ?? null,
      budget: { level: 'open', estimatedInputTokens, tokens, runId }
    };
  }

  return {
    wrap,
    peek,
    estimateFor,
    /** 仅供测试与诊断读取，不参与业务判断。 */
    observed: () => new Map(lastUsed)
  };
}
