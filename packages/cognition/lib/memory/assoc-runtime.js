// P5 关联运行时：只把“可追溯的真实经历”写成关联事件，检索时再按证据过闸。
//
// 三条边界（与 P5 指令对齐）：
//   1. 共同召回（co-recall）不是证据，本模块不产生；只写 co-experience / co-cite。
//   2. 重复处理同一次经历按 ep 去重，不重复强化同一条边。
//   3. 展开结果必须过 associationGate；单条弱证据不能仅凭边把记忆拉进上下文。
import { buildCoCiteEvent, stableEpisodeId } from './assoc-collect.js';
import { expandSeeds } from './associations.js';
import { associationGate } from './assoc-gate.js';
import { brainStrength } from './brainmem.js';

const RUNTIME_REASONS = Object.freeze({
  disabled: 'disabled',
  noEdges: 'no-edges',
  noSeeds: 'no-seeds',
  expanded: 'graph-expanded',
});

function edgeMap(doc) {
  if (!doc) return null;
  if (doc instanceof Map) return doc;
  if (doc.graph instanceof Map) return doc.graph;
  return doc.edges instanceof Map ? doc.edges : null;
}

export function createAssociationRuntime({
  store,
  clock = () => Date.now(),
  logger = console,
  maxHops = 1,
  hopDecay = 0.5,
  maxExpanded = 3,
} = {}) {
  if (!store) throw new Error('createAssociationRuntime: 缺少 store');
  let cached = null;

  function document() {
    if (!cached) cached = store.loadAssociationGraph();
    return cached;
  }

  function refresh() {
    cached = store.loadAssociationGraph();
    return cached;
  }

  function graph() {
    return edgeMap(document());
  }

  async function recordExperience({ episodeId, memoryIds = [], at = null } = {}) {
    const ids = [...new Set(memoryIds.map(String).filter(Boolean))];
    const ep = stableEpisodeId(episodeId);
    if (ids.length < 2) return { ok: false, reason: 'insufficient-ids' };
    if (!ep) return { ok: false, reason: 'missing-ep' };
    const result = await store.appendAssociationEvent({
      t: Number.isFinite(at) ? at : clock(),
      kind: 'co-experience',
      ids,
      ep,
    });
    if (result.ok) cached = null;
    return result;
  }

  async function recordCites({ ownerId, memoryIds = [], sourceEventId, at = null } = {}) {
    const built = buildCoCiteEvent({
      ownerId,
      cites: memoryIds,
      sourceEventId,
      t: Number.isFinite(at) ? at : clock(),
      known: new Set(store.memory.memories.map(row => row.id)),
    });
    if (!built.event) return { ok: false, reason: built.reason, dropped: built.dropped };
    const result = await store.appendAssociationEvent(built.event);
    if (result.ok) cached = null;
    return { ...result, dropped: built.dropped };
  }

  function expand({ memories = [], seedIds = [], baseIds = new Set(), now, limit = maxExpanded } = {}) {
    const edges = graph();
    if (!edges || edges.size === 0) return { items: [], reason: RUNTIME_REASONS.noEdges, reached: 0 };
    const seeds = [...new Set(seedIds.map(String).filter(Boolean))].slice(0, 3);
    if (seeds.length === 0) return { items: [], reason: RUNTIME_REASONS.noSeeds, reached: 0 };
    const reached = expandSeeds(edges, seeds, { maxHops, hopDecay, now });
    const byId = new Map(memories.map(row => [row.id, row]));
    const items = [];
    let gatedOut = 0;
    for (const candidate of reached) {
      if (baseIds.has(candidate.id)) continue;
      const memory = byId.get(candidate.id);
      if (!memory) continue;
      const { strength } = brainStrength(memory, now);
      const gate = associationGate({
        sim: 0,
        assoc: candidate.score,
        strength,
        evidence: candidate.evidence,
      });
      if (!gate.allowed) {
        gatedOut += 1;
        continue;
      }
      items.push({
        id: memory.id,
        kind: memory.kind,
        layer: memory.layer,
        title: memory.title,
        score: Number((candidate.score * 0.5).toFixed(4)),
        lexical: 0,
        recency: 0,
        importance: Number(memory.importance ?? 0),
        drive: 0,
        notYet: false,
        state: 'association',
        topic: null,
        reason: `association:${gate.reason}`,
        association: {
          score: candidate.score,
          hop: candidate.hop,
          via: candidate.via,
          kind: candidate.kind,
          evidence: candidate.evidence,
        },
      });
      if (items.length >= limit) break;
    }
    return {
      items,
      reason: items.length > 0 ? RUNTIME_REASONS.expanded : 'all-gated',
      seeds,
      reached: reached.length,
      gatedOut,
    };
  }

  // 被动注入 ≠ 被使用。
  //
  // 线上实测：247/610 条被召回过，前 20 条吃掉 34.3% 的召回次数（最高 33 次），
  // 而它们恰好是「执行发送」这类模板条目——因为旧实现把"进了召回列表"就记成"用过了"，
  // 于是 lastRecalledAt 被注入行为自己刷新 → 条目永远年轻 → 更容易再被注入（热点自我强化）。
  //
  // 现在拆成两个语义：
  //   markInjected：只记"进过上下文"，写 lastInjectedAt / injectCount，不碰 recallCount / lastRecalledAt；
  //   markUsed：只由模型显式引用（decision 里的 memoryIds）触发，才推进使用痕迹。
  function markInjected(memoryIds = [], eventId, now = clock()) {
    if (!eventId) return 0;
    const wanted = new Set(memoryIds.map(String));
    let changed = 0;
    for (const row of store.memory.memories) {
      if (!wanted.has(row.id)) continue;
      if (row.lastInjectedEventId === eventId) continue;
      row.injectCount = Number(row.injectCount ?? 0) + 1;
      row.lastInjectedAt = now;
      row.lastInjectedEventId = eventId;
      changed += 1;
    }
    return changed;
  }

  // 只有"被真正使用"才推进使用痕迹；按 eventId 幂等。
  function markUsed(memoryIds = [], eventId, now = clock()) {
    if (!eventId) return 0;
    const wanted = new Set(memoryIds.map(String));
    let changed = 0;
    for (const row of store.memory.memories) {
      if (!wanted.has(row.id)) continue;
      if (row.lastUsedEventId === eventId) continue;
      row.recallCount = Number(row.recallCount ?? 0) + 1;
      row.lastRecalledAt = now;
      row.lastUsedEventId = eventId;
      changed += 1;
    }
    return changed;
  }

  return {
    recordExperience,
    recordCites,
    expand,
    markInjected,
    markUsed,
    refresh,
    graph,
    stats() {
      const doc = document();
      const edges = edgeMap(doc);
      return {
        edges: edges?.size ?? 0,
        source: doc?.source ?? 'unknown',
        degraded: Array.isArray(doc?.degraded) ? doc.degraded.length > 0 : Boolean(doc?.degraded),
      };
    },
  };
}
