// S3 最小循环：perceive → recall → appraise → decide → act → outcome → learn。
// decide 可注入（测试/以后接模型）；默认只对认证用户的消息做确定性回执。
// act 不发送，只把意图交出去；tool-result 带 correlationId 回来才算闭环。

import { randomUUID } from 'node:crypto';
import { recallMemories, emptyRecall, cuesFromRecall } from '../memory/recall.js';
import { recallP4 } from '../memory/recall-p4.js';
import { addMemory, upsertObservationSource } from '../memory/write.js';
import { encodeEvent } from '../memory/encode.js';
import { appendEpisode, collectOpenLoops, recentEpisodes } from '../memory/episodes.js';
import { INTENT_TYPES } from '../ports/contract.js';
import { applyCareOutcome, careAllowed, topicOverlap, CARE_WINDOW_MS } from '../self/learning.js';
import { fastHabit, habitKey, recordHabitOutcome } from '../self/habits.js';
import { decayDrives, driveSummary, observeEvent, observeOutcome, topicsFromText } from '../self/drives.js';
import { settle } from '../self/mood.js';
import { careEvent, feedbackEvent, resultEvent, sendEvent, timeoutEvent } from '../self/mood-events.js';
import { timeSlot } from '../decide/presence.js';
import { actionSignature, recentDuplicate, rememberAction } from '../decide/safety.js';
import { classifyDelayedFeedback, feedbackKey, textHash } from '../self/social-feedback.js';
import { activeTraits, deriveTraits } from '../self/traits.js';
import { activeSpeakHabits, speakContextsFor } from '../self/speak-habits.js';
import { appendDormantTraits } from '../state/dormant-traits.js';
import { buildCatalog, findTool } from '../capability/catalog.js';
import { searchCatalog } from '../capability/search.js';
import { recordUsage } from '../capability/skills.js';

export const LOOP_STAGES = Object.freeze([
  'perceive',
  'recall',
  'appraise',
  'decide',
  'act',
  'outcome',
  'learn'
]);

export const DEFAULT_FALLBACK_TEXT = '嗯，我在。';

// 同一轮的多条回执（talkAndDo 会回来 send + invoke 两条）在这个窗口内只续一次。
const CONTINUATION_DEDUPE_MS = 5_000;

// 她发起 invoke 之后多久没回执，算一次“不确定”（情绪事件 timeout，10 分钟）。
const INVOKE_TIMEOUT_MS = 10 * 60_000;

// 待回执行动上限：超过时明确拒绝新行动，不静默截断旧关联。
export const PENDING_LIMIT = 256;

function queryOf(event, memories = [], now = event?.at) {
  if (event?.type === 'owner-message' || event?.type === 'owner-feedback') {
    const text = event?.payload?.text;
    if (typeof text === 'string') return text.slice(0, 300);
  }
  // 到点追问时也必须带上那条记忆，否则模型只能空手开口。
  if (event?.type === 'tick') {
    const due = findDueMemory(memories, now);
    if (due) return `${due.title ?? ''} ${due.content ?? ''}`.trim().slice(0, 200);
  }
  return '';
}

// 到点、未被追问、未被替代的最早一条；tick 的召回、默认策略和习惯都用它。
export function findDueMemory(memories, now = Date.now()) {
  if (!Array.isArray(memories)) return null;
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

export function followUpText(due) {
  const tag = (due?.tags ?? []).find(item => item !== '日程');
  return tag ? `${tag}的事，后来怎么样了？` : `上次说的${due?.title ?? '那件事'}，后来怎么样了？`;
}

// 内核只发出自己能说清楚的意图；不自洽的意图在 act 前就被挡住，不交给总线。
export const FEEDBACK_TYPES = Object.freeze([
  'execution-success',
  'read',
  'reply',
  'explicit-positive',
  'explicit-negative',
  'unknown'
]);

// R7：反馈只认证据。工具回执里的 ok 只证明执行成功；已读/回复也不等于认可。
function feedbackOf(payload, ok) {
  const declared = typeof payload?.feedback === 'string'
    ? payload.feedback
    : payload?.feedback?.type ?? payload?.feedbackType ?? null;
  if (FEEDBACK_TYPES.includes(declared)) return declared;
  if (!ok) return 'unknown';
  if (payload?.read === true || payload?.readAt != null) return 'read';
  if (payload?.reply === true || payload?.replied === true) return 'reply';
  if (payload?.sentiment === 'positive' || payload?.rating === 'positive') return 'explicit-positive';
  if (payload?.sentiment === 'negative' || payload?.rating === 'negative') return 'explicit-negative';
  return 'execution-success';
}

/**
 * 从一次决定里取出模型真正引用过的记忆 id。
 *
 * 决定的形状有两种：单个 intent，或 intents 数组（talkAndDo）。send/invoke/self-turn/wake
 * 都把 memoryIds 放在 intent 上同一层，所以只认这一处；去重后保持顺序。
 */
export function citedMemoryIds(decision) {
  const list = [];
  const push = value => {
    if (!Array.isArray(value)) return;
    for (const id of value) {
      const text = typeof id === 'string' ? id.trim() : '';
      if (text && !list.includes(text)) list.push(text);
    }
  };
  push(decision?.intent?.memoryIds);
  for (const intent of Array.isArray(decision?.intents) ? decision.intents : []) {
    push(intent?.memoryIds);
  }
  return list;
}

function intentProblem(intent, event) {  if (!INTENT_TYPES.includes(intent?.type)) return 'intent-type-unknown';
  if (intent.type === 'send') {
    if (typeof intent.text !== 'string' || intent.text.trim() === '') return 'send-text-empty';
    if (intent.replyTo != null && typeof intent.replyTo !== 'string') return 'send-reply-to-invalid';
  }
  if (intent.type === 'wake') {
    if (!Number.isFinite(intent.wakeAt) || intent.wakeAt <= event.at) return 'wake-time-not-future';
  }
  if (intent.type === 'invoke') {
    if (typeof intent.tool !== 'string' || intent.tool === '') return 'invoke-tool-missing';
    if (!intent.args || typeof intent.args !== 'object' || Array.isArray(intent.args)) {
      return 'invoke-args-invalid';
    }
  }
  return null;
}

// 她约了"过一会儿再想这件事"：把理由写成一条带 followUpAt 的计划记忆。
// wake 到点触发 tick 时，findDue 会把它当成"到期旧事"交回给她；
// 处理过后由 followUpAskedAt 标记，不会反复触发。
export function planMemoryInput(intent, event) {
  if (!intent || intent.type !== 'wake') return null;
  if (!Number.isFinite(intent.wakeAt)) return null;
  const reason = String(intent.reason ?? '').trim();
  const title = reason === '' ? '想做的事' : reason.slice(0, 60);
  return {
    kind: 'fact',
    layer: 'episodic',
    title: `计划：${title}`,
    content: (reason === '' ? '（没有写理由）' : reason).slice(0, 500),
    tags: ['计划', '自己约的'],
    importance: 3,
    source: { level: 'self-plan', selfPlan: true, eventId: event?.id ?? null },
    followUpAt: intent.wakeAt,
    occurredAt: intent.at
  };
}

function resultSummary(payload) {
  if (payload?.error) return `失败：${String(payload.error.message ?? payload.error.code ?? 'unknown').slice(0, 160)}`;
  const value = payload?.result;
  if (value === undefined) return '已执行';
  try {
    return `结果：${JSON.stringify(value).slice(0, 160)}`;
  } catch {
    return '已执行';
  }
}

// invoke 成功的回执是一条“观察”，不是“行动记录”：行动已在活动流水里。
function observationItems(payload) {
  const result = payload?.result;
  const unwrapped =
    result && typeof result === 'object' && !Array.isArray(result) && result.result && typeof result.result === 'object'
      ? result.result
      : result;
  const source = payload?.items ? { items: payload.items } : unwrapped;
  if (!source) return [];
  if (Array.isArray(source)) return source.slice(0, 5);
  if (Array.isArray(source.items)) return source.items.slice(0, 5);
  return [source];
}

function observationItemsPresent(payload) {
  const result = payload?.result;
  let value = result;
  if (typeof result === 'string') {
    try { value = JSON.parse(result); } catch { return false; }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (value.ok === false) return false;
    if (value.result && typeof value.result === 'object' && value.result.ok === false) return false;
  }
  const items = observationItems(payload);
  return items.some(item => item && (item.title || item.excerpt || item.desc));
}

function observationInput(payload, event, correlationId, intent = null) {
  const items = observationItems(payload);
  const first = items[0] ?? {};
  const title = String(first.title ?? payload?.title ?? '一次浏览').slice(0, 80);
  // 单条结果（字幕、视频详情）给足正文；多条的列表（搜索结果/热门）每条留短摘要。
  const perItem = items.length === 1 ? 800 : 120;
  const body = items
    .map(item => `${String(item.title ?? '').slice(0, 80)}：${String(item.excerpt ?? item.desc ?? '').slice(0, perItem)}`)
    .join('\n')
    .slice(0, 1200);
  const tags = [...new Set(items.flatMap(item => (Array.isArray(item.tags) ? item.tags : [])))]
    .filter(tag => typeof tag === 'string')
    .slice(0, 4);
  return {
    kind: 'observation',
    layer: 'episodic',
    title,
    content: body === '' ? '（没有描述，只有标题）' : body,
    tags: [...tags, '视频'],
    importance: 3,
    source: {
      level: 'observation',
      channel: 'tool',
      messageId: correlationId,
      correlationId,
      ...observationSourceMeta(payload, intent, event.at)
    },
    occurredAt: event.at
  };
}

// 观察的来源键与阅读进度：只有"针对同一个 bvid 的读取"才合并。
// discover（搜索列表）不参与合并——搜到的列表不是"看过某个东西"。
const OBSERVATION_MERGE_TOOLS = /bilibili\.(video|subtitles|audience)$/;
export function observationSourceMeta(payload, intent = null, atMs = 0) {
  const tool = String(intent?.tool ?? payload?.tool ?? '');
  const args = intent?.args && typeof intent.args === 'object' ? intent.args : {};
  const bvid = String(args.bvid ?? '').match(/BV[0-9A-Za-z]{10}/)?.[0] ?? '';
  const result = payload?.result && typeof payload.result === 'object' ? payload.result : {};
  const nextFrom = Number(result?.nextFrom);
  const meta = {};
  if (tool) meta.tool = tool;
  if (!OBSERVATION_MERGE_TOOLS.test(tool) || !bvid) return meta;
  meta.key = `bvid:${bvid}`;
  const from = Number.isFinite(Number(args.from)) ? Number(args.from) : 0;
  meta.progress = {
    tool,
    from,
    ...(Number.isFinite(nextFrom) ? { to: nextFrom, nextFrom } : {}),
    // 字幕：truncated=false 表示这一段已经到结尾；video/audience 本身没有分页，读到就算完整。
    done: tool.endsWith('.subtitles') ? result?.truncated === false : true,
    lastAt: Number(atMs) || 0
  };
  return meta;
}

// 已提交的长期理解：只作决策背景，不进入事实层。
function recentInsights(memory, { limit = 3 } = {}) {
  const rows = Array.isArray(memory?.memories) ? memory.memories : [];
  return rows
    .filter(row => row && row.kind === 'insight' && row.status !== 'staged' && !row.archivedAt && !row.supersededBy)
    .sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0))
    .slice(0, limit)
    .map(row => ({ id: row.id, title: row.title, content: row.content }));
}

// 只给决策提供最近一两篇日记的“自述背景”；日记不是事实来源，不能反过来当证据。
async function recentDiary(store, { limit = 2 } = {}) {
  if (!store?.listDiaries || !store?.readDiary) return [];
  try {
    const pendingDay = store.memory?.journal?.pending?.day ?? null;
    const rows = (await store.listDiaries()).filter(row => row && !row.archived && row.day !== pendingDay);
    const picked = rows.slice(-limit);
    const out = [];
    for (const row of picked) {
      const got = await store.readDiary(row.id);
      if (typeof got === 'string' && got.trim()) {
        out.push({ id: row.id, day: row.day ?? row.date ?? null, content: got.slice(0, 400) });
      }
    }
    return out;
  } catch {
    return [];
  }
}

// 把一次“用户消息 → 我的回复 → 回执”压成一张经历卡；experience 仍是原文真源。
function turnEpisodeOf(entry, event, payload) {
  if (entry.intent.type !== 'send') return null;
  return {
    id: `ep-${entry.event.id}`,
    kind: 'turn',
    at: entry.event.at,
    startedAt: entry.event.at,
    endedAt: event.at,
    userText: entry.event.type === 'owner-message' ? String(entry.event.payload?.text ?? '') : '',
    selfText: String(entry.intent.text ?? ''),
    outcome: { ok: payload?.ok === true, messageId: payload?.messageId ?? null },
    eventIds: [entry.event.id, event.id]
  };
}

export function createCycle({
  store,
  clock = () => Date.now(),
  decide = defaultDecide,
  onIntent = null,
  // 内在触发用：把自触发事件压回内核队列（不经过计时器与总线）。
  enqueue = null,
  // 自触发事件没有总线 payload 时，用它补一份当前能力目录（搜索/describe/使用印象需要）。
  capabilitiesProvider = null,
  capacity = 5000,
  timeZone = '',
  fallbackText = DEFAULT_FALLBACK_TEXT,
  extractor = null,
  // 浏览提炼：把 observation 压成可召回短句（仍写同一个 memory.json）。
  distiller = null,
  reflection = null,
  journal = null,
  association = null,
  personality = false,
  recallMode = 'legacy',
  logger = console
} = {}) {
  if (!store) throw new Error('createCycle: 缺少 store');
  const pending = new Map();
  let hydratePromise = null;
  // 连续自触发回合的计数（只用于记录，不拦截）；外部回合会重置。
  let selfChain = 0;
  // 同一轮只续一次：键是这一轮的事件 id。
  const continuationMarks = new Map();

  function hydratePending() {
    if (!hydratePromise) {
      hydratePromise = (async () => {
        const rows = Array.isArray(store.memory?.pendingActions) ? store.memory.pendingActions : [];
        for (const row of rows) {
          if (!row || typeof row.correlationId !== 'string') continue;
          if (!pending.has(row.correlationId)) pending.set(row.correlationId, row);
        }
        // 内存视图只是尾部缓存；待回执行动以 append-only 日志为准。
        if (typeof store.readPendingActions === 'function') {
          try {
            const persisted = await store.readPendingActions();
            for (const row of persisted) {
              if (!row || typeof row.correlationId !== 'string') continue;
              if (!pending.has(row.correlationId)) pending.set(row.correlationId, row);
            }
          } catch (error) {
            logger?.warn?.('[cognition] 待回执行动日志读取失败', { error: error?.message });
          }
        }
      })();
    }
    return hydratePromise;
  }

  async function run(event) {
    await hydratePending();
    // 只有新的外部回合才重置自激计数；回执属于同一串，不能清零。
    const isSelfTurn = event.type === 'self-turn' || (event.type === 'tick' && event.payload?.source === 'self');
    if (!isSelfTurn && event.type !== 'tool-result') selfChain = 0;
    const trace = {
      id: `trace-${randomUUID()}`,
      eventId: event.id,
      at: event.at,
      stages: {}
    };

    if (event.type === 'tool-result') return runOutcome(event, trace);

    // R8：惰性节律衰减；同一时间戳重复调用是 no-op。
    // V-A-E 时间结算也在这里做：没有事件时只推进自然平复与精力恢复。
    // 顺便扫描“回执超时”：她发起 invoke 后 10 分钟没有回执，算一次不确定（cause=unknown）。
    // 事件 id 固定为 timeout:<correlationId>，重复扫描不会重复计。
    await store.saveBehavior(behavior => {
      decayDrives(behavior, event.at);
      const timeouts = [];
      for (const [correlationId, entry] of pending) {
        if (entry?.intent?.type !== 'invoke') continue;
        const createdAt = Number(entry.createdAt ?? 0);
        if (!Number.isFinite(createdAt) || event.at - createdAt < INVOKE_TIMEOUT_MS) continue;
        const ev = timeoutEvent({ correlationId, at: event.at });
        if (ev) timeouts.push(ev);
      }
      behavior.affect = settle(behavior.affect, { now: event.at, events: timeouts }).affect;
    });

    trace.stages.perceive = { type: event.type, actor: event.actor?.kind ?? 'unknown' };
    const care = await resolveCare(event);
    if (care.length > 0) trace.stages.perceive.care = care;
    const encoded = encodeEvent(event, { state: store.memory, now: event.at, timeZone, capacity });
    if (encoded.created.length > 0 || encoded.corrected.length > 0) {
      await store.saveMemory(() => undefined);
      trace.stages.perceive.encoded = encoded.created.length;
      trace.stages.perceive.corrected = encoded.corrected.length;
    }
    if (association && encoded.created.length >= 2) {
      const linked = await association.recordExperience({
        episodeId: event.id,
        memoryIds: encoded.created.map(row => row.id),
        at: event.at
      });
      if (linked?.ok) trace.stages.perceive.association = 'co-experience';
    }
    const query = queryOf(event, store.memory.memories, event.at);
    const contextText = recallMode === 'p4'
      ? recentEpisodes(store.memory, { k: 4 })
        .map(row => String(row.userText ?? '').trim())
        .filter(Boolean)
        .slice(-3)
        .join(' ')
      : '';
    const recall =
      query === ''
        ? emptyRecall()
        : recallMode === 'p4'
          ? recallP4(store.memory.memories, query, { now: event.at, drives: store.behavior, contextText })
          : recallMemories(store.memory.memories, query, { now: event.at, drives: store.behavior });
    // K-1 召回审计：每次执行的召回留一行（有上限，不无限增长）。
    // 用途：算僵尸率（活跃且长期零次出现）/ 引用率 / 槽位填充率。
    if (query !== '' && Array.isArray(recall?.items)) {
      try {
        await store.saveMemory(memory => {
          const runs = Array.isArray(memory.recallRuns) ? memory.recallRuns : [];
          runs.push({
            at: event.at,
            mode: recall.mode ?? 'legacy',
            q: String(query).slice(0, 80),
            n: recall.items.length,
            chars: recall.items.reduce((sum, item) => sum + JSON.stringify(item).length, 0),
            ids: recall.items.map(item => item.id)
          });
          memory.recallRuns = runs.slice(-300);
        });
      } catch { /* 审计失败不影响召回 */ }
    }
    trace.stages.recall = {
      executed: query !== '',
      mode: recall?.mode ?? 'legacy',
      items: recall.items.length,
      truncated: recall.truncated,
      topics: Object.keys(recall.topicHits ?? {}).length,
      ...(recall?.mode === 'p4' ? { usedContext: recall.usedContext, poolSize: recall.poolSize, excluded: recall.excluded } : {})
    };
    if (association && recallMode === 'p4' && query !== '') {
      const baseIds = new Set(recall.items.map(item => item.id));
      const expanded = association.expand({
        memories: store.memory.memories,
        seedIds: recall.items.map(item => item.id),
        baseIds,
        now: event.at
      });
      if (expanded.items.length > 0) {
        recall.items = recall.items.concat(expanded.items);
        recall.truncated = true;
      }
      trace.stages.recall.association = {
        reason: expanded.reason,
        seeds: expanded.seeds?.length ?? 0,
        reached: expanded.reached ?? 0,
        added: expanded.items.length,
        gatedOut: expanded.gatedOut ?? 0
      };
    }
    // 被动注入只记"进过上下文"，不记"被使用"：否则被注入自己就把条目刷年轻，形成热点自我强化。
    if (association) {
      const injected = typeof association.markInjected === 'function'
        ? association.markInjected(recall.items.map(item => item.id), event.id, event.at)
        : 0;
      if (injected > 0) await store.saveMemory(() => undefined);
    }

    const cues = cuesFromRecall(recall);
    const affect = { ...store.behavior.affect };
    const isOwnerTurn = event.type === 'owner-message' || event.type === 'owner-feedback';
    const ownerText = isOwnerTurn ? String(event.payload?.text ?? '') : '';
    // 兴趣话题优先取用户原话里的内容词；召回标签只补“非通用”的，避免把
    // 承诺/行为/对话这类结构标签误当成话题。
    const genericTags = new Set(['承诺', '请求', '情绪', '行为', '对话', '日程', '偏好', '用户', '称呼', '问句', '寒暄']);
    const nonGenericTopics = cues.topics
      .map(item => item.topic)
      .filter(topic => !String(topic).split(/[,，]/).some(part => genericTags.has(part.trim())));
    const activeTopics = isOwnerTurn
      ? [...new Set([...topicsFromText(ownerText, { limit: 4 }), ...nonGenericTopics])].slice(0, 6)
      : [];
    if (isOwnerTurn) {
      await store.saveBehavior(behavior => {
        observeEvent(behavior, {
          topics: activeTopics,
          question: /[？?]|吗|呢/.test(ownerText),
          now: event.at
        });
      });
      const delayed = await applyDelayedFeedback(event, ownerText);
      if (delayed) trace.stages.perceive.delayedFeedback = delayed;
    }
    const drives = driveSummary(store.behavior);
    trace.stages.appraise = {
      drivers: cues.drivers.length,
      topics: activeTopics.length,
      energy: affect.energy,
      drives
    };

    if (personality) {
      const evolved = deriveTraits({
        memories: store.memory.memories,
        personality: store.behavior.personality,
        now: event.at
      });
      if (evolved.changes.length > 0) {
        await store.saveBehavior(behavior => {
          behavior.personality = evolved.personality;
        });
        // 超出活跃池被挤出的条目沉底，不删除（以前是 slice(-24) 直接吃掉）。
        if (Array.isArray(evolved.evicted) && evolved.evicted.length > 0 && store.root) {
          try {
            await appendDormantTraits(store.root, evolved.evicted);
          } catch (error) {
            logger?.warn?.('[cognition] 倾向沉底失败', { error: error?.message });
          }
        }
        await store.appendActivity({
          at: clock(),
          eventId: event.id,
          kind: 'trait-updated',
          changes: evolved.changes,
          ...(Array.isArray(evolved.evicted) && evolved.evicted.length > 0
            ? { dormant: evolved.evicted.map(item => item.label) }
            : {})
        });
        await store.appendPersonalityRevision?.({
          at: clock(),
          eventId: event.id,
          revision: evolved.personality.revision,
          changes: evolved.changes,
          items: evolved.personality.items
        });
      }
      trace.stages.appraise.personality = evolved.changes;
    }
    const due = event.type === 'tick' ? findDueMemory(store.memory.memories, event.at) : null;
    // 话题相关优先：把当前对话/兴趣/到期旧事的主题给倾向选择器，再按置信补足。
    const traitTopics = [
      ...(Array.isArray(cues?.topics) ? cues.topics : []),
      ...(Array.isArray(drives?.interests) ? drives.interests.map(row => row?.topic ?? row) : []),
      ...(Array.isArray(due?.tags) ? due.tags : [])
    ].filter(topic => typeof topic === 'string' && topic.trim().length >= 2);
    const traits = personality ? activeTraits(store.behavior.personality, { topics: traitTopics }) : [];
    const speakHabits = activeSpeakHabits(store.self, {
      contexts: speakContextsFor({ event, affect }),
      limit: 5
    });

    let decision;
    {
      const diary = await recentDiary(store, { limit: 2 });
      const pendingSearch = Array.isArray(store.memory.pendingSearch?.results) ? store.memory.pendingSearch.results : [];
      // 下一步该用的工具（搜完视频后把 bilibili.video 摆到手边，避免"搜到了却不知道拿它看"）
      const nextTools = Array.isArray(store.memory.nextToolHints) ? store.memory.nextToolHints : [];
      const skills = typeof store.readSkills === 'function' ? await store.readSkills() : null;
      decision = await decide({
        event,
        recall,
        cues,
        affect,
        drives,
        self: store.self,
        memories: store.memory.memories,
        activities: store.memory.activity,
        episodes: store.memory.episodes,
        recent: recentEpisodes(store.memory, { k: 12 }),
        openLoops: collectOpenLoops(store.memory, { now: event.at }),
        insights: recentInsights(store.memory, { now: event.at }),
        diary,
        traits,
        speakHabits,
        now: event.at,
        timeZone,
        fallbackText,
        due,
        skills,
        pendingSearch,
        nextTools
      });
      // 搜索结果/下一步工具只活一轮：这一轮用完就清掉。
      if (pendingSearch.length > 0 || nextTools.length > 0) {
        await store.saveMemory(memory => {
          delete memory.pendingSearch;
          delete memory.nextToolHints;
        });
      }
    }
    trace.stages.decide = trace.stages.decide ?? {
      intentType: decision?.intent?.type ?? null,
      reason: decision?.reason ?? null,
      source: decision?.source ?? 'default',
      action: decision?.action ?? null,
      input: decision?.input ?? null,
      ...(Array.isArray(decision?.ignoredMemoryIds) && decision.ignoredMemoryIds.length > 0
        ? { ignoredMemoryIds: decision.ignoredMemoryIds }
        : {})
    };
    if (Array.isArray(decision?.ignoredMemoryIds) && decision.ignoredMemoryIds.length > 0) {
      await store.appendActivity({
        at: clock(),
        eventId: event.id,
        kind: 'memory-id-ignored',
        memoryIds: decision.ignoredMemoryIds
      });
    }
    // 只有模型明确引用（memoryIds）才算"被使用"：recallCount / lastRecalledAt 只由真实使用驱动。
    if (association && typeof association.markUsed === 'function') {
      const cited = citedMemoryIds(decision);
      if (cited.length > 0) {
        const used = association.markUsed(cited, event.id, event.at);
        if (used > 0) await store.saveMemory(() => undefined);
        trace.stages.recall.cited = cited.length;
      }
    }
    if (decision?.activity) {
      await store.appendActivity({
        at: clock(),
        eventId: event.id,
        ...decision.activity
      });
    }

    // 能力发现：search / describe 只查目录、不执行工具。
    // 结果放进 pendingSearch（只活一轮），再压一轮续跑，让她下一轮看到"手边工具"。
    if (decision?.action === 'search' || decision?.action === 'describe') {
      const catalog = catalogFor(event);
      const nowAt = clock();
      let pending = null;
      if (decision.action === 'search') {
        const result = searchCatalog(catalog, { query: decision.query });
        pending = { kind: 'search', query: decision.query, results: result.items, at: nowAt };
        await store.appendActivity({
          at: nowAt, eventId: event.id, kind: 'capability-search',
          query: decision.query, hits: result.items.length
        });
      } else {
        const found = findTool(catalog, decision.name);
        pending = {
          kind: 'describe', name: decision.name, at: nowAt,
          results: found
            ? [{ tool: found.tool, summary: found.description.slice(0, 60), domain: found.domain, executable: found.executable }]
            : []
        };
        await store.appendActivity({
          at: nowAt, eventId: event.id, kind: 'capability-describe',
          name: decision.name, found: Boolean(found)
        });
      }
      await store.saveMemory(memory => { memory.pendingSearch = pending; });
      const followEvent = {
        id: `self-${event.id}-${randomUUID()}`,
        type: 'tick',
        at: clock(),
        actor: { kind: 'system' },
        payload: {
          source: 'self',
          allowBrowse: true,
          reason: decision.action === 'search' ? '搜完了，看看手边有没有合适的工具' : '参数查到了，看看要不要用',
          ...(capabilitiesOf(event) ? { capabilities: capabilitiesOf(event) } : {})
        }
      };
      if (typeof enqueue === 'function') {
        await enqueue(followEvent);
        await store.appendActivity({
          at: clock(), eventId: event.id, kind: 'capability-follow-up',
          selfEventId: followEvent.id, via: decision.action
        });
        trace.stages.act = { selfTurn: true, selfEventId: followEvent.id, via: decision.action };
      } else {
        trace.stages.act = { selfTurn: false, reason: 'no-enqueue' };
      }
      return { trace, intent: null };
    }

    // 内在触发：她自己开一轮。不产生 wake、不经过计时器与总线，
    // 直接把一个自触发事件压回队列；自触发回合不再开放 initiate（见 allowedActionsFor）。
    if (decision?.intent?.type === 'self-turn') {
      const selfEvent = {
        id: `self-${event.id}-${randomUUID()}`,
        type: 'self-turn',
        at: clock(),
        actor: { kind: 'system' },
        payload: {
          source: 'self',
          reason: String(decision.reason ?? '').slice(0, 200),
          ...(capabilitiesOf(event) ? { capabilities: capabilitiesOf(event) } : {})
        }
      };
      if (typeof enqueue === 'function') {
        await enqueue(selfEvent);
        await store.appendActivity({
          at: clock(),
          eventId: event.id,
          kind: 'self-turn-queued',
          selfEventId: selfEvent.id
        });
        trace.stages.act = { selfTurn: true, selfEventId: selfEvent.id };
      } else {
        await store.appendActivity({ at: clock(), eventId: event.id, kind: 'self-turn-unavailable' });
        trace.stages.act = { selfTurn: false, reason: 'no-enqueue' };
      }
      return { trace, intent: null };
    }

    // 边说边做：先把 send 发出去，再按单意图路径处理 invoke。
    if (Array.isArray(decision?.intents) && decision.intents.length > 0) {
      const [first, ...rest] = decision.intents;
      if (first?.type === 'send' && typeof onIntent === 'function') {
        // 每个意图要有自己的 correlationId：同一轮里 send + invoke 若共用 event.id，
        // 先到的 send 回执会把 pending 里的键删掉，后到的 invoke 回执就成了"无主"，
        // 浏览结果会被整包丢掉。
        const sendIntentId = `intent-${randomUUID()}`;
        const sendIntent = {
          ...first,
          intentId: sendIntentId,
          correlationId: first.correlationId || sendIntentId,
          at: clock()
        };
        const sendProblem = intentProblem(sendIntent, event);
        if (!sendProblem) {
          await store.appendActivity({
            at: clock(),
            eventId: event.id,
            kind: 'outbound-before-do',
            text: String(sendIntent.text ?? '').slice(0, 120)
          });
          await onIntent(sendIntent);
          // send 的回执也要登记，否则每轮都会多一条"无主回执"噪声。
          const sendEntry = {
            actionId: `act-${sendIntent.intentId}`,
            correlationId: sendIntent.correlationId,
            intent: sendIntent,
            event: {
              id: event.id,
              type: event.type,
              at: event.at,
              actor: event.actor ?? null,
              payload: { text: event.payload?.text ?? '' }
            },
            status: 'pending',
            createdAt: sendIntent.at
          };
          pending.set(sendIntent.correlationId, sendEntry);
          await store.saveMemory(memory => {
            const list = Array.isArray(memory.pendingActions) ? memory.pendingActions : (memory.pendingActions = []);
            memory.pendingActions = list.filter(row => row?.correlationId !== sendIntent.correlationId).concat([sendEntry]);
          });
        } else {
          await store.appendActivity({
            at: clock(),
            eventId: event.id,
            kind: 'intent-invalid',
            intentType: sendIntent.type,
            reason: sendProblem
          });
        }
      }
      decision = { ...decision, intent: rest[0] ?? null, intents: undefined };
      if (!decision.intent) return { trace, intent: null };
    }

    if (!decision?.intent) {
      if (event.type === 'owner-message' || event.type === 'tick') {
        appendEpisode(store.memory, {
          id: `ep-dec-${event.id}`,
          kind: 'decision',
          at: event.at,
          userText: event.type === 'owner-message' ? String(event.payload?.text ?? '') : '',
          content: decision?.reason ?? 'no-intent',
          eventIds: [event.id]
        });
        await store.saveMemory(() => undefined);
      }
      await store.appendActivity({
        at: clock(),
        kind: 'decision-none',
        eventId: event.id,
        reason: decision?.reason ?? 'no-intent'
      });
      return { trace, intent: null };
    }

    const intentId = `intent-${randomUUID()}`;
    const intent = {
      ...decision.intent,
      intentId,
      // 用意图自己的 id 做关联键，避免同一轮多个意图互相覆盖/误删。
      correlationId: decision.intent.correlationId || intentId,
      at: clock()
    };
    const problem = intentProblem(intent, event);
    if (problem) {
      await store.appendActivity({
        at: intent.at,
        kind: 'intent-invalid',
        eventId: event.id,
        intentType: intent.type ?? null,
        reason: problem
      });
      trace.stages.act = { invalid: true, reason: problem };
      return { trace, intent: null };
    }
    // 她自己约的 wake：先把"要做什么"落成计划记忆，醒来时 due 会把它带回来。
    if (intent.type === 'wake') {
      // delay 上限：最多 7 个还没消费的唤醒；到顶就先不排，记一笔。
      const pendingWakes = store.memory.memories.filter(
        row => row?.source?.selfPlan === true && Number(row.followUpAt) > intent.at && !row.supersededBy
      ).length;
      if (pendingWakes >= 7) {
        await store.appendActivity({
          at: intent.at, eventId: event.id, kind: 'delay-rejected', pending: pendingWakes
        });
        trace.stages.act = { invalid: true, reason: 'delay-limit' };
        return { trace, intent: null };
      }
      const plan = planMemoryInput(intent, event);
      if (plan) {
        await store.saveMemory(memory => {
          addMemory(memory, plan, { now: intent.at, capacity, timeZone });
        });
        await store.appendActivity({
          at: intent.at,
          kind: 'plan-recorded',
          eventId: event.id,
          wakeAt: intent.wakeAt,
          reason: String(intent.reason ?? '').slice(0, 120)
        });
      }
    }
    // 主动关心也受阈值约束：模型或默认策略都不能绕过“太弱的旧事不提”。
    if (intent.type === 'send' && intent.followUpMemoryId && event.type === 'tick') {
      const row = store.memory.memories.find(item => item.id === intent.followUpMemoryId);
      const gate = careAllowed({ row, now: event.at, self: store.self });
      if (!gate.allowed) {
        await store.appendActivity({
          at: intent.at,
          eventId: event.id,
          kind: 'care-skipped',
          memoryId: intent.followUpMemoryId,
          score: gate.score,
          threshold: gate.threshold
        });
        trace.stages.act = { skipped: true, reason: 'care-below-threshold' };
        return { trace, intent: null };
      }
    }
    const careRow = intent.followUpMemoryId
      ? store.memory.memories.find(item => item.id === intent.followUpMemoryId)
      : null;
    const careHabitKey =
      careRow && event.type === 'tick'
        ? habitKey({
            eventType: 'tick',
            topic: careRow.tags?.[0] ?? null,
            slot: timeSlot(intent.at, timeZone),
            energy: affect.energy
          })
        : null;

    // 技术保护：完全相同的动作在短窗口内只执行一次，避免异常循环。
    // 只挡对外发送与唤醒；只读 invoke 连续两次可能是正常浏览，不在这里拦。
    // 这不是“联系间隔”，不限制正常的不同行动。
    const signature = intent.type === 'send' ? actionSignature(intent) : null;
    const duplicate = signature ? recentDuplicate(store.memory.recentActions, signature, intent.at) : false;
    if (duplicate) {
      await store.appendActivity({
        at: intent.at,
        kind: 'duplicate-suppressed',
        eventId: event.id,
        intentType: intent.type,
        signature
      });
      trace.stages.act = { skipped: true, reason: 'duplicate-suppressed', signature };
      return { trace, intent: null };
    }

    const actionId = intent.actionId || `act-${intent.intentId}`;
    intent.actionId = actionId;

    // 容量上限：宁可明确拒绝新行动，也不静默丢掉旧的待回执行动。
    if (pending.size >= PENDING_LIMIT) {
      await store.appendActivity({
        at: intent.at,
        kind: 'action-capacity-reached',
        eventId: event.id,
        intentType: intent.type,
        actionId,
        pending: pending.size,
        limit: PENDING_LIMIT
      });
      trace.stages.act = { skipped: true, reason: 'action-capacity-reached', pending: pending.size, limit: PENDING_LIMIT };
      return { trace, intent: null };
    }

    await store.saveMemory(memory => {
      memory.recentActions = rememberAction(memory.recentActions, signature, intent.at);
    });

    const pendingEntry = {
      actionId,
      correlationId: intent.correlationId,
      intent,
      event: {
        id: event.id,
        type: event.type,
        at: event.at,
        actor: event.actor ?? null,
        payload: { text: event.payload?.text ?? '' }
      },
      habitKey: careHabitKey,
      topics: activeTopics,
      drove: drives,
      cited: Array.isArray(decision?.intent?.memoryIds) ? [...decision.intent.memoryIds] : [],
      status: 'pending',
      createdAt: intent.at
    };
    try {
      if (typeof store.appendPendingAction === 'function') {
        await store.appendPendingAction(pendingEntry);
      }
    } catch (error) {
      await store.appendActivity({
        at: intent.at,
        kind: 'action-persist-failed',
        eventId: event.id,
        intentType: intent.type,
        actionId,
        error: String(error?.message ?? error)
      });
      trace.stages.act = { skipped: true, reason: 'action-persist-failed', actionId };
      return { trace, intent: null };
    }
    pending.set(intent.correlationId, pendingEntry);
    await store.saveMemory(memory => {
      const list = Array.isArray(memory.pendingActions) ? memory.pendingActions : (memory.pendingActions = []);
      memory.pendingActions = list.filter(row => row?.correlationId !== intent.correlationId).concat([pendingEntry]);
    });
    if (intent.followUpMemoryId) {
      await store.saveMemory(memory => {
        const row = memory.memories.find(item => item.id === intent.followUpMemoryId);
        if (row) row.followUpAskedAt = event.at;
        const list = Array.isArray(memory.carePending) ? memory.carePending : (memory.carePending = []);
        list.push({
          memoryId: intent.followUpMemoryId,
          correlationId: intent.correlationId,
          sentAt: intent.at,
          habitKey: careHabitKey
        });
        if (list.length > 5) memory.carePending = list.slice(-5);
      });
    }
    await store.appendActivity({
      at: intent.at,
      kind: 'intent-emitted',
      eventId: event.id,
      intentType: intent.type,
      intentId: intent.intentId,
      actionId,
      correlationId: intent.correlationId
    });
    trace.stages.act = {
      intentType: intent.type,
      intentId: intent.intentId,
      actionId,
      correlationId: intent.correlationId
    };

    if (typeof onIntent === 'function') {
      try {
        await onIntent(intent);
      } catch (error) {
        logger?.error?.('[cognition] 意图投递失败', { intentId: intent.intentId, error: error?.message });
      }
    }
    return { trace, intent };
  }

  // 延迟社交反馈：用户后续明确评价才算证据；执行成功本身不算认可。
  // 证据身份以用户消息 id 为主：同一消息重复到达幂等，不同消息即使文字相同也是独立交流。
  async function applyDelayedFeedback(event, text) {
    if (!text) return null;
    const feedback = classifyDelayedFeedback(text);
    if (!feedback) return null;
    const cutoff = event.at - 72 * 60 * 60 * 1000;
    const actions = (store.memory.memories ?? [])
      .filter(
        row =>
          row?.kind === 'action' &&
          row?.source?.intentType === 'send' &&
          typeof row?.source?.actionId === 'string' &&
          Number(row.occurredAt) >= cutoff
      )
      .sort((a, b) => Number(b.occurredAt) - Number(a.occurredAt));
    const action = actions[0];
    if (!action) return null;
    const key = feedbackKey(action.source.actionId, event.id, text);
    const digest = textHash(text);
    const seen = Array.isArray(store.memory.feedbackEvidence) ? store.memory.feedbackEvidence : [];
    if (seen.some(entry => (typeof entry === 'string' ? entry : entry?.key) === key)) {
      return { type: feedback.type, actionId: action.source.actionId, duplicate: true };
    }
    // 同一行动下文字完全相同的独立消息：仍算真实交流，但权重减半，避免机械重复抬高兴趣。
    const repeated = seen.filter(entry => typeof entry === 'object' && entry?.actionId === action.source.actionId && entry?.textHash === digest);
    const weight = repeated.length > 0 ? 0.5 : 1;
    await store.saveBehavior(behavior => {
      observeOutcome(behavior, {
        ok: feedback.type === 'explicit-positive',
        topics: Array.isArray(action.source.topics) ? action.source.topics : [],
        proactive: true,
        now: event.at,
        weight
      });
      // 只有“用户确实接住了这次主动关心”才算一点正向情绪；
      // unrelated / silence 不接——没接话不是否定，沉默更不是。
      const careMood = careEvent({ actionId: action.source.actionId, at: event.at, label: feedback.type });
      if (careMood) behavior.affect = settle(behavior.affect, { now: event.at, events: [careMood] }).affect;
    });
    await store.saveMemory(memory => {
      const list = Array.isArray(memory.feedbackEvidence) ? memory.feedbackEvidence : (memory.feedbackEvidence = []);
      memory.feedbackEvidence = list
        .concat([{ key, messageId: event.id, actionId: action.source.actionId, textHash: digest, type: feedback.type, at: event.at, weight }])
        .slice(-64);
      // 反馈原文单独成卡：主体是助手自己，而不是用户画像。
      addMemory(memory, {
        kind: 'feedback',
        layer: 'preference',
        title: `用户反馈：${feedback.type === 'explicit-positive' ? '肯定' : '否定'}`,
        content: String(text).slice(0, 300),
        tags: ['反馈', feedback.type === 'explicit-positive' ? '正反馈' : '负反馈'],
        importance: 3,
        confidence: 1,
        source: {
          level: 'owner-feedback',
          messageId: event.id,
          actionId: action.source.actionId,
          feedbackType: feedback.type,
          subject: 'self'
        }
      }, { now: event.at });
    });
    await store.appendActivity({
      at: event.at,
      kind: 'social-feedback',
      eventId: event.id,
      actionId: action.source.actionId,
      feedback: feedback.type,
      evidenceKey: key,
      messageId: event.id,
      textHash: digest,
      weight
    });
    return { type: feedback.type, actionId: action.source.actionId, key, weight };
  }

  // 学习信号解析：主动关心之后，用户的下一条消息（或沉默超窗）给一次反馈。
  // 只取最早的待回应记录；回别的事不算负信号，避免把“忙”误读成“不喜欢”。
  async function resolveCare(event) {
    const list = Array.isArray(store.memory.carePending) ? store.memory.carePending : [];
    if (list.length === 0) return [];
    const outcomes = [];
    const keep = [];
    let ownerResolved = false;
    for (const entry of [...list].sort((a, b) => Number(a.sentAt) - Number(b.sentAt))) {
      const age = event.at - Number(entry.sentAt);
      if (event.type === 'owner-message' && !ownerResolved && age >= 0 && age <= CARE_WINDOW_MS) {
        const row = store.memory.memories.find(item => item.id === entry.memoryId);
        outcomes.push({
          memoryId: entry.memoryId,
          habitKey: entry.habitKey ?? null,
          label: topicOverlap(row, event.payload?.text) ? 'topic-continues' : 'unrelated'
        });
        ownerResolved = true;
        continue;
      }
      if (age > CARE_WINDOW_MS) {
        outcomes.push({ memoryId: entry.memoryId, habitKey: entry.habitKey ?? null, label: 'silence' });
        continue;
      }
      keep.push(entry);
    }
    if (outcomes.length === 0) return [];

    store.memory.carePending = keep;
    await store.saveMemory(() => undefined);

    let selfChanged = false;
    const applied = [];
    for (const outcome of outcomes) {
      const learned = applyCareOutcome(store.self, {
        signal: outcome.label,
        at: event.at,
        timeZone,
        memoryId: outcome.memoryId
      });
      if (learned) {
        selfChanged = true;
        applied.push({ ...outcome, ...learned });
      }
      // 习惯只从真正的结果信号学习：继续聊=成功，72 小时没回=失败；回别的事不算。
      const learnedHabit =
        outcome.habitKey && outcome.label !== 'unrelated'
          ? recordHabitOutcome(store.self, {
              key: outcome.habitKey,
              action: 'send-followup',
              ok: outcome.label === 'topic-continues',
              at: event.at
            })
          : null;
      if (learnedHabit) selfChanged = true;
      await store.appendActivity({
        at: clock(),
        eventId: event.id,
        kind: 'care-outcome',
        signal: outcome.label,
        memoryId: outcome.memoryId,
        ...(learned ? { delta: learned.delta, threshold: learned.threshold } : {}),
        ...(learnedHabit ? { habitConfidence: learnedHabit.confidence } : {})
      });
    }
    if (selfChanged) await store.saveSelf(() => undefined);
    return applied;
  }

  async function runOutcome(event, trace) {
    const payload = event.payload ?? {};
    const correlationId = payload.correlationId || event.correlationId || null;
    trace.stages.outcome = { correlationId, ok: payload.ok === true };

    const entry = correlationId ? pending.get(correlationId) : null;
    if (!entry) {
      const completed = Array.isArray(store.memory.memories)
        ? store.memory.memories.find(
            row => row?.source?.level === 'action-result' && row?.source?.correlationId === correlationId
          )
        : null;
      if (completed) {
        const duplicateId = completed.source.actionId ?? null;
        await store.appendActivity({
          at: clock(),
          kind: 'outcome-duplicate',
          eventId: event.id,
          ...(duplicateId ? { actionId: duplicateId } : {}),
          correlationId
        });
        trace.stages.outcome = { correlationId, matched: true, duplicate: true };
        return { trace, intent: null, outcome: { matched: true, duplicate: true } };
      }
      await store.appendActivity({
        at: clock(),
        kind: 'tool-result-unmatched',
        eventId: event.id,
        correlationId,
        actionStatus: 'unknown',
        ok: payload.ok === true
      });
      trace.stages.outcome = { correlationId, matched: false, actionStatus: 'unknown' };
      return { trace, intent: null, outcome: { matched: false, actionStatus: 'unknown' } };
    }

    const actionId = entry.actionId || entry.intent?.actionId || `act-${entry.intent?.intentId ?? correlationId}`;
    const doneAlready =
      Array.isArray(store.memory.processedActionIds) && store.memory.processedActionIds.includes(actionId);
    if (doneAlready) {
      pending.delete(correlationId);
      await store.appendActivity({
        at: clock(),
        kind: 'outcome-duplicate',
        eventId: event.id,
        actionId,
        correlationId
      });
      trace.stages.outcome = { correlationId, actionId, duplicate: true };
      return { trace, intent: null, outcome: { matched: true, duplicate: true } };
    }

    pending.delete(correlationId);
    await store.saveMemory(memory => {
      memory.pendingActions = (Array.isArray(memory.pendingActions) ? memory.pendingActions : []).filter(
        row => row?.correlationId !== correlationId
      );
    });

    const ok = payload.ok === true;
    // 工具使用印象：invoke 成功后记一笔（用途快照 + 次数），注入时优先出现。
    if (ok && entry.intent.type === 'invoke' && typeof store.saveSkills === 'function') {
      try {
        const catalog = catalogFor(event);
        const found = findTool(catalog, entry.intent.tool);
        await store.saveSkills(state => recordUsage(state, {
          tool: entry.intent.tool,
          purpose: found?.description ?? '',
          now: event.at
        }));
        // 搜完视频后，下一步通常是"点开看"：把 bilibili.video 摆到下一轮手边。
        if (entry.intent.tool === 'bilibili.discover') {
          await store.saveMemory(memory => { memory.nextToolHints = ['bilibili.video']; });
        }
      } catch { /* 使用印象/下一步提示失败不影响回执处理 */ }
    }
    const existing = store.memory.memories.find(
      row => row?.source?.correlationId === correlationId && row?.source?.level === 'action-result'
    );
    const result = existing
      ? { ok: true, id: existing.id, row: existing, duplicate: true }
      : entry.intent.type === 'invoke' && ok && observationItemsPresent(payload)
        ? (() => {
            // 同一个 bvid 的再次读取 → 合并进原记录（记 sections / progress / done），不再开新行。
            const observationData = observationInput(payload, event, correlationId, entry.intent);
            const mergedObservation = upsertObservationSource(store.memory, observationData, { now: event.at });
            return mergedObservation
              ?? addMemory(store.memory, observationData, { now: event.at, capacity, timeZone });
          })()
        : addMemory(
            store.memory,
            {
              kind: 'action',
              layer: 'episodic',
              title:
                entry.intent.type === 'send'
                  ? '执行发送'
                  : entry.intent.type === 'wake'
                    ? '安排唤醒'
                    : `执行${entry.intent.type}`,
              content:
                entry.intent.type === 'send'
                  ? `我对用户说：${String(entry.intent.text ?? '').slice(0, 500)}\n发送结果：${resultSummary(payload)}`
                  : resultSummary(payload),
              tags: entry.intent.type === 'send' ? ['行为', '对话'] : ['行为'],
              importance: ok ? 3 : 2,
              source: {
                level: 'action-result',
                channel: 'tool',
                actionId,
                messageId: correlationId,
                correlationId,
                intentId: entry.intent.intentId,
                intentType: entry.intent.type,
                topics: Array.isArray(entry.topics) ? entry.topics : [],
                ...(entry.intent.type === 'send' ? { to: entry.intent.to ?? 'owner' } : {})
              },
              occurredAt: event.at
            },
            { now: event.at, capacity, timeZone }
          );

    // 观察刚写进记忆：让提炼器把它压成一条可召回的短事实。
    if (entry.intent.type === 'invoke' && ok && result?.row && typeof distiller?.enqueue === 'function') {
      try { distiller.enqueue(result.row); } catch { /* 提炼失败不影响主流程 */ }
    }

    let episode = null;
    if (entry.intent.type === 'send') {
      episode = appendEpisode(store.memory, turnEpisodeOf(entry, event, payload));
    } else if (entry.intent.type === 'invoke' && ok && result.ok) {
      episode = appendEpisode(store.memory, {
        id: `ep-obs-${correlationId}`,
        kind: 'observation',
        at: event.at,
        title: result.row?.title ?? '一次浏览',
        content: result.row?.content ?? '',
        memoryIds: [result.id],
        eventIds: [event.id]
      });
    }
    if (episode) extractor?.enqueue(episode);
    if (episode?.kind === 'turn') {
      reflection?.enqueue?.(episode);
    }
    if (association && result.ok) {
      const cited = Array.isArray(entry.cited) ? entry.cited : [];
      if (entry.intent.type === 'send' && cited.length > 0) {
        const linked = await association.recordCites({
          ownerId: result.id,
          memoryIds: cited,
          sourceEventId: episode?.id ?? event.id,
          at: event.at
        });
        if (linked?.ok) trace.stages.outcome.association = 'co-cite';
      }
      if (episode && Array.isArray(episode.memoryIds) && episode.memoryIds.length >= 2) {
        await association.recordExperience({
          episodeId: episode.id,
          memoryIds: episode.memoryIds,
          at: event.at
        });
      }
    }

    await store.appendActivity({
      at: clock(),
      kind: ok ? 'outcome-ok' : 'outcome-failed',
      eventId: event.id,
      intentId: entry.intent.intentId,
      actionId,
      correlationId,
      feedback: feedbackOf(payload, ok),
      ...(result.ok ? { memoryId: result.id } : { memoryError: result.error })
    });

    // 工具结果回来就给她一轮：有内容要说"看到了什么"，没内容（无字幕/搜不到/失败）
    // 也要能说"没有/没成功"，不能因为她没带回观察就沉默。
    const broughtBack = entry.intent.type === 'invoke' && ok ? observationItems(payload).length : 0;
    const shouldContinue = entry.intent.type === 'invoke';
    const originId = entry.event?.id ?? event.id;
    const lastQueued = continuationMarks.get(originId) ?? 0;
    const deduped = clock() - lastQueued <= CONTINUATION_DEDUPE_MS;
    if (shouldContinue && !deduped && typeof enqueue === 'function') {
      continuationMarks.set(originId, clock());
      if (continuationMarks.size > 200) {
        for (const key of [...continuationMarks.keys()].slice(0, continuationMarks.size - 100)) {
          continuationMarks.delete(key);
        }
      }
      const followEvent = {
        id: `self-${event.id}-${randomUUID()}`,
        type: 'tick',
        at: clock(),
        actor: { kind: 'system' },
        payload: {
          source: 'self',
          allowBrowse: true,
          reason: '工具结果回来了',
          ...(capabilitiesOf(event) ? { capabilities: capabilitiesOf(event) } : {})
        }
      };
      selfChain += 1;
      await enqueue(followEvent);
      await store.appendActivity({
        at: clock(),
        eventId: event.id,
        kind: 'self-turn-queued',
        selfEventId: followEvent.id,
        reason: 'tool-result',
        chain: selfChain
      });
      trace.stages.outcome = { ...trace.stages.outcome, selfTurn: followEvent.id };
    }

    const feedback = feedbackOf(payload, ok);
    if (entry.intent.type === 'send') {
      await store.saveBehavior(behavior => {
        // 精力/情绪统一走 V-A-E 结算；事件 id 用 actionId 保证重复回执不重复扣。
        const moodEvents = [sendEvent({ actionId, at: event.at, proactive: !entry.intent.replyTo })].filter(Boolean);
        // R7：只有明确肯定/否定才改变兴趣与动机；送达成功、已读、回复都不自动算“认可”。
        if (feedback === 'explicit-positive' || feedback === 'explicit-negative') {
          observeOutcome(behavior, {
            ok: feedback === 'explicit-positive',
            topics: entry.topics ?? [],
            proactive: !entry.intent.replyTo,
            now: event.at
          });
          // 情绪只由用户“明确”反馈驱动；送达/已读不算
          const feedbackMood = feedbackEvent({ actionId, at: event.at, feedback });
          if (feedbackMood) moodEvents.push(feedbackMood);
        }
        behavior.affect = settle(behavior.affect, { now: event.at, events: moodEvents }).affect;
      });
      trace.stages.learn = {
        energy: store.behavior.affect.energy,
        drives: driveSummary(store.behavior),
        feedback,
        ...(result.ok ? { memoryId: result.id } : { error: result.error })
      };
    } else {
      // 做事（invoke / talkAndDo）的结果：成败都会影响情绪与精力；事件 id 用 correlationId 去重。
      await store.saveBehavior(behavior => {
        const ev = resultEvent({ correlationId, at: event.at, ok });
        behavior.affect = settle(behavior.affect, { now: event.at, events: ev ? [ev] : [] }).affect;
      });
      trace.stages.learn = { ...(result.ok ? { memoryId: result.id } : { error: result.error }), feedback };
    }
    await store.saveMemory(memory => {
      const list = Array.isArray(memory.processedActionIds) ? memory.processedActionIds : (memory.processedActionIds = []);
      if (!list.includes(actionId)) memory.processedActionIds = list.concat([actionId]).slice(-128);
    });
    if (typeof store.appendPendingResolved === 'function') {
      try {
        await store.appendPendingResolved({ actionId, correlationId, outcome: 'resolved' });
      } catch (error) {
        logger?.warn?.('[cognition] 待回执行动结算日志写入失败', { actionId, error: error?.message });
      }
    }
    return {
      trace,
      intent: null,
      outcome: { matched: true, ok, actionId, feedback, memoryId: result.id ?? null }
    };
  }

  // 内在状态变了（例如新的理解落盘）：由外部调用方请她开一轮。
  // 这不是"回执到了就续"，而是"她心里多了点东西，给她一次说话的时机"。
  // 事件没带能力目录时（自触发/工具回执），用 provider 补一份。
  function capabilitiesOf(event) {
    if (Array.isArray(event?.payload?.capabilities)) return event.payload.capabilities;
    const provided = typeof capabilitiesProvider === 'function' ? capabilitiesProvider() : null;
    return Array.isArray(provided) ? provided : null;
  }

  function catalogFor(event) {
    return buildCatalog(capabilitiesOf(event) ?? []);
  }

  async function queueSelfTurn(reason = '内在状态变了', { capabilities = null } = {}) {
    if (typeof enqueue !== 'function') return null;
    const caps = Array.isArray(capabilities)
      ? capabilities
      : (typeof capabilitiesProvider === 'function' ? capabilitiesProvider() : null);
    const followEvent = {
      id: `self-${randomUUID()}`,
      type: 'self-turn',
      at: clock(),
      actor: { kind: 'system' },
      payload: {
        source: 'self',
        reason,
        ...(Array.isArray(caps) ? { capabilities: caps } : {})
      }
    };
    selfChain += 1;
    await enqueue(followEvent);
    await store.appendActivity({
      at: clock(),
      kind: 'self-turn-queued',
      selfEventId: followEvent.id,
      reason: 'internal-state',
      detail: String(reason).slice(0, 80),
      chain: selfChain
    });
    return followEvent.id;
  }

  return {
    run,
    hydrate: hydratePending,
    pendingCount: () => pending.size,
    queueSelfTurn,
    reflectNow: () => reflection?.processNow?.() ?? null,
    stages: LOOP_STAGES
  };
}

export function defaultDecide({
  event,
  memories = [],
  self = null,
  now = event?.at,
  fallbackText = DEFAULT_FALLBACK_TEXT
} = {}) {
  if (event?.type === 'tick') {
    const due = findDueMemory(memories, now);
    if (!due) return { intent: null, reason: 'no-follow-up-due' };
    const gate = careAllowed({ row: due, now, self });
    if (!gate.allowed) {
      return {
        intent: null,
        reason: 'care-below-threshold',
        activity: {
          kind: 'care-skipped',
          memoryId: due.id,
          score: gate.score,
          threshold: gate.threshold
        }
      };
    }
    return {
      intent: { type: 'send', to: 'owner', text: followUpText(due), replyTo: null, followUpMemoryId: due.id },
      reason: 'follow-up-due'
    };
  }
  if (event?.type !== 'owner-message') return { intent: null, reason: 'event-has-no-outgoing-action' };
  if (event.actor?.kind !== 'owner') return { intent: null, reason: 'not-owner' };
  if (event.actor?.authenticated !== true) return { intent: null, reason: 'owner-not-authenticated' };
  return {
    intent: {
      type: 'send',
      to: 'owner',
      text: fallbackText,
      replyTo: event.id
    },
    reason: 'default-owner-ack'
  };
}



