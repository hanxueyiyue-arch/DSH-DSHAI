// S3.8 学习信号（v1 只做一条）：主动关心的阈值随结果缓慢变化。
// 规则是确定性的：同向多次才移动，每天最多移动 CARE_DAILY_CAP，且不越过边界。
// 这里不调用模型，也不读写磁盘；调用方负责保存 self。

import { brainStrength } from '../memory/brainmem.js';
import { lexemes } from '../memory/memory.js';

export const CARE_WINDOW_MS = 72 * 3_600_000;
export const CARE_DAILY_CAP = 0.02;
export const DEFAULT_CARE_THRESHOLD = 0.6;
export const CARE_THRESHOLD_MIN = 0.3;
export const CARE_THRESHOLD_MAX = 0.9;
// 软门禁：低于这个强度才硬拦，介于两者之间交给模型自己判断。
export const CARE_HARD_FLOOR = 0.3;

// 主动关心后的结果：用户继续聊这件事 → 阈值下调；一直没回应 → 阈值上调。
// 用户回了别的事（unrelated）不算信号，避免把“忙”误读成“不喜欢”。
const STEPS = Object.freeze({
  'topic-continues': -0.012,
  silence: 0.006
});

const round3 = value => Math.round(value * 1000) / 1000;

export function localDayKey(at = Date.now(), timeZone = 'Asia/Shanghai') {
  const zone = timeZone || 'Asia/Shanghai';
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date(at));
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

export function careScore(row, now = Date.now()) {
  const strength = Number(brainStrength(row, now)?.strength);
  return Number.isFinite(strength) ? round3(strength) : 0;
}

function thresholdOf(self) {
  // 兼容旧字段名 initiativeThreshold。
  const value = Number(self?.traits?.careThreshold ?? self?.traits?.initiativeThreshold);
  if (!Number.isFinite(value)) return DEFAULT_CARE_THRESHOLD;
  return Math.min(CARE_THRESHOLD_MAX, Math.max(CARE_THRESHOLD_MIN, value));
}

// 主动关心只在“记忆够强/够重要”时发生：太弱的旧事，宁可不提。
export function careAllowed({ row, now, self }) {
  const threshold = thresholdOf(self);
  const score = careScore(row, now);
  // 软门禁：只有"极弱的旧事"才硬拦；偏弱但不到极弱的，交给模型自己判断提不提。
  const hard = score < CARE_HARD_FLOOR;
  return { allowed: !hard, soft: !hard && score < threshold, hard, score, threshold, hardFloor: CARE_HARD_FLOOR };
}

// 用户回复是否还在同一件事上：共享至少一个词法单元（中文按相邻二字切分）。
export function topicOverlap(row, text) {
  if (!row || typeof text !== 'string') return false;
  const tokens = lexemes(text);
  if (tokens.size === 0) return false;
  const rowTokens = lexemes(`${row.title ?? ''} ${(Array.isArray(row.tags) ? row.tags.join(' ') : '')}`);
  for (const token of rowTokens) if (tokens.has(token)) return true;
  return false;
}

function normalizeLearning(learning, at, timeZone) {
  const day = localDayKey(at, timeZone);
  if (!learning || typeof learning !== 'object' || learning.day !== day) {
    return { day, initiativeDelta: 0 };
  }
  const delta = Number(learning.initiativeDelta);
  return { day, initiativeDelta: Number.isFinite(delta) ? delta : 0 };
}

export function applyCareOutcome(
  self,
  { signal, at = Date.now(), timeZone = 'Asia/Shanghai', memoryId = null } = {}
) {
  const base = STEPS[signal];
  if (!base) return null;
  if (!self || typeof self !== 'object') return null;
  if (!self.traits || typeof self.traits !== 'object') self.traits = {};
  if (!Array.isArray(self.outcomes)) self.outcomes = [];

  const learning = normalizeLearning(self.learning, at, timeZone);
  self.learning = learning;
  const threshold = thresholdOf(self);

  // 当日累计变化封顶；正负分开算，避免“先降后升”绕过上限。
  const floor = -CARE_DAILY_CAP - Math.min(0, learning.initiativeDelta);
  const ceil = CARE_DAILY_CAP - Math.max(0, learning.initiativeDelta);
  const delta = Math.max(floor, Math.min(ceil, base));
  if (delta === 0) {
    return { delta: 0, threshold, capped: true };
  }

  const next = Math.min(CARE_THRESHOLD_MAX, Math.max(CARE_THRESHOLD_MIN, threshold + delta));
  const applied = round3(next - threshold);
  if (applied === 0) return { delta: 0, threshold, capped: true };

  self.traits.careThreshold = round3(next);
  learning.initiativeDelta = round3(learning.initiativeDelta + applied);
  self.outcomes.push({
    kind: 'care-followup',
    signal,
    memoryId,
    at,
    delta: applied,
    threshold: round3(next)
  });
  self.outcomes = self.outcomes.slice(-200);
  self.updatedAt = new Date(at).toISOString();
  return { delta: applied, threshold: round3(next), capped: false };
}
