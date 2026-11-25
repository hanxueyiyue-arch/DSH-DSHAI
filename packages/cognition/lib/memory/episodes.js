// 经历卡：把“谁说了什么、她做了什么、结果如何”压成可注入的短卡。
// 只是 experience 的投影；experience 仍是原文真源，这里允许裁剪、允许重建。

export const EPISODE_LIMIT = 200;
export const EPISODE_KINDS = Object.freeze(['turn', 'action', 'observation', 'decision', 'maintenance']);

function text(value, max = 500) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

export function normalizeEpisode(input) {
  if (!input || typeof input !== 'object') return null;
  const kind = String(input.kind ?? '');
  if (!EPISODE_KINDS.includes(kind)) return null;
  const at = Number(input.at);
  if (!Number.isFinite(at)) return null;
  const id = typeof input.id === 'string' && input.id !== '' ? input.id : `ep-${kind}-${at}`;
  return {
    id,
    kind,
    at,
    startedAt: Number.isFinite(Number(input.startedAt)) ? Number(input.startedAt) : at,
    endedAt: Number.isFinite(Number(input.endedAt)) ? Number(input.endedAt) : at,
    userText: text(input.userText, 300),
    selfText: text(input.selfText, 500),
    title: text(input.title, 80),
    content: text(input.content, 800),
    outcome: input.outcome && typeof input.outcome === 'object' ? input.outcome : null,
    memoryIds: Array.isArray(input.memoryIds) ? input.memoryIds.filter(item => typeof item === 'string').slice(0, 6) : [],
    eventIds: Array.isArray(input.eventIds) ? input.eventIds.filter(item => typeof item === 'string').slice(0, 6) : [],
    ...(Number.isFinite(Number(input.extractedAt)) ? { extractedAt: Number(input.extractedAt) } : {})
  };
}

export function appendEpisode(memory, input, { limit = EPISODE_LIMIT } = {}) {
  if (!memory || typeof memory !== 'object') return null;
  const row = normalizeEpisode(input);
  if (!row) return null;
  const list = Array.isArray(memory.episodes) ? memory.episodes : (memory.episodes = []);
  const existing = list.find(item => item.id === row.id);
  if (existing) return existing;
  list.push(row);
  if (list.length > limit) memory.episodes = list.slice(-limit);
  return row;
}

function clip(value, max) {
  const str = String(value ?? '');
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

// 最近 K 张卡，按时间升序；超出字符预算时从最旧开始丢。
export function recentEpisodes(memory, { k = 12, maxChars = 2400 } = {}) {
  const list = Array.isArray(memory?.episodes) ? memory.episodes : [];
  const picked = [];
  let used = 0;
  for (let index = list.length - 1; index >= 0 && picked.length < k; index -= 1) {
    const row = list[index];
    const line = clip(
      row.kind === 'turn'
        ? `用户：${row.userText || '（主动开口）'} / 我：${row.selfText || '（没有回复）'}${row.outcome?.ok === false ? '（发送失败）' : ''}`
        : row.kind === 'decision'
          ? `用户：${row.userText || '（主动）'} / 我：没有开口（${row.content || row.title || '未说明原因'}）`
          : `${row.title || row.kind}${row.content ? `：${row.content}` : ''}`,
      320
    );
    if (used + line.length > maxChars && picked.length > 0) break;
    used += line.length;
    picked.push({
      id: row.id,
      kind: row.kind,
      at: row.at,
      userText: row.userText,
      selfText: row.selfText,
      title: row.title,
      outcome: row.outcome,
      line
    });
  }
  return picked.reverse();
}

// 未完成事项：已到期的追问、还没被回应/没被问的日程。
export function collectOpenLoops(memory, { now = Date.now(), limit = 5 } = {}) {
  const rows = Array.isArray(memory?.memories) ? memory.memories : [];
  const cared = new Set((Array.isArray(memory?.carePending) ? memory.carePending : []).map(item => item.memoryId));
  const loops = [];
  for (const row of rows) {
    if (!row || row.archivedAt || row.supersededBy) continue;
    if (Number.isFinite(row.followUpAt) && !row.followUpAskedAt) {
      loops.push({
        id: `loop-${row.id}`,
        memoryId: row.id,
        title: row.title,
        dueAt: row.followUpAt,
        state: row.followUpAt <= now ? 'due' : 'scheduled'
      });
    }
  }
  for (const c of Array.isArray(memory?.carePending) ? memory.carePending : []) {
    if (loops.some(item => item.memoryId === c.memoryId)) continue;
    const row = rows.find(item => item.id === c.memoryId);
    loops.push({
      id: `loop-${c.memoryId}-care`,
      memoryId: c.memoryId,
      title: row?.title ?? '一次等待回应的话',
      dueAt: Number(c.sentAt) || now,
      state: cared.has(c.memoryId) ? 'awaiting-reply' : 'pending'
    });
  }
  return loops
    .sort((a, b) => Number(a.dueAt) - Number(b.dueAt))
    .slice(0, limit);
}
