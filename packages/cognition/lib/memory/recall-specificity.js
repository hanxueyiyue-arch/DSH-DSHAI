/**
 * 召回特异性（T1c 专项，隔离实现）。
 *
 * 两个要解决的问题：
 *   1. 同词不同事件（噪声）：查询与记忆只共享"游戏/开放世界/今晚"这类常见词，
 *      但并不是同一件事，词袋相似度无法区分。
 *   2. 无字面重叠但有关联（漏召回）：查询与目标记忆没有共同词，只靠关联图。
 *
 * 本模块只提供**候选判据**，不改 `cycleRecall`、不改唤醒公式、不改金标：
 *   - `poolStats`：在当前候选池内统计每个 lexeme 的文档频率（池内 IDF，本地、无依赖）。
 *   - `overlapProfile`：查询与单条记忆的重叠画像（共享词、多字词、池内稀有词、常见词）。
 *   - `specificityGate`：只有"共享词足够具体"才放行的闸门，默认关闭。
 *
 * 设计约束：
 *   - 纯函数，不读文件、不写状态、不修改入参。
 *   - 词表来自 `lib/memory.js` 的 `lexemes`，与现有召回同一口径，避免第二套分词。
 *   - 池内 IDF 用 `log(1 + N/(1+df))`：只在"这批候选"里比较，不假设全库分布。
 */

import { lexemes } from './memory.js';

const HAN = /[\u3400-\u9fff]/;

/** 是否"多字词"（中文 ≥2 字或长度 ≥2 的拉丁/数字串）。 */
export function isWordToken(token) {
  if (typeof token !== 'string' || token.length < 2) return false;
  return HAN.test(token) || /[a-z0-9]/i.test(token);
}

export function memoryText(memory) {
  return `${memory?.title ?? ''} ${memory?.content ?? ''} ${memory?.tags ?? ''}`;
}

/**
 * 候选池内的词频统计。
 * @param {Array<object>} memories 候选记忆（不修改）
 * @returns {{n:number, df:Map<string,number>, idf:(token:string)=>number}}
 */
export function poolStats(memories) {
  const df = new Map();
  let n = 0;
  for (const memory of memories) {
    n += 1;
    for (const token of lexemes(memoryText(memory))) df.set(token, (df.get(token) ?? 0) + 1);
  }
  const idf = token => Math.log(1 + n / (1 + (df.get(token) ?? 0)));
  return { n, df, idf };
}

/**
 * 查询与单条记忆的重叠画像。
 *
 * @param {string} cue 查询
 * @param {object} memory 记忆
 * @param {{n:number, df:Map<string,number>, idf:Function}} stats 池内统计
 * @param {{rareRatio?:number}} [options] `rareRatio` 决定"稀有词"的 df 上限（默认 0.34）
 */
export function overlapProfile(cue, memory, stats, { rareRatio = 0.34 } = {}) {
  const q = lexemes(cue);
  const m = lexemes(memoryText(memory));
  const shared = [];
  for (const token of q) if (m.has(token)) shared.push(token);

  const rareMax = stats.n >= 3 ? Math.max(1, Math.floor(stats.n * rareRatio)) : 1;
  const commonMin = stats.n >= 3 ? Math.max(2, Math.ceil(stats.n * 0.67)) : Infinity;

  let idfSum = 0;
  let idfQuery = 0;
  let maxIdf = 0;
  let wordHits = 0;
  let rareHits = 0;
  let commonHits = 0;
  for (const token of q) idfQuery += stats.idf(token);
  for (const token of shared) {
    const w = stats.idf(token);
    const df = stats.df.get(token) ?? 0;
    idfSum += w;
    if (w > maxIdf) maxIdf = w;
    if (isWordToken(token)) wordHits += 1;
    if (df <= rareMax) rareHits += 1;
    if (df >= commonMin) commonHits += 1;
  }

  return {
    shared: shared.length,
    words: wordHits,
    rare: rareHits,
    common: commonHits,
    idfSum,
    idfQuery,
    maxIdf,
    // 查询侧 IDF 归一：缺失词会被计入分母，因此"只有一两个常见词命中"的案例分数会很低。
    idfSim: idfQuery > 0 ? idfSum / idfQuery : 0,
    // 覆盖率：共享词占查询词的比例（与 tokenSimilarity 同分母，便于对照）。
    coverage: q.size > 0 ? shared.length / q.size : 0,
    sharedTokens: shared,
  };
}

/**
 * 特异性闸门：默认关闭；只有调用方显式传 `enabled:true` 才判定。
 *
 * 规则（任一满足即放行）：
 *   - 共享的"多字词"达到 `minWords` 个；
 *   - 共享词里至少有 `minRare` 个池内稀有词（df ≤ 34%）；
 *   - `idfSim` 达到 `minIdfSim`（给"一个非常罕见的词"留一条路）。
 *
 * 拒绝理由用于审计，不改变任何既有分数。
 */
export function specificityGate(profile, { enabled = false, minWords = 2, minRare = 1, minIdfSim = 0.5 } = {}) {
  if (!enabled) return { allowed: true, reason: 'gate-off' };
  if (!profile || profile.shared === 0) return { allowed: false, reason: 'no-shared-token' };
  if (profile.words >= minWords) return { allowed: true, reason: 'words' };
  if (profile.rare >= minRare) return { allowed: true, reason: 'rare' };
  if (profile.idfSim >= minIdfSim) return { allowed: true, reason: 'idf' };
  return { allowed: false, reason: 'generic-only' };
}
