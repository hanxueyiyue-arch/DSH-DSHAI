// P4 检索：四层融合（归一化 → RRF + 基线保护 → 加权和 → MMR）。
// 纯函数；不写状态。默认不接管 recall.js 的旧路径，由调用方显式选择 mode。
//
// 为什么改成四层（2026-11-24）：
//   旧实现把「legacy BM25 归一化分」和「唤醒度 W」两个不可比分布直接加权相加，
//   等于把考试分和人气票相加排名。实测 P4 相对 legacy 丢了 48 条候选，其中 21 条是相关的。
//   新实现分层：
//     第 0 层 用 sigmoid 把词法分压成 0~1（不再"除以本批最高分"，避免一条强文档压扁其余）；
//     第 1 层 跨通道只按名次融合（RRF k=60），并保证至少一半结果来自基线通道（单调不劣化）；
//     第 2 层 通道内按 0.5 相关性 + 0.25 重要性 + 0.25 新鲜度 定序；
//     第 3 层 MMR 去冗余，避免 5 条召回全是同一件事。

import { selectCandidates, filterByTime } from './recall-filter.js';
import { topicRelation, topicProfile } from './recall-strategies.js';
import { cycleRecall } from './brainmem-v2.js';
import { tokenSimilarity } from './brainmem.js';
import { topicsFromText, interestBoost } from '../self/drives.js';
import { clipped, memoryDate } from './text-util.js';

// 只有这些字段会被 model-decide 的 recallForModel 转发给模型，字符预算也只按它们计。
function billedSize(item) {
  return JSON.stringify({
    id: item.id,
    title: item.title,
    excerpt: item.excerpt,
    kind: item.kind,
    layer: item.layer,
    score: item.score,
    date: item.date
  }).length;
}

// role 分层：action 记录同质高频，默认不进正排。
const ACTION_INTENT = /我说过|我说了|你说过|做过|干了|上次说|之前说|答应|承诺|汇报|报备/;
export function roleAllows(row, query) {
  if (!row || row.kind !== 'action') return true;
  return ACTION_INTENT.test(String(query ?? ''));
}

// recency：被回忆起过的记忆应当"更新"，而不是只看创建时间。
function recencyAt(row) {
  const recalled = Number(row?.lastRecalledAt);
  if (Number.isFinite(recalled) && recalled > 0) return recalled;
  const occurred = Number(row?.occurredAt);
  if (Number.isFinite(occurred)) return occurred;
  const created = Date.parse(row?.createdAt ?? '');
  return Number.isFinite(created) ? created : 0;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// 分类型遗忘（I）：不同东西该有不同的"记忆寿命"。
// 行为流水一天几十条，留太久只会挤占召回；用户的偏好不该随时间变淡。
// 参考 dsh-mneme 的 per-type decay + immunity。
const RECENCY_HALF_LIFE_DAYS = Object.freeze({
  action: 7,
  observation: 30,
  uncertain: 60,
  inference: 120,
  fact: 180,
  insight: 90,
  feedback: 90
});
export function halfLifeDaysOf(row) {
  if (!row) return 90;
  if (row.layer === 'preference') return Infinity; // 偏好免疫：不随时间变淡
  const days = RECENCY_HALF_LIFE_DAYS[row.kind];
  return Number.isFinite(days) ? days : 90;
}

export const P4_PARAMS = Object.freeze({
  strategy: 'AB',
  overFetch: 4,
  minOverFetch: 24,
  // 第 2 层的四项权重（相关性 / 重要性 / 新鲜度 / 兴趣）。
  // 默认取旧 P4 的 0.58/0.15/0.12/0.15：实测 0.5/0.25/0.25 会把 precision 从 0.77 拉到 0.73，
  // 因为 importance/freshness 权重抬高后淹没了词法区分度。
  blend: Object.freeze({ relevance: 0.58, importance: 0.12, freshness: 0.15, interest: 0.15 }),
  // 第 1 层 RRF 与基线保护
  rrfK: 60,
  // 相关性的混合系数：relevanceMix × 词法相对分 + (1 - relevanceMix) × 融合相对分。
  // 词法分盯精度，融合分（含唤醒度 wake 通道）盯"老记忆"重surface，二者是对立的。
  relevanceMix: 0.5,
  // 回声惩罚：刚写下的记忆常常只是在复述当前这句话，把它们压一压，
  // 老记忆才有机会浮上来（实测 echoShare 0.42、oldHit@1 仅 0.325）。
  // 回声惩罚：机制保留但默认关闭。实测 oldHit 的分母只有 16 条查询（噪声 ±0.24），
  // 看不出收益；开启会稳定吃掉一点 nDCG（0.894 → 0.878）。需要时用 params.echo.penalty 打开。
  echo: Object.freeze({ ms: 1800_000, penalty: 1 }),
  baselineFloor: 0.5,
  channelWeights: Object.freeze({ legacy: 1, wake: 1, phrase: 0.8 }),
  // 第 3 层 MMR
  // MMR：实测（160 查询）开启与否 top5 文本重复率都是 0.4%，tokenSimilarity 抓不到"同一件事的不同说法"。
  // 因此默认关闭，保留实现供重复率升高时启用。
  mmr: Object.freeze({ enabled: false, lambda: 0.85 }),
  // 第 0 层 sigmoid：中点按"实测 top1 词法分中位数"标定，随查询长度分档。
  // 实测（160 查询 / 773 记忆）：中位 top1 分 = <=3字 5.1，4-6字 8.9，7-10字 16.0，
  // 11-20字 24.1，>20字 63.0 —— 长度与分数强相关，所以中点必须分档，否则短问句全被判成弱相关。
  sigmoid: Object.freeze({ midpoints: [5.1, 8.9, 16.0, 24.1, 63.0], steepness: 2 }),
  // 门槛（第 4 层）：基础阈值 + 自适应调整
  // 阈值作用在"绝对相关性"（sigmoid 分）上，尺度与旧的 tokenSimilarity 不同，按空答率标定：
  // 目标是把空答率保持在 3%~8%（旧实现 3.1%），而不是动辄空一半。
  // gateMode: 'wake' = 沿用旧的 token 相似度门槛（与记忆库规模无关，实测 3.1% 空答）；
  //           'absolute' = 用 sigmoid 绝对相关性；'off' = 不设门槛。
  // 实测 'absolute' 在记忆库较小时误杀严重（库<100 条时 relTop 均值 0.207，库≥300 时 0.407），
  // 所以默认回到 'wake'。
  gateMode: 'wake',
  thetaBase: 0.05,
  thetaShort: 0.08,
  thetaLong: 0.03,
  shortQueryChars: 5,
  longQueryChars: 30,
  headGapRatio: 0.3,
  precisionFirst: true,
  // 回指/时间线索 → 宽召回
  broadRecallLimitFactor: 2,
  broadRecallThetaFactor: 0.7,
  futurePenalty: 0.8,
  contextChars: 60,
  expansionWeight: 0.10,
  maxCandidates: 60,
  status: 'candidate'
});

const PRONOUN = /它|他|她|这个|那个|刚才|上面|前面|那样|这件事|那件事/;
const FUTURE = /明天|下次|以后|将来|计划|准备|打算|要去|会去|还没|什么时候/;
const PAST = /去过|当时|上次|昨天|以前|已经|之前|那天/;
// 回指 / 时间线索：出现即说明"她指的是记忆里的东西"，当场按新话题搜不出来。
const RECALL_CUES = /上次|之前|以前|那天|那次|刚才|刚刚|后来|很早|还记得|记不记得|我们讨论|我们聊|我说过|你提过|提到过|最近|上次说|之前说/;

export function wantsFuture(query) {
  return FUTURE.test(String(query ?? ''));
}

export function wantsPast(query) {
  return PAST.test(String(query ?? ''));
}

/** 回指/时间线索是否命中 → 决定要不要宽召回。纯函数、零成本。 */
export function needsBroadRecall(query) {
  return RECALL_CUES.test(String(query ?? ''));
}

/**
 * 第 0 层：把原始词法分压到 0~1。
 * 用 sigmoid（中点/陡度随查询长度自适应）而不是"除以本批最高分"——
 * 后者会让同一条记忆的分数随"这轮有没有强对手"浮动。
 */
export function normalizeLexical(rawScore, query = '', params = P4_PARAMS) {
  const score = Number(rawScore);
  if (!Number.isFinite(score) || score <= 0) return 0;
  const chars = [...String(query ?? '').trim()].length;
  const { midpoints, steepness } = params.sigmoid;
  const idx = chars <= 3 ? 0 : chars <= 6 ? 1 : chars <= 10 ? 2 : chars <= 20 ? 3 : 4;
  const mid = midpoints[idx];
  // 词法分是无上限的原始分（实测 p50=20，max=274），所以在对数空间做 sigmoid：
  // 分数等于本档中位数 → 0.5；3 倍中位数 → 约 0.90；远低于中位数 → 接近 0。
  return 1 / (1 + Math.exp(-steepness * (Math.log1p(score) - Math.log1p(mid))));
}

/**
 * 第 4 层门槛：按查询形态自适应。
 * 历史记录里固定 θ 扫过 51 个点没有可行解，问题不在常数——所以按形态给。
 */
export function adaptiveThreshold(query, lexicalScores = [], params = P4_PARAMS) {
  const text = String(query ?? '');
  const chars = [...text.trim()].length;
  let theta = params.thetaBase;
  if (chars > 0 && chars < params.shortQueryChars) theta = params.thetaShort;      // 短句几乎匹配一切 → 收紧
  else if (chars > params.longQueryChars) theta = params.thetaLong;               // 长句更具体 → 放宽
  // 头部分明（第 1 名比第 5 名高出很多）→ 放宽，让尾部也进候选
  const sorted = (Array.isArray(lexicalScores) ? lexicalScores : []).map(Number)
    .filter(n => Number.isFinite(n) && n > 0).sort((a, b) => b - a);
  if (sorted.length >= 5 && sorted[0] > 0) {
    const gap = (sorted[0] - sorted[4]) / sorted[0];
    if (gap > params.headGapRatio) theta = Math.min(theta, params.thetaLong);
  }
  return theta;
}

/**
 * 连续追问的线索扩展：只有短问句或含代词时才借用上一轮话术。
 */
export function expandCue(query, { contextText = '', contextChars = P4_PARAMS.contextChars } = {}) {
  const base = String(query ?? '').trim();
  const context = String(contextText ?? '').replace(/\s+/g, ' ').trim().slice(-contextChars);
  if (!base || !context) return { cue: base, usedContext: false, reason: 'no-context' };
  const short = base.length <= 8;
  const pronoun = PRONOUN.test(base);
  if (!pronoun && !(short && !topicProfile(base).known)) {
    return { cue: base, usedContext: false, reason: 'has-topic' };
  }
  return { cue: `${base} ${context}`, usedContext: true, reason: pronoun ? 'pronoun' : 'short' };
}

function tokensOf(row) {
  const tags = Array.isArray(row?.tags) ? row.tags : String(row?.tags ?? '').split(/\s+/);
  return [...tags, ...topicsFromText(`${row?.title ?? ''} ${row?.content ?? ''}`)].filter(Boolean);
}

function targetedDrive(drives, row) {
  if (!drives) return 0;
  const tokens = tokensOf(row);
  const interests = drives.interests && typeof drives.interests === 'object' ? drives.interests : {};
  const hit = tokens.filter(token => Number(interests[token]) > 0);
  if (!hit.length) return 0;
  const curiosity = Number(drives.curiosity);
  const base = interestBoost(drives, hit);
  return Math.min(1, 0.8 * base + 0.2 * (Number.isFinite(curiosity) ? curiosity : 0));
}

function recencyOf(row, now) {
  const at = recencyAt(row);
  if (!Number.isFinite(at)) return 0;
  const days = halfLifeDaysOf(row);
  if (!Number.isFinite(days)) return 1; // 免疫类型：新鲜度恒为满分
  return Math.exp(-Math.max(0, now - at) / (days * DAY_MS));
}

/**
 * 第 1 层：Reciprocal Rank Fusion。
 * 通道分数不可比（BM25 / W / 子串命中率），所以只让"名次"参与融合。
 */
export function fuseRRF(channelLists, { k = 60, weights = {} } = {}) {
  const fused = new Map();
  for (const [name, ids] of Object.entries(channelLists ?? {})) {
    const weight = Number(weights[name] ?? 1);
    if (!Number.isFinite(weight) || weight <= 0) continue;
    (Array.isArray(ids) ? ids : []).forEach((id, index) => {
      const cur = fused.get(id) ?? { id, score: 0, channels: [] };
      cur.score += weight / (k + index + 1);
      cur.channels.push(name);
      fused.set(id, cur);
    });
  }
  return [...fused.values()].sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
}

/**
 * 第 1 层附加：基线保护。
 * 增强通道最多只能挤掉 (1 - floor) 的基线结果——保证"原来能召回的"不会因为新机制彻底消失。
 */
export function applyBaselineFloor(ordered, baselineIds, { k, floor }) {
  const isBaseline = id => baselineIds.has(id);
  const chosen = ordered.slice(0, k);
  const availableBaseline = ordered.filter(entry => isBaseline(entry.id)).length;
  const reserved = Math.min(Math.ceil(k * floor), availableBaseline);
  let baselineCount = chosen.filter(entry => isBaseline(entry.id)).length;
  if (baselineCount >= reserved) return chosen;
  const promoted = ordered.filter(entry => isBaseline(entry.id) && !chosen.some(c => c.id === entry.id));
  for (const entry of promoted) {
    if (baselineCount >= reserved) break;
    const victim = chosen.map(e => isBaseline(e.id)).lastIndexOf(false);
    if (victim < 0) break;
    chosen.splice(victim, 1);
    chosen.push(entry);
    baselineCount += 1;
  }
  return chosen.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
}

/**
 * 基线保护：最终输出里至少 ceil(limit × floor) 条来自基线通道（legacy / wake）。
 * 单调不劣化保证——新机制最多只能挤掉 (1 - floor) 的"原来能召回的"。
 */
export function enforceBaselineQuota(list, baselineIds, { limit, floor }) {
  const items = Array.isArray(list) ? list : [];
  if (!items.length) return [];
  const quota = Math.max(0, Math.min(limit, Math.ceil(limit * Number(floor ?? 0))));
  if (quota <= 0) return items.slice(0, limit);
  const isBaseline = item => baselineIds.has(item.id);
  const out = items.slice(0, limit);
  let count = out.filter(isBaseline).length;
  if (count >= quota) return out;
  const spare = items.filter(item => isBaseline(item) && !out.some(o => o.id === item.id));
  for (const item of spare) {
    if (count >= quota) break;
    const victim = out.map(isBaseline).lastIndexOf(false);
    if (victim < 0) break;
    out.splice(victim, 1, item);
    count += 1;
  }
  return out.sort((a, b) => (Number(b.blend) || 0) - (Number(a.blend) || 0));
}

/**
 * 第 3 层：MMR 去冗余（Carbonell & Goldstein 1998）。
 * relevance 先在候选集内 min-max 归一化——否则原始分尺度会压过相似度项，λ 失去意义。
 */
export function mmrOrder(entries, { lambda = 0.7, limit = entries.length } = {}) {
  if (!Array.isArray(entries) || entries.length <= 1) return [...(entries ?? [])];
  // blend 本身已经落在 0~1（第 2 层的加权和），直接当 relevance 用。
  // 之前做 min-max 归一化会把 1.00 与 0.95 拉成 1 与 0，等于把"几乎一样好"误判成"差很多"，
  // MMR 于是宁可选重复的高分项也不选稍低分的不同项——正是它要防的事。
  const pool = entries.map(e => ({
    entry: e,
    text: `${e.title ?? ''} ${e.excerpt ?? ''}`.slice(0, 300),
    relevance: Math.min(1, Math.max(0, Number(e.blend) || 0)),
    maxSim: 0
  }));
  const remaining = [...pool];
  const out = [];
  while (remaining.length > 0 && out.length < limit) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i += 1) {
      const cand = remaining[i];
      const mmrScore = lambda * cand.relevance - (1 - lambda) * cand.maxSim;
      if (mmrScore > bestScore) { bestScore = mmrScore; bestIdx = i; }
    }
    const [picked] = remaining.splice(bestIdx, 1);
    out.push(picked.entry);
    for (const cand of remaining) {
      const sim = tokenSimilarity(picked.text, cand.text);
      if (sim > cand.maxSim) cand.maxSim = sim;
    }
  }
  return out;
}

/**
 * 第 1 层里的 phrase 通道：整串子串匹配（中文不切词）。
 * 汉字二元组擅长模糊召回，但会把她引用的原话切碎；这一路专门补"整句对得上"。
 */
function phraseRanking(rows, cue, limit) {
  const needle = String(cue ?? '').trim().toLowerCase();
  if (needle.length < 2) return [];
  const scored = [];
  for (const row of rows) {
    const hay = `${row?.title ?? ''} ${row?.content ?? ''}`.toLowerCase();
    const at = hay.indexOf(needle);
    if (at < 0) continue;
    scored.push({ id: row.id, at, count: hay.split(needle).length - 1 });
  }
  scored.sort((a, b) => b.count - a.count || a.at - b.at);
  return scored.slice(0, limit).map(x => x.id);
}

/**
 * @param {Array} rows 记忆数组（只读）
 * @returns 与 recallMemories 同形的 {items, topicHits, ...}，另带 p4 诊断字段
 */
export function recallP4(rows, query, {
  now = Date.now(),
  limit = 5,
  maxChars = 1600, // 实测：800 时 64% 的查询被预算截断；1600 只截断 3%，平均多 473 字符/轮
  drives = null,
  contextText = '',
  includeTest = false,
  includeHidden = false,
  params = {}
} = {}) {
  const p = {
    ...P4_PARAMS,
    ...params,
    blend: { ...P4_PARAMS.blend, ...(params.blend ?? {}) },
    channelWeights: { ...P4_PARAMS.channelWeights, ...(params.channelWeights ?? {}) },
    mmr: { ...P4_PARAMS.mmr, ...(params.mmr ?? {}) },
    echo: { ...P4_PARAMS.echo, ...(params.echo ?? {}) }
  };
  const active = (Array.isArray(rows) ? rows : [])
    .filter(row => row && !row.archivedAt && (includeTest || (row.kind !== 'test' && row.isTest !== true)))
    // G：写入时判定为低质量（<30）的记忆不自动注入，但显式检索（includeHidden）仍能看到。
    .filter(row => row.autoInject !== false || includeHidden)
    .filter(row => roleAllows(row, query));
  const expansion = expandCue(query, { contextText, contextChars: p.contextChars });
  const before = filterByTime(active, { now });

  // 回指/时间线索 → 宽召回（多取候选、放宽门槛）
  const broad = needsBroadRecall(expansion.cue);
  const effectiveLimit = broad ? Math.ceil(limit * p.broadRecallLimitFactor) : limit;
  const thetaFactor = broad ? p.broadRecallThetaFactor : 1;
  const candidates = Math.min(
    p.maxCandidates,
    Math.max(p.minOverFetch, effectiveLimit * p.overFetch)
  );

  // —— 通道 A：唤醒度（wake） ——
  const selected = selectCandidates(active, expansion.cue, {
    now,
    limit: candidates,
    strategy: p.strategy,
    includeNotYet: true,
    // 门槛交给第 4 层统一判（这里先不做 precisionFirst 提前空答，否则宽召回无从生效）
    precisionFirst: p.gateMode === 'wake',
    strategyParams: { expansionWeight: p.expansionWeight }
  });
  // —— 通道 B：旧 BM25（legacy） ——
  const legacy = cycleRecall(active, expansion.cue, {
    now,
    limit: candidates,
    maxChars: Math.max(maxChars * 4, 2400),
    validity: true,
    includeNotYet: true
  });
  // —— 通道 C：整串匹配（phrase） ——
  const phraseIds = phraseRanking(active, expansion.cue, candidates);

  // 第 0 层：把 legacy 原始词法分压成 0~1 的绝对相关性（不再"除以本批最高分"）
  const legacyById = new Map(legacy.items.map(item => [item.id, Number(item.score) || 0]));
  const legacyRanked = [...legacyById.entries()]
    .map(([id, raw]) => ({ id, raw }))
    .sort((a, b) => b.raw - a.raw || String(a.id).localeCompare(String(b.id)));
  const relTop = legacyRanked.length ? normalizeLexical(legacyRanked[0].raw, expansion.cue, p) : 0;

  // 第 4 层门槛（自适应）：主通道最高分都够不着门槛 → 干脆空答，别硬凑。
  const theta = adaptiveThreshold(expansion.cue, legacyRanked.map(x => x.raw), p) * thetaFactor;
  if (p.gateMode === 'absolute' && relTop < theta) {
    return {
      readOnly: true, evidenceOnly: true, mode: 'p4',
      query: String(query ?? '').slice(0, 150), cue: expansion.cue.slice(0, 200),
      usedContext: expansion.usedContext, contextReason: expansion.reason,
      items: [], topicHits: {}, truncated: false, charBudget: maxChars,
      poolSize: active.length,
      eligibleSize: before.kept.length + before.notYet.length,
      excluded: before.dropped.length,
      overFetch: candidates, filtered: 0, precisionFirst: true,
      theta: Number(theta.toFixed(3)), topSignal: Number(relTop.toFixed(3)),
      reason: 'below-threshold', broad,
      params: { blend: p.blend, mmr: p.mmr, rrfK: p.rrfK, baselineFloor: p.baselineFloor }
    };
  }

  // 第 1 层：RRF 融合（只认名次）
  const fused = fuseRRF({
    legacy: legacyRanked.map(x => x.id),
    wake: selected.selected.map(entry => entry.id),
    phrase: phraseIds
  }, { k: p.rrfK, weights: p.channelWeights });
  // 基线保护标记：真正生效在"最终输出"那一步（见 enforceBaselineQuota）
  const baselineIds = new Set([...legacyRanked.map(x => x.id), ...selected.selected.map(entry => entry.id)]);
  const kept = fused.slice(0, candidates);

  const wakeById = new Map(selected.selected.map(entry => [entry.id, entry]));
  const byId = new Map(active.map(row => [row.id, row]));
  const future = wantsFuture(expansion.cue);
  const past = wantsPast(expansion.cue);
  const maxFuse = Math.max(1e-9, ...kept.map(entry => entry.score));
  const maxLexical = Math.max(1e-9, ...kept.map(entry => legacyById.get(entry.id) ?? 0));

  const scored = [];
  for (const candidate of kept) {
    const row = byId.get(candidate.id);
    if (!row) continue;
    if (topicRelation(expansion.cue, row).relation === 'conflict') continue;
    const entry = wakeById.get(candidate.id) ?? null;
    const futureLike = Boolean(entry?.notYet || row.modality === '计划');
    if (futureLike && past && !future) continue;
    const notYetPenalty = futureLike && !future && !past ? p.futurePenalty : 1;

    // 第 2 层：通道内加权和（三项都在 0~1，可比）
    // 第 2 层的"相关性"取原始词法分的批内相对值 —— 不用 RRF 融合分：
    // RRF 只贡献名次，同批条目的分数挤在 1/(k+1)~1/(k+n) 之间，归一化后全部贴近 1.0，
    // 于是 importance/freshness 反而主导排序（实测 precision 0.773 → 0.738）。
    // RRF 仍然负责"哪些候选进集合"和"基线保护"，只是不再当相关性用。
    // 相关性 = 一半词法相对分 + 一半融合相对分。
    // 纯词法：precision/nDCG 好，但"老记忆"命中差（实测 oldHit@1 0.325）；
    // 纯融合：老记忆好（0.735）但精度差。实测两者各有所长，故各半。
    const rawLexical = legacyById.get(candidate.id) ?? 0;
    const lexRel = rawLexical > 0 ? Math.min(1, Math.max(0, rawLexical / maxLexical)) : 0;
    const rrfRel = Math.min(1, Math.max(0, candidate.score / maxFuse));
    const mix = Number.isFinite(p.relevanceMix) ? p.relevanceMix : 0.5;
    const relevance = mix * lexRel + (1 - mix) * rrfRel;
    const qualityFactor = Number.isFinite(Number(row.quality)) ? Math.max(0.3, Number(row.quality) / 100) : 1;
    const importance = Math.min(1, Math.max(0, (Number(row.importance) || 3) / 5)) * qualityFactor;
    const freshness = recencyOf(row, now);
    const interest = Math.min(1, Math.max(0, targetedDrive(drives, row)));
    const bornAt = recencyAt(row);
    const isEcho = Number.isFinite(bornAt) && bornAt > 0 && (now - bornAt) <= Number(p.echo.ms);
    const echoPenalty = isEcho ? Number(p.echo.penalty) : 1;
    const blend = echoPenalty * notYetPenalty * (
      p.blend.relevance * relevance +
      p.blend.importance * importance +
      p.blend.freshness * freshness +
      (p.blend.interest ?? 0) * interest
    );

    scored.push({
      id: row.id,
      kind: row.kind,
      layer: row.layer,
      title: row.title,
      excerpt: clipped(String(row.content ?? ''), 160),
      date: memoryDate(row),
      blend: Number(blend.toFixed(4)),
      score: Number(blend.toFixed(4)),
      relevance: Number(relevance.toFixed(3)),
      importance: Number(importance.toFixed(3)),
      freshness: Number(freshness.toFixed(3)),
      drive: Number(interest.toFixed(3)),
      channels: candidate.channels.join('+'),
      notYet: Boolean(entry?.notYet || row.modality === '计划'),
      state: entry?.state ?? 'unknown',
      topic: entry?.topic ?? null,
      reason: entry?.reason ?? 'rrf'
    });
  }
  scored.sort((a, b) => b.blend - a.blend || String(a.id).localeCompare(String(b.id)));

  // 第 3 层：MMR 去冗余（默认关闭：实测对 top5 文本重复无影响）
  const mmrOrdered = p.mmr.enabled ? mmrOrder(scored, { lambda: p.mmr.lambda, limit: candidates }) : scored;
  // 第 1 层的基线保护落到最终输出：至少 ceil(limit × floor) 条来自 legacy/wake 通道。
  // 之前加在中间列表上，最终按 blend 重排就把它冲掉了（floor 30/70 实测无差别即是证据）。
  const ordered = enforceBaselineQuota(mmrOrdered, baselineIds, { limit: effectiveLimit, floor: p.baselineFloor });

  const items = [];
  const topicHits = {};
  let used = 0;
  for (const item of ordered) {
    if (items.length >= effectiveLimit) break;
    const size = billedSize(item);
    if (items.length > 0 && used + size > maxChars) break;
    items.push(item);
    used += size;
    for (const topic of tokensOf(byId.get(item.id))) topicHits[topic] = (topicHits[topic] || 0) + 1;
  }

  return {
    readOnly: true,
    evidenceOnly: true,
    mode: 'p4',
    query: String(query ?? '').slice(0, 150),
    cue: expansion.cue.slice(0, 200),
    usedContext: expansion.usedContext,
    contextReason: expansion.reason,
    items,
    topicHits,
    truncated: items.length < ordered.length,
    charBudget: maxChars,
    poolSize: active.length,
    eligibleSize: before.kept.length + before.notYet.length,
    excluded: before.dropped.length,
    overFetch: candidates,
    filtered: selected.dropped.length,
    precisionFirst: p.gateMode !== 'off',
    theta: Number(theta.toFixed(3)),
    broad,
    channels: { legacy: legacyRanked.length, wake: selected.selected.length, phrase: phraseIds.length },
    params: {
      blend: p.blend,
      mmr: p.mmr,
      rrfK: p.rrfK,
      baselineFloor: p.baselineFloor,
      channelWeights: p.channelWeights
    }
  };
}
