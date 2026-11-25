// 异步记忆抽取：每轮结束后合并一小批，交给注入的 extractTurn（模型或测试替身）。
// 只产出候选，落盘前仍走 write.addMemory 的校验、去重与容量；失败不阻塞聊天。
//
// 失败语义（R1）：
// - 模型超时/报错/输出不是数组：整批 episode 都不标 extractedAt，不推进 lastAt；
// - 成功但没有候选：整批标 extractedAt，outcome=empty，lastAt 正常推进；
// - 成功且有候选：写入记忆后标 extractedAt，outcome=created；
// - 失败会写 memory-extract-failed，并保留 episode 的尝试次数与最后错误，供下次启动/手动重试。

import { addMemory } from './write.js';

export const EXTRACT_KINDS = Object.freeze(['fact', 'inference', 'uncertain']);
export const EXTRACT_BATCH_SIZE = 3;
export const EXTRACT_DELAY_MS = 30_000;
export const EXTRACT_RETRY_DELAY_MS = 60_000;
export const EXTRACT_MAX_AUTO_ATTEMPTS = 3;

function reasonOf(error) {
  const message = String(error?.message ?? error ?? 'unknown');
  return message.slice(0, 200);
}

// P1-B：抽取的确定性校验。
// 模型可能把「我不太喜欢别人叫我老板」记成「我叫老板」——否定丢失即语义反转。
// 这里用模型给出的 quote 与原文核对，再用否定词存在性做一次反向检查。
const NEGATION_CUES = /[不别没未无]|讨厌|不喜欢|不需要|拒绝|避免/;
const stripSpace = value => String(value ?? '').replace(/\s+/g, '').trim();

function validateCandidate(candidate, batch) {
  const content = String(candidate?.content ?? '');
  const title = String(candidate?.title ?? '');
  const quote = stripSpace(candidate?.quote);
  // 没给引文时不做否定检查，但仍记一个标记，便于观察模型是否遵守新契约。
  if (!quote) return { ok: true, quote: '', noQuote: true };
  const pool = batch.map(item => stripSpace(item?.userText)).filter(Boolean);
  if (!pool.some(text => text.includes(quote))) {
    return { ok: false, reason: 'quote-not-in-source', quote };
  }
  const quoteNegated = NEGATION_CUES.test(quote);
  const contentNegated = NEGATION_CUES.test(`${title} ${content}`);
  if (quoteNegated && !contentNegated) {
    return { ok: false, reason: 'negation-dropped', quote };
  }
  return { ok: true, quote };
}

export function createExtractor({
  extractTurn,
  store,
  clock = () => Date.now(),
  delayMs = EXTRACT_DELAY_MS,
  retryDelayMs = EXTRACT_RETRY_DELAY_MS,
  batchSize = EXTRACT_BATCH_SIZE,
  capacity = 5000,
  timeZone = '',
  logger = console
} = {}) {
  if (typeof extractTurn !== 'function') throw new Error('createExtractor: 缺少 extractTurn');
  if (!store) throw new Error('createExtractor: 缺少 store');

  const pending = [];
  let timer = null;
  let running = false;
  let disposed = false;

  function schedule(ms = delayMs) {
    if (disposed || timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush().catch(error => logger?.warn?.('[cognition] 记忆抽取失败', { error: error?.message }));
    }, Math.max(0, ms));
    timer.unref?.();
  }

  function enqueue(episode) {
    if (disposed || !episode || episode.kind !== 'turn' || episode.extractedAt) return;
    if (!pending.some(item => item.id === episode.id)) pending.push(episode);
    schedule();
  }

  // 启动时补跑停机期间没抽的轮次（不止最近三轮），并带上之前失败、尚未成功的轮次。
  function catchUp(limit = 50) {
    const list = Array.isArray(store.memory?.episodes) ? store.memory.episodes : [];
    const missed = list
      .filter(item => item.kind === 'turn' && !item.extractedAt)
      .sort((a, b) => (Number(a?.at) || 0) - (Number(b?.at) || 0))
      .slice(0, Math.max(0, limit));
    for (const episode of missed) {
      if (!pending.some(item => item.id === episode.id)) pending.push(episode);
    }
    if (pending.length > 0) schedule(0);
    return missed.length;
  }

  function retryFailed(limit = Number.POSITIVE_INFINITY) {
    for (const episode of Array.isArray(store.memory?.episodes) ? store.memory.episodes : []) {
      if (episode.kind !== 'turn' || episode.extractedAt) continue;
      if (!pending.some(item => item.id === episode.id)) pending.push(episode);
      if (pending.length >= limit) break;
    }
    if (pending.length > 0) schedule(0);
    return pending.length;
  }

  function markFailure(batch, reason) {
    const now = clock();
    for (const episode of batch) {
      const row = store.memory.episodes?.find(item => item.id === episode.id);
      if (!row) continue;
      row.extractAttempts = Number(row.extractAttempts || 0) + 1;
      row.lastExtractError = reason;
      row.lastExtractFailedAt = now;
    }
    return now;
  }

  async function flush() {
    if (running || disposed) return { extracted: 0, failed: 0 };
    running = true;
    try {
      let processed = 0;
      let extracted = 0;
      let failed = 0;
      while (pending.length > 0 && processed < batchSize) {
        const batch = pending.splice(0, Math.min(batchSize - processed, pending.length));
        let candidates;
        try {
          candidates = await extractTurn({
            episodes: batch.map(item => ({
              id: item.id,
              at: item.at,
              userText: item.userText,
              selfText: item.selfText
            }))
          });
          if (!Array.isArray(candidates)) throw new Error('extract-result-not-array');
        } catch (error) {
          const reason = reasonOf(error);
          const now = markFailure(batch, reason);
          for (const episode of batch) {
            const row = store.memory.episodes?.find(item => item.id === episode.id);
            const attempts = Number(row?.extractAttempts || 0);
            if (!disposed && attempts < EXTRACT_MAX_AUTO_ATTEMPTS) pending.push(episode);
          }
          await store.saveMemory(() => undefined);
          await store.appendActivity({
            at: now,
            kind: 'memory-extract-failed',
            episodes: batch.length,
            episodeIds: batch.map(item => item.id),
            reason
          });
          failed += batch.length;
          processed += batch.length;
          logger?.warn?.('[cognition] 抽取模型失败，保留待重试', { reason, episodes: batch.length });
          break;
        }

        const list = candidates.slice(0, 3);
        const now = clock();
        let created = 0;
        const rejected = [];
        const noQuote = [];
        for (const candidate of list) {
          const checked = validateCandidate(candidate, batch);
          if (!checked.ok) {
            rejected.push({
              reason: checked.reason,
              title: String(candidate?.title ?? '').slice(0, 40)
            });
            continue;
          }
          if (checked.noQuote) noQuote.push(String(candidate?.title ?? '').slice(0, 40));
          const kind = EXTRACT_KINDS.includes(candidate?.kind) ? candidate.kind : 'fact';
          const first = batch[0];
          const result = addMemory(
            store.memory,
            {
              kind,
              layer: candidate?.layer === 'preference' ? 'preference' : 'episodic',
              title: String(candidate?.title ?? '').slice(0, 120),
              content: String(candidate?.content ?? '').slice(0, 2000),
              tags: Array.isArray(candidate?.tags) ? candidate.tags : ['抽取'],
              importance: Number(candidate?.importance) || 3,
              confidence: Math.min(1, Math.max(0, Number(candidate?.confidence) || 0.6)),
              source: {
                level: 'model-extraction',
                channel: 'model',
                messageId: first?.eventIds?.[0] ?? first?.id ?? null,
                episodeId: first?.id ?? null,
                ...(checked.quote ? { quote: checked.quote.slice(0, 200) } : {})
              },
              occurredAt: first?.at ?? now
            },
            { now, capacity, timeZone }
          );
          if (result.ok) created += 1;
        }
        if (rejected.length > 0) {
          await store.appendActivity({
            at: now,
            kind: 'memory-candidate-rejected',
            rejected,
            episodeIds: batch.map(item => item.id)
          });
          logger?.warn?.('[cognition] 抽取候选未通过校验', { rejected });
        }
        if (noQuote.length > 0) {
          await store.appendActivity({
            at: now,
            kind: 'memory-candidate-no-quote',
            titles: noQuote
          });
        }
        for (const episode of batch) {
          const row = store.memory.episodes?.find(item => item.id === episode.id);
          if (!row) continue;
          row.extractedAt = now;
          row.extractOutcome = list.length > 0 ? 'created' : 'empty';
          delete row.lastExtractError;
          delete row.lastExtractFailedAt;
        }
        store.memory.extract = { lastAt: now };
        store.memory.counters.extracted = Number(store.memory.counters.extracted || 0) + created;
        await store.saveMemory(() => undefined);
        await store.appendActivity({
          at: now,
          kind: 'memory-extracted',
          outcome: list.length > 0 ? 'created' : 'empty',
          episodes: batch.length,
          created
        });
        extracted += created;
        processed += batch.length;
      }
      if (pending.length > 0) schedule(failed > 0 ? retryDelayMs : delayMs);
      return { extracted, failed, processed };
    } finally {
      running = false;
      if (pending.length > 0 && !timer) schedule(delayMs);
    }
  }

  function dispose() {
    disposed = true;
    if (timer) clearTimeout(timer);
    timer = null;
    pending.length = 0;
  }

  return { enqueue, catchUp, retryFailed, flush, dispose, pendingCount: () => pending.length };
}
