// P6 反思管线：积累真实经历 → 真实模型生成有证据的 insight → 暂存校验 → 单写者提交。
// 只读 experience/ 原始经历做证据；insight 不能给自己当证据；失败不推进水位。

import { createHash } from 'node:crypto';
import { applyReflectionTendency } from './traits.js';
import { mergeSpeakHabits } from './speak-habits.js';
import { appendDormantTraits } from '../state/dormant-traits.js';
import { collapseLabelPrefix } from '../memory/text-util.js';

export const REFLECTION_DEFAULTS = Object.freeze({
  minImportance: 4,
  minEpisodes: 2,
  delayMs: 45_000,
  maxAttempts: 3,
  maxBatch: 6,
  maxInsights: 3
});

export function blankReflection() {
  return {
    lastAt: null,
    processed: [],
    runs: 0,
    committed: 0,
    noops: 0,
    failures: 0,
    calls: 0,
    staging: null,
    batch: null,
    attempts: {},
    lastError: null
  };
}

export function normalizeReflection(value) {
  const base = blankReflection();
  if (!value || typeof value !== 'object') return base;
  const attempts = value.attempts && typeof value.attempts === 'object' ? value.attempts : {};
  return {
    ...base,
    lastAt: Number.isFinite(Number(value.lastAt)) ? Number(value.lastAt) : null,
    processed: (Array.isArray(value.processed) ? value.processed : []).filter(id => typeof id === 'string').slice(-500),
    runs: Number(value.runs) || 0,
    committed: Number(value.committed) || 0,
    noops: Number(value.noops) || 0,
    failures: Number(value.failures) || 0,
    calls: Number(value.calls) || 0,
    staging: value.staging && typeof value.staging === 'object' ? value.staging : null,
    batch: normalizeBatch(value.batch),
    attempts: Object.fromEntries(
      Object.entries(attempts)
        .filter(([key, count]) => typeof key === 'string' && Number.isFinite(Number(count)))
        .slice(-50)
    ),
    lastError: typeof value.lastError === 'string' ? value.lastError : null
  };
}

function normalizeBatch(value) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string') return null;
  const expected = Array.isArray(value.expected)
    ? value.expected
        .filter(row => row && typeof row.id === 'string')
        .map(row => ({ id: row.id, hash: String(row.hash ?? ''), title: String(row.title ?? '').slice(0, 80) }))
        .slice(0, 8)
    : [];
  const status = ['generating', 'data-written', 'committed', 'failed'].includes(value.status) ? value.status : 'failed';
  return {
    id: value.id,
    status,
    at: Number(value.at) || 0,
    episodes: (Array.isArray(value.episodes) ? value.episodes : []).filter(id => typeof id === 'string').slice(0, 8),
    expected,
    tendencies: Array.isArray(value.tendencies) ? value.tendencies.slice(0, 2) : [],
    speakHabits: Array.isArray(value.speakHabits) ? value.speakHabits.slice(0, 1) : [],
    error: typeof value.error === 'string' ? value.error.slice(0, 200) : null
  };
}

function insightHash(insight) {
  return createHash('sha1').update(`${insight.title}\n${insight.content}`).digest('hex').slice(0, 16);
}

function normalizeEvidence(value, rawIds, batchIds, batchRawIds, rawOf) {
  const list = Array.isArray(value) ? value : [];
  const evidence = [...new Set(list.map(item => String(item ?? '').trim()).filter(Boolean))];
  // 允许模型引用 episode id 或原始事件 id；两者都必须在 experience 里找得到原文。
  const invalid = evidence.filter(id => !rawIds.has(id) && !rawIds.has(rawOf.get(id)));
  if (invalid.length > 0) return { invalid, evidence: [], rawEventIds: [] };
  const fresh = evidence.filter(id => batchIds.has(id) || batchRawIds.has(id));
  if (fresh.length === 0) return { invalid: ['no-batch-evidence'], evidence: [], rawEventIds: [] };
  const rawEventIds = evidence.map(id => (batchIds.has(id) ? rawOf.get(id) : id)).filter(Boolean);
  return { invalid: [], evidence, rawEventIds };
}

export function batchIdOf(episodeIds) {
  return `batch:${createHash('sha1').update(episodeIds.join('|')).digest('hex').slice(0, 16)}`;
}

const SELF_ACTION = /(我|自己).{0,12}(问过|问了一句|说过|回答过|回复过|告诉过|提过|发过|找过|提醒过)/;

/**
 * 证据 ID 有效，不等于内容每一句都被证据支持。
 * 这里只做确定性审查：识别“我自己问过/说过/回复过”类自述；若 cited 原始事件里没有
 * 行动/回执类记录，则标记为未验证自述，禁止进入 P7 人格演化。
 */
export function auditInsightContent(insight, experience = []) {
  const text = `${insight?.title ?? ''} ${insight?.content ?? ''}`;
  const selfAction = SELF_ACTION.test(text);
  const cited = new Set(insight?.rawEventIds ?? []);
  const actionEvidence = experience.some(record => {
    const event = record?.event;
    if (!event || !cited.has(event.id)) return false;
    return event.type === 'tool-result'
      || event.type === 'tool-call'
      || event.actor?.kind === 'self'
      || event.payload?.source === 'self';
  });
  if (!selfAction) return { selfActionClaims: false, actionEvidence, support: 'grounded' };
  return {
    selfActionClaims: true,
    actionEvidence,
    support: actionEvidence ? 'grounded' : 'unverified-self-narrative'
  };
}

function normalizeInsights(raw, rawIds, batchIds, batchRawIds, maxInsights, rawOf) {
  const list = Array.isArray(raw?.insights) ? raw.insights : [];
  const accepted = [];
  const rejected = [];
  for (const item of list) {
    const title = String(item?.title ?? '').trim().slice(0, 80);
    const content = String(item?.content ?? '').trim().slice(0, 500);
    if (!title || !content) {
      rejected.push({ title, reason: 'empty' });
      continue;
    }
    const checked = normalizeEvidence(item?.evidence, rawIds, batchIds, batchRawIds, rawOf);
    if (checked.invalid.length > 0) {
      rejected.push({ title, reason: checked.invalid.join(',') });
      continue;
    }
    accepted.push({
      title,
      content,
      evidence: checked.evidence,
      rawEventIds: checked.rawEventIds,
      confidence: Math.max(0, Math.min(1, Number(item?.confidence) || 0.5))
    });
    if (accepted.length >= maxInsights) break;
  }
  return { accepted, rejected };
}

export function createReflector({
  reflectTurn,
  store,
  clock = () => Date.now(),
  minImportance = REFLECTION_DEFAULTS.minImportance,
  minEpisodes = REFLECTION_DEFAULTS.minEpisodes,
  delayMs = REFLECTION_DEFAULTS.delayMs,
  maxAttempts = REFLECTION_DEFAULTS.maxAttempts,
  onCommitted = null,
  maxBatch = REFLECTION_DEFAULTS.maxBatch,
  maxInsights = REFLECTION_DEFAULTS.maxInsights,
  logger = console
} = {}) {
  if (!store) throw new Error('createReflector: 缺少 store');
  let running = false;
  let timer = null;
  let disposed = false;

  const state = () => {
    if (!store.memory.reflection) store.memory.reflection = blankReflection();
    return store.memory.reflection;
  };

  function importanceOf(episode) {
    const rows = (store.memory.memories ?? []).filter(row => row?.source?.episodeId === episode.id);
    if (rows.length === 0) return 1;
    return rows.reduce((sum, row) => {
      const value = Number(row.importance);
      return sum + (Number.isFinite(value) ? Math.max(1, Math.min(5, value)) : 2);
    }, 0);
  }

  async function fail(kind, batch, detail, calls) {
    const now = clock();
    await store.saveMemory(memory => {
      const reflection = memory.reflection ?? (memory.reflection = blankReflection());
      reflection.runs += 1;
      reflection.calls += calls;
      reflection.failures += 1;
      reflection.lastError = `${kind}${detail ? `:${String(detail).slice(0, 120)}` : ''}`;
      reflection.lastAt = now;
      const key = batch.map(item => item.id).join('|');
      reflection.attempts[key] = (reflection.attempts[key] ?? 0) + 1;
      reflection.staging = { at: now, batch: batch.map(item => item.id), status: 'failed', error: reflection.lastError };
    });
    await store.appendActivity({ at: now, kind: 'reflection-failed', reason: kind, batch: batch.map(item => item.id), detail: String(detail ?? '').slice(0, 200) });
    return { status: 'failed', reason: kind, batch: batch.length, calls };
  }

  // 读取门禁：只有 committed 的 insight 才能进入正式认知上下文。
  function committedInsights() {
    return (store.memory.memories ?? []).filter(row => row?.kind === 'insight' && row?.status !== 'staged');
  }

  async function markBatchFailed(pending, reason) {
    const now = clock();
    await store.saveMemory(memory => {
      const stateNow = memory.reflection ?? (memory.reflection = blankReflection());
      stateNow.batch = {
        id: pending.id,
        status: 'failed',
        at: now,
        episodes: pending.episodes,
        expected: pending.expected,
        error: reason
      };
      stateNow.failures += 1;
      stateNow.lastError = reason;
      stateNow.lastAt = now;
      const key = pending.episodes.join('|');
      stateNow.attempts[key] = (stateNow.attempts[key] ?? 0) + 1;
      // 未提交的 staged 行永远不可见；失败后清理，避免残留。
      memory.memories = (memory.memories ?? []).filter(
        row => !(row?.kind === 'insight' && row?.source?.batchId === pending.id && row?.status === 'staged')
      );
    });
    await store.appendActivity({
      at: now,
      kind: 'reflection-failed',
      reason: reason,
      batchId: pending.id,
      batch: pending.episodes,
      expected: pending.expected.length
    });
  }

  // 倾向写入：正常提交、无新理解、崩溃恢复三条路径共用同一套逻辑。
  // polarity='counter' 表示这段经历反证了某条已有倾向：只能指向已有/近义标签，
  // 对不上就丢弃——反证不许凭空造出一条倾向。
  // allowedEvidence：本批允许引用的证据 id；不在里面的（幻觉 id）过滤掉，没有剩证据就不写。
  async function applySpeakHabits(list, { now = clock(), allowedEvidence = null } = {}) {
    if (!Array.isArray(list) || list.length === 0) return [];
    try {
      let applied = [];
      await store.saveSelf(self => {
        const result = mergeSpeakHabits(self.speakHabits ?? [], list, { now, allowedEvidence });
        self.speakHabits = result.items;
        applied = result.applied;
      });
      return applied;
    } catch (error) {
      logger?.warn?.('[cognition] 说话习惯写入失败', { error: error?.message });
      return [];
    }
  }

  async function applyTendencies(tendencies, { now = clock(), phase = 'normal', allowedEvidence = null } = {}) {
    const list = Array.isArray(tendencies) ? tendencies.slice(0, 2) : [];
    if (list.length === 0) return [];
    const applied = [];
    const skipped = [];
    const evicted = [];
    try {
      await store.saveBehavior(behavior => {
        const before = Array.isArray(behavior.personality?.items) ? behavior.personality.items.length : 0;
        let personality = behavior.personality;
        for (const candidate of list) {
          const label = String(candidate?.label ?? '').trim();
          const polarity = String(candidate?.polarity ?? '').toLowerCase() === 'counter' ? 'counter' : 'support';
          const evidence = Array.isArray(candidate?.evidence)
            ? candidate.evidence.filter(id => typeof id === 'string' && (!allowedEvidence || allowedEvidence.has(id)))
            : [];
          if (evidence.length === 0) {
            skipped.push({ label: label || null, polarity, reason: 'no-evidence' });
            continue;
          }
          const result = applyReflectionTendency(personality, { ...candidate, evidence }, { now, polarity });
          if (!result.changed) {
            skipped.push({ label: label || null, polarity, reason: result.reason ?? 'unchanged' });
            continue;
          }
          personality = result.personality;
          if (Array.isArray(result.evicted) && result.evicted.length > 0) evicted.push(...result.evicted);
          applied.push({
            label: result.item?.label ?? label,
            polarity,
            status: result.item?.status ?? null,
            confidence: result.item?.confidence ?? null,
            ...(result.mergedInto ? { mergedInto: result.mergedInto } : {})
          });
        }
        // 兜底：写回前确认没有条目凭空消失。被挤出活跃池的会沉底，所以计入总量。
        const after = Array.isArray(personality?.items) ? personality.items.length : 0;
        if (after + evicted.length < before) throw new Error(`tendency-count-drop:${before}->${after}+${evicted.length}`);
        behavior.personality = personality;
      });
    } catch (error) {
      logger?.warn?.('[cognition] 倾向写入失败', { error: error?.message });
      return [];
    }
    // 挤出的条目搬进沉底区，不删除。
    if (evicted.length > 0 && store.root) {
      try { await appendDormantTraits(store.root, evicted); } catch (error) {
        logger?.warn?.('[cognition] 倾向沉底失败', { error: error?.message });
      }
    }
    // 有写入、或者有被丢弃的候选，都留一条痕：反证被丢弃时才能解释“为什么没生效”。
    if (applied.length > 0 || skipped.length > 0) {
      try {
        await store.appendActivity({
          at: now,
          kind: 'tendency-reflected',
          phase,
          count: applied.length,
          items: applied,
          ...(evicted.length > 0 ? { dormant: evicted.map(item => item.label) } : {}),
          ...(skipped.length > 0 ? { skipped } : {})
        });
      } catch { /* 留痕失败不影响主流程 */ }
    }
    return applied;
  }

  // 跨重启恢复：分三段处理“数据已写但未提交”“已提交但水位没推进”“生成中崩溃”。
  async function resumeBatch(pending) {
    if (!pending) return null;
    const rows = (store.memory.memories ?? []).filter(
      row => row?.kind === 'insight' && row?.source?.batchId === pending.id
    );
    const stateNow = state();

    if (pending.status === 'committed') {
      const missing = pending.episodes.filter(id => !stateNow.processed.includes(id));
      if (missing.length === 0) {
        // 整批已提交且水位已推进：清掉批次记录，下一次进入 idle 而不是反复报 recovered。
        await store.saveMemory(memory => {
          if (memory.reflection?.batch?.id === pending.id) memory.reflection.batch = null;
        });
        return null;
      }
      const now = clock();
      await store.saveMemory(memory => {
        const state = memory.reflection ?? (memory.reflection = blankReflection());
        state.processed = [...new Set(state.processed.concat(missing))].slice(-500);
        state.lastAt = now;
        state.batch = null;
      });
      await store.appendActivity({ at: now, kind: 'reflection-recovered', batchId: pending.id, batch: missing, phase: 'watermark' });
      return { status: 'recovered', phase: 'watermark', batch: missing.length, batchId: pending.id, calls: 0 };
    }

    if (pending.status === 'data-written') {
      const expected = pending.expected ?? [];
      const byId = new Map(rows.map(row => [row.id, row]));
      const complete =
        expected.length > 0 &&
        expected.every(entry => {
          const row = byId.get(entry.id);
          return row && row.status === 'staged' && row.source?.contentHash === entry.hash;
        });
      if (!complete) {
        await markBatchFailed(pending, 'batch-incomplete');
        return { status: 'failed', reason: 'batch-incomplete', batch: pending.episodes.length, calls: 0 };
      }
      const now = clock();
      const created = [];
      await store.saveMemory(memory => {
        const state = memory.reflection ?? (memory.reflection = blankReflection());
        for (const entry of expected) {
          const row = memory.memories.find(item => item?.id === entry.id);
          if (!row) continue;
          row.status = 'committed';
          created.push({ id: row.id, title: row.title });
        }
        memory.memories = memory.memories.slice(-5000);
        state.batch = {
          id: pending.id,
          status: 'committed',
          at: now,
          episodes: pending.episodes,
          expected: pending.expected,
          error: null
        };
        state.staging = null;
        state.committed += created.length;
        state.runs += 1;
        state.lastAt = now;
        state.processed = [...new Set(state.processed.concat(pending.episodes))].slice(-500);
        const key = pending.episodes.join('|');
        state.attempts[key] = 0;
        state.lastError = null;
      });
      await store.appendActivity({
        at: now,
        kind: 'reflection-committed',
        batch: pending.episodes,
        batchId: pending.id,
        insights: created,
        recovered: true,
        calls: 0
      });
      // 反思顺带产出"我倾向于怎么做"的描述（不是建议）。只写行为层，不进 prompt 当指令。
      await applyTendencies(Array.isArray(pending.tendencies) ? pending.tendencies : null, { now, phase: 'recovered', allowedEvidence: new Set(pending.episodes ?? []) });
      await applySpeakHabits(Array.isArray(pending.speakHabits) ? pending.speakHabits : null, { now, allowedEvidence: new Set(pending.episodes ?? []) });

      // 新的理解落盘 = 内在状态变了：给她一次主动开口的机会。
      try { await onCommitted?.({ batchId: pending.id, insights: created }); } catch { /* 不影响主循环 */ }
      return { status: 'recovered', phase: 'commit', batch: pending.episodes.length, batchId: pending.id, insights: created, calls: 0 };
    }

    if (pending.status === 'generating') {
      // 模型调用中断，数据尚未落盘：清理后允许按正常路径重试。
      await store.saveMemory(memory => {
        const state = memory.reflection ?? (memory.reflection = blankReflection());
        state.batch = null;
        state.staging = null;
      });
      return null;
    }
    return null;
  }

  async function processNow() {
    if (disposed) return { status: 'disposed', calls: 0 };
    if (running) return { status: 'busy', calls: 0 };
    if (typeof reflectTurn !== 'function') return { status: 'disabled', calls: 0 };
    running = true;
    try {
      const resumed = await resumeBatch(state().batch);
      if (resumed) return resumed;
      const reflection = state();
      const eligible = (store.memory.episodes ?? [])
        .filter(episode => episode?.kind === 'turn' && episode.userText && !reflection.processed.includes(episode.id))
        .sort((a, b) => Number(a.at) - Number(b.at));
      if (eligible.length === 0) return { status: 'idle', calls: 0 };
      const batch = eligible.slice(0, maxBatch);
      const importance = batch.reduce((sum, episode) => sum + importanceOf(episode), 0);
      if (importance < minImportance && batch.length < minEpisodes) {
        return { status: 'waiting', batch: batch.length, importance, calls: 0 };
      }
      const key = batch.map(item => item.id).join('|');
      if ((reflection.attempts[key] ?? 0) >= maxAttempts) {
        return { status: 'blocked', batch: batch.length, attempts: reflection.attempts[key], calls: 0 };
      }

      // 恢复只认持久 batch 清单；不再“看到同 batchId 的任意一条 insight 就补水位”。
      const batchId = batchIdOf(batch.map(item => item.id));

      const experience = await store.readExperience();
      const rawIds = new Set(experience.map(record => record?.event?.id).filter(Boolean));
      // episode.id 只是经历卡编号；证据必须落到它引用的原始事件（eventIds[0]）。
      const rawOf = new Map(
        batch
          .map(episode => [episode.id, Array.isArray(episode.eventIds) ? episode.eventIds[0] : null])
          .filter(([, rawId]) => typeof rawId === 'string' && rawId.length > 0)
      );
      const missing = batch.filter(episode => !rawIds.has(rawOf.get(episode.id))).map(episode => episode.id);
      if (missing.length > 0) return fail('missing-raw-experience', batch, missing.join(','), 0);

      const batchIds = new Set(batch.map(episode => episode.id));
      const batchRawIds = new Set([...rawOf.values()]);
      const now = clock();
      await store.saveMemory(memory => {
        const stateNow = memory.reflection ?? (memory.reflection = blankReflection());
        stateNow.staging = {
          at: now,
          batch: batch.map(episode => episode.id),
          status: 'generating',
          episodes: batch.map(episode => ({ id: episode.id, at: episode.at, userText: episode.userText, selfText: episode.selfText ?? '' }))
        };
      });

      let raw = null;
      try {
        raw = await reflectTurn({
          episodes: batch.map(episode => ({ id: episode.id, at: episode.at, userText: episode.userText, selfText: episode.selfText ?? '' })),
          existing: (store.memory.memories ?? [])
            .filter(row => row.kind === 'insight')
            .slice(-5)
            .map(row => ({ title: row.title, content: row.content })),
          tendencyLabels: (store.behavior?.personality?.items ?? [])
            // 按置信度排序取前 12：倾向已经有二十几条，按创建顺序切片会让模型看不到强的那几条，
            // 反证也就无从指向它们。
            .slice()
            .sort((a, b) => (Number(b?.confidence) || 0) - (Number(a?.confidence) || 0))
            .slice(0, 12)
            .map(item => ({
              label: item.label,
              statement: item.statement,
              confidence: item.confidence,
              status: item.status
            })),
          speakHabitDimensions: (store.self?.speakHabits ?? []).map(item => item.dimension).filter(Boolean).slice(0, 12)
        });
      } catch (error) {
        return fail('model-call-failed', batch, error?.message ?? error, 1);
      }

      const { accepted, rejected } = normalizeInsights(raw, rawIds, batchIds, batchRawIds, maxInsights, rawOf);
      if (rejected.length > 0) {
        return fail('invalid-evidence', batch, JSON.stringify(rejected).slice(0, 300), 1);
      }
      for (const insight of accepted) {
        insight.audit = auditInsightContent(insight, experience);
        if (insight.audit.support === 'unverified-self-narrative') {
          insight.confidence = Math.min(insight.confidence, 0.4);
        }
      }

      if (accepted.length === 0) {
        // 没有形成新理解，但这段经历仍可能印证或反证已有倾向，照常写一次。
        await applyTendencies(raw?.tendencies, { now, phase: 'noop', allowedEvidence: new Set([...batchIds, ...batchRawIds]) });
        await applySpeakHabits(raw?.speakHabits, { now, allowedEvidence: new Set([...batchIds, ...batchRawIds]) });
        await store.saveMemory(memory => {
          const stateNow = memory.reflection ?? (memory.reflection = blankReflection());
          stateNow.runs += 1;
          stateNow.calls += 1;
          stateNow.noops += 1;
          stateNow.lastAt = now;
          stateNow.staging = null;
          stateNow.processed = stateNow.processed.concat(batch.map(episode => episode.id)).slice(-500);
          stateNow.attempts[key] = 0;
        });
        await store.appendActivity({ at: now, kind: 'reflection-noop', batch: batch.map(episode => episode.id), calls: 1 });
        return { status: 'noop', batch: batch.length, calls: 1 };
      }

      const expected = accepted.map((insight, index) => ({
        id: `ins-${batchId.replace(/^batch:/, '')}-${index + 1}`,
        hash: insightHash(insight),
        // insight 是直写 memories 的（不经 addMemory），重复前缀要在这里收掉：
        // 模型产出的 title 经常自己就带「理解：」，再套一层就变成「理解：理解：…」。
        title: collapseLabelPrefix(`理解：${insight.title}`)
      }));
      const episodes = batch.map(episode => episode.id);

      // 阶段 A：整批写入 staging 行 + 持久批次清单；staged 行对 recentInsights/recall 不可见。
      await store.saveMemory(memory => {
        memory.memories = (memory.memories ?? []).filter(
          row => !(row?.kind === 'insight' && row?.source?.batchId === batchId && row?.status === 'staged')
        );
        accepted.forEach((insight, index) => {
          memory.memories.push({
            id: expected[index].id,
            kind: 'insight',
            status: 'staged',
            layer: 'semantic',
            title: expected[index].title,
            content: insight.content,
            tags: insight.audit?.support === 'unverified-self-narrative' ? ['反思', '未验证自述'] : ['反思'],
            importance: Math.max(2, Math.min(4, Math.round(2 + insight.confidence * 2))),
            confidence: insight.confidence,
            support: insight.audit?.support ?? 'grounded',
            audit: insight.audit ?? null,
            source: {
              level: 'reflection',
              episodeIds: insight.evidence,
              rawEventIds: insight.rawEventIds,
              batchId,
              contentHash: expected[index].hash,
              model: 'reflection'
            },
            createdAt: new Date(now).toISOString(),
            updatedAt: new Date(now).toISOString(),
            occurredAt: now,
            recallCount: 0,
            lastRecalledAt: null
          });
        });
        const stateNow = memory.reflection ?? (memory.reflection = blankReflection());
        stateNow.batch = {
          id: batchId,
          status: 'data-written',
          at: now,
          episodes,
          expected,
          tendencies: Array.isArray(raw?.tendencies) ? raw.tendencies.slice(0, 2) : [],
          speakHabits: Array.isArray(raw?.speakHabits) ? raw.speakHabits.slice(0, 1) : [],
          error: null
        };
        stateNow.staging = { at: now, batch: episodes, status: 'staged', expected: expected.length };
      });

      // 阶段 B：同一次原子写里翻转 committed、写完成标记并推进水位。
      const created = [];
      await store.saveMemory(memory => {
        const stateNow = memory.reflection ?? (memory.reflection = blankReflection());
        for (const entry of expected) {
          const row = (memory.memories ?? []).find(item => item?.id === entry.id);
          if (!row) throw new Error(`reflection-commit-missing:${entry.id}`);
          if (row.source?.contentHash !== entry.hash) throw new Error(`reflection-commit-hash:${entry.id}`);
          row.status = 'committed';
          row.updatedAt = new Date(now).toISOString();
          created.push({ id: row.id, title: row.title });
        }
        memory.memories = memory.memories.slice(-5000);
        stateNow.batch = { id: batchId, status: 'committed', at: now, episodes, expected, error: null };
        stateNow.runs += 1;
        stateNow.calls += 1;
        stateNow.committed += created.length;
        stateNow.lastAt = now;
        stateNow.staging = null;
        stateNow.processed = [...new Set(stateNow.processed.concat(episodes))].slice(-500);
        stateNow.attempts[key] = 0;
        stateNow.lastError = null;
      });
      await store.appendActivity({
        at: now,
        kind: 'reflection-committed',
        batch: episodes,
        batchId,
        insights: created,
        calls: 1
      });
      // 之前这条路径漏了倾向写入，只有崩溃恢复才会写——所以反思跑成功时倾向从不累积。
      await applyTendencies(raw?.tendencies, { now, phase: 'normal', allowedEvidence: new Set([...batchIds, ...batchRawIds]) });
      await applySpeakHabits(raw?.speakHabits, { now, allowedEvidence: new Set([...batchIds, ...batchRawIds]) });
      try { await onCommitted?.({ batchId, insights: created }); } catch { /* 不影响主循环 */ }
      return { status: 'committed', batch: batch.length, insights: created, calls: 1 };
    } catch (error) {
      logger?.warn?.('reflection failed', error);
      try {
        const now = clock();
        await store.saveMemory(memory => {
          const stateNow = memory.reflection ?? (memory.reflection = blankReflection());
          stateNow.failures += 1;
          stateNow.lastError = String(error?.message ?? error).slice(0, 200);
          stateNow.staging = null;
        });
        await store.appendActivity({ at: now, kind: 'reflection-failed', reason: 'internal', detail: String(error?.message ?? error).slice(0, 200) });
      } catch {
        // 反思失败不能影响主循环。
      }
      return { status: 'failed', reason: 'internal', calls: 1 };
    } finally {
      running = false;
    }
  }

  function enqueue(episode) {
    if (disposed || !episode || episode.kind !== 'turn') return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      processNow().catch(error => logger?.warn?.('reflection timer failed', error));
    }, delayMs);
    timer.unref?.();
  }

  function dispose() {
    disposed = true;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return {
    enqueue,
    processNow,
    dispose,
    status: () => ({ ...state(), inFlight: running })
  };
}
