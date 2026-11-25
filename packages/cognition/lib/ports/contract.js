// 内核与外部世界的词汇表（v1）。
// 这里只有形状与常量，不实现传输；公共插件/工具插件按此对齐。

export const CONTRACT_VERSION = 1;

export const EVENT_TYPES = Object.freeze([
  'owner-message',
  'tick',
  'tool-result',
  'owner-feedback',
  'owner-command',
  'maintenance'
]);

export const INTENT_TYPES = Object.freeze(['send', 'wake', 'invoke']);

export const ACTOR_KINDS = Object.freeze(['owner', 'stranger', 'system', 'tool', 'unknown']);

// 意图最小形状。v1 只允许这三类；未知类型必须被拒绝。
export const INTENT_SHAPES = Object.freeze({
  send: Object.freeze({ to: 'owner', text: 'string', replyTo: 'string?' }),
  wake: Object.freeze({ wakeAt: 'number', reason: 'string?' }),
  invoke: Object.freeze({ tool: 'string', args: 'object', correlationId: 'string' })
});

// tool-result 回执：必须带 correlationId，否则无法归因，按 unknown 处理。
export const TOOL_RESULT_SHAPE = Object.freeze({
  correlationId: 'string',
  ok: 'boolean',
  result: 'object?',
  error: 'object?'
});

// 能力目录条目：工具插件自报，内核只读。
export const CAPABILITY_SHAPE = Object.freeze({
  name: 'string',
  kind: 'send|read|search|invoke|other',
  cost: 'free|paid|unknown',
  sideEffect: 'boolean',
  requiresOwnerApproval: 'boolean',
  readOnly: 'boolean'
});

// 预算摘要：v1 由总线放在事件里，内核只读。
export const BUDGET_DIGEST_SHAPE = Object.freeze({
  level: 'ok|tight|blocked',
  remaining: 'object?',
  asOf: 'number'
});

export function isIntentType(value) {
  return INTENT_TYPES.includes(value);
}

export function assertToolResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('tool-result 必须是对象');
  }
  if (typeof value.correlationId !== 'string' || value.correlationId === '') {
    throw new Error('tool-result 缺少 correlationId');
  }
  if (typeof value.ok !== 'boolean') {
    throw new Error('tool-result.ok 必须是布尔值');
  }
  return true;
}
