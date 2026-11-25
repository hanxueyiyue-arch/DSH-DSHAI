// 认知内核的服务窗口（S2）。
// 只做：加载状态、收事件（校验/幂等/有界队列/回执）、只读 API、身份写入。
// 不跑七阶段、不发消息、不起定时器、不联网。

import { existsSync, mkdirSync, readdirSync, renameSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStore } from '../state/store.js';
import { ACTIVITY_TAIL_MAX, RECENT_EVENT_IDS_MAX } from '../state/schema.js';
import { normalizeEvent, normalizeIdentity } from './validate.js';
import { createCycle } from '../loop/cycle.js';
import { createModelDecide } from '../decide/model-decide.js';
import { planMaintenance } from '../memory/maintenance.js';
import { planProposals, planDedupe, applyProposal as applyProposalToState, dismissProposal as dismissProposalToState } from '../memory/consolidate.js';
import { createExtractor } from '../memory/extract.js';
import { createDistiller } from '../memory/distill.js';
import { ensurePersona, personaView } from '../state/persona.js';
import { maybeAppendChronicle, listChronicle, readChronicle, documentsRoot } from '../state/chronicle.js';
import { createAssociationRuntime } from '../memory/assoc-runtime.js';
import { createReflector } from '../self/reflection.js';
import { createDailyJournal } from '../memory/diary.js';
import { createDiary, reviseDiary, readDiaryHistory } from '../memory/journal-store.js';
import { activeTraits, disableTrait, revertTrait, mergeSimilarTraits, TRAIT_LIMIT, normalizeLabel } from '../self/traits.js';
import { readTendencySeed } from '../self/tendency-seed.js';
import { readDormantTraits, appendDormantTraits, writeDormantTraits, mergeDormantIntoActive, readReconcileState, writeReconcileState } from '../state/dormant-traits.js';
import { driveSummary } from '../self/drives.js';
import { settleIdle } from '../self/mood.js';
import { exportArchive, previewImport, importArchive } from '../data/archive.js';
import { addAlarm, removeAlarm, listAlarms, dueAlarms, markFired, markChecked, localClock } from '../schedule/alarms.js';
import { timeSlot } from '../decide/presence.js';

export const COGNITION_SERVICE = 'cognition';
// 内存队列只负责调度；已确认接收的事件必须先落 events/log.jsonl 再入队。
// 超过硬上限时在“确认接收”之前明确拒绝，绝不先回 accepted 再丢弃。
export const QUEUE_LIMIT = 32;
export const HARD_QUEUE_LIMIT = 1024;
export const EVENT_RETRY_MAX = 3;

export function createCognitionService({
  stateRoot,
  timeZone = '',
  identity = null,
  capacity = 5000,
  clock = () => Date.now(),
  logger = console,
  lock = true,
  loop = false,
  onIntent = null,
  decide = null,
  model = null,
  modelTimeoutMs = 15_000,
  budgetGate = null,
  fallbackText,
  extractor = null,
  distiller = null,
  distillTurn = null,
  extractTurn = null,
  recallMode = 'legacy',
  association = false,
  reflection = false,
  reflectTurn = null,
  journal = false,
  journalTurn = null,
  journalDebounceMs = 8_000,
  autoConsolidate = false,
  personality = false,
  // 启动迁移：behavior.personality.items 为空时采纳包内倾向种子（只采纳一次）。
  backfillTraits = true,
  queueLimit = HARD_QUEUE_LIMIT,
  // 闹钟：Cognition 自己的分钟级检查器（不走总线调度）。
  alarmEnabled = true,
  alarmPollMs = 60_000,
  capabilityProvider = null,
  store: injectedStore = null
} = {}) {
  if (!stateRoot) throw new Error('createCognitionService: 缺少 stateRoot');

  const store = injectedStore ?? createStore({ root: stateRoot, clock, lock });
  const resolvedExtractor =
    extractor ??
    (typeof extractTurn === 'function'
      ? createExtractor({ extractTurn, store, clock, capacity, timeZone, logger })
      : null);
  const resolvedDistiller =
    distiller ??
    (typeof distillTurn === 'function'
      ? createDistiller({ distillTurn, store, clock, capacity, timeZone, logger })
      : null);
  const resolvedDecide =
    typeof decide === 'function'
      ? decide
      : typeof model === 'function'
        ? createModelDecide({ model, timeoutMs: modelTimeoutMs, logger })
        : undefined;
  const resolvedAssociation = association
    ? createAssociationRuntime({ store, clock, logger })
    : null;
  // 反思先于 cycle 创建，这里用引用在提交后把"内在状态变了"转成一次自触发回合。
  let cycleRef = null;
  const resolvedReflector =
    typeof reflectTurn === 'function'
      ? createReflector({
          reflectTurn,
          store,
          clock,
          logger,
          onCommitted: async info => {
            if (!cycleRef || !Array.isArray(info?.insights) || info.insights.length === 0) return;
            // 反思之后，沉底里如果有同义条目，把证据并回来（沉底回升）。
            try { await promoteDormantNow(); } catch (error) { logger?.warn?.('[cognition] 沉底回升失败', { error: error?.message }); }
            await cycleRef.queueSelfTurn('你想明白了一件事');
          }
        })
      : null;
  const resolvedJournal = journal && typeof journalTurn === 'function'
    ? createDailyJournal({ store, journalTurn, now: clock, debounceMs: journalDebounceMs, logger })
    : null;
  const cycle = loop
    ? createCycle({
        store,
        clock,
        onIntent,
        // 内在触发：自触发事件直接压回内核队列（不经过计时器与总线）。
        enqueue: raw => onEvent(raw),
        // 自触发/回执事件没有总线 payload 时，用它补当前能力目录。
        capabilitiesProvider: capabilityProvider,
        capacity,
        timeZone,
        fallbackText,
        logger,
        recallMode,
        ...(resolvedExtractor ? { extractor: resolvedExtractor } : {}),
        ...(resolvedDistiller ? { distiller: resolvedDistiller } : {}),
        ...(resolvedAssociation ? { association: resolvedAssociation } : {}),
        ...(resolvedReflector ? { reflection: resolvedReflector } : {}),
        ...(resolvedJournal ? { journal: resolvedJournal } : {}),
        personality,
        ...(resolvedDecide ? { decide: resolvedDecide } : {})
      })
    : null;
  cycleRef = cycle;
  const pending = [];
  let eventLog = new Map();
  let recent = new Set();
  let running = false;
  let disposed = false;
  let dropped = 0;
  let processed = 0;
  let failures = 0;
  let recovered = 0;
  let lastDroppedId = null;
  let idleWaiters = [];
  let readyPromise = null;

  async function init() {
    await store.ensure();
    // V-A-E 开机结算：关机期间只做自然平复与精力恢复，不模拟活动。
    // 迁移只对旧版 affect（version < 2）发生一次，日志也只记一次。
    let affectMigratedFrom = null;
    await store.saveBehavior(behavior => {
      const settled = settleIdle(behavior.affect, { now: clock() });
      if (settled.flags.migrated) affectMigratedFrom = settled.flags.fromVersion;
      behavior.affect = settled.affect;
    });
    if (affectMigratedFrom !== null) {
      await store.appendActivity({ at: clock(), kind: 'affect-migrated', fromVersion: affectMigratedFrom });
    }
    // 启动迁移：倾向为空时采纳包内种子。
    // 放在这里而不是插件 apply 里，是因为 apply 是同步的、拿不到 await；
    // 而这里保证在第一次写入之前、且只跑一次。
    await reconcileTendencyLibrary();
    recent = new Set(store.memory.recentEventIds);
    eventLog = await store.readEventLog();    // 重启恢复：pending/processing/failed 且未完成的事件重新入队；done 只用于幂等判定。
    for (const [id, row] of eventLog) {
      if (!row?.event) continue;
      if (row.status === 'done') {
        recent.add(id);
        continue;
      }
      if (row.status === 'processing') {
        await store.appendEventRecord(row.event, { status: 'pending', detail: 'recovered-after-restart' });
        recovered += 1;
      } else if (row.status === 'failed' && Number(row.detail?.attempts ?? 0) >= EVENT_RETRY_MAX) {
        continue;
      } else if (row.status === 'pending') {
        recovered += 1;
      }
      if (!pending.some(item => item.id === id)) pending.push(row.event);
      recent.add(id);
    }
    if (identity && !store.self.identity) {
      await writeIdentity({ ...identity, source: 'config' });
    }
    await cycle?.hydrate?.();
    resolvedExtractor?.catchUp?.();
    if (resolvedJournal) {
      void Promise.resolve()
        .then(() => resolvedJournal.archiveNow())
        .catch(error => logger?.warn?.('[cognition] 日记归档启动失败', { error: error?.message }));
    }
    if (resolvedReflector) {
      // 启动补一次：只看未处理的 turn episode；没有就零模型调用退出。
      void Promise.resolve()
        .then(() => resolvedReflector.processNow())
        .catch(error => logger?.warn?.('[cognition] 反思补跑失败', { error: error?.message }));
    }
    if (pending.length > 0) scheduleDrain();
    if (alarmEnabled) startAlarms();
  }

  // 闹钟检查器：每分钟一次；错过的只补最近一次（>2h 不补）。
  let alarmTimer = null;
  let alarmBusy = false;
  let lastRevisionCount = null;
  function startAlarms() {
    if (alarmTimer || !(alarmPollMs > 0)) return;
    alarmTimer = setInterval(() => {
      if (alarmBusy || disposed) return;
      alarmBusy = true;
      void checkAlarms()
        .catch(error => logger?.warn?.('[cognition] 闹钟检查失败', { error: error?.message }))
        .finally(() => { alarmBusy = false; });
    }, alarmPollMs);
    if (typeof alarmTimer.unref === 'function') alarmTimer.unref();
  }

  // 习惯到点：时段内一次（旧习惯是时段粒度，没有精确时间）。
  async function checkHabitTrigger() {
    if (!cycle || typeof cycle.queueSelfTurn !== 'function') return;
    const now = clock();
    const day = localClock(now, timeZone).day;
    const slot = timeSlot(now, timeZone);
    const habits = Array.isArray(store.self.habits) ? store.self.habits : [];
    const triggered = store.memory.habitTriggers && typeof store.memory.habitTriggers === 'object' ? store.memory.habitTriggers : {};
    const hit = habits.find(habit => {
      const parts = String(habit?.key ?? '').split('|');
      if ((parts[2] ?? '') !== slot) return false;
      if ((Number(habit?.confidence) || 0) < 0.5) return false;
      return triggered[habit.key] !== day;
    });
    if (!hit) return;
    await store.saveMemory(memory => {
      memory.habitTriggers = { ...(memory.habitTriggers ?? {}), [hit.key]: day };
    });
    await cycle.queueSelfTurn(`习惯到点：${hit.key}`, { capabilities: capabilityProvider?.() ?? null });
  }

  // 倾向变化：revisions.jsonl 行数增加一次，就给她一次自省后的回合。
  async function checkTendencyTrigger() {
    if (!cycle || typeof cycle.queueSelfTurn !== 'function') return;
    const file = join(store.root, 'personality', 'revisions.jsonl');
    let count = 0;
    try { count = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).length; } catch { count = 0; }
    if (lastRevisionCount === null) { lastRevisionCount = count; return; }
    if (count <= lastRevisionCount) { lastRevisionCount = count; return; }
    lastRevisionCount = count;
    await cycle.queueSelfTurn('倾向有变化', { capabilities: capabilityProvider?.() ?? null });
  }

  // 新记忆：fact/insight/inference/uncertain 落盘后给她一次回合；她自己行动产生的不算。
  async function maybeInitiateFromMemory(event, beforeIds) {
    if (!cycle || typeof cycle.queueSelfTurn !== 'function') return;
    if (event.type === 'self-turn' || event.type === 'tool-result') return;
    const fresh = store.memory.memories.filter(row => !beforeIds.has(row.id));
    const hit = fresh.find(row =>
      ['fact', 'insight', 'inference', 'uncertain'].includes(row?.kind)
      && row?.source?.level !== 'action-result'
      && row?.source?.level !== 'observation'
      && row?.source?.channel !== 'tool'
    );
    if (!hit) return;
    await cycle.queueSelfTurn(`新记忆：${String(hit.title ?? '').slice(0, 60)}`, {
      capabilities: capabilityProvider?.() ?? null
    });
  }

  async function checkAlarms() {
    await ensureReady();
    await checkHabitTrigger();
    await checkTendencyTrigger();
    const now = clock();
    const state = await store.readAlarms();
    const due = dueAlarms(state, { now, timeZone });
    if (due.length === 0) {
      await store.saveAlarms(current => markChecked(current, { now }));
      return { fired: [] };
    }
    const latest = due.slice().sort((a, b) => b.time.localeCompare(a.time))[0];
    await store.saveAlarms(current => markFired(current, latest.id, { now, timeZone }));
    const event = {
      id: `alarm-${latest.id}-${now}`,
      type: 'tick',
      at: now,
      actor: { kind: 'system' },
      payload: {
        source: 'alarm',
        allowBrowse: true,
        reason: `闹钟：${latest.label || latest.time}`,
        ...(typeof capabilityProvider === 'function' ? { capabilities: capabilityProvider() } : {})
      }
    };
    await onEvent(event);
    return { fired: [latest.id] };
  }

  async function alarmToolSet(input = {}) {
    await ensureReady();
    const now = clock();
    const result = addAlarm(await store.readAlarms(), { time: input.time, label: input.label, now });
    if (!result.ok) return result;
    await store.saveAlarms(() => result.state);
    return { ok: true, alarm: result.alarm };
  }

  async function alarmToolList() {
    await ensureReady();
    return { ok: true, alarms: listAlarms(await store.readAlarms()) };
  }

  async function alarmToolRemove(input = {}) {
    await ensureReady();
    const result = removeAlarm(await store.readAlarms(), input.id, { now: clock() });
    if (!result.ok) return result;
    await store.saveAlarms(() => result.state);
    return { ok: true, removed: String(input.id ?? '') };
  }

  // 老布局 <root>/diary → 新布局 <root>/documents/diary（统一文档根）。
  function migrateDiaryLayout() {
    try {
      const oldDir = join(stateRoot, 'diary');
      const newDir = join(documentsRoot({ root: stateRoot }), 'diary');
      if (!existsSync(oldDir)) return;
      mkdirSync(newDir, { recursive: true });
      for (const name of readdirSync(oldDir)) {
        const from = join(oldDir, name);
        const to = join(newDir, name);
        if (existsSync(to)) continue;
        renameSync(from, to);
      }
    } catch { /* 迁移失败不影响启动，旧数据仍可读 */ }
  }

  // 启动整理（幂等）：
  //   1) 补齐种子里缺的倾向（只加不覆盖，跳过停用/沉底/已合并的标签）
  //   2) 合并近义标签（同一件事换个说法，不该长成两条）
  //   3) 超出活跃池上限的按价值挤出 → 沉底文件，绝不删除
  // 放在启动而不是外部改文件，是因为 behavior.json 由内存副本整份重写，运行中改会被覆盖。
  async function reconcileTendencyLibrary({ force = false } = {}) {
    if (!backfillTraits && !force) return { status: 'disabled' };
    try {
      const seed = readTendencySeed({ logger });
      const dormant = await readDormantTraits(store.root);
      const reconcile = await readReconcileState(store.root);
      const retired = new Set(reconcile.retiredLabels.map(normalizeLabel));
      const known = new Set(
        [...(store.behavior?.personality?.items ?? []), ...dormant]
          .map(item => normalizeLabel(item?.label))
          .filter(Boolean)
      );
      const seedVersion = Number(seed?.version) || 0;
      const mayRestore = Boolean(seed) && (force || seedVersion > (reconcile.restoredSeedVersion || 0));
      const report = { restored: [], merges: [], evicted: [], before: 0, after: 0, dormantTotal: null, seedVersion, revived: [], mergedBack: [] };
      let changed = false;
      const dormantBefore = await readDormantTraits(store.root);
      let dormantAfterRevival = dormantBefore;

      await store.saveBehavior(behavior => {
        const items = Array.isArray(behavior.personality?.items) ? behavior.personality.items : [];
        report.before = items.length;
        const next = [...items];
        if (mayRestore) {
          for (const seedItem of seed.items) {
            const key = normalizeLabel(seedItem.label);
            if (!key || known.has(key) || retired.has(key)) continue;
            next.push(JSON.parse(JSON.stringify(seedItem)));
            known.add(key);
            report.restored.push(seedItem.label);
          }
        }
        const merged = mergeSimilarTraits(next, { limit: TRAIT_LIMIT });
        // 沉底回升：同义的把证据并回来；有空位的新条目直接回来。
        const revival = mergeDormantIntoActive(merged.items, dormantBefore, { limit: TRAIT_LIMIT });
        const final = mergeSimilarTraits(revival.active, { limit: TRAIT_LIMIT });
        dormantAfterRevival = revival.dormant;
        report.revived = revival.promoted;
        report.mergedBack = revival.merged;
        report.merges = [...merged.merges, ...final.merges];
        // 两轮 partition 挤出的都要沉底：先合并/补种那一轮，和回升之后再收口那一轮。
        const evictedById = new Map();
        for (const row of [...merged.evicted, ...final.evicted]) evictedById.set(row.id, row);
        report.evicted = [...evictedById.values()];
        report.after = final.items.length;
        changed = report.restored.length > 0 || report.merges.length > 0 || report.evicted.length > 0
          || report.revived.length > 0 || report.mergedBack.length > 0;
        if (changed) {
          behavior.personality = {
            items: final.items,
            revision: (Number(behavior.personality?.revision) || 0) + 1,
            updatedAt: clock()
          };
        }
      });

      if (!changed) return { ...report, status: 'noop' };

      if (report.revived.length > 0 || report.mergedBack.length > 0) {
        await writeDormantTraits(store.root, dormantAfterRevival);
      }
      if (report.evicted.length > 0) {
        const res = await appendDormantTraits(store.root, report.evicted);
        report.dormantTotal = res.total;
      }
      // 被合并掉的标签记进 retired，避免下次启动又从种子补回来、再被合并（来回抖动）
      await writeReconcileState(store.root, {
        restoredSeedVersion: mayRestore ? seedVersion : reconcile.restoredSeedVersion,
        retiredLabels: [...reconcile.retiredLabels, ...report.merges.map(row => row.mergedLabel)]
      });
      await store.appendActivity({
        at: clock(),
        kind: 'traits-reconciled',
        before: report.before,
        after: report.after,
        restored: report.restored,
        merges: report.merges,
        evicted: report.evicted.map(item => item.label),
        dormantTotal: report.dormantTotal
      });
      await store.appendPersonalityRevision?.({
        at: clock(),
        kind: 'reconcile',
        count: report.after,
        revision: store.behavior.personality.revision,
        items: store.behavior.personality.items
      });
      logger?.info?.('[cognition] 倾向整理完成', {
        before: report.before,
        after: report.after,
        restored: report.restored.length,
        merged: report.merges.length,
        dormant: report.evicted.length
      });
      return { ...report, status: 'reconciled' };
    } catch (error) {
      logger?.warn?.('[cognition] 倾向整理失败，跳过', { error: error?.message });
      return { status: 'error', error: String(error?.message ?? error).slice(0, 200) };
    }
  }

  // 反思提交后调用：把沉底里同义的倾向证据并回活跃池；有空位时让沉底条目回来。
  async function promoteDormantNow() {
    if (!store.behavior?.personality) return { status: 'noop' };
    const dormant = await readDormantTraits(store.root);
    if (dormant.length === 0) return { status: 'noop' };
    const result = mergeDormantIntoActive(store.behavior.personality.items ?? [], dormant, { limit: TRAIT_LIMIT });
    if (result.merged.length === 0 && result.promoted.length === 0) return { status: 'noop' };
    const merged = mergeSimilarTraits(result.active, { limit: TRAIT_LIMIT });
    await store.saveBehavior(behavior => {
      behavior.personality = {
        items: merged.items,
        revision: (Number(behavior.personality?.revision) || 0) + 1,
        updatedAt: clock()
      };
    });
    await writeDormantTraits(store.root, [
      ...result.dormant,
      ...merged.evicted.map(item => ({ ...item, dormantAt: clock() }))
    ]);
    await store.appendActivity({
      at: clock(),
      kind: 'dormant-revived',
      merged: result.merged.length,
      promoted: result.promoted.length,
      evicted: merged.evicted.length
    });
    return { status: 'revived', merged: result.merged.length, promoted: result.promoted.length };
  }

  // 人工补倾向：走和启动整理同一条路径（force 时忽略种子版本标记）。
  async function backfillPersonalityTraits({ force = false } = {}) {
    await ensureReady();
    return reconcileTendencyLibrary({ force: force === true });
  }

  async function ensureReady() {
    migrateDiaryLayout();
    if (!readyPromise) readyPromise = init();
    return readyPromise;
  }

  function scheduleDrain() {
    if (running) return;
    queueMicrotask(drain);
  }

  async function drain() {
    if (running) return;
    running = true;
    try {
      while (pending.length > 0) {
        const event = pending.shift();
        const known = eventLog.get(event.id);
        if (known?.status === 'done') {
          processed += 1;
          continue;
        }
        const attempts = Number(known?.detail?.attempts ?? 0);
        try {
          await store.appendEventRecord(event, { status: 'processing' });
          eventLog.set(event.id, { status: 'processing', event, detail: { attempts } });
          await process(event);
          await store.appendEventRecord(event, { status: 'done' });
          eventLog.set(event.id, { status: 'done', event, detail: { attempts } });
          processed += 1;
        } catch (error) {
          failures += 1;
          const nextAttempts = attempts + 1;
          logger?.error?.('[cognition] 事件处理失败', {
            eventId: event.id,
            attempts: nextAttempts,
            error: error?.message
          });
          try {
            await store.appendEventRecord(event, {
              status: 'failed',
              detail: { attempts: nextAttempts, error: String(error?.message ?? '').slice(0, 200) }
            });
          } catch (persistError) {
            logger?.error?.('[cognition] 事件失败状态落盘失败', {
              eventId: event.id,
              error: persistError?.message
            });
          }
          eventLog.set(event.id, {
            status: 'failed',
            event,
            detail: { attempts: nextAttempts, error: String(error?.message ?? '').slice(0, 200) }
          });
          if (nextAttempts < EVENT_RETRY_MAX && !disposed) {
            pending.push(event);
            setTimeout(() => scheduleDrain(), Math.min(30_000, 500 * nextAttempts)).unref?.();
            break;
          }
        }
      }
    } finally {
      running = false;
      if (pending.length === 0) {
        const waiters = idleWaiters;
        idleWaiters = [];
        for (const resolve of waiters) resolve();
      }
    }
  }

  async function process(event) {
    await store.appendExperience(event);
    await store.appendActivity({
      at: event.at,
      kind: 'event-received',
      eventId: event.id,
      type: event.type
    });
    await store.saveMemory(memory => {
      memory.recentEventIds.push(event.id);
      memory.recentEventIds = memory.recentEventIds.slice(-RECENT_EVENT_IDS_MAX);
      memory.counters.events += 1;
      memory.counters.lastEventAt = event.at;
    });
    if (event.type === 'maintenance') {
      try {
        await maintain({ now: event.at });
      } catch (error) {
        logger?.error?.('[cognition] 维护失败', { eventId: event.id, error: error?.message });
      }
      return;
    }
    if (cycle) {
      const beforeMemoryIds = new Set(store.memory.memories.map(row => row.id));
      try {
        const result = await cycle.run(event);
        await maybeInitiateFromMemory(event, beforeMemoryIds).catch(error => {
          logger?.warn?.('[cognition] 内在触发失败', { error: error?.message });
        });
        if (result?.trace) {
          await store.appendTrace({
            at: event.at,
            eventId: event.id,
            type: event.type,
            traceId: result.trace.id,
            stages: result.trace.stages
          });
        }
      } catch (error) {
        logger?.error?.('[cognition] 循环执行失败', { eventId: event.id, error: error?.message });
      }
    }
  }

  // 维护只由 maintenance 事件触发；内核不自带定时器，宿主维护窗口到点才投事件。
  async function maintain({ now = clock() } = {}) {
    const plan = planMaintenance(store.memory.memories, {
      now,
      capacity,
      diaryIndex: store.memory.diaryIndex
    });
    const result = plan.archive.length
      ? await store.archiveMemories(plan.archive, { at: now })
      : { archived: [] };
    const dedupe = autoConsolidate ? planDedupe(store.memory.memories, { now }) : [];
    let proposals = [];
    await store.saveMemory(memory => {
      const byId = new Map(memory.memories.map(row => [row.id, row]));
      for (const op of dedupe) {
        const duplicate = byId.get(op.duplicateId);
        if (duplicate && !duplicate.supersededBy) {
          duplicate.supersededBy = op.keepId;
          duplicate.supersededAt = now;
          duplicate.updatedAt = now;
        }
      }
      memory.counters.lastMaintenanceAt = now;
      proposals = planProposals(memory.memories, { now });
      memory.proposals = proposals;
    });
    await store.appendActivity({
      at: now,
      kind: 'maintenance',
      archived: result.archived.length,
      proposals: proposals.length,
      deduped: dedupe.length
    });
    return {
      archived: result.archived.length,
      proposals,
      deduped: dedupe
    };
  }

  async function proposals() {
    await ensureReady();
    return (store.memory.proposals ?? []).map(item => ({ ...item }));
  }

  async function applyProposal(id) {
    if (disposed) throw new Error('认知内核已关闭');
    await ensureReady();
    const result = applyProposalToState(store.memory, id, { now: clock(), capacity, timeZone });
    if (result.ok) await store.saveMemory(() => undefined);
    return result;
  }

  async function dismissProposal(id) {
    await ensureReady();
    const result = dismissProposalToState(store.memory, id);
    if (result.ok) await store.saveMemory(() => undefined);
    return result;
  }

  function idle() {
    if (!running && pending.length === 0) return Promise.resolve();
    return new Promise(resolve => idleWaiters.push(resolve));
  }

  async function onEvent(raw) {
    if (disposed) throw new Error('认知内核已关闭');
    const checked = normalizeEvent(raw);
    if (!checked.ok) {
      return { accepted: false, eventId: typeof raw?.id === 'string' ? raw.id : null, error: checked.error };
    }
    await ensureReady();
    const event = checked.event;

    // 预算打标：只有会触发付费决策的事件才读预算状态（读失败按可用处理）。
    if (budgetGate && (event.type === 'owner-message' || event.type === 'tick')) {
      try {
        const digest = await budgetGate.peek();
        if (digest) event.budget = digest;
      } catch { /* 预算状态不可读时不影响事件接收 */ }
    }

    const known = eventLog.get(event.id);
    if (recent.has(event.id) || known?.status === 'done') {
      return { accepted: true, eventId: event.id, duplicate: true, queued: pending.length };
    }
    if (known && (known.status === 'pending' || known.status === 'processing' || known.status === 'failed')) {
      if (!pending.some(item => item.id === event.id)) {
        pending.push(known.event ?? event);
        scheduleDrain();
      }
      recent.add(event.id);
      return { accepted: true, eventId: event.id, duplicate: true, queued: pending.length };
    }

    // 容量不足时在确认接收之前拒绝；不先回 accepted 再丢弃。
    if (pending.length >= queueLimit) {
      return { accepted: false, eventId: event.id, error: 'EVENT_QUEUE_FULL', queued: pending.length };
    }

    try { maybeAppendChronicle(store, { now: clock() }); } catch { /* 编年史失败不影响事件 */ }
    try {
      await store.appendEventRecord(event, { status: 'pending' });
    } catch (error) {
      return {
        accepted: false,
        eventId: event.id,
        error: 'EVENT_PERSIST_FAILED',
        detail: String(error?.message ?? '').slice(0, 200)
      };
    }
    eventLog.set(event.id, { status: 'pending', event, detail: {} });
    pending.push(event);
    recent.add(event.id);
    scheduleDrain();

    return {
      accepted: true,
      eventId: event.id,
      duplicate: false,
      queued: pending.length
    };
  }

  async function writeIdentity(input) {
    const checked = normalizeIdentity(input);
    if (!checked.ok) throw new Error(`identity.${checked.error}`);
    await store.saveSelf(self => {
      const previous = self.identity;
      self.identity = {
        ...checked.identity,
        revision: (previous?.revision ?? 0) + 1,
        updatedAt: new Date(clock()).toISOString(),
        ...(input.source ? { source: input.source } : {})
      };
    });
    return { ...store.self.identity };
  }

  async function setIdentity(input) {
    await ensureReady();
    const persona = ensurePersona(store, { now: clock() });
    if (persona.locked === true) {
      return { ok: false, locked: true, reason: 'persona-locked', persona: personaView(store, { now: clock() }) };
    }
    const written = await writeIdentity(input);
    // 写入后若初始人设已齐（姓名 + 性别），立刻落盘并锁定；不齐就继续留在可编辑状态。
    const next = ensurePersona(store, { now: clock() });
    return {
      ok: true,
      locked: next.locked === true,
      reason: next.locked === true ? null : 'persona-incomplete',
      identity: written,
      persona: personaView(store, { now: clock() })
    };
  }

  async function status() {
    await ensureReady();
    const self = store.self;
    const memory = store.memory;
    const behavior = store.behavior;
    return {
      schema: 1,
      state: 'ready',
      identity: self.identity ? { name: self.identity.name, gender: self.identity.gender } : null,
      counts: {
        memories: memory.memories.length,
        diary: memory.diaryIndex.length,
        archived: Number(memory.counters.archived) || 0,
        events: memory.counters.events
      },
      // 只暴露展示需要的字段；processedEventIds 是内部去重记录，不发给 UI。
      affect: (() => {
        const { processedEventIds, ...rest } = behavior.affect ?? {};
        return { ...rest, tired: Number(rest.energy) < 20 };
      })(),
      drives: driveSummary(behavior, { limit: 8 }),
      association: resolvedAssociation ? resolvedAssociation.stats() : { enabled: false },
      personality: {
        enabled: personality === true,
        revision: Number(store.behavior.personality?.revision) || 0,
        traits: activeTraits(store.behavior.personality, { limit: 5 })
      },
      // 用户明确说过的偏好与约定：带支持度（被确认过几次）和置信度。
      // 设置页用它渲染「偏好与倾向」折叠区；默认收起，点开才看。
      preferences: (() => {
        const rows = (Array.isArray(memory.memories) ? memory.memories : [])
          .filter(row => row && !row.archivedAt && !row.supersededBy && row.layer === 'preference')
          .sort((a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0)
            || (Number(b.support) || 1) - (Number(a.support) || 1)
            || (Number(b.occurredAt) || 0) - (Number(a.occurredAt) || 0));
        return {
          total: rows.length,
          items: rows.map(row => ({
            id: row.id,
            title: String(row.title ?? ''),
            content: String(row.content ?? ''),
            support: Number(row.support) || 1,
            confidence: Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : null,
            importance: Number(row.importance) || 3,
            confirmedAt: Number(row.lastConfirmedAt) || Number(row.occurredAt) || null
          }))
        };
      })(),
      // 她自己的倾向：当前生效的 traits + 说话习惯（只读预览）。
      tendencies: (() => {
        const traits = activeTraits(store.behavior.personality, { limit: 40 })
          .map(row => ({ id: row.id, label: row.label, statement: row.statement, confidence: row.confidence, support: Array.isArray(row.support) ? row.support.length : 0 }));
        const habits = Array.isArray(store.self?.speakHabits) ? store.self.speakHabits : [];
        return {
          traits,
          speakHabits: habits.map(row => ({ id: row.id, label: row.label, statement: row.statement, confidence: row.confidence, scope: row.scope }))
        };
      })(),
      feedback: {
        evidence: (Array.isArray(memory.feedbackEvidence) ? memory.feedbackEvidence : []).slice(-8)
      },
      reflection: resolvedReflector
        ? { enabled: true, ...resolvedReflector.status() }
        : { enabled: false },
      journal: resolvedJournal
        ? { enabled: true, ...resolvedJournal.status() }
        : { enabled: false },
      habits: { active: self.habits.length, dormant: self.habitsDormant.length },
      loop: cycle
        ? { enabled: true, pending: cycle.pendingCount(), model: Boolean(model) }
        : { enabled: false, pending: 0, model: false },
      queue: {
        pending: pending.length,
        dropped,
        processed,
        failures,
        recovered,
        persisted: eventLog.size,
        limit: queueLimit,
        hardLimit: queueLimit
      },
      lastEventAt: memory.counters.lastEventAt,
      budget: budgetGate ? await budgetGate.peek() : null
    };
  }

  async function memories({ limit = 20, offset = 0, kind = null, layer = null, includeArchived = false } = {}) {
    await ensureReady();
    const size = Math.min(Math.max(Number(limit) || 20, 1), 200);
    const start = Math.max(Number(offset) || 0, 0);
    const timeOfRow = row => {
      const created = Date.parse(row?.createdAt || '');
      if (Number.isFinite(created)) return created;
      const occurred = Number(row?.occurredAt);
      return Number.isFinite(occurred) ? occurred : 0;
    };
    const rows = store.memory.memories.filter(row => {
      if (kind && row.kind !== kind) return false;
      if (layer && row.layer !== layer) return false;
      if (!includeArchived && row.archivedAt) return false;
      return true;
    });
    // 最新优先：否则 limit 截断总是切掉刚发生的事（界面因此看不到新记忆）。
    const ordered = rows.slice().sort((a, b) => timeOfRow(b) - timeOfRow(a));
    return ordered.slice(start, start + size).map(row => ({ ...row }));
  }

  async function diaryList() {
    await ensureReady();
    const pendingDay = store.memory?.journal?.pending?.day ?? null;
    const rows = await store.listDiaries();
    return pendingDay ? rows.filter(row => row?.day !== pendingDay) : rows;
  }

  async function diaryRead(id) {
    await ensureReady();
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(id)) {
      throw new Error('diaryRead: 非法日记 id');
    }
    const pendingDay = store.memory?.journal?.pending?.day ?? null;
    if (pendingDay) {
      const rows = await store.listDiaries();
      if (rows.some(row => row?.id === id && row?.day === pendingDay)) return null;
    }
    const text = await store.readDiary(id);
    return text === null ? null : { id, text };
  }

  // ---------- 日记工具（给她本人用）----------
  function diaryToday() {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: timeZone || 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(new Date(clock()));
    } catch {
      return new Date(clock()).toISOString().slice(0, 10);
    }
  }

  // 日记条目的 at / createdAt 必须是真实写入时间。
  // 旧实现把每条都写成"那天 12:00+08:00"，于是 index.json 里 11-22/23/24 全是
  // 2026-11-xxT04:00:00.000Z（本地正午），和文件实际写入时间（08:00 / 22:00）对不上。
  // 归属哪一天由条目自带的 day 字段决定，不靠时间戳反推，所以这里可以直接用真实时间。
  function diaryStampForDay(day) {
    // 保留函数名（调用方与返回值里还有 stamp 字段），但只作为"这一天"的展示锚点，
    // 不再写进 at。真实写入时间由 clock() 提供。
    return new Date(`${day}T12:00:00+08:00`).toISOString();
  }

  async function diaryToolWrite(input = {}) {
    await ensureReady();
    const mode = ['create', 'append', 'revise'].includes(input.mode) ? input.mode : 'create';
    const today = diaryToday();
    const targetDay = /^\d{4}-\d{2}-\d{2}$/.test(String(input.day ?? '')) ? String(input.day) : today;
    const body = String(input.text ?? '').trim();
    if (!body) return { ok: false, reason: 'empty-text' };
    const diff = Math.round((Date.parse(`${today}T00:00:00+08:00`) - Date.parse(`${targetDay}T00:00:00+08:00`)) / 86400000);
    const rows = await store.listDiaries();
    const dayRows = rows.filter(row => row.day === targetDay && !row.archived);

    if (mode === 'create') {
      if (diff < 0) return { ok: false, reason: 'future-day', detail: '不能写未来的日记' };
      if (diff > 1) return { ok: false, reason: 'too-old', detail: '只能补写前一天的日记' };
      const baseId = `d-${targetDay.replaceAll('-', '')}`;
      let id = /^d-[0-9a-z-]{6,64}$/.test(String(input.id ?? '')) ? String(input.id) : null;
      if (!id) {
        id = baseId;
        for (let i = 2; dayRows.some(row => row.id === id); i += 1) id = `${baseId}-${i}`;
      }
      const writtenAt = new Date(clock()).toISOString();
      const result = createDiary(store.root, { id, day: targetDay, text: body, mood: String(input.mood ?? ''), at: writtenAt });
      return { ...result, day: targetDay, stamp: writtenAt };
    }

    if (diff !== 0) return { ok: false, reason: 'locked', detail: '只有当天的日记可以修改' };
    const entry = dayRows[dayRows.length - 1] ?? null;
    if (!entry) return { ok: false, reason: 'no-diary-today' };
    const current = await store.readDiary(entry.id);
    if (current === null) return { ok: false, reason: 'read-failed' };
    const nextText = mode === 'append' ? `${String(current).trimEnd()}\n\n${body}` : body;
    return reviseDiary(store.root, { reviseOf: entry.id, text: nextText, mood: String(input.mood ?? ''), at: new Date(clock()).toISOString() });
  }

  async function diaryToolList({ limit = 30 } = {}) {
    await ensureReady();
    const today = diaryToday();
    const rows = await store.listDiaries();
    return rows.slice(0, Math.max(1, Math.min(100, Number(limit) || 30))).map(row => ({
      id: row.id,
      day: row.day,
      chars: row.chars ?? null,
      revision: row.revision ?? null,
      archived: row.archived === true,
      writable: row.day === today
    }));
  }

  async function diaryToolRead({ id, history = false } = {}) {
    await ensureReady();
    const text = await store.readDiary(String(id ?? ''));
    if (text === null) return { ok: false, reason: 'not-found' };
    const entry = (await store.listDiaries()).find(row => row.id === id) ?? null;
    const hist = history
      ? readDiaryHistory(store.root, String(id)).slice(-5).map(row => ({
          at: row.at ?? null,
          revision: row.revision ?? null,
          action: row.action ?? null,
          body: String(row.body ?? '').slice(0, 1200)
        }))
      : undefined;
    return { ok: true, id, day: entry?.day ?? null, updatedAt: entry?.updatedAt ?? null, revision: entry?.revision ?? null, text, ...(history ? { history: hist } : {}) };
  }

  async function activity({ limit = 50 } = {}) {
    await ensureReady();
    const size = Math.min(Math.max(Number(limit) || 50, 1), ACTIVITY_TAIL_MAX);
    return store.memory.activity.slice(-size).map(row => ({ ...row }));
  }

  // 只读诊断：取最近若干次循环的阶段摘要，可按 eventId 过滤。
  async function trace({ eventId = null, limit = 20 } = {}) {
    await ensureReady();
    const size = Math.min(Math.max(Number(limit) || 20, 1), 200);
    const rows = await store.readTraces({ limit: 500 });
    const filtered = eventId ? rows.filter(row => row.eventId === eventId) : rows;
    return filtered.slice(-size);
  }

  // 备份/迁移：导出 ZIP；导入前先预览，目标非空时默认拒绝。
  async function exportData({ includeActivity = false, includeTrace = false } = {}) {
    await ensureReady();
    const { buffer, manifest } = await exportArchive({ root: stateRoot, includeActivity, includeTrace, clock });
    const stamp = new Date(clock()).toISOString().slice(0, 10).replace(/-/g, '');
    return {
      filename: `cognition-backup-${stamp}.zip`,
      base64: buffer.toString('base64'),
      bytes: buffer.length,
      manifest
    };
  }

  async function previewDataImport({ base64 } = {}) {
    await ensureReady();
    if (typeof base64 !== 'string' || !base64) throw new Error('previewDataImport: 缺少备份内容');
    const buffer = Buffer.from(base64, 'base64');
    return previewImport({ root: stateRoot, buffer });
  }

  async function importData({ base64, mode = 'empty-only' } = {}) {
    if (disposed) throw new Error('认知内核已关闭');
    if (running || pending.length > 0) throw new Error('导入前需要内核空闲：请等待当前事件处理完成');
    await ensureReady();
    if (typeof base64 !== 'string' || !base64) throw new Error('importData: 缺少备份内容');
    const buffer = Buffer.from(base64, 'base64');
    const result = await importArchive({ root: stateRoot, buffer, mode, clock });
    await store.reload();
    recent = new Set(store.memory.recentEventIds);
    return result;
  }

  // 费用可观测：只记录，不设配额、不阻断正常实验。
  async function recordModelCall(entry = {}) {
    if (disposed) return;
    try {
      await ensureReady();
      await store.appendActivity({
        at: new Date(clock()).toISOString(),
        kind: 'model-call',
        provider: entry.provider ?? null,
        model: entry.model ?? null,
        ok: entry.ok === true,
        ms: Number.isFinite(entry.ms) ? entry.ms : null,
        usage: entry.usage ?? null,
        error: entry.error ?? null
      });
    } catch (error) {
      logger?.warn?.('[cognition] 模型费用记录失败', { error: error?.message });
    }
  }

  async function reflectNow() {
    await ensureReady();
    if (!resolvedReflector) return { status: 'disabled', calls: 0 };
    return resolvedReflector.processNow();
  }

  async function traits() {
    await ensureReady();
    return activeTraits(store.behavior.personality, { limit: 24, minConfidence: 0 });
  }

  async function journalNow({ day = null, force = false } = {}) {
    await ensureReady();
    if (!resolvedJournal) return { ok: false, status: 'disabled' };
    return resolvedJournal.processNow({ day, force });
  }

  async function archiveJournal() {
    await ensureReady();
    if (!resolvedJournal) return { ok: false, status: 'disabled' };
    return resolvedJournal.archiveNow();
  }

  async function revertPersonalityTrait(id, toRevision = null) {
    await ensureReady();
    let reverted = null;
    let target = null;
    await store.saveBehavior(behavior => {
      const out = revertTrait(behavior.personality, id, { now: clock(), toRevision });
      behavior.personality = out.personality;
      reverted = out.reverted;
      target = out.toRevision ?? null;
    });
    if (!reverted) return { reverted: null };
    await store.appendActivity({ at: clock(), kind: 'trait-reverted', traitId: reverted, toRevision: target });
    await store.appendPersonalityRevision?.({
      at: clock(),
      kind: 'revert',
      traitId: reverted,
      toRevision: target,
      revision: store.behavior.personality.revision,
      items: store.behavior.personality.items
    });
    return { reverted, toRevision: target };
  }

  async function disablePersonalityTrait(id, reason = 'manual') {
    await ensureReady();
    let disabled = null;
    await store.saveBehavior(behavior => {
      const out = disableTrait(behavior.personality, id, { now: clock(), reason });
      behavior.personality = out.personality;
      disabled = out.disabled;
    });
    if (!disabled) return { disabled: null };
    await store.appendActivity({ at: clock(), kind: 'trait-disabled', traitId: disabled, reason });
    await store.appendPersonalityRevision?.({
      at: clock(),
      kind: 'disable',
      traitId: disabled,
      reason,
      revision: store.behavior.personality.revision,
      items: store.behavior.personality.items
    });
    return { disabled };
  }

  async function dispose() {
    if (disposed) return;
    await idle();
    disposed = true;
    if (alarmTimer) { clearInterval(alarmTimer); alarmTimer = null; }
    resolvedExtractor?.dispose?.();
    resolvedReflector?.dispose?.();
    resolvedJournal?.dispose?.();
    await store.dispose();
  }

  return {
    schema: 1,
    onEvent,
    status,
    persona: async () => {
      await ensureReady();
      const view = personaView(store, { now: clock() });
      const items = Array.isArray(store.behavior?.personality?.items) ? store.behavior.personality.items : [];
      return {
        ...view,
        tendencies: items.slice(-24).map(item => ({
          label: item.label,
          statement: item.statement,
          confidence: item.confidence,
          status: item.status,
          support: Array.isArray(item.support) ? item.support.length : 0,
          updatedAt: item.updatedAt ?? null
        }))
      };
    },
    chronicleList: async ({ limit = 30 } = {}) => {
      await ensureReady();
      return listChronicle(store, { limit });
    },
    chronicleRead: async id => {
      await ensureReady();
      return readChronicle(store, id);
    },
    identity: async () => {
      await ensureReady();
      return store.self.identity ? { ...store.self.identity } : null;
    },
    setIdentity,
    memories,
    diaryList,
    diaryRead,
    diaryToolWrite,
    diaryToolList,
    diaryToolRead,
    alarmToolSet,
    alarmToolList,
    alarmToolRemove,
    checkAlarms,
    activity,
    trace,
    proposals,
    applyProposal,
    dismissProposal,
    exportData,
    previewDataImport,
    importData,
    recordModelCall,
    reflectNow,
    journalNow,
    archiveJournal,
    traits,
    backfillTraits: backfillPersonalityTraits,
    revertTrait: revertPersonalityTrait,
    disableTrait: disablePersonalityTrait,
    idle,
    dispose,
    get queueLimit() {
      return queueLimit;
    },
    get capacity() {
      return capacity;
    }
  };
}
