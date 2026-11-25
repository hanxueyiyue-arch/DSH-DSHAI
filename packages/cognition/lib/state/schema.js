// 状态文件的 schema 与空骨架。
// 只做数据形状，不读写磁盘、不读环境变量。

import { CONSTITUTION, DEFAULT_TRAITS } from '../self-state.js';
import { normalizeDormant, normalizeHabits } from '../self/habits.js';
import { normalizeSpeakHabits } from '../self/speak-habits.js';
import { blankDrives, normalizeDrives } from '../self/drives.js';
import { blankReflection, normalizeReflection } from '../self/reflection.js';
import { blankPersonality, normalizePersonality } from '../self/traits.js';
import { blankAffect, normalizeAffect } from '../self/mood.js';
import { blankJournal, normalizeJournal } from '../memory/diary.js';

export const STATE_SCHEMA = 1;

export const EVENT_TYPES = Object.freeze([
  'owner-message',
  'tick',
  'self-turn',
  'tool-result',
  'owner-feedback',
  'owner-command',
  'maintenance'
]);

export const INTENT_TYPES = Object.freeze(['send', 'wake', 'invoke']);

export const ACTOR_KINDS = Object.freeze(['owner', 'stranger', 'system', 'tool', 'unknown']);

export const MEMORY_CAPACITY_DEFAULT = 5000;
export const MEMORY_CAPACITY_WARN_RATIO = 0.85;
export const RECENT_EVENT_IDS_MAX = 200;
export const ACTIVITY_TAIL_MAX = 200;

const nowIso = () => new Date().toISOString();

export function blankSelf() {
  return {
    schema: STATE_SCHEMA,
    updatedAt: nowIso(),
    identity: null,
    constitution: {
      version: 1,
      rules: CONSTITUTION.map(rule => ({ id: rule.id, rule: rule.rule }))
    },
    // 只剩 careThreshold（到期旧事的发言门槛）。其余数值特质已删除；可演化倾向在 behavior.personality。
    traits: { ...DEFAULT_TRAITS },
    habits: [],
    habitsDormant: [],
    speakHabits: [],
    outcomes: [],
    learning: { day: null, initiativeDelta: 0 }
  };
}

export function blankMemory() {
  return {
    schema: STATE_SCHEMA,
    updatedAt: nowIso(),
    memories: [],
    diaryIndex: [],
    episodes: [],
    proposals: [],
    extract: { lastAt: null },
    reflection: blankReflection(),
    journal: blankJournal(),
    activity: [],
    recentEventIds: [],
    recentActions: [],
    pendingActions: [],
    processedActionIds: [],
    feedbackEvidence: [],
    carePending: [],
    counters: { events: 0, lastEventAt: null, archived: 0, lastMaintenanceAt: null, extracted: 0 }
  };
}

export function blankBehavior(now = Date.now()) {
  return {
    schema: STATE_SCHEMA,
    updatedAt: nowIso(),
    // V-A-E 情绪/精力：唯一权威来源（valence/arousal/energy + at 锚点 + 事件去重记录）。
    affect: blankAffect(now),
    interests: {},
    drives: blankDrives(),
    personality: blankPersonality(),
    // legacy: 旧 behavior/* 插件仍读取；新 Cognition 循环不写入，保留以兼容导入导出。
    routine: { timeZone: '', wakeHour: 9, sleepHour: 23 },
    counters: { events: 0 }
  };
}

function fail(name, reason) {
  throw new Error(`${name} 格式错误：${reason}；请先备份并人工检查，内核不会静默重建`);
}

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(name, '不是对象');
  if (value.schema !== STATE_SCHEMA) fail(name, `schema 应为 ${STATE_SCHEMA}`);
  return value;
}

export function normalizeSelf(value) {
  const data = requireObject(value, 'self.json');
  if (data.identity !== null && (typeof data.identity !== 'object' || Array.isArray(data.identity))) {
    fail('self.json', 'identity 必须是对象或 null');
  }
  if (!data.constitution || typeof data.constitution !== 'object') {
    fail('self.json', 'constitution 缺失');
  }
  if (!Array.isArray(data.constitution.rules) || data.constitution.rules.length === 0) {
    fail('self.json', 'constitution.rules 必须是非空数组');
  }
  if (!data.traits || typeof data.traits !== 'object' || Array.isArray(data.traits)) {
    fail('self.json', 'traits 缺失');
  }
  for (const [key, trait] of Object.entries(data.traits)) {
    if (typeof trait !== 'number' || !Number.isFinite(trait)) fail('self.json', `traits.${key} 不是数字`);
  }
  if (!Array.isArray(data.habits)) fail('self.json', 'habits 必须是数组');
  if (data.habitsDormant !== undefined && !Array.isArray(data.habitsDormant)) {
    fail('self.json', 'habitsDormant 必须是数组');
  }
  if (!Array.isArray(data.outcomes)) fail('self.json', 'outcomes 必须是数组');
  const learning =
    data.learning && typeof data.learning === 'object' && !Array.isArray(data.learning)
      ? {
          day: data.learning.day ?? null,
          initiativeDelta: Number(data.learning.initiativeDelta) || 0
        }
      : { day: null, initiativeDelta: 0 };
  const habits = normalizeHabits(data.habits);
  const speakHabits = normalizeSpeakHabits(data.speakHabits);
  const legacyThreshold = Number((data.traits ?? {}).careThreshold ?? (data.traits ?? {}).initiativeThreshold);
  const traits = Number.isFinite(legacyThreshold) ? { careThreshold: Math.min(0.95, Math.max(0.05, legacyThreshold)) } : { careThreshold: 0.6 };
  return {
    ...data,
    traits,
    habits,
    speakHabits,
    habitsDormant: normalizeDormant(data.habitsDormant, new Set(habits.map(row => row.key))),
    outcomes: data.outcomes.slice(-200),
    learning
  };
}

export function normalizeMemory(value) {
  const data = requireObject(value, 'memory.json');
  if (!Array.isArray(data.memories)) fail('memory.json', 'memories 必须是数组');
  if (!Array.isArray(data.diaryIndex)) fail('memory.json', 'diaryIndex 必须是数组');
  if (!Array.isArray(data.activity)) fail('memory.json', 'activity 必须是数组');
  if (!Array.isArray(data.recentEventIds)) fail('memory.json', 'recentEventIds 必须是数组');
  if (!data.counters || typeof data.counters !== 'object') fail('memory.json', 'counters 缺失');
  if (!Number.isFinite(Number(data.counters.events))) fail('memory.json', 'counters.events 不是数字');
  const proposals = (Array.isArray(data.proposals) ? data.proposals : [])
    .filter(item => item && typeof item.id === 'string' && Array.isArray(item.memoryIds))
    .slice(-50);
  const extract =
    data.extract && typeof data.extract === 'object' && !Array.isArray(data.extract)
      ? { lastAt: Number.isFinite(Number(data.extract.lastAt)) ? Number(data.extract.lastAt) : null }
      : { lastAt: null };
  return {
    ...data,
    reflection: normalizeReflection(data.reflection),
    journal: normalizeJournal(data.journal),
    recentEventIds: data.recentEventIds.filter(id => typeof id === 'string').slice(-RECENT_EVENT_IDS_MAX),
    recentActions: (Array.isArray(data.recentActions) ? data.recentActions : [])
      .filter(item => item && typeof item.signature === 'string' && Number.isFinite(Number(item.at)))
      .slice(-64),
    episodes: (Array.isArray(data.episodes) ? data.episodes : [])
      .filter(item => item && typeof item.id === 'string' && Number.isFinite(Number(item.at)))
      .slice(-200),
    pendingActions: (Array.isArray(data.pendingActions) ? data.pendingActions : [])
      .filter(item => item && typeof item.actionId === 'string' && typeof item.correlationId === 'string' && item.intent),
    processedActionIds: (Array.isArray(data.processedActionIds) ? data.processedActionIds : [])
      .filter(id => typeof id === 'string')
      .slice(-128),
    feedbackEvidence: (Array.isArray(data.feedbackEvidence) ? data.feedbackEvidence : [])
      .filter(item => typeof item === 'string' || (item && typeof item.key === 'string' && typeof item.actionId === 'string'))
      .slice(-64),
    proposals,
    extract,
    activity: data.activity.slice(-ACTIVITY_TAIL_MAX),
    carePending: (Array.isArray(data.carePending) ? data.carePending : [])
      .filter(entry => entry && typeof entry.memoryId === 'string' && Number.isFinite(Number(entry.sentAt)))
      .slice(-5),
    counters: {
      events: Number(data.counters.events),
      lastEventAt: data.counters.lastEventAt ?? null,
      archived: Number(data.counters.archived) || 0,
      lastMaintenanceAt: data.counters.lastMaintenanceAt ?? null,
      extracted: Number(data.counters.extracted) || 0
    }
  };
}

export function normalizeBehavior(value) {
  const data = requireObject(value, 'behavior.json');
  if (!data.affect || typeof data.affect !== 'object' || Array.isArray(data.affect)) {
    fail('behavior.json', 'affect 缺失');
  }
  // 旧状态可能只有 energy/mood；V-A-E 的归一化由 mood.js 负责（越界夹紧、锚点校验、迁移）。
  // 注意：这里不能再做“缺 energy 就报错”，否则无法迁移 11-21 之前的状态。
  if (!data.interests || typeof data.interests !== 'object' || Array.isArray(data.interests)) {
    fail('behavior.json', 'interests 必须是对象');
  }
  if (!data.routine || typeof data.routine !== 'object' || Array.isArray(data.routine)) {
    fail('behavior.json', 'routine 缺失');
  }
  if (!data.counters || typeof data.counters !== 'object') fail('behavior.json', 'counters 缺失');
  return {
    ...data,
    affect: normalizeAffect(data.affect),
    drives: normalizeDrives(data.drives),
    personality: normalizePersonality(data.personality),
    counters: { ...data.counters, events: Number(data.counters.events) || 0 }
  };
}
