/**
 * 关联图（伴生图）——纯函数层，不做 I/O。
 *
 * 依据：`docs/V0.5.0-ALGORITHM-UPGRADE-DESIGN.md` §4.3。
 *
 * 图里只有 id 与数，不含记忆内容、不生成新事实、不参与事实判定。
 * 真源是 append-only 的 `assoc-events.jsonl`；`associations.json` 只是可删可重建的缓存。
 *
 * 事件形状（设计 §4.3 规定的 `{t, kind, ids[], w?}`）：
 *   { t: 毫秒时间戳, kind: 'co-tag' | 'co-recall' | 'co-cite', ids: [id, id, ...], w?: number }
 *   - 一个事件表示"这些 id 在同一轮里一起出现"，组内两两建边（不建自环）。
 *   - `w` 是可选的事件观察权重（0..1），缺省 1；乘在 η 上，用于"弱证据"降权。
 *
 * 边权更新（同一对 id，Δt 为距上次该边更新的天数）：
 *   w ← clip( w·exp(-Δt/τ) + η_kind·(1 − w), 0, 1 )
 *   τ = 30 天（**指数衰减时间常数，不是半衰期**；半衰期 = τ·ln2 ≈ 20.8 天。
 *   写"半衰期 30 天"会把实际衰减速度算慢约 1.44 倍，这里统一按 τ 表述）
 *   η: co-tag 0.30 / co-recall 0.15 / co-cite 0.30
 *
 * 为什么 co-tag 的 η 是 0.30：设计里写"同标签共现 初始 w=0.30"，而"同一轮共同召回 +0.15、
 * 共同引用 +0.30"。把一个从未出现过的边当作 w=0 代入上式，首次事件的结果正好是 η，所以
 * 三个 η 与设计里的三个增量一一对应，不需要另立"初始值"规则。
 *
 * 读时过滤（不写删）：w < 0.05 的边不参与展开；每节点保留 top-8；总边 ≤ 2N。
 */

export const ASSOC_SCHEMA = 1;
/** 指数衰减时间常数（天）：w(Δt) = w₀·e^(−Δt/τ)。不是半衰期。 */
export const TAU_DAYS = 30;
export const MIN_EDGE_WEIGHT = 0.05;
export const MAX_DEGREE = 8;
export const EDGE_BUDGET_FACTOR = 2;
export const EVENT_KINDS = Object.freeze(['co-tag', 'co-recall', 'co-cite', 'co-experience']);

export const ETA = Object.freeze({
  'co-tag': 0.30,
  'co-recall': 0.15,
  'co-cite': 0.30,
  // 同一次真实经历里产生的多条记忆：比标签共现强，但弱于明确引用。
  'co-experience': 0.35,
});

const DAY_MS = 86_400_000;

const clip01 = value => (value < 0 ? 0 : value > 1 ? 1 : value);
const round6 = value => Math.round(value * 1e6) / 1e6;

/** 边的规范键：端点排序后拼接，保证 (a,b) 与 (b,a) 是同一条边。 */
export function edgeKey(a, b) {
  return String(a) <= String(b) ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

const MAX_EPS = 8;

function normalizeEdge(a, b, w, at, kind, eps = null) {
  const [first, second] = String(a) <= String(b) ? [a, b] : [b, a];
  const edge = { a: String(first), b: String(second), w: round6(clip01(w)), at, kind };
  // `eps` 是这条边背后的**独立经历编号**（去重、有序、封顶 8 条）。它不参与权重计算，
  // 只用于回答"这条边有几段互不相同的经历作证"——一次共现是巧合，两次才是模式。
  // 没有 ep 的旧事件不写这个字段，缓存格式因此对旧数据保持逐字节不变。
  if (Array.isArray(eps) && eps.length) edge.eps = eps;
  return edge;
}

function mergeEps(previous, ep) {
  if (!ep) return previous && Array.isArray(previous.eps) ? [...previous.eps] : null;
  const next = new Set(Array.isArray(previous?.eps) ? previous.eps : []);
  next.add(ep);
  return [...next].sort().slice(0, MAX_EPS);
}

/** 空图。`edges` 用 Map 以便更新；序列化时才转数组。 */
export function emptyGraph() {
  return new Map();
}

export function cloneGraph(graph) {
  const next = new Map();
  for (const [key, edge] of graph) next.set(key, { ...edge });
  return next;
}

/**
 * 校验一条事件。返回 `{ ok: true, event }` 或 `{ ok: false, reason }`。
 * 不做任何"修复"——非法事件必须被丢弃并留痕，不能猜。
 */
export function validateEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'not-an-object' };
  if (!Number.isFinite(raw.t)) return { ok: false, reason: 'bad-t' };
  if (!EVENT_KINDS.includes(raw.kind)) return { ok: false, reason: 'unknown-kind' };
  if (!Array.isArray(raw.ids)) return { ok: false, reason: 'bad-ids' };
  if (raw.ids.length < 2) return { ok: false, reason: 'too-few-ids' };
  if (raw.ids.length > 32) return { ok: false, reason: 'too-many-ids' };
  const ids = raw.ids.map(id => (typeof id === 'string' || typeof id === 'number' ? String(id) : ''));
  if (ids.some(id => !id)) return { ok: false, reason: 'bad-id' };
  if (new Set(ids).size !== ids.length) return { ok: false, reason: 'duplicate-ids' };
  let w = 1;
  if (raw.w !== undefined) {
    if (!Number.isFinite(raw.w) || raw.w < 0 || raw.w > 1) return { ok: false, reason: 'bad-w' };
    w = raw.w;
  }
  const event = { t: raw.t, kind: raw.kind, ids, w };
  // `ep` 是**经历编号**（provenance），用于防重复：同一次共同回忆无论被系统自动返回多少次，
  // 都只应写一条事件。它是可选的，缺省表示"来源未标注"，此时无法去重。
  if (raw.ep !== undefined) {
    if (typeof raw.ep !== 'string' || !raw.ep.trim() || raw.ep.length > 64) return { ok: false, reason: 'bad-ep' };
    event.ep = raw.ep;
  }
  return { ok: true, event };
}

/**
 * 把一条事件作用到图上（原地修改并返回图）。
 *
 * 组内两两建边：n 个 id → n(n-1)/2 条边。n 由 `validateEvent` 限到 32，最多 496 条，
 * 所以不需要额外的组合爆炸保护。
 */
export function applyEvent(graph, event) {
  const eta = ETA[event.kind];
  if (eta === undefined) throw new Error(`unknown event kind: ${event.kind}`);
  const observation = event.w === undefined ? 1 : event.w;

  for (let i = 0; i < event.ids.length; i += 1) {
    for (let j = i + 1; j < event.ids.length; j += 1) {
      const key = edgeKey(event.ids[i], event.ids[j]);
      const previous = graph.get(key);
      const dtDays = previous && Number.isFinite(previous.at) ? Math.max(0, (event.t - previous.at) / DAY_MS) : 0;
      const decayed = previous ? previous.w * Math.exp(-dtDays / TAU_DAYS) : 0;
      const next = clip01(decayed + eta * observation * (1 - decayed));
      // `kind` 记"最近一次增强它的证据类型"，用于诊断，不参与权重计算。
      graph.set(key, normalizeEdge(event.ids[i], event.ids[j], next, event.t, event.kind, mergeEps(previous, event.ep)));
    }
  }
  return graph;
}

/**
 * 重放事件序列。
 *
 * 顺序：先按 `t` 升序，`t` 相同保持输入顺序（Array.prototype.sort 在 V8 上是稳定排序）。
 * 同一批事件换顺序若 `t` 不同，结果会不同——这是有意的：时间是不可交换的。
 */
export function buildGraph(events) {
  const graph = emptyGraph();
  const ordered = events
    .map((event, index) => ({ event, index }))
    .sort((left, right) => left.event.t - right.event.t || left.index - right.index);
  for (const { event } of ordered) applyEvent(graph, event);
  return graph;
}

/**
 * 读时有效关联强度。
 *
 * 重放阶段只在"有新事件到来"时对旧边做一次衰减，所以一条 25 天前写下的 co-cite 边
 * 会永远停在 0.30——它早就该淡了，但没有任何东西来扣它。这个函数补上"从最后一次
 * 更新到现在"的那段衰减，**只用于读**：不写事件日志、不改缓存文件。
 *
 * 两条约束：
 *   1. 不重复计算：重放衰减算的是「上次更新 → 本次事件」，这里算的是「上次更新 → now」，
 *      两段首尾相接、不重叠。
 *   2. `now` 早于 `at`（时钟回拨/未来事件）不放大权重，按未衰减处理。
 */
export function effectiveWeight(edge, now, tauDays = TAU_DAYS) {
  if (!edge || !Number.isFinite(edge.w)) return 0;
  if (!Number.isFinite(now) || !Number.isFinite(edge.at)) return edge.w;
  const dtDays = (now - edge.at) / DAY_MS;
  if (!(dtDays > 0)) return edge.w;
  return clip01(edge.w * Math.exp(-dtDays / (tauDays > 0 ? tauDays : TAU_DAYS)));
}

/** 读时过滤 + 度上限 + 总量上限。全部确定性排序，结果只取决于边集本身。
 *  给了 `now` 时按**有效权重**（含读时衰减）过滤与排序，但返回的边仍保存落盘权重。 */
export function pruneGraph(graph, { minWeight = MIN_EDGE_WEIGHT, maxDegree = MAX_DEGREE, edgeFactor = EDGE_BUDGET_FACTOR, now } = {}) {
  const useNow = Number.isFinite(now);
  const live = [];
  for (const edge of graph.values()) {
    const weight = useNow ? effectiveWeight(edge, now) : edge.w;
    if (weight >= minWeight) live.push({ edge, weight });
  }
  const nodes = new Set();
  for (const { edge } of live) {
    nodes.add(edge.a);
    nodes.add(edge.b);
  }
  const edgeBudget = Math.max(0, edgeFactor * nodes.size);

  const ranked = live.sort(
    (left, right) =>
      right.weight - left.weight ||
      (left.edge.a < right.edge.a ? -1 : left.edge.a > right.edge.a ? 1 : 0) ||
      (left.edge.b < right.edge.b ? -1 : left.edge.b > right.edge.b ? 1 : 0),
  );

  const degree = new Map();
  const kept = new Map();
  for (const { edge } of ranked) {
    if (kept.size >= edgeBudget) break;
    const da = degree.get(edge.a) ?? 0;
    const db = degree.get(edge.b) ?? 0;
    if (da >= maxDegree || db >= maxDegree) continue;
    kept.set(edgeKey(edge.a, edge.b), normalizeEdge(edge.a, edge.b, edge.w, edge.at, edge.kind, edge.eps));
    degree.set(edge.a, da + 1);
    degree.set(edge.b, db + 1);
  }
  return kept;
}

/**
 * 规范化序列化：边按 (a,b) 排序，键顺序固定，权重保留 6 位小数。
 * 同一事件序列重放两次，输出必须逐字节相等——单测据此断言"可重建"。
 */
export function serializeGraph(graph, meta = null) {
  const edges = [...graph.values()]
    .sort((left, right) => (left.a < right.a ? -1 : left.a > right.a ? 1 : 0) || (left.b < right.b ? -1 : left.b > right.b ? 1 : 0))
    .map(edge => {
      const body = { a: edge.a, b: edge.b, w: round6(edge.w), at: edge.at, kind: edge.kind };
      if (Array.isArray(edge.eps) && edge.eps.length) body.eps = [...edge.eps].sort();
      return body;
    });
  const body = meta ? { version: ASSOC_SCHEMA, edges, meta } : { version: ASSOC_SCHEMA, edges };
  return `${JSON.stringify(body)}\n`;
}

/**
 * 解析缓存文件并保留 `meta`。
 *
 * `meta` 记录"这份缓存是怎么来的"：正常重放（`degraded:false`）还是**部分重放**
 * （事件日志有坏行，`degraded:true` + 坏行号）。缓存本身可以逐字节重建，
 * 但"这份缓存是残缺日志的产物"这件事必须留在文件里，否则下次读到 `source:'cache'`
 * 就再也看不出降级历史。
 */
export function parseGraphDocument(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || parsed.version !== ASSOC_SCHEMA || !Array.isArray(parsed.edges)) return null;
  const graph = emptyGraph();
  for (const edge of parsed.edges) {
    if (!edge || typeof edge.a !== 'string' || typeof edge.b !== 'string') return null;
    if (!Number.isFinite(edge.w) || !Number.isFinite(edge.at)) return null;
    if (edge.a === edge.b) return null;
    if (!EVENT_KINDS.includes(edge.kind)) return null;
    const eps = Array.isArray(edge.eps) ? [...new Set(edge.eps.filter(ep => typeof ep === 'string' && ep))].sort().slice(0, MAX_EPS) : null;
    graph.set(edgeKey(edge.a, edge.b), normalizeEdge(edge.a, edge.b, edge.w, edge.at, edge.kind, eps));
  }
  const meta = parsed.meta && typeof parsed.meta === 'object' && !Array.isArray(parsed.meta) ? parsed.meta : null;
  return { graph, meta };
}

/** 解析缓存文件（只要图）。任何结构性问题都返回 `null`（调用方据此回退到事件重放）。 */
export function parseGraph(text) {
  return parseGraphDocument(text)?.graph ?? null;
}

/**
 * 结构自检：无自环、无重复、无悬空（`knownIds` 给出时）、度上限、总量上限。
 * 返回问题列表，空数组表示健康。
 */
export function lintGraph(graph, { knownIds = null, maxDegree = MAX_DEGREE, edgeFactor = EDGE_BUDGET_FACTOR } = {}) {
  const problems = [];
  const degree = new Map();
  const seen = new Set();
  for (const [key, edge] of graph) {
    if (edge.a === edge.b) problems.push({ code: 'self-loop', edge: key });
    if (seen.has(key)) problems.push({ code: 'duplicate-edge', edge: key });
    seen.add(key);
    if (knownIds) {
      if (!knownIds.has(edge.a)) problems.push({ code: 'dangling', edge: key, missing: edge.a });
      if (!knownIds.has(edge.b)) problems.push({ code: 'dangling', edge: key, missing: edge.b });
    }
    if (edge.w < 0 || edge.w > 1) problems.push({ code: 'weight-out-of-range', edge: key, w: edge.w });
    degree.set(edge.a, (degree.get(edge.a) ?? 0) + 1);
    degree.set(edge.b, (degree.get(edge.b) ?? 0) + 1);
  }
  for (const [id, count] of degree) {
    if (count > maxDegree) problems.push({ code: 'degree-overflow', id, degree: count });
  }
  const nodes = degree.size;
  if (graph.size > edgeFactor * nodes) problems.push({ code: 'edge-budget-exceeded', edges: graph.size, nodes });
  return problems;
}

export function graphStats(graph) {
  const degree = new Map();
  let weightSum = 0;
  for (const edge of graph.values()) {
    weightSum += edge.w;
    degree.set(edge.a, (degree.get(edge.a) ?? 0) + 1);
    degree.set(edge.b, (degree.get(edge.b) ?? 0) + 1);
  }
  const degrees = [...degree.values()];
  return {
    nodes: degree.size,
    edges: graph.size,
    avgDegree: degrees.length ? round6((degrees.reduce((sum, value) => sum + value, 0)) / degrees.length) : 0,
    maxDegree: degrees.length ? Math.max(...degrees) : 0,
    avgWeight: graph.size ? round6(weightSum / graph.size) : 0,
  };
}

/**
 * 从种子沿边展开（1–2 跳）。种子只能来自"当次查询的字面命中"，
 * **禁止**用金标 id 或测试标签当种子。
 *
 * 返回值按 `score` 降序、`id` 升序排列，保证确定性：
 *   score = 边权 × 0.5^(hop-1)   （同一 id 取所有路径里的最大值）
 * `via` 记录用的哪条边、第几跳、什么证据类型，便于诊断"这条是怎么被想起的"。
 */
export function expandSeeds(graph, seedIds, { maxHops = 2, hopDecay = 0.5, minWeight = MIN_EDGE_WEIGHT, now } = {}) {
  const useNow = Number.isFinite(now);
  const frontier = new Set(seedIds.map(String));
  const best = new Map();
  let current = [...frontier];
  for (let hop = 1; hop <= maxHops; hop += 1) {
    const next = [];
    for (const id of current) {
      for (const edge of graph.values()) {
        const weight = useNow ? effectiveWeight(edge, now) : edge.w;
        if (weight < minWeight) continue;
        let other = null;
        if (edge.a === id) other = edge.b;
        else if (edge.b === id) other = edge.a;
        if (!other) continue;
        if (frontier.has(other)) continue;
        const score = round6(weight * hopDecay ** (hop - 1));
        const previous = best.get(other);
        if (!previous || score > previous.score) {
          best.set(other, {
            id: other,
            score,
            hop,
            via: id,
            kind: edge.kind,
            weight: round6(weight),
            evidence: Array.isArray(edge.eps) ? edge.eps.length : 1,
          });
          next.push(other);
        }
      }
    }
    for (const id of next) frontier.add(id);
    current = next;
    if (!current.length) break;
  }
  return [...best.values()].sort(
    (left, right) => right.score - left.score || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );
}
