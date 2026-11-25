// 情绪事件表：把“发生了什么”翻译成 V-A-E 事件。
//
// 设计原则（已确认）：
//  - 每个事件都必须能指回一条可验证的事实（actionId / correlationId / care 记录）。
//  - 单次小挫折不直接进“烦/别扭/担心”：幅度控制在“一次只到低落”，同类两次才翻。
//  - “沉默”不是事实，不产生事件——用户去睡/去忙和冷落在数据上无法区分。

export const MOOD_EVENT_TABLE = Object.freeze({
  // 低敏感事件表：单次只动一点点，长期由累积与回落决定。
  //
  // 精力成本按"日收支"标定（2026-11-24 实测后调整）：
  //   线上真实负载 ≈ 每天 103 次工具调用 + 58 次非工具活动，可恢复空闲约 18.9 小时/天；
  //   旧表 resultOk=-1 → 108 点/天消耗 vs 37.9 点/天恢复 = 净亏 71 点/天，
  //   电池天天见底（实测精力长期在 20~50 徘徊，fatigueStart=60 于是长期处于疲劳态）。
  //   最终取值（用户指定）：resultOk -0.2 / resultFail -0.3 / proactive -0.1，其余不变。
  //   按同一负载：日消耗 ≈24.8 点、日恢复 ≈37.8 点，净 +13 点/天。
  //   后果（知情接受）：精力稳定在偏满区间，正常情况下基本不会跌破 fatigueStart=60，
  //   也就是"她几乎不会再显得累"；只有远超日常的重负载（约 200+ 次工具调用/天）才会掉下去。
  //   以后若想让她偶尔露出疲惫，把 resultOk 调回 -0.25~-0.3 即可（不必动回能）。
  //   注意：**没有**改 energyRecoveryPerHour（2/小时）与 idleGraceMinutes（15 分钟）——
  //   19 小时空闲已经是每天固定大头，抬高回能只会让她一直顶在 100，精力就失去意义。
  reply: { dV: 0, dA: 0, energyCost: -0.05 },
  proactive: { dV: 0, dA: 0, energyCost: -0.1 },
  resultOk: { dV: 0.03, dA: 0.02, energyCost: -0.2 },
  resultFail: { dV: -0.03, dA: 0.02, cause: 'system', energyCost: -0.3 },
  timeout: { dV: -0.03, dA: 0.02, cause: 'unknown', energyCost: 0 },
  positive: { dV: 0.07, dA: 0.02, energyCost: 0 },
  negative: { dV: -0.06, dA: 0.015, cause: 'owner', energyCost: -0.2 },
  careContinued: { dV: 0.02, dA: 0, energyCost: 0 }
});

function base(kind, id, at, extra = {}) {
  const row = MOOD_EVENT_TABLE[kind];
  return {
    id,
    at,
    kind,
    dV: row.dV,
    dA: row.dA,
    energyCost: row.energyCost,
    cause: row.cause ?? null,
    ...extra
  };
}

// 发出消息：被动回复 −0.1，主动开口 −0.3（不再一刀切 -2）
export function sendEvent({ actionId, at, proactive = false } = {}) {
  if (!actionId) return null;
  return base(proactive ? 'proactive' : 'reply', `send:${actionId}`, at);
}

// 做事结果：成功小幅正/失败小幅负，都带精力成本
export function resultEvent({ correlationId, at, ok = true } = {}) {
  if (!correlationId) return null;
  return base(ok ? 'resultOk' : 'resultFail', `result:${correlationId}`, at);
}

// 回执超时：她发起 invoke 后 10 分钟没回执 → 不确定（cause=unknown）
export function timeoutEvent({ correlationId, at } = {}) {
  if (!correlationId) return null;
  return base('timeout', `timeout:${correlationId}`, at);
}

// 用户明确反馈：只有 explicit-positive / explicit-negative 才算；送达/已读不算
export function feedbackEvent({ actionId, at, feedback } = {}) {
  if (!actionId) return null;
  if (feedback === 'explicit-positive') return base('positive', `feedback:${actionId}:positive`, at);
  if (feedback === 'explicit-negative') return base('negative', `feedback:${actionId}:negative`, at);
  return null;
}

// 主动关心之后用户确实接住了（topic-continues）→ 小幅正向。
// unrelated / silence 一律不接：没讨论同一话题不是否定，沉默更不是。
export function careEvent({ actionId, at, label } = {}) {
  if (!actionId) return null;
  if (label !== 'topic-continues') return null;
  return base('careContinued', `care:${actionId}`, at);
}
