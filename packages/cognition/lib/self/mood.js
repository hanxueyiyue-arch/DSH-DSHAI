/**
 * DSHAI Cognition — V-A-E 情绪耦合（候选实现，隔离工作区）
 *
 * 本文件只在 tmp/mood-cand 下维护，未接入正式插件。
 *
 * V = Valence : [-1, 1]  情绪正负
 * A = Arousal : [0, 1]   情绪激活
 * E = Energy  : [0, 100] 精力（Cognition 内唯一权威来源）
 *
 * 设计约束（本轮已确认）：
 *  - 纯函数：不读磁盘、不调模型、不依赖宿主；时间由调用方给 now。
 *  - Energy 存盘，带 at 锚点；长时间补算用有界时间分段积分。
 *  - 关机期间只做“自然平复 + 精力恢复”，不模拟活动、不扣压力。
 *  - 压力改为事件驱动（事件的 energyCost），不按离线小时扣。
 *  - 事件按稳定 id 去重；去重记录与状态同文件（behavior.json）原子落盘。
 *  - cause 表示归因（system/owner/unknown），有超时、已解决、被更强原因替换三种清除路径。
 *  - 标签由 labelOf 统一计算并保存“前一稳定标签”，带迟滞。
 *  - 标签只用于表达/展示，绝不转化为行为命令。
 */

export const AFFECT_VERSION = 2;

export const MOOD_PARAMS = Object.freeze({
  // 疲劳与基线
  fatigueStart: 60,
  negativeBaseline: 0.15,
  arousalBaseline: 0.25,
  arousalFatiguePenalty: 0.10,

  // 事件敏感度（疲劳时负面更敏感、正面略钝）
  negativeSensitivity: 0.30,
  positiveSensitivity: 0.10,

  // 自然平复时间常数（小时）
  valenceTauHours: 8,
  arousalTauHours: 4,
  // 第一版关闭“负面恢复更慢”，避免与基线/敏感度叠成三重惩罚
  negativeRecoveryPenalty: 0,

  // 精力
  energyRecoveryPerHour: 2,
  // 空闲多久才开始回能（分钟）：活跃期间完全不回
  idleGraceMinutes: 15,
  energyMax: 100,
  energyMin: 0,

  // 补算
  segmentationHours: 1,
  maxCatchupHours: 72,

  // cause
  causeTimeoutHours: 6,
  // 0.10：一次“回执超时”（−0.12）足以成为一个可解释的原因，
  // 但标签仍要到第二次才翻（进入阈值 0.50）。
  causeMinStrength: 0.10,
  causeReplaceMargin: 0.05,
  causeClearValence: -0.05,

  // 标签迟滞
  labelArousalIn: 0.50,
  labelArousalOut: 0.40,

  // 疲惫只影响表达
  tiredEnergy: 20,

  // 事件去重
  processedLimit: 128,
  processedWindowMs: 7 * 24 * 3600 * 1000
});

const HIGH_AROUSAL_NEGATIVE = new Set(['烦', '别扭', '担心']);
const CAUSES = new Set(['system', 'owner', 'unknown']);

const clamp = (x, min, max) => Math.max(min, Math.min(max, x));
const num = (x, fallback = 0) => (Number.isFinite(Number(x)) ? Number(x) : fallback);
const round = (x, digits = 4) => Number(Number(x).toFixed(digits));

export function resolveParams(overrides = {}) {
  const out = { ...MOOD_PARAMS };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!(key in MOOD_PARAMS)) continue;
    if (!Number.isFinite(Number(value))) continue;
    out[key] = Number(value);
  }
  // 参数边界：负数时间常数/速率没有物理意义
  out.valenceTauHours = Math.max(0.1, out.valenceTauHours);
  out.arousalTauHours = Math.max(0.1, out.arousalTauHours);
  out.segmentationHours = clamp(out.segmentationHours, 0.05, 24);
  out.maxCatchupHours = Math.max(1, out.maxCatchupHours);
  out.energyRecoveryPerHour = Math.max(0, out.energyRecoveryPerHour);
  out.fatigueStart = clamp(out.fatigueStart, 1, 100);
  return out;
}

// ---------- 基础公式 ----------

export function fatigue(energy, params = MOOD_PARAMS) {
  const p = resolveParams(params);
  return clamp((p.fatigueStart - clamp(num(energy), 0, 100)) / p.fatigueStart, 0, 1);
}

export function emotionBaseline(energy, params = MOOD_PARAMS) {
  const p = resolveParams(params);
  const F = fatigue(energy, p);
  return {
    valence: -p.negativeBaseline * F,
    arousal: clamp(p.arousalBaseline - p.arousalFatiguePenalty * F, 0, 1)
  };
}

export function modulateEventValence(deltaV, energy, params = MOOD_PARAMS) {
  const p = resolveParams(params);
  const F = fatigue(energy, p);
  const dv = clamp(num(deltaV), -1, 1);
  // factor 必须非负：否则调大 sensitivity 会把正面事件反转成负面
  const factor = dv < 0
    ? 1 + Math.max(0, p.negativeSensitivity) * F
    : 1 - clamp(p.positiveSensitivity, 0, 1) * F;
  return dv * Math.max(0, factor);
}

export function relax(value, baseline, hours, tau) {
  const h = Math.max(0, num(hours));
  const t = Math.max(0.1, num(tau, 1));
  return baseline + (num(value) - baseline) * Math.exp(-h / t);
}

// ---------- 状态规范化 / 迁移 ----------

export function blankAffect(now = Date.now()) {
  const baseline = emotionBaseline(70);
  return {
    version: AFFECT_VERSION,
    valence: baseline.valence,
    arousal: baseline.arousal,
    energy: 70,
    cause: null,
    causeStrength: 0,
    causeAt: 0,
    label: '平静',
    mood: '平静',
    at: now,
    lastActivityAt: now,
    processedEventIds: []
  };
}

function normalizeProcessed(value) {
  const list = Array.isArray(value) ? value : [];
  const out = [];
  const seen = new Set();
  for (const row of list) {
    const id = typeof row === 'string' ? row : row?.id;
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, at: Math.max(0, num(row?.at)) });
  }
  return out.slice(-MOOD_PARAMS.processedLimit);
}

export function normalizeAffect(raw, { now = 0, params = MOOD_PARAMS, preserveAnchor = false } = {}) {
  const p = resolveParams(params);
  const atRaw = num(raw?.at);
  // 锚点规则（不依赖墙钟，保证可测试）：
  //  - 有合法锚点：结算路径原样保留（时钟回拨也不改）；其他路径不得晚于 now（若调用方给了 now）。
  //  - 没有锚点：调用方给了 now 就用 now，否则留 0，交给结算时补。
  const validAt = Number.isFinite(atRaw) && atRaw > 0;
  const at = validAt
    ? (preserveAnchor || !now ? atRaw : Math.min(atRaw, now))
    : (now > 0 ? now : 0);
  const cause = CAUSES.has(raw?.cause) ? raw.cause : null;
  const label = typeof raw?.label === 'string' && raw.label
    ? raw.label
    : (typeof raw?.mood === 'string' && raw.mood ? raw.mood : '平静');
  return {
    // version 原样保留：未迁移的旧状态保持 0，交给 settle 触发一次性迁移。
    // 若在这里直接写成 AFFECT_VERSION，迁移就永远不会发生。
    version: num(raw?.version),
    valence: clamp(num(raw?.valence), -1, 1),
    arousal: clamp(num(raw?.arousal, p.arousalBaseline), 0, 1),
    energy: clamp(num(raw?.energy, 70), p.energyMin, p.energyMax),
    lastActivityAt: Math.max(num(raw?.lastActivityAt), at, 0),
    cause,
    causeStrength: cause ? clamp(num(raw?.causeStrength), 0, 1) : 0,
    causeAt: cause ? Math.max(0, num(raw?.causeAt)) : 0,
    label,
    mood: label,
    at,
    processedEventIds: normalizeProcessed(raw?.processedEventIds)
  };
}

/**
 * 迁移：只重置“旧版（version < 2）”状态。
 * 新版合法的 Energy = 0 不会被误判——version 已经等于 2 就直接走 normalize。
 * 迁移是一次性的：迁移后 version = 2，重入会直接返回 migrated: false。
 */
export function migrateAffect(raw, { now = Date.now(), params = MOOD_PARAMS, preserveAnchor = false } = {}) {
  const version = num(raw?.version);
  if (version >= AFFECT_VERSION) {
    return { affect: normalizeAffect(raw, { now, params, preserveAnchor }), migrated: false, fromVersion: version };
  }
  const fresh = blankAffect(now);
  return { affect: fresh, migrated: true, fromVersion: version, reason: 'legacy-affect-reset' };
}

// ---------- 标签（唯一来源 + 迟滞） ----------

function baseLabelFor(state, p) {
  const v = num(state?.valence);
  const a = num(state?.arousal);
  const cause = CAUSES.has(state?.cause) ? state.cause : null;
  if (v <= -0.15 && a >= p.labelArousalIn) {
    if (cause === 'system') return '烦';
    if (cause === 'owner') return '别扭';
    if (cause === 'unknown') return '担心';
  }
  if (v >= 0.45 && a >= 0.55) return '兴奋';
  if (v >= 0.20) return '高兴';
  if (v > 0.05) return '轻松';
  // 负价但唤醒不够高：一律是“低落”，不再落到“平静”（-0.4 的 valence 说平静是错的）
  if (v <= -0.15) return '低落';
  return '平静';
}

function nonHighNegativeLabel(state, p) {
  const v = num(state?.valence);
  if (v >= 0.45 && num(state?.arousal) >= 0.55) return '兴奋';
  if (v >= 0.20) return '高兴';
  if (v > 0.05) return '轻松';
  if (v <= -0.15) return '低落';
  return '平静';
}

/**
 * 统一标签函数：唯一来源。
 * 进入高唤醒负面标签需要 A >= labelArousalIn；已经在里面时，只有 A < labelArousalOut 才退出。
 * 返回 { label, tired }；tired 只用于表达（允许她说累），不构成任何行为命令。
 */
export function labelOf(prevLabel, state, params = MOOD_PARAMS) {
  const p = resolveParams(params);
  const prev = typeof prevLabel === 'string' && prevLabel ? prevLabel : '平静';
  const prevHigh = HIGH_AROUSAL_NEGATIVE.has(prev);
  const a = num(state?.arousal);
  const raw = baseLabelFor(state, p);

  let label;
  if (HIGH_AROUSAL_NEGATIVE.has(raw)) {
    // 想进入高唤醒负面：到达进入阈值才切换
    label = a >= p.labelArousalIn ? raw : (prevHigh ? prev : nonHighNegativeLabel(state, p));
  } else if (prevHigh && a >= p.labelArousalOut) {
    // 想离开高唤醒负面：仍高于退出阈值就保持，避免阈值附近抖动
    label = prev;
  } else {
    label = raw;
  }
  return { label, tired: num(state?.energy) < p.tiredEnergy };
}

// ---------- 事件 ----------

export function normalizeEvent(raw) {
  const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
  if (!id) return { ok: false, reason: 'no-id' };
  const at = num(raw?.at);
  const cause = raw?.cause === undefined || raw?.cause === null ? null : (CAUSES.has(raw.cause) ? raw.cause : null);
  return {
    ok: true,
    event: {
      id,
      at: Number.isFinite(at) && at > 0 ? at : null,
      dV: clamp(num(raw?.dV), -1, 1),
      dA: clamp(num(raw?.dA), -1, 1),
      energyCost: clamp(num(raw?.energyCost), -50, 50),
      cause,
      causeResolved: raw?.causeResolved === true,
      kind: typeof raw?.kind === 'string' ? raw.kind.slice(0, 40) : null
    }
  };
}

function applyEvent(state, event, t, p) {  const deltaV = modulateEventValence(event.dV, state.energy, p);
  state.valence = clamp(state.valence + deltaV, -1, 1);
  state.arousal = clamp(state.arousal + event.dA, 0, 1);
  state.energy = clamp(state.energy + event.energyCost, p.energyMin, p.energyMax);
  // 有动作/事件发生 = 不是空闲；之后要重新等 grace 才开始回能。
  state.lastActivityAt = t;

  if (event.causeResolved) {
    state.cause = null;
    state.causeStrength = 0;
    state.causeAt = 0;
    return;
  }
  const strength = Math.abs(deltaV);
  if (deltaV <= -p.causeMinStrength && event.cause) {
    const stronger = strength > state.causeStrength + p.causeReplaceMargin;
    const expired = state.causeAt > 0 && t - state.causeAt > p.causeTimeoutHours * 3600 * 1000;
    if (!state.cause || stronger || expired) {
      state.cause = event.cause;
      state.causeStrength = round(strength);
      state.causeAt = t;
    }
  }
}

// cause 的另外两条清除路径：情绪已恢复、原因超时
function expireCause(state, now, p) {
  if (!state.cause) return;
  if (state.valence >= p.causeClearValence) {
    state.cause = null;
    state.causeStrength = 0;
    state.causeAt = 0;
    return;
  }
  if (state.causeAt > 0 && now - state.causeAt > p.causeTimeoutHours * 3600 * 1000) {
    state.cause = null;
    state.causeStrength = 0;
    state.causeAt = 0;
  }
}

// 有界时间分段积分：长跨度与逐步更新在容差内一致
function integrate(state, hours, p, recoveryHours = hours) {
  let remaining = Math.max(0, num(hours));
  let recoveryRemaining = Math.max(0, Math.min(num(recoveryHours), remaining));
  let truncated = false;
  if (remaining > p.maxCatchupHours) {
    // 超长停机：视为充分休息，直接回满并回到基线，不再逐段积分
    state.energy = p.energyMax;
    const baseline = emotionBaseline(state.energy, p);
    state.valence = baseline.valence;
    state.arousal = baseline.arousal;
    return { truncated: true };
  }
  while (remaining > 1e-9) {
    const dt = Math.min(p.segmentationHours, remaining);
    // 只有空闲时间才恢复：恢复时长由调用方按 idleGrace 算好。
    const recoverDt = Math.min(dt, recoveryRemaining);
    state.energy = clamp(state.energy + p.energyRecoveryPerHour * recoverDt, p.energyMin, p.energyMax);
    recoveryRemaining = Math.max(0, recoveryRemaining - dt);
    const baseline = emotionBaseline(state.energy, p);
    const F = fatigue(state.energy, p);
    const tau = state.valence < baseline.valence
      ? p.valenceTauHours * (1 + Math.max(0, p.negativeRecoveryPenalty) * F)
      : p.valenceTauHours;
    state.valence = relax(state.valence, baseline.valence, dt, tau);
    state.arousal = relax(state.arousal, baseline.arousal, dt, p.arousalTauHours);
    remaining -= dt;
  }
  return { truncated };
}

// 空闲回能：只有距上次活动超过 idleGraceMinutes 之后的时间才算休息。
function recoveryHoursBetween(fromMs, toMs, state, p) {
  const graceMs = Math.max(0, num(p.idleGraceMinutes)) * 60_000;
  const last = Math.max(0, num(state.lastActivityAt));
  const start = Math.max(fromMs, last + graceMs);
  return Math.max(0, (toMs - start) / 3600_000);
}

/**
 * 结算：推进时间 + 按时间顺序施加事件。
 *
 * 确定性规则：
 *  - now < at（时间回拨）：不回退锚点，按 0 小时处理；
 *  - 事件时间在未来：截断到 now，并在 flags 里标记；
 *  - 事件时间早于游标：不倒退时间，按游标时刻结算（保持顺序稳定）；
 *  - 重复 id：跳过，计入 skipped；
 *  - 缺少 id：跳过（稳定 id 是硬要求）。
 */
export function settle(affect, { now = Date.now(), events = [], params = MOOD_PARAMS } = {}) {
  const p = resolveParams(params);
  // 结算路径保留原锚点：时钟回拨时也不能把锚点改到未来/回退
  const { affect: migrated, migrated: didMigrate, fromVersion } = migrateAffect(affect, { now, params: p, preserveAnchor: true });
  const state = migrated;
  // 没有锚点（旧文件、字段缺失）→ 从现在开始，不补算任何时间
  if (!(state.at > 0)) state.at = now;
  const flags = { migrated: didMigrate, fromVersion, timeRollback: false, futureClamped: 0, catchupTruncated: false, dropped: 0 };
  const skipped = [];
  const applied = [];

  const processed = new Set(state.processedEventIds.map(row => row.id));
  const incoming = [];
  const batchSeen = new Set();
  for (const raw of Array.isArray(events) ? events : []) {
    const checked = normalizeEvent(raw);
    if (!checked.ok) { flags.dropped += 1; skipped.push({ id: raw?.id ?? null, reason: checked.reason }); continue; }
    // 同一批里重复出现的同一个 id 也只能算一次
    if (processed.has(checked.event.id) || batchSeen.has(checked.event.id)) {
      skipped.push({ id: checked.event.id, reason: 'duplicate' });
      continue;
    }
    batchSeen.add(checked.event.id);
    incoming.push(checked.event);
  }
  // 事件时间语义：按发生时间排序；缺时间的好事件视为“此刻”
  const baseTime = Math.max(state.at, 0);
  for (const event of incoming) if (event.at === null) event.at = now;
  incoming.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  let cursor = baseTime;
  if (now < cursor) { flags.timeRollback = true; cursor = now; }

  for (const event of incoming) {
    let t = event.at;
    if (t > now) { t = now; flags.futureClamped += 1; }
    if (t < cursor) t = cursor; // 乱序/回拨：不倒退
    const advanced = integrate(state, (t - cursor) / 3600_000, p, recoveryHoursBetween(cursor, t, state, p));
    if (advanced.truncated) flags.catchupTruncated = true;
    applyEvent(state, event, t, p);
    cursor = t;
    applied.push({ id: event.id, at: t, kind: event.kind });
  }

  const tail = integrate(state, (now - cursor) / 3600_000, p, recoveryHoursBetween(cursor, now, state, p));
  if (tail.truncated) flags.catchupTruncated = true;

  expireCause(state, now, p);

  const labelled = labelOf(state.label, state, p);
  state.label = labelled.label;
  state.mood = labelled.label; // 兼容字段：与 label 同源，不单独维护
  state.at = Math.max(now, state.at); // 时间回拨时不回退锚点
  state.version = AFFECT_VERSION;

  // 去重记录：同一文件原子落盘；按窗口与容量裁剪
  const merged = [...state.processedEventIds];
  const seen = new Set(merged.map(row => row.id));
  for (const event of incoming) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    merged.push({ id: event.id, at: now });
  }
  const fresh = merged.filter(row => now - row.at <= p.processedWindowMs).slice(-p.processedLimit);
  state.processedEventIds = fresh;

  // 收尾裁剪，保证输出永远是合法数值
  state.valence = round(clamp(state.valence, -1, 1));
  state.arousal = round(clamp(state.arousal, 0, 1));
  state.energy = round(clamp(state.energy, p.energyMin, p.energyMax));

  return { affect: state, applied, skipped, flags, tired: labelled.tired };
}

/** 只做时间推进（开机结算、定时结算）：等价于 events = []。 */
export function settleIdle(affect, { now = Date.now(), params = MOOD_PARAMS } = {}) {
  return settle(affect, { now, events: [], params });
}
