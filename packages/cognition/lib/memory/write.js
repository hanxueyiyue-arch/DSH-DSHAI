// 记忆写入的薄校验层：容量、字段、去重。
// 不做模型抽取；抽取在后面的编码层。

import { randomUUID } from 'node:crypto';
import { collapseLabelPrefix } from './text-util.js';

export const MEMORY_KINDS = Object.freeze(['fact', 'inference', 'uncertain', 'action', 'observation', 'feedback', 'insight']);
export const MEMORY_LAYERS = Object.freeze(['episodic', 'semantic', 'autobiographical', 'preference']);
export const MEMORY_CAPACITY = 5000;


// ================= G. 写入质量门 =================
// 由来（2026-11-24 实测）：782 条活跃记忆里 63.8% 从未被召回，38.9% 是 action 流水，
// 50 条正文 < 20 字，43 条标题带 X：X： 重复前缀。它们在同一个池子里靠召回时的正则去挡，
// 挡不住就稀释排名。这里改成"写入时打分"：
//   ≥ 60 正常入库；30–60 入库但降权（召回按 quality/100 乘算）；< 30 标记 autoInject=false
//   （仍然可被显式检索到，只是不自动注入——不是删除）。
export const QUALITY_BANDS = Object.freeze({ normal: 60, weak: 30 });

const META_MEMORY = /记忆系统|记忆机制|元记忆|记忆库|召回|检索|抽取器|反思器|蒸馏|向量库|embedding|检索器/i;
const BAD_PREFIX = /^([^：:\s]{1,8})[：:]\s*\1[：:]/;

function trigramRepeatRatio(text) {
  const s = String(text ?? '').replace(/\s+/g, '');
  if (s.length < 12) return 0;
  const grams = new Map();
  for (let i = 0; i < s.length - 2; i += 1) {
    const g = s.slice(i, i + 3);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let top = 0;
  for (const c of grams.values()) if (c > top) top = c;
  return top / Math.max(1, s.length - 2);
}

/**
 * 0–100 质量分。扣分表照 dsh-mneme 的 quality-filter，阈值按我们的实测分布调过。
 * @returns {{score:number, flags:string[], autoInject:boolean, band:'normal'|'weak'|'archive'}}
 */
export function scoreMemoryQuality(input, { recent = [] } = {}) {
  const title = String(input?.title ?? '');
  const content = String(input?.content ?? '');
  const flags = [];
  let score = 100;

  if (META_MEMORY.test(`${title} ${content}`)) { score -= 45; flags.push('meta'); }
  if (BAD_PREFIX.test(title)) { score -= 15; flags.push('self_referential'); }
  if (content.trim().length < 20) { score -= 80; flags.push('short_content'); }
  if (trigramRepeatRatio(content) > 0.35) { score -= 50; flags.push('repetitive'); }

  // duplicate：与近期同 kind 记忆 char-bigram 相似 > 0.85
  const mine = normalizeForCompare(`${title} ${content}`);
  const dup = (Array.isArray(recent) ? recent : []).find(row => {
    if (!row || row.archivedAt) return false;
    if (row.kind !== input?.kind) return false;
    return bigramJaccard(mine, normalizeForCompare(`${row.title ?? ''} ${row.content ?? ''}`)) > 0.85;
  });
  if (dup) { score -= 80; flags.push('duplicate'); }

  score = Math.max(0, Math.min(100, score));
  const band = score >= QUALITY_BANDS.normal ? 'normal' : score >= QUALITY_BANDS.weak ? 'weak' : 'archive';
  return { score, flags, band, autoInject: band !== 'archive' };
}

// ================= H. 写入时关系判定 =================
// duplicate：同一件事又写一遍 → 直接并进原行（不新增）
// update：同一主题、说法变了 → 旧行 supersededBy 新行
// contradict：同一主题但否定相反 → 两行都留，新行记 contradicts 指回旧行
// unrelated：正常新增
const NEGATION = /不|没|别|未|无|禁止|不要|无需|不用|拒绝/;

function hasNegation(text) {
  return NEGATION.test(String(text ?? ''));
}

// 只有"知识型"记忆才谈得上 duplicate / update / contradict。
// action（执行发送、安排唤醒）是流水账：同一标题下每天几十条，但它们是**先后发生的事**，
// 不是"同一件事的新说法"。2026-11-25 实测：不加这条限制，每条新 send 都会把上一条 supersededBy 掉，
// 一晚上误伤 16 条 action 记录。
const KNOWLEDGE_KINDS = new Set(['fact', 'inference', 'insight', 'uncertain']);

// 第二条限制：标题像 ≠ 同一件事。
// 2026-11-25 实测线上 8 对取代记录：正文相似度最低 0.152、中位 0.203、最高 0.514，
// 全部是"标题相同但内容讲的是另一件事"（多为「更正：X」把不同对话塞进同一个标题）。
//
// 但正文相似度本身分不开"真更新"和"真误伤"——实测：
//   真更新（爱喝咖啡→改喝无咖啡因 / Win10→Win11 / 路径改了）：0.061 / 0.079 / 0.391 / 0.379 / 0.200
//   真误伤（讲的是两件事）：0.032 / 0.067 / 0.080 / 0.096 / 0.054 / 0.250
// 两者区间完全重叠，任何 bodySim 阈值都会同时漏放和误伤。
//
// 所以改用语义硬门槛：新内容必须出现"明确替换"的说法，才允许让旧条失效。
// 只收窄口径的替换短语——"改"这个字太宽（"改一下这个实现""你改动了什么"都会误中）。
const REPLACES = /(改成|改为|改到|改喝|改用|换用|换成|调整成|升级到|降级到|作废|废弃|取代|替换成|不再|取消|停止使用|not anymore|switch(?:ed)? to|no longer)/i;

export function classifyRelation(state, input, { threshold = 0.85 } = {}) {
  if (!KNOWLEDGE_KINDS.has(String(input?.kind ?? ''))) {
    return { relation: 'unrelated', target: null, similarity: 0, skipped: 'event-kind' };
  }
  const rows = Array.isArray(state?.memories) ? state.memories : [];
  const mineTitle = normalizeForCompare(input?.title);
  const mineBody = normalizeForCompare(`${input?.title ?? ''} ${input?.content ?? ''}`);
  let best = null;
  for (const row of rows) {
    if (!row || row.archivedAt || row.supersededBy) continue;
    if (row.kind !== input?.kind) continue;
    const theirTitle = normalizeForCompare(row.title);
    const theirBody = normalizeForCompare(`${row.title ?? ''} ${row.content ?? ''}`);
    const titleSim = bigramJaccard(mineTitle, theirTitle);
    const bodySim = bigramJaccard(mineBody, theirBody);
    const score = Math.max(titleSim, bodySim);
    if (!best || score > best.score) best = { row, score, titleSim, bodySim };
  }
  if (!best) return { relation: 'unrelated', target: null, similarity: 0 };

  const { row, titleSim, bodySim } = best;
  if (bodySim >= threshold) return { relation: 'duplicate', target: row, similarity: bodySim };
  if (titleSim >= 0.8 && bodySim < threshold) {
    const flipped = hasNegation(input?.content) !== hasNegation(row.content);
    // 同一主题但否定相反 → 矛盾（两行都留），这一步不需要替换词。
    if (flipped) return { relation: 'contradict', target: row, similarity: titleSim };
    // 标题像但新内容没有"替换"的说法 → 这是同标题下的另一条记录，不动旧行。
    if (!REPLACES.test(`${input?.title ?? ''} ${input?.content ?? ''}`)) {
      return { relation: 'unrelated', target: row, similarity: titleSim, skipped: 'no-replacement-wording' };
    }
    return { relation: 'update', target: row, similarity: titleSim };
  }
  return { relation: 'unrelated', target: row, similarity: best.score };
}

export function addMemory(state, input, { now = Date.now(), capacity = MEMORY_CAPACITY, timeZone = '', relation = true } = {}) {
  const kind = String(input?.kind ?? '');
  if (!MEMORY_KINDS.includes(kind)) return { ok: false, error: 'memory-kind-invalid' };
  const layer = input?.layer ?? 'episodic';
  if (!MEMORY_LAYERS.includes(layer)) return { ok: false, error: 'memory-layer-invalid' };

  // 标题归一化在这里做一次：所有经 addMemory 的写入（抽取/规则编码/整合）都收重复前缀，
  // 避免下游各自再写一遍（reflection 直写 memories，那里单独处理）。
  const title = collapseLabelPrefix(input?.title).slice(0, 120);
  if (title === '') return { ok: false, error: 'memory-title-empty' };
  const content = String(input?.content ?? '').trim().slice(0, 2000);
  if (content === '') return { ok: false, error: 'memory-content-empty' };

  const tags = Array.isArray(input?.tags)
    ? input.tags.map(tag => String(tag).trim()).filter(Boolean).slice(0, 8)
    : [];
  const importance = Math.min(5, Math.max(1, Number(input?.importance) || 3));
  const source = input?.source && typeof input.source === 'object' ? input.source : { level: 'inference' };

  if (Array.isArray(state?.memories) && state.memories.length >= capacity) {
    return { ok: false, error: 'memory-capacity-reached' };
  }

  // ---- G：质量分（所有 kind 都算） ----
  const quality = scoreMemoryQuality({ kind, layer, title, content }, {
    recent: Array.isArray(state?.memories) ? state.memories.slice(-80) : []
  });

  // ---- H：写入时关系判定 ----
  // duplicate 直接并进原行；update 让旧行失效；contradict 留两行并连边。
  let relationVerdict = null;
  // 偏好层例外：用户重复同一件事应当走"支持度+1"，而不是被当成 duplicate 并掉。
  if (relation && layer !== 'preference') {
    relationVerdict = classifyRelation(state, { kind, layer, title, content });
    if (relationVerdict.relation === 'duplicate') {
      const target = relationVerdict.target;
      target.updatedAt = new Date(Number.isFinite(now) ? now : Date.now()).toISOString();
      target.duplicateMentions = (Number(target.duplicateMentions) || 1) + 1;
      return { ok: true, id: target.id, existing: true, merged: 'duplicate', similarity: Number(relationVerdict.similarity.toFixed(2)) };
    }
  }

  // ---- 偏好层的「支持度」机制 ----
  // 用户反复说同一件事时，应该加强原来那条，而不是再堆一条重复记忆。
  // 实测 44 条偏好里已有 1 组完全同名、1 组近似重复；没有 support 就只会越堆越多。
  if (layer === 'preference') {
    const incomingConfidence = Number.isFinite(Number(input?.confidence)) ? Math.min(1, Math.max(0, Number(input.confidence))) : 0.6;
    const hit = findSimilarPreference(state, { title, content });
    if (hit) {
      const support = (Number(hit.support) || 1) + 1;
      const bumped = Math.min(0.98, Math.max(Number(hit.confidence) || 0, incomingConfidence) + 0.05);
      hit.support = support;
      hit.confidence = Number(bumped.toFixed(2));
      hit.lastConfirmedAt = Number.isFinite(now) ? now : Date.now();
      hit.updatedAt = new Date(hit.lastConfirmedAt).toISOString();
      hit.confirmCount = support - 1;
      if (Array.isArray(tags) && tags.length) {
        hit.tags = [...new Set([...(Array.isArray(hit.tags) ? hit.tags : []), ...tags])].slice(0, 8);
      }
      return { ok: true, id: hit.id, existing: true, merged: 'preference-support', support, confidence: hit.confidence };
    }
  }

  const messageId = typeof source.messageId === 'string' ? source.messageId : null;
  if (messageId) {
    // 已归档 / 已被取代的行不能挡住一次合法的新写入——
    // 否则同一条消息里重新说起的偏好会"命中"一条早就不生效的旧记录。
    const duplicate = state.memories.find(
      row => row?.source?.messageId === messageId
        && row.kind === kind
        && row.title === title
        && !row.archivedAt
        && !row.supersededBy
    );
    if (duplicate) return { ok: true, id: duplicate.id, existing: true };
  }

  const timestamp = Number.isFinite(now) ? now : Date.now();
  const iso = new Date(timestamp).toISOString();
  const confidence = Number(input?.confidence);
  const row = {
    id: input?.id && typeof input.id === 'string' ? input.id : `mem-${randomUUID()}`,
    kind,
    layer,
    title,
    content,
    tags,
    importance,
    source,
    ...(Number.isFinite(confidence) ? { confidence: Math.min(1, Math.max(0, confidence)) } : {}),
    ...(layer === 'preference' ? { support: 1, lastConfirmedAt: timestamp } : {}),
    occurredAt: input?.occurredAt ?? timestamp,
    createdAt: iso,
    updatedAt: iso,
    recallCount: 0,
    lastRecalledAt: null,
    ...(input?.validFrom !== undefined ? { validFrom: input.validFrom } : {}),
    ...(input?.validUntil !== undefined ? { validUntil: input.validUntil } : {}),
    ...(Number.isFinite(input?.followUpAt) ? { followUpAt: input.followUpAt } : {}),
    ...(Number.isFinite(input?.followUpAskedAt) ? { followUpAskedAt: input.followUpAskedAt } : {}),
    ...(typeof input?.modality === 'string' ? { modality: input.modality } : {}),
    ...(Number.isFinite(input?.plannedFor) ? { plannedFor: input.plannedFor } : {}),
    ...(input?.precision === 'day' ? { precision: 'day', timeZone } : {})
  };

  row.quality = quality.score;
  row.qualityBand = quality.band;
  if (quality.flags.length) row.qualityFlags = quality.flags;
  if (!quality.autoInject) row.autoInject = false;
  if (relationVerdict?.relation === 'update' && relationVerdict.target) {
    relationVerdict.target.supersededBy = row.id;
    relationVerdict.target.supersededAt = iso;
    row.supersedes = relationVerdict.target.id;
  }
  if (relationVerdict?.relation === 'contradict' && relationVerdict.target) {
    row.contradicts = [relationVerdict.target.id];
  }
  state.memories.push(row);
  return {
    ok: true,
    id: row.id,
    row,
    quality: quality.score,
    qualityBand: quality.band,
    relation: relationVerdict?.relation ?? 'unrelated',
    ...(row.supersedes ? { supersedes: row.supersedes } : {}),
    ...(row.contradicts ? { contradicts: row.contradicts } : {})
  };
}

// 归一化：去掉标点空白，只留字词，用于判断"是不是同一件事"。
function normalizeForCompare(text) {
  return String(text ?? '').toLowerCase().replace(/[\s，。；：、！？,.;:!?"'""''（）()【】\[\]…—\-]/g, '');
}

// 字符二元组 Jaccard：不依赖分词，中英文都适用。
function bigramJaccard(a, b) {
  const grams = s => {
    const out = new Set();
    for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let both = 0;
  for (const g of ga) if (gb.has(g)) both += 1;
  return both / (ga.size + gb.size - both);
}

// 找"同一件事"的既有偏好：标题高度重合，或标题+正文综合高度重合。
export function findSimilarPreference(state, { title, content }, { threshold = 0.72 } = {}) {
  const rows = Array.isArray(state?.memories) ? state.memories : [];
  const t = normalizeForCompare(title);
  const c = normalizeForCompare(content);
  let best = null;
  let bestScore = 0;
  for (const row of rows) {
    if (!row || row.archivedAt || row.supersededBy || row.layer !== 'preference') continue;
    const rt = normalizeForCompare(row.title);
    const rc = normalizeForCompare(row.content);
    const titleSim = bigramJaccard(t, rt);
    const score = Math.max(titleSim, 0.5 * titleSim + 0.5 * bigramJaccard(c, rc));
    if (score > bestScore) { bestScore = score; best = row; }
  }
  return bestScore >= threshold ? best : null;
}

// ---- 观察的「一个来源一条记忆」合并 ----
// 由来（2026-11-24 实测）：120 条 observation 归并到 50 个来源，其中 22 个来源出现多次
// （最多的一条视频被记了 14 次），top5 的"最近看过"3 个槽位里 2 个是同一篇。
// 合并后：同一条视频只有一行，内部记 sections（每次抓到什么）+ progress（读到哪）+ done（看完没）。
export const OBSERVATION_SECTIONS_MAX = 12;

function normalizeForSection(text) {
  return String(text ?? '').replace(/\s+/g, '').slice(0, 60);
}

export function upsertObservationSource(state, input, { now = Date.now() } = {}) {
  const key = input?.source?.key;
  if (!key || !Array.isArray(state?.memories)) return null;
  const existing = state.memories.find(row => row && row.kind === 'observation' && !row.archivedAt && row.source?.key === key);
  if (!existing) return null;

  const timestamp = Number.isFinite(now) ? now : Date.now();
  const section = {
    tool: input.source?.tool ?? null,
    from: Number.isFinite(input.source?.progress?.from) ? input.source.progress.from : null,
    to: Number.isFinite(input.source?.progress?.to) ? input.source.progress.to : null,
    at: timestamp,
    text: String(input.content ?? '').slice(0, 1200)
  };
  const sections = Array.isArray(existing.sections) ? existing.sections.slice() : [];
  // 老数据（以及首次经 addMemory 建的行）没有 sections：先把现有正文补成第一段，
  // 否则第一次合并会把"原来读到的那一段"丢了。
  if (sections.length === 0 && String(existing.content ?? '').trim() !== '') {
    sections.push({
      tool: existing.source?.tool ?? null,
      from: Number.isFinite(existing.source?.progress?.from) ? existing.source.progress.from : null,
      to: Number.isFinite(existing.source?.progress?.to) ? existing.source.progress.to : null,
      at: Number(existing.occurredAt) || timestamp,
      text: String(existing.content).slice(0, 1200)
    });
  }
  const isDuplicate = sections.some(row => normalizeForSection(row.text) === normalizeForSection(section.text));
  if (!isDuplicate) sections.push(section);
  existing.sections = sections.slice(-OBSERVATION_SECTIONS_MAX);
  existing.reads = (Number(existing.reads) || 1) + 1;

  const prevProgress = existing.source?.progress ?? {};
  const nextProgress = { ...prevProgress, ...(input.source?.progress ?? {}) };
  existing.source = {
    ...existing.source,
    ...(input.source?.tool ? { tool: input.source.tool } : {}),
    progress: nextProgress
  };
  existing.progress = nextProgress;
  if (nextProgress.done === true) existing.done = true;
  // 内容只保留最新一段（去重命中时不动），全文都在 sections 里。
  if (!isDuplicate) existing.content = String(input.content ?? '').slice(0, 1200);
  existing.updatedAt = new Date(timestamp).toISOString();
  existing.lastReadAt = timestamp;

  return { ok: true, id: existing.id, existing: true, merged: 'observation-source', reads: existing.reads, done: Boolean(existing.done) };
}
