/**
 * 召回候选筛选与排序（T1b，隔离实现）。
 *
 * 依据：docs/V0.5.0-ALGORITHM-UPGRADE-DESIGN.md §4.4（唤醒度）、§1.5（排序）、§4.12.2（四态）。
 *
 * 三条边界：
 *   1. 纯函数：不读文件、不写 state、不改入参（调用方传进来的 memories 必须原样返回）。
 *   2. 不接管 cycleRecall：本模块只在 A/B harness 与测试里被调用。
 *   3. 四态语义只做"候选是否入选"的判断，不做持久化字段的写入——字段由后续任务的存储层负责。
 */

import { wakeability, wakeabilityFromEvidence } from './wakeability.js';
import { brainStrength, tokenSimilarity } from './brainmem.js';
import { normalizeStrategy, topicRelation, expandCue, expandedSimilarity } from './recall-strategies.js';
import { associationGate } from './assoc-gate.js';
import { poolStats, overlapProfile, specificityGate } from './recall-specificity.js';

const DAY = 86400000;

/**
 * 时间有效性四态（§4.12.2）。实现已迁到 `lib/validity.js`，这里只做转发，
 * 保证"存储层写字段"和"召回层判状态"用的是同一份判定，不会各写一套慢慢分叉。
 */
import { timeState } from './validity.js';
export { timeState };

/**
 * 按四态筛选。默认排除 superseded 与 expired；not_yet 单独返回（可被检索，但不得当成当前事实）。
 * 返回新数组，不修改入参。
 */
export function filterByTime(memories, { now = Date.now(), includeExpired = false, includeSuperseded = false } = {}) {
  const kept = [];
  const notYet = [];
  const dropped = [];
  for (const memory of memories) {
    const state = timeState(memory, now);
    if (state === 'superseded') {
      if (includeSuperseded) kept.push({ memory, state });
      else dropped.push({ id: memory.id, state });
      continue;
    }
    if (state === 'expired') {
      if (includeExpired) kept.push({ memory, state });
      else dropped.push({ id: memory.id, state });
      continue;
    }
    if (state === 'not_yet') {
      notYet.push({ memory, state, notYet: true });
      continue;
    }
    kept.push({ memory, state });
  }
  return { kept, notYet, dropped };
}

/**
 * B1 排序分（§4.4 排序式）：score = 0.55·sim + 0.45·(0.6·assoc + 0.4·S)。
 * sim/assoc/S 由调用方给出，本函数只做加权。
 */
export function rankScore({ sim = 0, assoc = 0, strength = 0 } = {}) {
  return 0.55 * sim + 0.45 * (0.6 * assoc + 0.4 * strength);
}

/**
 * B1 候选：四态筛选 → 唤醒度过滤 → 排序截断。
 *
 * @param {Array} memories 记忆数组（不修改）
 * @param {string} cue 查询文本
 * @param {object} options
 * @param {number} options.now
 * @param {number} options.limit 默认 6
 * @param {number} options.thetaWake 默认取 wakeability 的候选值
 * @param {Map<string,number>|object} options.assoc 记忆间关联权重（可选，缺省 0）
 * @param {'B0'|'B1'|'A'|'B'|'AB'} options.strategy 候选策略（默认 B1；B0 仅用于文档对齐，实际走 harness）
 * @param {object} options.strategyParams 覆盖 STRATEGY_PARAMS 的候选值（仅实验用）
 */
/**
 * 时间资格过滤的开关（默认关）。
 *
 * 只有显式设成 `'1'` 才开：V0.5.1 要求"隔离验证、默认关闭"，不允许因为升级
 * 就被动改变任何已有召回的结果。
 */
export function validityFilterEnabled(env = process.env) {
  return env?.DSH_BM_VALIDITY_FILTER === '1';
}

/**
 * 按四态裁剪候选池，供 B0 这类"没有内建时间过滤"的检索路径复用。
 *
 * 注意：这里只做**资格**判断，不做相关性判断，也不改分数。
 * `not_yet` 默认留在池子里（它是"已记录的信息"），由调用方决定是否标注为背景；
 * `expired` 与 `superseded` 默认移出。
 */
export function filterPoolByValidity(
  memories,
  { now = Date.now(), includeNotYet = true, includeExpired = false } = {},
) {
  const { kept, notYet, dropped } = filterByTime(memories, { now, includeExpired });
  const rows = includeNotYet ? [...kept, ...notYet] : kept;
  return {
    pool: rows.map(row => row.memory),
    notYetIds: notYet.map(row => row.memory.id),
    kept,
    notYet,
    dropped,
  };
}

/**
 * 时间有效 ≠ 查询相关：四态只回答"这条现在成不成立"，不参与排序。
 */
export function selectCandidates(
  memories,
  cue,
  {
    now = Date.now(),
    limit = 6,
    thetaWake,
    assoc = {},
    includeNotYet = false,
    strategy = 'B1',
    strategyParams,
    assocGate = false,
    assocEvidence = null,
    precisionFirst = false,
    precisionMaxSim = 0.30,
    precisionMinSim = 0.08,
  } = {},
) {
  const mode = normalizeStrategy(strategy);
  const filtered = filterByTime(memories, { now });
  const pool = includeNotYet ? [...filtered.kept, ...filtered.notYet] : filtered.kept;
  const expansion = mode === 'B' || mode === 'AB' ? expandCue(cue, strategyParams) : null;
  const gated = [];
  const scored = [];
  for (const entry of pool) {
    const memory = entry.memory;
    const assocValue = pickAssoc(assoc, memory.id);
    const text = `${memory.title ?? ''} ${memory.content ?? ''} ${memory.tags ?? ''}`;
    let result;
    let bonus = 0;
    let topic = null;

    if (mode === 'B1') {
      // 与 T1b 完全同一路径，保证 B1 数据可复现。
      result = wakeability(memory, cue, { now, assoc: assocValue, thetaWake });
    } else {
      const S = brainStrength(memory, now).strength;
      let sim = tokenSimilarity(cue, text);
      if (expansion) {
        const expanded = expandedSimilarity(cue, text, expansion);
        sim = expanded.sim;
        bonus = expanded.bonus;
      }
      result = wakeabilityFromEvidence({ sim, assoc: assocValue, S }, { thetaWake });

      if (mode === 'A' || mode === 'AB') {
        const relation = topicRelation(cue, memory);
        topic = relation.relation;
        if (relation.relation === 'conflict') {
          const penalty = Number(strategyParams?.topicPenalty ?? 0.35);
          const scaled = result.W * penalty;
          result = {
            ...result,
            W: scaled,
            eligible: scaled >= result.theta,
            reason: 'topic-conflict',
            topicConflict: { cue: relation.cue, memory: relation.memory, penalty },
          };
        }
      }
    }

    if (!result.eligible) continue;
    // 安全闸：靠关联进来的候选要单独过资格（见 lib/assoc-gate.js）。
    // 默认关闭，只有显式打开才生效——这样 T1b/T1c 已冻结的数字不会被静默改写。
    if (assocGate && result.assoc > 0) {
      const verdict = associationGate({
        sim: result.sim,
        assoc: result.assoc,
        strength: result.S,
        evidence: pickEvidence(assocEvidence, memory.id),
      });
      if (!verdict.allowed) {
        gated.push({ id: memory.id, reason: verdict.reason, W: result.W, S: result.S, sim: result.sim, assoc: result.assoc });
        continue;
      }
    }
    scored.push({
      id: memory.id,
      state: entry.state,
      notYet: Boolean(entry.notYet),
      W: result.W,
      sim: result.sim,
      assoc: result.assoc,
      strength: result.S,
      bonus,
      topic,
      reason: result.reason,
      score: rankScore({ sim: result.sim, assoc: result.assoc, strength: result.S }),
    });
  }
  scored.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
  let selected = scored.slice(0, Math.max(1, limit));
  let precision = null;
  if (precisionFirst && selected.length) {
    const maxSim = Math.max(...selected.map(entry => Number(entry.sim) || 0));
    if (selected.length === 1) {
      const stats = poolStats(memories);
      const memory = memories.find(entry => entry.id === selected[0].id);
      const profile = overlapProfile(cue, memory, stats);
      const verdict = specificityGate(profile, { enabled: true });
      if (!verdict.allowed) {
        precision = { action: 'abstain', maxSim, from: 1, to: 0, reason: verdict.reason };
        selected = [];
      }
    }
    if (selected.length >= 3 && maxSim < precisionMaxSim) {
      // 三条以上弱候选互不相让：不是“多给几个联想”，而是没有可靠答案，宁可空答。
      precision = { action: 'abstain', maxSim, from: selected.length, to: 0 };
      selected = [];
    } else if (selected.length === 2 && maxSim < precisionMaxSim) {
      // 两条弱候选可能是同一事件的两个版本（如更正前后）；保留最靠前一条，避免把旧版也当答案。
      precision = { action: 'truncate', maxSim, from: 2, to: 1 };
      selected = selected.slice(0, 1);
    } else if (selected.length === 1 && maxSim < precisionMinSim) {
      // 单候选也弱到没有可用的词面/关联证据时，宁可空答。
      precision = { action: 'abstain', maxSim, from: 1, to: 0 };
      selected = [];
    }
  }
  return {
    selected,
    dropped: filtered.dropped,
    gated,
    poolSize: pool.length,
    strategy: mode,
    precisionFirst: precision,
    expansion: expansion ? { matched: expansion.matched, added: expansion.added } : null,
  };
}

/** 这条记忆背后的独立经历数（缺省 1：没有来源标注就只能算一次）。 */
function pickEvidence(source, id) {
  if (!source) return 1;
  const value = source instanceof Map ? source.get(id) : source[id];
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? count : 1;
}

function pickAssoc(assoc, id) {
  if (!assoc) return 0;
  if (assoc instanceof Map) return Number(assoc.get(id)) || 0;
  return Number(assoc[id]) || 0;
}

/** 便捷：只返回入选 id 列表，供 harness 与测试比较。 */
export function selectedIds(memories, cue, options = {}) {
  return selectCandidates(memories, cue, options).selected.map(item => item.id);
}
