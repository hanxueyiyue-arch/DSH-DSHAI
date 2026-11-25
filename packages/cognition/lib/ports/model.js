// 模型端口的词汇表与输出校验。
// 模型只负责“这一次说什么/做什么”，不直接写状态、不碰发送。

// 动作词表：
//   speak      只说话（对话回合=回复；行动回合=主动开口）
//   invoke     只做事（调用 capabilities 里的工具）
//   talkAndDo  边说边做（先发消息，再执行工具）
//   initiate   自己开一轮（内部触发，不经过计时器）
//   search     查一下手里有哪些工具（不确定用哪个时）
//   describe   看某个工具的参数（知道名字但不会用）
//   delay      约一个时间再想（外部计时器）
//   silence    什么都不做
export const MODEL_ACTIONS = Object.freeze(['speak', 'invoke', 'talkAndDo', 'initiate', 'search', 'describe', 'delay', 'silence']);

// v1 只开放只读能力；工具名固定，模型不能传 URL，只能传参数。
export const MODEL_CAPABILITIES = Object.freeze([
  Object.freeze({
    tool: 'bilibili.browse',
    readOnly: true,
    cost: 'free',
    description: '只读浏览 B 站公开视频（标题、简介、标签、UP 主）；不发送、不读私信、不下载。',
    args: { max: '1-5，一次最多看几条' }
  })
]);

// 能力目录以总线随事件下发的 payload.capabilities 为准：
// 总线知道自己当前注册了哪些工具（B 站浏览、未来的 QQ、发布视频……），
// 内核不再硬编码工具名，新增能力只需要在总线上注册。
function normalizeCapabilityList(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const tool = String(item.tool ?? '').trim();
    if (!tool) continue;
    out.push(Object.freeze({
      tool,
      readOnly: item.readOnly === true,
      cost: typeof item.cost === 'string' ? item.cost : 'unknown',
      description: typeof item.description === 'string' ? item.description : '',
      args: item.args && typeof item.args === 'object' ? item.args : {}
    }));
  }
  return out;
}

export function capabilitiesFor(kind, event) {
  const provided = normalizeCapabilityList(event?.payload?.capabilities);
  // tick：只有总线显式允许时才给能力（allowBrowse 是旧名，语义已扩展为"允许动手"）。
  if (kind === 'tick') {
    if (event?.payload?.allowBrowse !== true) return Object.freeze([]);
    return Object.freeze(provided ?? MODEL_CAPABILITIES);
  }
  // owner-message：用户可能直接要求做点什么，同样给它当前全部能力。
  if (kind === 'owner-message') return Object.freeze(provided ?? MODEL_CAPABILITIES);
  // self-turn：她自己开的回合（initiate），和用户回合一样可以动手。
  if (kind === 'self-turn') return Object.freeze(provided ?? MODEL_CAPABILITIES);
  return Object.freeze([]);
}

export function allowedActionsFor(kind, event) {
  // 自触发回合（source='self' 或 self-turn）不再提供 initiate，避免无限自转。
  const selfTurn = event?.payload?.source === 'self' || kind === 'self-turn';
  if (kind === 'owner-message') {
    return Object.freeze(['speak', 'invoke', 'talkAndDo', 'initiate', 'search', 'describe', 'delay', 'silence']);
  }
  return selfTurn
    ? Object.freeze(['speak', 'invoke', 'talkAndDo', 'search', 'describe', 'delay', 'silence'])
    : Object.freeze(['speak', 'invoke', 'talkAndDo', 'initiate', 'search', 'describe', 'delay', 'silence']);
}

export const MODEL_INPUT_SHAPE = Object.freeze({
  kind: 'owner-message|tick',
  allowedActions: 'string[]（本次唯一允许的动作）',
  capabilities: '只读能力目录（invoke 时只能从这里选）',
  message: '{id,text}|null',
  recall: '{items:[{id,title,excerpt,kind,layer,score}]}',
  cues: '{drivers,topics}',
  self: '{name,gender,profileText}',
  affect: '{energy,mood}',
  budget: '{level,remaining,asOf}|null',
  due: '{id,title,followUpAt}|null',
  timeZone: 'string'
});

export const MODEL_OUTPUT_SHAPE = Object.freeze({
  action: 'speak|invoke|talkAndDo|initiate|search|describe|delay|silence',
  text: 'string（speak/talkAndDo 必填，≤300 字；invoke 不许带）',
  tool: 'invoke/talkAndDo 必填，必须是 capabilities 里的 tool（speak 不许带）',
  args: 'invoke/talkAndDo 时的参数对象',
  query: 'search 时必填，要查的关键词（空或 * 表示列出全部）',
  name: 'describe 时必填，要看参数的工具名',
  delayMinutes: 'delay 时可选，10-360',
  reason: 'string（可选，≤200 字）',
  confidence: 'number 0..1（可选）',
  memoryIds: 'string[]（只能引用本次召回里出现的 id）'
});

function fail(error) {
  return { ok: false, error };
}

export function normalizeModelOutput(
  raw,
  { kind, recallIds = new Set(), contextIds = new Set(), allowedActions, allowedTools = [], allowedArgsByTool = null } = {}
) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('model-output-not-object');
  const action = String(raw.action ?? '');
  if (!MODEL_ACTIONS.includes(action)) return fail('model-action-invalid');

  const allowed = Array.isArray(allowedActions) && allowedActions.length > 0
    ? allowedActions
    : allowedActionsFor(kind);
  if (!allowed.includes(action)) return fail('model-action-not-allowed');

  // 三种"做点什么"的动作，字段边界必须清楚：
  //   speak      → 只能有 text
  //   invoke     → 只能有 tool/args
  //   talkAndDo  → text 和 tool 都必须有
  const needsText = action === 'speak' || action === 'talkAndDo';
  const needsTool = action === 'invoke' || action === 'talkAndDo';

  let text = '';
  if (needsText) {
    text = String(raw.text ?? '').trim();
    if (text === '') return fail('model-text-empty');
    if (text.length > 300) text = text.slice(0, 300);
  } else if (typeof raw.text === 'string' && raw.text.trim() !== '') {
    return fail('model-text-not-allowed');
  }

  let tool = '';
  let args = {};
  if (needsTool) {
    tool = String(raw.tool ?? '');
    const tools = Array.isArray(allowedTools) ? allowedTools : [];
    if (tool === '' && tools.length === 1) tool = tools[0];
    if (!tools.includes(tool)) return fail('model-tool-not-allowed');
    const rawArgs = raw.args && typeof raw.args === 'object' && !Array.isArray(raw.args) ? raw.args : {};
    // 参数按工具自己的能力声明透传：声明里列出的键 + 历史白名单（max/minutes/count）。
    // 只收原始类型，字符串截断，防止把任意结构塞进总线工具。
    const declared = allowedArgsByTool && typeof allowedArgsByTool === 'object' ? allowedArgsByTool[tool] : null;
    const allow = new Set([...(Array.isArray(declared) ? declared : []), 'max', 'minutes', 'count']);
    for (const [key, value] of Object.entries(rawArgs)) {
      if (!allow.has(key)) continue;
      if (typeof value === 'string') args[key] = value.slice(0, 2000);
      else if (typeof value === 'number' && Number.isFinite(value)) args[key] = value;
      else if (typeof value === 'boolean') args[key] = value;
    }
    const max = Number(args.max);
    if (Number.isFinite(max)) args.max = Math.min(5, Math.max(1, Math.round(max)));
    const minutes = Number(args.minutes);
    if (Number.isFinite(minutes)) args.minutes = Math.round(minutes);
    if (tool === 'bilibili.browse' && args.max === undefined) args.max = 3;
  } else if (typeof raw.tool === 'string' && raw.tool.trim() !== '') {
    return fail('model-tool-not-allowed');
  }

  // search / describe：只查能力，不执行；字段各自独立。
  let query = '';
  let name = '';
  if (action === 'search') {
    query = String(raw.query ?? '').trim().slice(0, 120);
    if (query === '') return fail('model-query-empty');
    if (typeof raw.name === 'string' && raw.name.trim() !== '') return fail('model-name-not-allowed');
  } else if (action === 'describe') {
    name = String(raw.name ?? '').trim().slice(0, 80);
    if (name === '') return fail('model-name-empty');
    if (typeof raw.query === 'string' && raw.query.trim() !== '') return fail('model-query-not-allowed');
  } else {
    if (typeof raw.query === 'string' && raw.query.trim() !== '') return fail('model-query-not-allowed');
    if (typeof raw.name === 'string' && raw.name.trim() !== '') return fail('model-name-not-allowed');
  }

  const declaredMemoryIds = Array.isArray(raw.memoryIds)
    ? raw.memoryIds.filter(item => typeof item === 'string')
    : [];
  // R4 + P1-A：引用错误不再丢掉整段回复。
  // 原行为是"声称有依据却一个有效引用都没有 → 整轮回退"，实测 10 轮里有 3 轮
  // 因为模型把事件 id 当记忆 id 引用而得体地变成"嗯，我在。"，代价过大。
  // 现在一律剔除无效引用后继续；无效引用照旧写进 ignoredMemoryIds，
  // 由 loop/cycle.js 记 memory-id-ignored 活动，可追溯但不影响回复本身。
  const usable = id => recallIds.has(id) || contextIds.has(id);
  const memoryIds = declaredMemoryIds.filter(usable);
  const ignoredMemoryIds = declaredMemoryIds.filter(id => !usable(id));
  const memoryEvidence = declaredMemoryIds.length === 0
    ? 'none'
    : memoryIds.length > 0 ? 'partial-or-full' : 'unavailable';

  const confidence = Number(raw.confidence);
  const delayMinutes = Number.isFinite(Number(raw.delayMinutes)) ? Number(raw.delayMinutes) : null;
  return {
    ok: true,
    output: {
      action,
      text,
      tool,
      args,
      query,
      name,
      memoryIds,
      ignoredMemoryIds,
      memoryEvidence,
      delayMinutes,
      reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 200) : '',
      confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5
    }
  };
}
