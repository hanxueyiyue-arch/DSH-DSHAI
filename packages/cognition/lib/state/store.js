// 单状态根：加载、原子保存、经历/活动追加。
// 所有写操作串行；读取直接返回内存中的当前对象。

import { join } from 'node:path';
import { mkdir, readdir, rename, stat } from 'node:fs/promises';
import { readJson, readText, writeJsonAtomic, appendJsonl } from './atomic.js';
import { ACTIVITY_TAIL_MAX, blankBehavior, blankMemory, blankSelf, normalizeBehavior, normalizeMemory, normalizeSelf } from './schema.js';
import { acquireLock } from '../host/lock.js';
import { appendEventOnce, loadGraph, readEvents, rebuild } from '../memory/assoc-store.js';
import { scanDiaries, readDiary as readJournalDiary } from '../memory/journal-store.js';

const monthOf = timestamp => {
  const date = new Date(Number.isFinite(timestamp) ? timestamp : Date.now());
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
};

export function createStore({
  root,
  clock = () => Date.now(),
  lock = true,
  eventLogMaxBytes = 4 * 1024 * 1024
} = {}) {
  if (!root) throw new Error('createStore: 缺少状态根');

  const paths = {
    self: join(root, 'self.json'),
    memory: join(root, 'memory.json'),
    behavior: join(root, 'behavior.json'),
    skills: join(root, 'skills', 'tool-usage.json'),
    alarms: join(root, 'schedule', 'alarms.json'),
    lock: join(root, 'run.lock')
  };
  const dirs = {
    experience: join(root, 'experience'),
    diary: join(root, 'diary'),
    archive: join(root, 'archive'),
    activity: join(root, 'activity'),
    trace: join(root, 'trace'),
    events: join(root, 'events'),
    associations: join(root, 'associations'),
    personality: join(root, 'personality'),
    skills: join(root, 'skills'),
    schedule: join(root, 'schedule')
  };

  let self = null;
  let memory = null;
  let behavior = null;
  let lockHandle = null;
  let eventLogSeq = 0;
  let ensurePromise = null;
  let tail = Promise.resolve();
  const nowIso = () => new Date(clock()).toISOString();

  function serialize(task) {
    const next = tail.then(task, task);
    tail = next.catch(() => undefined);
    return next;
  }

  async function ensure() {
    if (!ensurePromise) {
      ensurePromise = (async () => {
        await Promise.all([
          mkdir(dirs.experience, { recursive: true }),
          mkdir(dirs.diary, { recursive: true }),
          mkdir(dirs.archive, { recursive: true }),
          mkdir(dirs.activity, { recursive: true }),
          mkdir(dirs.trace, { recursive: true }),
          mkdir(dirs.events, { recursive: true }),
          mkdir(dirs.associations, { recursive: true }),
          mkdir(dirs.personality, { recursive: true }),
          mkdir(dirs.skills, { recursive: true }),
          mkdir(dirs.schedule, { recursive: true })
        ]);
        if (lock) lockHandle = await acquireLock(paths.lock, { clock });

        const loadedSelf = await readJson(paths.self);
        const loadedMemory = await readJson(paths.memory);
        const loadedBehavior = await readJson(paths.behavior);

        self = loadedSelf === null ? blankSelf() : normalizeSelf(loadedSelf);
        memory = loadedMemory === null ? blankMemory() : normalizeMemory(loadedMemory);
        behavior = loadedBehavior === null ? blankBehavior(clock()) : normalizeBehavior(loadedBehavior);

        if (loadedSelf === null) await writeJsonAtomic(paths.self, self);
        if (loadedMemory === null) await writeJsonAtomic(paths.memory, memory);
        if (loadedBehavior === null) await writeJsonAtomic(paths.behavior, behavior);
      })();
    }
    return ensurePromise;
  }

  async function saveSelf(mutator) {
    await ensure();
    return serialize(async () => {
      mutator(self);
      self.updatedAt = nowIso();
      await writeJsonAtomic(paths.self, self);
      return self;
    });
  }

  async function saveMemory(mutator) {
    await ensure();
    return serialize(async () => {
      mutator(memory);
      memory.updatedAt = nowIso();
      await writeJsonAtomic(paths.memory, memory);
      return memory;
    });
  }

  async function saveBehavior(mutator) {
    await ensure();
    return serialize(async () => {
      mutator(behavior);
      behavior.updatedAt = nowIso();
      await writeJsonAtomic(paths.behavior, behavior);
      return behavior;
    });
  }

  // 工具使用印象：独立小文件，不设上限、不做衰减（见 capability/skills.js）
  let skills = null;
  async function readSkills() {
    await ensure();
    if (skills === null) {
      const loaded = await readJson(paths.skills);
      skills = loaded ?? { schema: 1, updatedAt: nowIso(), items: [] };
    }
    return skills;
  }

  async function saveSkills(mutator) {
    await ensure();
    return serialize(async () => {
      const current = skills ?? await readJson(paths.skills) ?? { schema: 1, updatedAt: nowIso(), items: [] };
      skills = typeof mutator === 'function' ? mutator(current) : current;
      skills.updatedAt = nowIso();
      await writeJsonAtomic(paths.skills, skills);
      return skills;
    });
  }

  // 闹钟/日程：独立小文件 schedule/alarms.json
  let alarms = null;
  async function readAlarms() {
    await ensure();
    if (alarms === null) {
      const loaded = await readJson(paths.alarms);
      alarms = loaded ?? { schema: 1, updatedAt: nowIso(), lastCheckAt: 0, items: [] };
    }
    return alarms;
  }

  async function saveAlarms(mutator) {
    await ensure();
    return serialize(async () => {
      const current = alarms ?? await readJson(paths.alarms) ?? { schema: 1, updatedAt: nowIso(), lastCheckAt: 0, items: [] };
      alarms = typeof mutator === 'function' ? mutator(current) : current;
      alarms.updatedAt = nowIso();
      await writeJsonAtomic(paths.alarms, alarms);
      return alarms;
    });
  }

  async function appendExperience(event) {
    await ensure();
    const at = Number.isFinite(event?.at) ? event.at : clock();
    await appendJsonl(join(dirs.experience, `${monthOf(at)}.jsonl`), {
      schema: 1,
      kind: 'event',
      receivedAt: clock(),
      event
    });
  }

  async function readExperience() {
    await ensure();
    let files = [];
    try {
      files = await readdir(dirs.experience);
    } catch {
      return [];
    }
    const records = [];
    for (const file of files.filter(name => name.endsWith('.jsonl')).sort()) {
      let text = '';
      try {
        text = await readText(join(dirs.experience, file));
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (record?.event?.id) records.push(record);
        } catch {
          // 损坏行跳过；反思会因缺少原始证据而拒绝提交。
        }
      }
    }
    return records;
  }

  async function appendActivity(row) {
    await ensure();
    const at = Number.isFinite(row?.at) ? row.at : clock();
    const entry = { schema: 1, ...row, at };
    await appendJsonl(join(dirs.activity, `${monthOf(at)}.jsonl`), entry);
    await saveMemory(memory => {
      memory.activity.push(entry);
      memory.activity = memory.activity.slice(-ACTIVITY_TAIL_MAX);
    });
    return entry;
  }

  // 事件收发日志（R3）：先落盘再向调用方确认，重启后据此恢复未完成事件。
  // 日志只追加，最新状态由读取端按 id 归并；不把日志当作第二份认知状态。
  // 超过单段容量时改名分段，绝不删除历史；读取端按段顺序归并。
  async function appendEventRecord(event, { status = 'pending', detail = null } = {}) {
    await ensure();
    const at = Number.isFinite(event?.at) ? event.at : clock();
    const entry = {
      schema: 1,
      id: String(event?.id ?? ''),
      status,
      at,
      recordedAt: clock(),
      ...(detail ? { detail } : {}),
      event
    };
    const logPath = join(dirs.events, 'log.jsonl');
    const info = await stat(logPath).catch(() => null);
    if (info && info.size >= eventLogMaxBytes) {
      const stamp = new Date(clock()).toISOString().replace(/[:.]/g, '-');
      const seq = String(eventLogSeq).padStart(6, '0');
      eventLogSeq += 1;
      await rename(logPath, join(dirs.events, `log-${stamp}-${seq}.jsonl`));
    }
    await appendJsonl(logPath, entry);
    return entry;
  }

  async function readEventLog() {
    await ensure();
    const byId = new Map();
    const names = (await readdir(dirs.events))
      .filter(name => name === 'log.jsonl' || /^log-.*\.jsonl$/.test(name))
      .sort();
    for (const name of names) {
      const text = await readText(join(dirs.events, name));
      if (!text) continue;
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          if (!row?.id) continue;
          byId.set(row.id, row);
        } catch {
          // 损坏行忽略；原始日志仍在磁盘上可人工检查。
        }
      }
    }
    return byId;
  }

  // 待回执行动的持久化日志：内存视图只是尾部缓存，恢复以这里为准。
  async function appendAssociationEvent(event) {
    await ensure();
    return appendEventOnce(dirs.associations, event);
  }

  /** P7 人格修订的 append-only 审计流；behavior.json 只是当前视图。 */
  async function appendPersonalityRevision(row) {
    await ensure();
    const entry = { schema: 1, recordedAt: nowIso(), ...row };
    await appendJsonl(join(dirs.personality, 'revisions.jsonl'), entry);
    return entry;
  }

  function readAssociationEvents() {
    return readEvents(dirs.associations);
  }

  function loadAssociationGraph() {
    return loadGraph(dirs.associations);
  }

  async function rebuildAssociations() {
    await ensure();
    return rebuild(dirs.associations);
  }

  async function appendPendingAction(entry) {
    await ensure();
    await appendJsonl(join(dirs.events, 'pending-actions.jsonl'), {
      schema: 1,
      op: 'pending',
      at: clock(),
      actionId: entry.actionId,
      correlationId: entry.correlationId,
      entry
    });
    return entry;
  }

  async function appendPendingResolved({ actionId, correlationId, outcome = 'resolved' }) {
    await ensure();
    await appendJsonl(join(dirs.events, 'pending-actions.jsonl'), {
      schema: 1,
      op: 'resolved',
      at: clock(),
      actionId,
      correlationId,
      outcome
    });
  }

  async function readPendingActions() {
    await ensure();
    const text = await readText(join(dirs.events, 'pending-actions.jsonl'));
    const byAction = new Map();
    if (!text) return [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row?.op === 'pending' && row.entry?.actionId) {
          byAction.set(row.entry.actionId, row.entry);
        } else if (row?.op === 'resolved' && row.actionId) {
          byAction.delete(row.actionId);
        }
      } catch {
        // 损坏行忽略；不删原文件。
      }
    }
    return [...byAction.values()];
  }

  async function readDiary(id) {
    await ensure();
    const got = readJournalDiary(root, id);
    if (got.ok) return got.text;
    // 兼容旧布局：diary/<id>.md 没有 index.json。
    return readText(join(dirs.diary, `${id}.md`));
  }

  async function listDiaries() {
    await ensure();
    const rows = scanDiaries(root);
    if (rows.length > 0) return rows;
    const at = clock();
    return (memory.diaryIndex ?? []).map(row => ({
      id: row.id,
      date: row.date,
      title: row.title,
      revision: 0,
      bytes: 0,
      archived: false,
      createdAt: row.createdAt ?? at,
      updatedAt: row.updatedAt ?? at
    }));
  }

  // 验收需要：每次循环的阶段摘要单独存，失败时能定位断在召回还是决策。
  async function appendTrace(trace) {
    await ensure();
    const at = Number.isFinite(trace?.at) ? trace.at : clock();
    const entry = { schema: 1, ...trace, at };
    await appendJsonl(join(dirs.trace, `${monthOf(at)}.jsonl`), entry);
    return entry;
  }

  async function readTraces({ limit = 20 } = {}) {
    await ensure();
    const size = Math.min(Math.max(Number(limit) || 20, 1), 500);
    const names = (await readdir(dirs.trace)).filter(name => name.endsWith('.jsonl')).sort();
    const rows = [];
    for (const name of names) {
      const text = await readText(join(dirs.trace, name));
      if (!text) continue;
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          rows.push(JSON.parse(line));
        } catch {
          // 单行损坏不拖垮验收读取；文件本身仍按 jsonl 追加。
        }
      }
    }
    return rows.slice(-size);
  }

  // 归档不是删除：行原样写进 archive/YYYY-MM.jsonl，之后从活跃池移走。
  async function archiveMemories(entries, { at = clock() } = {}) {
    await ensure();
    const list = Array.isArray(entries) ? entries.filter(entry => entry?.id) : [];
    if (list.length === 0) return { archived: [] };
    return serialize(async () => {
      const reasons = new Map(list.map(entry => [entry.id, entry.reason || 'maintenance']));
      const rows = memory.memories.filter(row => reasons.has(row.id));
      if (rows.length === 0) return { archived: [] };
      for (const row of rows) {
        await appendJsonl(join(dirs.archive, `${monthOf(at)}.jsonl`), {
          schema: 1,
          kind: 'memory',
          archivedAt: at,
          reason: reasons.get(row.id),
          memory: row
        });
      }
      const archivedIds = new Set(rows.map(row => row.id));
      memory.memories = memory.memories.filter(row => !archivedIds.has(row.id));
      memory.counters.archived = (Number(memory.counters.archived) || 0) + rows.length;
      memory.counters.lastMaintenanceAt = at;
      memory.updatedAt = nowIso();
      await writeJsonAtomic(paths.memory, memory);
      return { archived: rows.map(row => row.id), at };
    });
  }

  async function dispose() {
    await tail.catch(() => undefined);
    await lockHandle?.release();
    lockHandle = null;
  }

  // 从磁盘重新加载三份状态（导入备份后使用）。
  async function reload() {
    await ensure();
    return serialize(async () => {
      const [loadedSelf, loadedMemory, loadedBehavior] = await Promise.all([
        readJson(paths.self),
        readJson(paths.memory),
        readJson(paths.behavior)
      ]);
      self = loadedSelf === null ? blankSelf() : normalizeSelf(loadedSelf);
      memory = loadedMemory === null ? blankMemory() : normalizeMemory(loadedMemory);
      behavior = loadedBehavior === null ? blankBehavior(clock()) : normalizeBehavior(loadedBehavior);
    });
  }

  return {
    root,
    paths,
    dirs,
    ensure,
    saveSelf,
    saveMemory,
    saveBehavior,
    readSkills,
    saveSkills,
    readAlarms,
    saveAlarms,
    appendExperience,
    readExperience,
    appendEventRecord,
    readEventLog,
    appendAssociationEvent,
    appendPersonalityRevision,
    readAssociationEvents,
    loadAssociationGraph,
    rebuildAssociations,
    appendPendingAction,
    appendPendingResolved,
    readPendingActions,
    appendActivity,
    readDiary,
    listDiaries,
    appendTrace,
    readTraces,
    archiveMemories,
    reload,
    dispose,
    get self() {
      return self;
    },
    get memory() {
      return memory;
    },
    get behavior() {
      return behavior;
    }
  };
}

