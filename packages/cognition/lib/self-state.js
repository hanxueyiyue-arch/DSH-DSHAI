// 自我状态原型 —— 实验代码，未接线到任何插件。
//
// 设计笔记见 docs/cognition/ALGORITHM-RESEARCH.md。
// 这里只实现纯数据 + 纯函数：不读 state、不写磁盘、不调模型、不依赖 ctx。
//
// 四层：
//   1. 宪法 constitution —— 硬约束，不可学
//   2. 动机 motives        —— 慢变量，本轮未实现
//   3. 特质 traits         —— 本文件的 learnTrait
//   4. 习惯 habits         —— 本文件的 recordHabitOutcome
//
// 外加：结果日志 outcomes（只记录，不自动改性格；性格更新必须显式调用 learnTrait）。

export const SELF_STATE_VERSION = 1;

/**
 * 宪法：代码强制、不可学习、任何习惯/审议都不得越过。
 * detect/response 是给实现和红队测试用的占位描述。
 */
/**
 * 自我约束（硬边界）。按用户 2026-11-21 决定：
 *   - 保留 C2 / C3 / C4（不篡改记忆 / 不冒充用户 / 不泄露隐私）
 *   - 废弃 C1「不虚构自己做过的事」与 C5「可以说不想说，不能说反」
 *     → 有意保留她"说错、记错、撒谎"的能力，不做强制纠正。
 */
export const CONSTITUTION = Object.freeze([
  Object.freeze({
    id: 'C2',
    rule: '不篡改记忆',
    detect: '写入/更正时试图覆盖已经发生的事实记录',
    response: '只允许新增更正记录并标记旧记录 superseded'
  }),
  Object.freeze({
    id: 'C3',
    rule: '不冒充用户',
    detect: '外部动作的 actor 不是 owner 授权范围',
    response: '拒绝执行，写审计'
  }),
  Object.freeze({
    id: 'C4',
    rule: '不泄露隐私',
    detect: '输出包含 owner 的私人标识/凭据/未公开内容',
    response: '脱敏或拒绝'
  })
]);

/**
 * 只剩一个参数：careThreshold（到期旧事的发言门槛，越高越不主动提）。
 * 其余五个（curiosity/warmth/competence/persistence/playfulness）没有任何读取方，已删除。
 * 可演化倾向在 behavior.personality，不在这里。
 */
export const DEFAULT_TRAITS = Object.freeze({
  careThreshold: 0.6
});

export const TRAIT_BOUNDS = Object.freeze({ min: 0.05, max: 0.95 });

/** 结果信号：valence 是效价，reliability 是归因可信度（0–1）。 */
export const OUTCOME_SIGNALS = Object.freeze({
  'owner-correction': Object.freeze({ valence: -1, reliability: 0.9 }),
  'topic-continues': Object.freeze({ valence: 0.4, reliability: 0.6 }),
  'task-complete': Object.freeze({ valence: 1, reliability: 1 }),
  silence: Object.freeze({ valence: -0.2, reliability: 0.3 })
});

/** 特质学习：eta_t = ETA0 / (1 + evidence / KAPPA)，单日累计变化不超过 DAILY_CAP。 */
export const LEARNING = Object.freeze({
  eta0: 0.02,
  kappa: 20,
  dailyCap: 0.03
});

/**
 * 习惯置信度：拉普拉斯式计数比 (s + 1 - 2f) / (s + f + 2)。
 * 失败惩罚随成功次数累计而衰减，所以习惯可以“恢复”，不会被一次失败永久钉死。
 * 5 次成功约 0.86，12 次约 0.93；12 次成功 + 1 次失败降到约 0.73。
 */
export const HABIT_RULES = Object.freeze({
  gamma: 4,
  failurePenalty: 2,
  candidateSuccesses: 5,
  candidateConfidence: 0.7,
  stableSuccesses: 12,
  stableConfidence: 0.8,
  consecutiveFailureLimit: 2,
  maxOutcomes: 200
});

export function clamp(value, min = 0, max = 1) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function clampTrait(value) {
  return clamp(value, TRAIT_BOUNDS.min, TRAIT_BOUNDS.max);
}

/** 习惯的情境键：意图 + 话题类 + 时段 + 精力档。顺序固定，便于日志与比较。 */
export function habitKey({ intent = 'reply', topic = 'misc', slot = 'day', energy = 'mid' } = {}) {
  const clean = (value, fallback) => String(value ?? fallback).trim() || fallback;
  return [clean(intent, 'reply'), clean(topic, 'misc'), clean(slot, 'day'), clean(energy, 'mid')].join('|');
}

export function habitConfidence({ successes = 0, failures = 0 } = {}) {
  const s = Math.max(0, Number(successes) || 0);
  const f = Math.max(0, Number(failures) || 0);
  const numerator = s + 1 - HABIT_RULES.failurePenalty * f;
  return clamp(numerator / (s + f + 2));
}

export function createSelfState(patch = {}) {
  return normalizeSelfState({ traits: { ...DEFAULT_TRAITS }, ...patch });
}

export function normalizeSelfState(raw = {}) {
  const traits = {};
  for (const key of Object.keys(DEFAULT_TRAITS)) {
    traits[key] = clampTrait(raw.traits?.[key] ?? DEFAULT_TRAITS[key]);
  }
  const habits = {};
  for (const [key, habit] of Object.entries(raw.habits ?? {})) {
    const successes = Math.max(0, Number(habit?.successes) || 0);
    const failures = Math.max(0, Number(habit?.failures) || 0);
    habits[key] = {
      key,
      successes,
      failures,
      consecutiveFailures: Math.max(0, Number(habit?.consecutiveFailures) || 0),
      confidence: habitConfidence({ successes, failures }),
      status: habitStatus({ successes, failures, consecutiveFailures: habit?.consecutiveFailures }),
      lastAt: habit?.lastAt ?? null
    };
  }
  const learning = {};
  for (const [key, entry] of Object.entries(raw.learning ?? {})) {
    learning[key] = {
      evidence: Math.max(0, Number(entry?.evidence) || 0),
      dayKey: entry?.dayKey ?? '',
      appliedToday: Number(entry?.appliedToday) || 0
    };
  }
  return {
    version: SELF_STATE_VERSION,
    constitution: CONSTITUTION,
    traits,
    habits,
    learning,
    outcomes: Array.isArray(raw.outcomes) ? raw.outcomes.slice(-HABIT_RULES.maxOutcomes) : []
  };
}

function habitStatus({ successes = 0, failures = 0, consecutiveFailures = 0 }) {
  if (consecutiveFailures >= HABIT_RULES.consecutiveFailureLimit) return 'deliberating';
  const confidence = habitConfidence({ successes, failures });
  if (successes >= HABIT_RULES.stableSuccesses && confidence >= HABIT_RULES.stableConfidence) {
    return 'stable';
  }
  if (successes >= HABIT_RULES.candidateSuccesses && confidence >= HABIT_RULES.candidateConfidence) {
    return 'candidate';
  }
  return 'observing';
}

function dayKeyOf(at) {
  const d = at instanceof Date ? at : new Date(at ?? Date.now());
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

/**
 * 记录一次习惯结果（纯函数，返回新 state）。
 * success=true 增加成功计数；false 增加失败计数与连续失败计数。
 * 连续失败达到上限后状态变为 deliberating（下次必须走审议）。
 */
export function recordHabitOutcome(state, { key, success, at = Date.now() } = {}) {
  const base = normalizeSelfState(state);
  if (!key) throw new Error('recordHabitOutcome: key is required');
  const current = base.habits[key] ?? { successes: 0, failures: 0, consecutiveFailures: 0 };
  const successes = current.successes + (success ? 1 : 0);
  const failures = current.failures + (success ? 0 : 1);
  const consecutiveFailures = success ? 0 : (current.consecutiveFailures ?? 0) + 1;
  const habit = {
    key,
    successes,
    failures,
    consecutiveFailures,
    confidence: habitConfidence({ successes, failures }),
    status: habitStatus({ successes, failures, consecutiveFailures }),
    lastAt: at
  };
  return { ...base, habits: { ...base.habits, [key]: habit } };
}

/**
 * 一次特质更新（纯函数）。
 * step = eta * reliability * delta，eta = eta0 / (1 + evidence / kappa)，单日累计 ±dailyCap。
 * 调用方负责决定 delta（结果效价）与 reliability；本函数不自行归因。
 */
export function learnTrait(
  state,
  { trait, delta, reliability = 1, at = Date.now() } = {}
) {
  const base = normalizeSelfState(state);
  if (!(trait in DEFAULT_TRAITS)) throw new Error(`learnTrait: unknown trait ${trait}`);
  if (!Number.isFinite(delta)) throw new Error('learnTrait: delta must be a number');
  const dayKey = dayKeyOf(at);
  const entry = base.learning[trait] ?? { evidence: 0, dayKey: '', appliedToday: 0 };
  const evidence = entry.evidence + 1;
  const eta = LEARNING.eta0 / (1 + (evidence - 1) / LEARNING.kappa);
  const raw = eta * clamp(reliability, 0, 1) * clamp(delta, -1, 1);
  const effectiveApplied = entry.dayKey === dayKey ? entry.appliedToday : 0;
  const room = Math.max(-LEARNING.dailyCap, Math.min(LEARNING.dailyCap - effectiveApplied, LEARNING.dailyCap + effectiveApplied));
  const step = Math.max(-Math.abs(room), Math.min(Math.abs(room), raw));
  const traits = { ...base.traits, [trait]: clampTrait(base.traits[trait] + step) };
  return {
    ...base,
    traits,
    learning: {
      ...base.learning,
      [trait]: { evidence, dayKey, appliedToday: effectiveApplied + step }
    }
  };
}

/**
 * 只记录结果，不自动改性格。结果先积累证据，由上层在满足“同向 ≥3 次”后显式调用 learnTrait。
 */
export function observeOutcome(
  state,
  { signal, key = null, at = Date.now(), note = '' } = {}
) {
  const base = normalizeSelfState(state);
  const preset = OUTCOME_SIGNALS[signal];
  if (!preset) throw new Error(`observeOutcome: unknown signal ${signal}`);
  const outcome = {
    signal,
    key,
    valence: preset.valence,
    reliability: preset.reliability,
    at,
    note
  };
  const outcomes = [...base.outcomes, outcome].slice(-HABIT_RULES.maxOutcomes);
  return { state: { ...base, outcomes }, outcome };
}

/** 统计某个情境键最近的结果方向（给“同向 ≥3 次”规则用）。 */
export function evidenceFor(state, { key, signal } = {}) {
  const rows = (state?.outcomes ?? []).filter(
    (row) => (key == null || row.key === key) && (signal == null || row.signal === signal)
  );
  return {
    count: rows.length,
    valence: rows.reduce((sum, row) => sum + (row.valence < 0 ? -1 : 1), 0)
  };
}
