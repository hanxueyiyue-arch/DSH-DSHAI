/**
 * T1c 候选策略（可独立关闭）：A 主题一致性软判断 + B 概念扩展。
 *
 * 依据：docs/V0.5.0-ALGORITHM-UPGRADE-DESIGN.md §4.4（唤醒度）、§4.3（关联），
 *       T1c 授权（2026-11-08）：A 用现有 tags/概念表做软判断；B 复用已有 CONCEPTS，不引入 LLM/向量库/网络。
 *
 * 三条边界：
 *   1. 纯函数：无 I/O，不改入参。
 *   2. 系数全部是候选值（`STRATEGY_PARAMS.status = 'candidate'`），未进入 GATES。
 *   3. 不接管 `cycleRecall`；只在 A/B harness 与测试里被调用。
 *
 * 两条"不"：
 *   - A 不把"推测出来的主题"当成确定事实：两侧都识别出主题才判冲突，任一侧缺主题即 unknown（不降权）。
 *   - B 不做无限扩词：每个概念组最多补 `maxSiblings` 个同组词，总量最多 `maxAdded` 个。
 */

import { lexemes } from './memory.js';
import { CONCEPTS } from './concepts.js';
import { tokenSimilarity } from './brainmem.js';

export const STRATEGY_PARAMS = Object.freeze({
  /** A：明确主题冲突时的唤醒度乘子（软判断，仍可能过阈值）。 */
  topicPenalty: 0.35,
  /** B：每个命中的概念组最多补几个同组词。 */
  maxSiblings: 2,
  /** B：一次查询最多补几个词（防止长查询把整张表都拉进来）。 */
  maxAdded: 6,
  /** B：补充词对相似度的贡献权重，必须显著低于精确命中（1.0）。 */
  expansionWeight: 0.24,
  status: 'candidate',
});

const GROUPS = Object.freeze(
  CONCEPTS.map((terms, index) => ({
    index,
    label: terms[0],
    terms,
    lowered: terms.map(term => String(term).toLowerCase()),
    tokens: new Set(terms.flatMap(term => [...lexemes(term)])),
  })),
);

function memoryText(memory) {
  return `${memory?.title ?? ''} ${memory?.content ?? ''} ${memory?.tags ?? ''}`;
}

/**
 * 文本的主题画像。只认概念表里出现过的词；没有命中就是"缺少主题信息"，不是"没有主题"。
 * @returns {{topics:number[], labels:string[], known:boolean}}
 */
export function topicProfile(text) {
  const low = String(text ?? '').toLowerCase();
  const hit = GROUPS.filter(group => group.lowered.some(term => low.includes(term)));
  return {
    topics: hit.map(group => group.index),
    labels: hit.map(group => group.label),
    known: hit.length > 0,
  };
}

/**
 * 线索与记忆的主题关系。
 * - `conflict`：两侧都识别出主题，且没有共同主题 → 明确主题冲突
 * - `match`：有共同主题
 * - `unknown`：任一侧缺少主题信息 → 不做任何判断（软判断的关键）
 */
export function topicRelation(cueText, memory) {
  const cue = topicProfile(cueText);
  const stored = topicProfile(memoryText(memory));
  if (!cue.known || !stored.known) {
    return { relation: 'unknown', cue: cue.labels, memory: stored.labels, shared: [] };
  }
  const shared = stored.topics.filter(topic => cue.topics.includes(topic));
  return {
    relation: shared.length ? 'match' : 'conflict',
    cue: cue.labels,
    memory: stored.labels,
    shared: shared.map(topic => GROUPS[topic].label),
  };
}

/** 策略名归一化；未知策略直接报错，避免"以为开了其实没开"。 */
export function normalizeStrategy(name) {
  const upper = String(name ?? 'B1').toUpperCase();
  if (upper === 'B0' || upper === 'B1' || upper === 'A' || upper === 'B' || upper === 'AB') return upper;
  throw new Error(`unknown strategy: ${name}`);
}

/**
 * B：确定性概念扩展。返回基础词、补充词与命中的概念组，便于诊断"到底扩了什么"。
 */
export function expandCue(cueText, params = {}) {
  const p = { ...STRATEGY_PARAMS, ...params };
  const low = String(cueText ?? '').toLowerCase();
  const baseTokens = [...lexemes(cueText)];
  const added = new Set();
  const matched = [];

  for (const group of GROUPS) {
    if (!group.lowered.some(term => low.includes(term))) continue;
    matched.push(group.label);
    let siblings = 0;
    for (const term of group.terms) {
      for (const token of lexemes(term)) {
        if (siblings >= p.maxSiblings || added.size >= p.maxAdded) break;
        if (baseTokens.includes(token) || added.has(token)) continue;
        added.add(token);
        siblings += 1;
      }
      if (siblings >= p.maxSiblings || added.size >= p.maxAdded) break;
    }
    if (added.size >= p.maxAdded) break;
  }

  return { baseTokens, added: [...added], matched, weight: p.expansionWeight };
}

/**
 * B：扩展相似度 = 基础相似度（与 T1a 完全同一口径）+ 权重 × 补充词覆盖率，上界 1。
 *
 * 已知风险（T1c 实测，未解决）：`expansionWeight = 0.24` 与 α=4 组合时，**只靠补充词命中**
 * 也可能过 θ_wake=0.30（S=0.6 时 W≈0.54），即扩词能"代替证据"而不是"帮一把"。
 * 本语料里只在 `basic-cat` 场景真正命中（0.12），且该场景 B1 本来就能召回，所以风险未被证伪；
 * 若将来要把 B 用于真实语料，应先把权重降到"单独命中过不了闸"的水平（约 ≤0.11）。
 */
export function expandedSimilarity(cueText, text, expansion) {
  const base = tokenSimilarity(cueText, text);
  const added = expansion?.added ?? [];
  if (!added.length) return { sim: base, bonus: 0, coverage: 0 };
  const textTokens = lexemes(text);
  let hit = 0;
  for (const token of added) if (textTokens.has(token)) hit += 1;
  const coverage = hit / added.length;
  const bonus = expansion.weight * coverage;
  return { sim: Math.min(1, base + bonus), bonus, coverage };
}
