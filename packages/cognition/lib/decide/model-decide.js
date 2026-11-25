// 模型决策：把“这次怎么回应”交给模型，但校验、兜底、预算和边界仍在内核。
// 模型输出不合法、超时、预算 blocked 时，回落到确定性 decide。

import { defaultDecide } from '../loop/cycle.js';
import {
  normalizeModelOutput,
  allowedActionsFor,
  capabilitiesFor
} from '../ports/model.js';
import { presenceSummary } from './presence.js';
import { careAllowed } from '../self/learning.js';
import { CONSTITUTION } from '../self-state.js';
import { buildCatalog } from '../capability/catalog.js';
import { buildInjection, INJECT_BUDGET_CHARS } from '../capability/inject.js';

// invoke 冷却：刚看过后这段时间内不再给 invoke，避免"问看到了什么 → 又去看一遍"。
const INVOKE_COOLDOWN_MS = 60_000;

// 完整时间上下文：年月日、星期、钟点、时区。
// presence 只给"几点 + 时段"，缺日期；这里补上，让她知道"今天是哪一天"。
export function timeContext(at, timeZone = 'Asia/Shanghai') {
  const when = Number.isFinite(Number(at)) ? Number(at) : Date.now();
  const zone = typeof timeZone === 'string' && timeZone ? timeZone : 'Asia/Shanghai';
  const partOf = options => {
    const build = tz => new Intl.DateTimeFormat('zh-CN', tz ? { timeZone: tz, ...options } : options).formatToParts(new Date(when));
    try { return build(zone); } catch { return build(null); }
  };
  const pick = (options, type) => partOf(options).find(item => item.type === type)?.value ?? '';
  const year = pick({ year: 'numeric' }, 'year');
  const month = pick({ month: '2-digit' }, 'month');
  const day = pick({ day: '2-digit' }, 'day');
  const hour = pick({ hour: '2-digit', hourCycle: 'h23' }, 'hour');
  const minute = pick({ minute: '2-digit' }, 'minute');
  const weekday = pick({ weekday: 'long' }, 'weekday');
  const date = year && month && day ? `${year}-${month}-${day}` : null;
  return {
    date,
    year: year ? Number(year) : null,
    month: month ? Number(month) : null,
    day: day ? Number(day) : null,
    weekday: weekday || null,
    clock: hour ? `${hour}:${minute}` : null,
    localText: date ? `${Number(year)}年${Number(month)}月${Number(day)}日 ${weekday} ${hour}:${minute}` : null,
    timeZone: zone
  };
}

function findDue(memories, now) {
  return (
    memories
      .filter(
        row =>
          row &&
          !row.archivedAt &&
          !row.supersededBy &&
          !row.followUpAskedAt &&
          typeof row.followUpAt === 'number' &&
          row.followUpAt <= now
      )
      .sort((a, b) => a.followUpAt - b.followUpAt)[0] ?? null
  );
}

function recallForModel(recall) {
  return {
    items: (recall?.items ?? []).map(item => ({
      id: item.id,
      title: item.title,
      excerpt: item.excerpt ?? String(item.content ?? '').slice(0, 160),
      // 让模型知道每条记忆"多旧"：没有日期，"三天前说要 A、昨天改口说 B"在它眼里是两条等重陈述。
      ...(item.date ? { date: item.date } : {}),
      kind: item.kind,
      layer: item.layer,
      score: item.score
    }))
  };
}

// 固定通道：最近看过的内容直接进上下文，不依赖检索能不能命中。
// 问"你看到什么/刚才干了什么"时，这就是她的事实来源。
const RECENT_OBSERVATION_LIMIT = 3;
const RECENT_OBSERVATION_CHARS = 1200;
// 最新一条给足空间（字幕/搜索结果都靠它），旧的多条只留摘要。
const RECENT_OBSERVATION_NEWEST_CHARS = 800;
const RECENT_OBSERVATION_OLDER_CHARS = 200;
export function recentObservationsOf(memories, { limit = RECENT_OBSERVATION_LIMIT, maxChars = RECENT_OBSERVATION_CHARS } = {}) {
  const rows = (Array.isArray(memories) ? memories : [])
    .filter(row => row && row.kind === 'observation' && !row.archivedAt && !row.supersededBy)
    .map(row => ({ row, at: Number(row.occurredAt ?? Date.parse(row.createdAt ?? '')) }))
    .filter(item => Number.isFinite(item.at))
    .sort((a, b) => b.at - a.at)
    .slice(0, Math.max(1, limit));
  const out = [];
  let used = 0;
  let index = 0;
  for (const { row, at } of rows) {
    const cap = index === 0 ? RECENT_OBSERVATION_NEWEST_CHARS : RECENT_OBSERVATION_OLDER_CHARS;
    const title = String(row.title ?? '').slice(0, 80);
    const body = String(row.content ?? '').slice(0, Math.max(0, cap - title.length - 1));
    const entry = (title + '：' + body).slice(0, Math.min(cap, maxChars - used));
    if (!entry) break;
    out.push({ id: row.id, at, text: entry });
    used += entry.length;
    index += 1;
    if (used >= maxChars) break;
  }
  return out;
}

// 「基本约定」常驻块：偏好层的记忆不再和几百条一起靠召回抢位。
// 依据（2026-11-24 实测）：44 条偏好、2003 字符，只有 41%（18 条）被召回过至少一次，26 条从未被召回。
// 这里按重要度优先、时间次之排序，压到 maxChars 以内，超出的不截断句子而是整条丢弃并计数。
export const CORE_PREFERENCE_CHARS = 2000;
export function buildCorePreferences(memories, { maxChars = CORE_PREFERENCE_CHARS, limit = 40 } = {}) {
  const rows = (Array.isArray(memories) ? memories : [])
    .filter(row => row && !row.archivedAt && row.layer === 'preference')
    .filter(row => String(row.title ?? '').trim() || String(row.content ?? '').trim())
    // 排序：重要度 → 支持度（用户确认过几次）→ 置信 → 时间。
    // 有了 support 之后，"被反复确认过的约定"应该比"只说过一次"更靠前，不容易被挤出 2000 字符上限。
    .sort((a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0)
      || (Number(b.support) || 1) - (Number(a.support) || 1)
      || (Number(b.confidence) || 0) - (Number(a.confidence) || 0)
      || (Number(b.occurredAt) || 0) - (Number(a.occurredAt) || 0));
  const out = [];
  let used = 0;
  let dropped = 0;
  for (const row of rows) {
    if (out.length >= limit) { dropped += 1; continue; }
    const support = Number(row.support) || 1;
    const line = String(row.title ?? '').trim().slice(0, 60)
      + (String(row.content ?? '').trim() ? '：' + String(row.content).trim().slice(0, 120) : '')
      + (support >= 2 ? `（用户确认过 ${support} 次）` : '');
    const size = [...line].length;
    if (used + size > maxChars) { dropped += 1; continue; }
    out.push({ id: row.id, line });
    used += size;
  }
  return { items: out, chars: used, total: rows.length, dropped };
}

export function buildModelInput({
  event,
  recall,
  cues,
  affect,
  self,
  memories,
  now,
  timeZone,
  due,
  activities = [],
  recent = [],
  openLoops = [],
  insights = [],
  diary = [],
  traits = [],
  speakHabits = [],
  drives = null,
  skills = null,
  pendingSearch = [],
  nextTools = []
}) {
  // 刚看过的内容应该靠观察记忆回答，而不是再去看一遍。
  // 这里做确定性冷却：最近一次 invoke 之后的冷却期内，不提供 invoke 能力，
  // 强制她走 reply（否则会出现"问她看到了什么，她又去看一遍"的死循环）。
  const lastInvokeAt = (Array.isArray(activities) ? activities : []).reduce((last, row) => {
    if (!row || row.kind !== 'intent-emitted') return last;
    if (row.intentType !== 'invoke') return last;
    const at = Number(row.at);
    return Number.isFinite(at) && at > last ? at : last;
  }, 0);
  const invokeCoolingDown = event.type === 'owner-message'
    && lastInvokeAt > 0
    && Number(now) - lastInvokeAt < INVOKE_COOLDOWN_MS;
  const fullCapabilities = capabilitiesFor(event.type, event);
  // 能力发现：目录全量给检索，注入只给"手边"的几条（概览 + 预置/最近/常用 + 搜索结果）。
  const catalog = buildCatalog(fullCapabilities);
  const baseInjection = buildInjection({
    catalog,
    skills,
    // 上一轮搜索结果 + 下一步该用的工具（例如搜完视频后把 bilibili.video 摆到手边）
    pending: [...(Array.isArray(pendingSearch) ? pendingSearch : []), ...(Array.isArray(nextTools) ? nextTools : [])],
    budgetChars: INJECT_BUDGET_CHARS
  });
  // invoke 冷却：这一轮不动手，但目录、概览和手边工具仍然可见（避免她误以为工具没了）。
  const injection = baseInjection;
  const allowedActions = allowedActionsFor(event.type, event).filter(action => {
    if (invokeCoolingDown && (action === 'invoke' || action === 'talkAndDo')) return false;
    if ((action === 'invoke' || action === 'talkAndDo') && injection.tools.length === 0) return false;
    if ((action === 'search' || action === 'describe') && catalog.total === 0) return false;
    return true;
  });
  // 输入顺序就是她思考的顺序：先情境，再"刚刚发生"，再"记得/在意"，
  // 最后才是"手边工具"。工具是手段，不是任务。
  return {
    // ---- 情境 ----
    time: timeContext(now, timeZone),
    timeZone: timeZone ?? '',
    // 只给事实，不设门槛：几点、多久没说话、最近谁说了多少、有没有回。
    presence: presenceSummary({ activities, now, timeZone }),
    // 精力 + 情绪：数值只作背景，标签由 mood.js 统一算出（唯一来源）。
    affect: {
      energy: affect?.energy ?? null,
      mood: affect?.label ?? affect?.mood ?? null,
      valence: affect?.valence ?? null,
      arousal: affect?.arousal ?? null,
      cause: affect?.cause ?? null,
      tired: Number.isFinite(Number(affect?.energy)) ? Number(affect.energy) < 20 : false
    },
    // 最近在意什么、好奇与动机的强弱；只作决策背景，不构成“该不该说话”的配额。
    drives: drives
      ? {
          curiosity: drives.curiosity,
          motivation: drives.motivation,
          interests: drives.interests
        }
      : null,
    // ---- 刚刚发生 ----
    kind: event.type,
    message:
      event.type === 'owner-message'
        ? { id: event.id, text: String(event.payload?.text ?? '').slice(0, 300) }
        : null,
    // 如果这次 tick 是她自己约的 wake，把她当时写的理由带进来，别让她"醒来不知道为什么"。
    ...(event.type === 'tick' && typeof event?.payload?.reason === 'string' && event.payload.reason.trim()
      ? { wakeReason: event.payload.reason.trim().slice(0, 200) }
      : {}),
    // self-turn：她自己开的回合，把触发原因带进来（不是 timer，也不是用户消息）。
    ...(event.type === 'self-turn' && typeof event?.payload?.reason === 'string' && event.payload.reason.trim()
      ? { initiateReason: event.payload.reason.trim().slice(0, 200) }
      : {}),
    due: due ? { id: due.id, title: due.title, followUpAt: due.followUpAt } : null,
    // 软门禁：到期的旧事有多强、门槛多高。偏弱时由她自己决定提不提。
    careGate: (() => {
      if (!due) return null;
      try {
        const gate = careAllowed({ row: due, now, self });
        return { score: gate.score, threshold: gate.threshold, soft: gate.soft === true, hardFloor: gate.hardFloor };
      } catch { return null; }
    })(),
    // ---- 你记得 / 在意 ----
    recall: recallForModel(recall),
    // 最近的真实往来：只给“谁说了什么”，按时间升序；response 里不许出现这里没有的对话。
    recent: recent.map(item => ({
      id: item.id,
      at: item.at,
      kind: item.kind,
      userText: item.userText,
      selfText: item.selfText,
      title: item.title,
      line: item.line
    })),
    // 固定通道：最近看过的东西，不参与检索打分，直接进上下文。
    recentObservations: recentObservationsOf(memories, { maxChars: RECENT_OBSERVATION_CHARS }),
    // 固定通道：基本约定（偏好层）常驻，不靠召回。
    preferences: buildCorePreferences(memories).items.map(item => item.line),
    openLoops: openLoops.map(item => ({
      memoryId: item.memoryId,
      title: item.title,
      dueAt: item.dueAt,
      state: item.state
    })),
    // 近两篇日记：只作自述背景与语气连续性参考，不是事实依据。
    diary: diary.map(item => ({
      id: item.id,
      day: item.day,
      content: String(item.content ?? '').slice(0, 400)
    })),
    // 已提交的长期理解：只作背景，不是事实依据。
    insights: insights.map(item => ({
      id: item.id,
      title: item.title,
      content: String(item.content ?? '').slice(0, 240)
    })),
    // 已提交的可演化倾向：暂定背景，不是身份事实，也不得反过来自我强化。
    traits: traits.map(item => ({
      id: item.id,
      label: item.label,
      statement: String(item.statement ?? '').slice(0, 160),
      confidence: item.confidence
    })),
    speakHabits: speakHabits.map(item => ({
      id: item.id,
      label: item.label,
      statement: String(item.statement ?? '').slice(0, 160),
      dimension: item.dimension,
      confidence: item.confidence
    })),
    cues: { drivers: cues?.drivers ?? [], topics: cues?.topics ?? [] },
    self: self?.identity
      ? { name: self.identity.name, gender: self.identity.gender, profileText: self.identity.profileText }
      : null,
    // ---- 手边工具（附录：先想做什么，再考虑用什么） ----
    // 概览常驻；具体工具只给 injection 选出来的几条；目录全量不进提示词。
    capabilityOverview: injection.overview,
    capabilities: injection.tools,
    invokeCoolingDown,
    allowedActions,
    // ---- 边界 ----
    // 硬边界：只限制做法，不限制想法。三条都在 self-state.js 里定义。
    rules: CONSTITUTION.map(rule => rule.rule),
    budget: event.budget ?? null
  };
}

// 她自己安排下一次醒来：delay → wake 意图。
// 限制范围，避免她每分钟醒一次（既烧钱也无意义）。
const WAKE_MIN_MINUTES = 10;
const WAKE_MAX_MINUTES = 360;
const WAKE_DEFAULT_MINUTES = 60;

export function clampWakeMinutes(value) {
  // 注意：Number(null) === 0，必须先区分"没给"和"给了 0"。
  if (value === null || value === undefined || value === '') return WAKE_DEFAULT_MINUTES;
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return WAKE_DEFAULT_MINUTES;
  return Math.min(WAKE_MAX_MINUTES, Math.max(WAKE_MIN_MINUTES, Math.round(minutes)));
}

// P1-C：用户说「我妈下周来」时，回复不能写成「我妈下周来」——用户家属不是她的。
// 只在用户原话里确实出现过该说法时才纠正，避免误改她自己的表达。
const OWNER_POSSESSIONS = Object.freeze([
  ['我妈妈', '你妈妈'],
  ['我爸爸', '你爸爸'],
  ['我妈', '你妈妈'],
  ['我爸', '你爸爸'],
  ['我家里', '你家里']
]);

export function correctOwnerAttribution(text, userText) {
  const reply = String(text ?? '');
  const ownerText = String(userText ?? '');
  if (!reply || !ownerText) return { text: reply, corrected: [] };
  let out = reply;
  const corrected = [];
  for (const [from, to] of OWNER_POSSESSIONS) {
    if (!ownerText.includes(from)) continue;
    if (!out.includes(from)) continue;
    out = out.split(from).join(to);
    corrected.push({ from, to });
  }
  return { text: out, corrected };
}

function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('model-timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createModelDecide({
  model,
  fallback = defaultDecide,
  timeoutMs = 15_000,
  logger = console
} = {}) {
  if (typeof model !== 'function') throw new Error('createModelDecide: 缺少 model');

  return async function decide(args) {
    const { event, memories = [], now = event?.at } = args ?? {};
    if (!event) return fallback(args ?? {});

    if (event.type !== 'owner-message' && event.type !== 'tick' && event.type !== 'self-turn') return fallback(args);
    if (event.type === 'owner-message') {
      if (event.actor?.kind !== 'owner' || event.actor?.authenticated !== true) {
        return fallback(args);
      }
    }

    const due = event.type === 'tick' ? findDue(memories, now) : null;
    // tick 短路只按"触发源"判断，不再看能力目录是否为空：
    // 有到期旧事 / 有未完成事项 / 总线允许动手，才值得叫模型。
    const openLoopCount = Array.isArray(args?.openLoops) ? args.openLoops.length : 0;
    if (event.type === 'tick' && !due && openLoopCount === 0 && capabilitiesFor(event.type, event).length === 0) {
      return fallback(args);
    }

    const fallbackWith = (reason, detail) => {
      const decision = fallback(args);
      return {
        ...decision,
        source: 'fallback',
        reason: `model-fallback:${reason}`,
        activity: { kind: 'decision-fallback', reason, ...(detail ? { detail: String(detail).slice(0, 200) } : {}), ...(due ? { memoryId: due.id } : {}) }
      };
    };

    if (event.budget?.level === 'blocked') return fallbackWith('budget-blocked');

    let raw;
    let input = null;
    let inputSummary = null;
    try {
      input = buildModelInput({ ...args, due });
      inputSummary = {
        dueId: due?.id ?? null,
        memoryIds: Array.isArray(input.items) ? input.items.map(item => item.id) : [],
        allowedActions: input.allowedActions,
        tools: input.capabilities.map(item => item.tool),
        recent: Array.isArray(input.recent) ? input.recent.map(item => item.id) : [],
        // 固定通道：日志里能直接证明这次带了几条最近观察。
        recentObservations: Array.isArray(input.recentObservations) ? input.recentObservations.map(item => item.id) : [],
        openLoops: Array.isArray(input.openLoops) ? input.openLoops.map(item => item.memoryId) : [],
        diary: Array.isArray(input.diary) ? input.diary.map(item => item.id) : [],
        insights: Array.isArray(input.insights) ? input.insights.map(item => item.id) : [],
        traits: Array.isArray(input.traits) ? input.traits.map(item => item.id) : [],
        drives: input.drives
          ? {
              curiosity: input.drives.curiosity,
              motivation: input.drives.motivation,
              interests: input.drives.interests.map(item => item.topic)
            }
          : null,
        presence: input.presence
          ? {
              slot: input.presence.current?.slot ?? null,
              sinceOwnerMs: input.presence.sinceOwnerMs ?? null,
              unansweredSelf: input.presence.unansweredSelf ?? null,
              selfSentAfterLastOwner: input.presence.recent?.selfSentAfterLastOwner ?? null
            }
          : null
      };
      raw = await withTimeout(Promise.resolve(model(input)), timeoutMs);
    } catch (error) {
      logger?.warn?.('[cognition] 模型决策失败，回落确定性策略', { error: error?.message });
      const reason = error?.code === 'BUDGET_BLOCKED'
        ? 'budget-blocked'
        : error?.message === 'model-timeout' ? 'timeout' : 'error';
      return fallbackWith(reason, error?.message);
    }

    const recallIds = new Set((args.recall?.items ?? []).map(item => item.id));
    // openLoops / insights / due 是明确放进模型的上下文，允许作为合法引用；
    // 否则模型引用“未完成事项”会被误判成未知记忆并整轮回退。
    const contextIds = new Set([
      ...(args.openLoops ?? []).map(item => item?.memoryId),
      ...(args.insights ?? []).map(item => item?.id),
      ...(args.diary ?? []).map(item => item?.id),
      due?.id
    ].filter(Boolean));
    // 执行校验对齐全量目录（和注入无关）：注入只是"手边工具"。
    const validationCatalog = buildCatalog(capabilitiesFor(event.type, event));
    const checked = normalizeModelOutput(raw, {
      kind: event.type,
      recallIds,
      contextIds,
      allowedActions: input?.allowedActions,
      allowedTools: validationCatalog.items.map(item => item.tool),
      allowedArgsByTool: Object.fromEntries(validationCatalog.items.map(item => [item.tool, item.argsKeys]))
    });
    if (!checked.ok) {
      // 她猜了一个目录里没有的工具名：不要整轮回退，转成一次 search，
      // 下一轮把真实存在的候选工具带回来（例如把 bilibili.search 纠正到 bilibili.discover）。
      const guessed = typeof raw?.tool === 'string' ? raw.tool.trim() : '';
      const actions = Array.isArray(input?.allowedActions) ? input.allowedActions : [];
      if (checked.error === 'model-tool-not-allowed' && guessed && actions.includes('search')) {
        return {
          intent: null,
          action: 'search',
          query: guessed.slice(0, 80),
          reason: `工具名 ${guessed} 不在目录，先搜一下真实名字`,
          source: 'model',
          confidence: 0.3,
          input: inputSummary
        };
      }
      return fallbackWith(checked.error);
    }

    const { action, text, tool, args: toolArgs, memoryIds, ignoredMemoryIds, reason, confidence, delayMinutes } =
      checked.output;
    const source = 'model';
    const ignored = Array.isArray(ignoredMemoryIds) && ignoredMemoryIds.length > 0 ? { ignoredMemoryIds } : {};
    // 对话回合=回复这条消息；行动回合=主动开口。
    const replyTo = event.type === 'owner-message' ? event.id : null;
    const buildSend = body => {
      // P1-C：用户说「我妈下周来」，回复不能写成「我妈下周来」——用户家属不是她的。
      const fixed = correctOwnerAttribution(body, event?.payload?.text ?? '');
      return {
        intent: {
          type: 'send',
          to: 'owner',
          text: fixed.text,
          replyTo,
          ...(replyTo === null && due ? { followUpMemoryId: due.id } : {}),
          memoryIds
        },
        ...(fixed.corrected.length > 0
          ? { activity: { kind: 'attribution-corrected', corrected: fixed.corrected } }
          : {})
      };
    };

    if (action === 'speak') {
      const built = buildSend(text);
      return {
        intent: built.intent,
        reason,
        source,
        confidence,
        action,
        ...ignored,
        ...(built.activity ? { activity: built.activity } : {}),
        input: inputSummary
      };
    }
    if (action === 'invoke') {
      return {
        intent: { type: 'invoke', tool, args: toolArgs, memoryIds },
        reason,
        source,
        confidence,
        action,
        ...ignored,
        input: inputSummary
      };
    }
    if (action === 'talkAndDo') {
      // 边说边做：先把话说出去，紧接着执行工具。
      const built = buildSend(text);
      return {
        intents: [built.intent, { type: 'invoke', tool, args: toolArgs, memoryIds }],
        reason,
        source,
        confidence,
        action,
        ...ignored,
        ...(built.activity ? { activity: built.activity } : {}),
        input: inputSummary
      };
    }
    if (action === 'initiate') {
      // 内在触发：不产生 wake、不经过计时器与总线，由循环把事件压回自己的队列。
      return {
        intent: { type: 'self-turn', reason, memoryIds },
        reason,
        source,
        confidence,
        action,
        ...ignored,
        input: inputSummary
      };
    }
    if (action === 'search' || action === 'describe') {
      // 只查能力，不执行工具；由循环把结果放进 pendingSearch 并压一轮续跑。
      return {
        intent: null,
        reason,
        source,
        confidence,
        action,
        query: checked.output.query ?? '',
        name: checked.output.name ?? '',
        ...ignored,
        input: inputSummary
      };
    }
    if (action === 'delay') {
      // "现在先不说，但我记着这件事，过一会儿再想一次" —— 生成 wake 意图。
      const minutes = clampWakeMinutes(delayMinutes);
      return {
        intent: { type: 'wake', wakeAt: event.at + minutes * 60_000, reason, memoryIds },
        reason,
        source,
        confidence,
        action,
        ...ignored,
        input: inputSummary
      };
    }
    return {
      intent: null,
      reason: reason || `model-${action}`,
      source,
      confidence,
      action,
      ...ignored,
      input: inputSummary
    };
  };
}
