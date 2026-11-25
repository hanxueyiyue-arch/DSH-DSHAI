/**
 * 唤醒度（wakeability）——纯函数、派生值、永不落盘。
 *
 * 公式的唯一依据：docs/V0.5.0-ALGORITHM-UPGRADE-DESIGN.md §4.4。
 *   u = (alpha·sim + beta·assoc) · (base + span·S)
 *   W = 1 − exp(−u)                      // 指数饱和：u=0 ⇒ W≡0（结构性质，不是调参）
 *   候选 = { W ≥ θ } ∪ { W ≥ θ/2 且 S ≥ 0.48 且 (sim ≥ 0.05 或 assoc ≥ 0.10) }
 *
 * 约束（T1a 边界，见开发计划 §8）：
 *   - 不读磁盘、不写 state.json、不调用 LLM、不接管 cycleRecall；
 *   - S 只能来自 brainStrength（沿用旧遗忘曲线），本函数不得再缩放或再归一化；
 *   - 所有系数都是实验初值（status: 'candidate'），标定方法见设计 §4.4。
 */
import { brainStrength, tokenSimilarity } from './brainmem.js';

const clamp01 = v => Math.max(0, Math.min(1, v));
const finiteOr = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** §4.4 的实验初值。不是结论，标定前不许当常数引用。 */
export const WAKE_PARAMS = Object.freeze({
  alpha: 4.0,
  beta: 2.0,
  base: 0.6,
  span: 0.4,
  thetaWake: 0.30,
  secondHopFraction: 0.5,
  secondHopMinStrength: 0.48,
  secondHopMinSim: 0.05,
  secondHopMinAssoc: 0.10,
  status: 'candidate',
});

function unit(value, label, flags) {
  const n = finiteOr(value, 0);
  if (n < 0 || n > 1) {
    flags.push(`${label}:out-of-range`);
    return clamp01(n);
  }
  return n;
}

function cueTextOf(cue) {
  if (typeof cue === 'string') return cue;
  if (!cue || typeof cue !== 'object') return '';
  if (typeof cue.text === 'string') return cue.text;
  if (Array.isArray(cue.tokens)) return cue.tokens.filter(t => typeof t === 'string' && t).join(' ');
  return '';
}

/**
 * 只做数学：给定证据（sim / assoc / S）算 W 与入选判定。
 * 对外主入口是 wakeability()；本函数单独存在是为了让 §4.4 的 8 行对照表能直接断言，
 * 也为了让「S 不许被调用方伪造」这条在类型层面成立——它明确要求 S，而 wakeability() 只接受 memory。
 */
export function wakeabilityFromEvidence(evidence = {}, params = {}) {
  const p = { ...WAKE_PARAMS, ...params };
  const flags = [];
  const sim = unit(evidence.sim, 'sim', flags);
  const assoc = unit(evidence.assoc, 'assoc', flags);
  const S = unit(evidence.S, 'S', flags);
  const factor = p.base + p.span * S;
  const u = (p.alpha * sim + p.beta * assoc) * factor;
  const W = u > 0 ? 1 - Math.exp(-u) : 0;
  const theta = Math.max(0, finiteOr(p.thetaWake, WAKE_PARAMS.thetaWake));
  const secondHopFloor = p.secondHopFraction * theta;
  const atThreshold = W >= theta;
  const hasCue = sim >= p.secondHopMinSim || assoc >= p.secondHopMinAssoc;
  const secondHop = !atThreshold
    && W >= secondHopFloor
    && S >= p.secondHopMinStrength
    && hasCue;

  let reason;
  if (u <= 0) reason = 'no-evidence';
  else if (atThreshold) reason = 'threshold';
  else if (secondHop) reason = 'second-hop';
  else if (!hasCue) reason = 'no-cue';
  else if (S < p.secondHopMinStrength) reason = 'low-strength';
  else reason = 'below-threshold';

  return {
    W, S, sim, assoc, u, factor, theta,
    eligible: atThreshold || secondHop,
    reason,
    clamped: flags.length > 0,
    flags,
  };
}

/**
 * 主入口：从一条记忆与一个线索算唤醒度。
 * @param {object} memory 至少含 id/title；sim 会用到 title+content+tags
 * @param {string|{text?:string,tokens?:string[]}} cue 线索
 * @param {{now?:number, assoc?:number, thetaWake?:number}} ctx
 */
export function wakeability(memory, cue = {}, ctx = {}) {
  if (!memory || typeof memory !== 'object' || Array.isArray(memory)) {
    throw new TypeError('wakeability(memory, cue, ctx): memory 必须是一条记忆对象');
  }
  const now = Number.isFinite(ctx?.now) ? ctx.now : Date.now();
  const text = cueTextOf(cue);
  const corpus = [memory.title, memory.content, memory.tags]
    .filter(v => typeof v === 'string' && v)
    .join(' ');
  const sim = text && corpus ? tokenSimilarity(text, corpus) : 0;
  const assoc = finiteOr(ctx?.assoc, 0);
  const { strength } = brainStrength(memory, now);
  const params = Number.isFinite(ctx?.thetaWake) ? { thetaWake: ctx.thetaWake } : {};
  const result = wakeabilityFromEvidence({ sim, assoc, S: strength }, params);
  return { id: memory.id ?? null, ...result };
}
