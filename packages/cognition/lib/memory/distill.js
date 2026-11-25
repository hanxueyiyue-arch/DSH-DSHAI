// 浏览经历提炼：把 observation 压成一条短的 fact，写进同一个 memory.json。
// 不新增存储位置；用 source.fromMemoryId 指回原文，保证可追溯、不重复提炼。
import { addMemory } from './write.js';

const DISTILL_DELAY_MS = 1500;
const DISTILL_BATCH_SIZE = 2;

export function createDistiller({
  distillTurn,
  store,
  clock = () => Date.now(),
  delayMs = DISTILL_DELAY_MS,
  batchSize = DISTILL_BATCH_SIZE,
  capacity = 5000,
  timeZone = '',
  logger = console
} = {}) {
  if (typeof distillTurn !== 'function') throw new Error('createDistiller: 缺少 distillTurn');
  if (!store) throw new Error('createDistiller: 缺少 store');

  const pending = [];
  let timer = null;
  let running = false;
  let disposed = false;

  const memories = () => (Array.isArray(store.memory?.memories) ? store.memory.memories : []);
  const alreadyDistilled = id => memories().some(row => row?.source?.fromMemoryId === id);

  function schedule(ms = delayMs) {
    if (disposed || timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush().catch(error => logger?.warn?.('[cognition] 浏览提炼失败', { error: error?.message }));
    }, Math.max(0, ms));
    timer.unref?.();
  }

  function enqueue(row) {
    if (disposed || !row || row.kind !== 'observation') return false;
    if (alreadyDistilled(row.id)) return false;
    if (!pending.some(item => item.id === row.id)) pending.push(row);
    schedule();
    return true;
  }

  async function flush() {
    if (running || disposed || pending.length === 0) return [];
    running = true;
    const batch = pending.splice(0, Math.max(1, batchSize));
    try {
      const observations = batch.map(row => ({
        id: row.id,
        title: String(row.title ?? '').slice(0, 80),
        content: String(row.content ?? '').slice(0, 600)
      }));
      let items = [];
      try {
        items = await distillTurn({ observations });
      } catch (error) {
        // 失败不重排：这些原文还在记忆里，下次浏览会重新触发；不制造重试风暴。
        await store.appendActivity({ at: clock(), kind: 'observation-distill-failed', reason: String(error?.message ?? error).slice(0, 160) });
        return [];
      }
      const now = clock();
      const created = [];
      for (const item of Array.isArray(items) ? items : []) {
        const source = batch.find(row => row.id === item?.fromId) ?? batch[0];
        const title = String(item?.title ?? '').trim().slice(0, 40);
        const content = String(item?.content ?? '').trim().slice(0, 300);
        if (!title || !content || !source) continue;
        if (alreadyDistilled(source.id)) continue;
        const tags = Array.isArray(item?.tags)
          ? item.tags.filter(tag => typeof tag === 'string' && tag.trim()).slice(0, 3).map(tag => tag.trim())
          : ['浏览'];
        const row = addMemory(store.memory, {
          kind: 'fact',
          layer: 'episodic',
          title,
          content,
          tags,
          importance: 3,
          source: {
            level: 'observation-distilled',
            channel: 'distill',
            fromMemoryId: source.id,
            fromTitle: String(source.title ?? '').slice(0, 80)
          },
          occurredAt: now
        }, { now, capacity, timeZone });
        created.push(row);
      }
      if (created.length > 0) await store.saveMemory(() => undefined);
      await store.appendActivity({
        at: now,
        kind: created.length > 0 ? 'observation-distilled' : 'observation-distill-empty',
        count: created.length,
        memoryIds: created.map(row => row.id)
      });
      return created;
    } finally {
      running = false;
      if (pending.length > 0) schedule(0);
    }
  }

  function dispose() {
    disposed = true;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return {
    enqueue,
    flush,
    processNow: flush,
    dispose,
    pendingCount: () => pending.length
  };
}
