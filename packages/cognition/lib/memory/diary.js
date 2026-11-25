/**
 * P8 日记编排：证据收集 → 真实模型写作 → 校验 → 单写者提交 → 修订历史。
 *
 * 关键约束：
 *   - 每个项目自然日最多一份当前逻辑正文（同日只 revise，不新建第二篇）。
 *   - 正文 20 KiB（UTF-8 字节）硬上限；超限拒绝，不拆分绕过。
 *   - 事实引用必须是原始经历或当日记忆；insight/staged 不能当事实证据。
 *   - 提交失败不推进水位，不覆盖已有正文。
 *   - 每次成功提交追加 append-only 历史快照，供回退与审计。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  archiveDiaries,
  createDiary,
  DIARY_DIR,
  JOURNAL_LIMITS,
  projectDay,
  readDiary,
  reviseDiary,
  scanDiaries
} from './journal-store.js';

export const JOURNAL_DEFAULTS = Object.freeze({
  maxBytes: JOURNAL_LIMITS.diaryMaxBytes,
  debounceMs: 8_000,
  maxAttempts: 3,
  promptMemories: 12,
  promptInsights: 4,
  promptTraits: 4
});

const sha = text => createHash('sha256').update(String(text), 'utf8').digest('hex');
const bytesOf = text => Buffer.byteLength(String(text), 'utf8');

export function blankJournal() {
  return {
    lastDay: null,
    lastEvidenceHash: null,
    lastProcessedAt: null,
    lastAttempt: null,
    attempts: 0,
    archives: 0,
    pending: null
  };
}

export function normalizeJournal(value) {
  const base = blankJournal();
  if (!value || typeof value !== 'object') return base;
  return {
    lastDay: typeof value.lastDay === 'string' ? value.lastDay : null,
    lastEvidenceHash: typeof value.lastEvidenceHash === 'string' ? value.lastEvidenceHash : null,
    lastProcessedAt: Number.isFinite(Number(value.lastProcessedAt)) ? Number(value.lastProcessedAt) : null,
    lastAttempt: value.lastAttempt && typeof value.lastAttempt === 'object' ? value.lastAttempt : null,
    attempts: Number.isFinite(Number(value.attempts)) ? Number(value.attempts) : 0,
    archives: Number.isFinite(Number(value.archives)) ? Number(value.archives) : 0,
    pending: value.pending && typeof value.pending === 'object'
      && typeof value.pending.day === 'string'
      && typeof value.pending.bodySha === 'string'
      ? {
          day: value.pending.day,
          bodySha: value.pending.bodySha,
          evidenceHash: typeof value.pending.evidenceHash === 'string' ? value.pending.evidenceHash : null,
          at: Number(value.pending.at) || null
        }
      : null
  };
}

function shortEvent(event) {
  const text = typeof event?.payload?.text === 'string'
    ? event.payload.text
    : (typeof event?.payload?.summary === 'string' ? event.payload.summary : '');
  return {
    id: String(event?.id ?? ''),
    type: String(event?.type ?? 'unknown'),
    at: event?.at ?? null,
    // P2-A：区分"发送回执"和"真的调用过工具"。日记不许把 send 回执写成"我看了什么"。
    ...(event?.payload?.intentType ? { intentType: String(event.payload.intentType) } : {}),
    ...(text ? { text: text.slice(0, 600) } : {})
  };
}

// P2-A：日记里"我用了工具 / 去查过 / 去看过"这类叙述，必须有 invoke 类回执支撑。
// send 回执只证明"我说了话"，不能当成"我查过 / 看过"的证据。
export const TOOL_CLAIM_PATTERN = /(用了工具|用工具|调用工具|工具那边|工具没|没带回来|带回来什么|查了一下|查了查|搜了一下|搜了搜|看了一眼|点开了|浏览了|打开页面)/;

export function bodyClaimsUnevidencedAction(body, experiences = []) {
  const text = String(body ?? '');
  if (!TOOL_CLAIM_PATTERN.test(text)) return false;
  return !experiences.some(item => item?.type === 'tool-result' && item?.intentType === 'invoke');
}

export async function collectDayEvidence(store, day) {  const records = await store.readExperience();
  const experiences = records
    .map(record => record.event)
    .filter(event => event && projectDay(event.at) === day)
    .map(shortEvent)
    .filter(item => item.id);
  const memories = (store.memory.memories ?? [])
    .filter(row => row && Number.isFinite(Number(row.createdAt)) && projectDay(row.createdAt) === day)
    .map(row => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      content: String(row.content ?? '').slice(0, 800),
      source: row.source ?? null
    }));
  const insights = (store.memory.memories ?? [])
    .filter(row => row && row.kind === 'insight' && row.status === 'committed')
    .slice(-JOURNAL_DEFAULTS.promptInsights)
    .map(row => ({ id: row.id, title: row.title, content: String(row.content ?? '').slice(0, 600) }));
  const traits = (store.behavior.personality?.items ?? [])
    .filter(row => row && row.status === 'active' && Number(row.confidence) >= 0.55)
    .slice(0, JOURNAL_DEFAULTS.promptTraits)
    .map(row => ({ id: row.id, label: row.label, statement: row.statement, confidence: row.confidence }));
  return { experiences, memories, insights, traits };
}

export function evidenceHashOf(evidence) {
  const ids = [
    ...(evidence.experiences ?? []).map(item => `e:${item.id}`),
    ...(evidence.memories ?? []).map(item => `m:${item.id}`),
    ...(evidence.insights ?? []).map(item => `i:${item.id}`),
    ...(evidence.traits ?? []).map(item => `t:${item.id}`)
  ].sort();
  return sha(ids.join('|'));
}

export function createDailyJournal({
  store,
  journalTurn,
  now = () => Date.now(),
  maxBytes = JOURNAL_DEFAULTS.maxBytes,
  debounceMs = JOURNAL_DEFAULTS.debounceMs,
  onStage = null,
  logger = console
} = {}) {
  if (!store) throw new Error('createDailyJournal 缺少 store');
  if (typeof journalTurn !== 'function') throw new Error('createDailyJournal 缺少 journalTurn');
  const root = store.root;
  let pending = null;
  let timer = null;
  let running = false;
  let disposed = false;
  let repaired = false;

  const historyDir = join(root, DIARY_DIR, 'history');
  const historyFile = id => join(historyDir, `${id}.jsonl`);
  const stagingFile = join(root, 'diary', '.pending.json');

  function readStaging() {
    try { return JSON.parse(readFileSync(stagingFile, 'utf8')); } catch { return null; }
  }

  function writeStaging(stag) {
    mkdirSync(join(root, 'diary'), { recursive: true });
    writeFileSync(stagingFile, JSON.stringify(stag), 'utf8');
  }

  function clearStaging() {
    try { rmSync(stagingFile, { force: true }); } catch { /* ignore */ }
  }

  function appendHistory(row) {
    mkdirSync(historyDir, { recursive: true });
    appendFileSync(historyFile(row.id), `${JSON.stringify({ schema: 1, ...row })}\n`, 'utf8');
  }

  function readHistory(id) {
    const file = historyFile(id);
    if (!existsSync(file)) return [];
    const rows = [];
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row && Number.isInteger(row.revision)) rows.push(row);
      } catch { /* 损坏行跳过，但保留文件本身 */ }
    }
    return rows.sort((a, b) => a.revision - b.revision);
  }

  /** 启动时修复历史：正文已提交但历史快照缺失时补一份，不覆盖已有快照。 */
  function repairHistory() {
    if (repaired) return;
    repaired = true;
    for (const row of scanDiaries(root)) {
      const got = readDiary(root, row.id);
      if (!got.ok) continue;
      const history = readHistory(row.id);
      const last = history.at(-1)?.revision ?? -1;
      const revision = Number(got.entry.revision) || 0;
      if (last < revision) {
        appendHistory({
          id: row.id,
          day: row.day,
          revision,
          body: got.text,
          sha256: sha(got.text),
          facts: [],
          subjective: [],
          at: now(),
          recovered: true,
          note: 'history-repaired-from-body'
        });
      }
    }
  }

  function rememberAttempt(memory, day, status, error = null) {
    const journal = normalizeJournal(memory.journal);
    memory.journal = {
      ...journal,
      attempts: journal.attempts + 1,
      lastAttempt: { at: now(), day, status, error: error ? String(error.message ?? error) : null }
    };
  }

  async function commitBatch(stag, at) {
    const existing = scanDiaries(root).find(row => row.day === stag.day && !row.archived) ?? null;
    let id = existing?.id ?? `d-${stag.day.replaceAll('-', '')}`;
    let revision = 0;
    const current = existing ? readDiary(root, existing.id) : null;
    const needWrite = !current?.ok || sha(current.text) !== stag.sha256;
    if (needWrite) {
      const written = existing
        ? reviseDiary(root, { reviseOf: existing.id, text: stag.body, mood: stag.mood ?? '', at: new Date(at).toISOString() })
        : createDiary(root, { id, day: stag.day, text: stag.body, mood: stag.mood ?? '', at: new Date(at).toISOString() });
      if (!written.ok) return { ok: false, status: written.reason ?? 'write-failed', day: stag.day };
      id = written.id;
      revision = written.revision;
      await onStage?.('body-written', { ...stag, id, revision });
    } else {
      revision = Number(current.entry.revision) || 0;
    }
    const history = readHistory(id);
    if (!history.some(row => row.sha256 === stag.sha256)) {
      appendHistory({
        id,
        day: stag.day,
        revision,
        body: stag.body,
        sha256: stag.sha256,
        facts: stag.facts ?? [],
        subjective: stag.subjective ?? [],
        insights: stag.insights ?? [],
        traits: stag.traits ?? [],
        model: stag.model ?? null,
        at
      });
    }
    await store.saveMemory(memory => {
      const journal = normalizeJournal(memory.journal);
      memory.journal = {
        ...journal,
        lastDay: stag.day,
        lastEvidenceHash: stag.evidenceHash ?? null,
        lastProcessedAt: at,
        attempts: 0,
        lastAttempt: { at, day: stag.day, status: 'committed' },
        pending: null
      };
      const prior = (memory.diaryIndex ?? []).filter(entry => entry?.id !== id);
      memory.diaryIndex = [...prior, {
        id,
        day: stag.day,
        revision,
        archived: false,
        memoryIds: stag.facts ?? []
      }];
    });
    clearStaging();
    await store.appendActivity({ kind: 'diary-committed', day: stag.day, diaryId: id, revision, bytes: bytesOf(stag.body), facts: stag.facts ?? [], at });
    return { ok: true, status: revision > 0 ? 'revised' : 'created', day: stag.day, diaryId: id, revision, bytes: bytesOf(stag.body), facts: stag.facts ?? [], subjective: stag.subjective ?? [] };
  }

  /** 未提交批次恢复：只有正文与 staging 哈希一致时才补提交，否则丢弃未完成批次。 */
  async function resumePending({ at = now() } = {}) {
    const pending = normalizeJournal(store.memory.journal).pending;
    if (!pending) return null;
    const stag = readStaging();
    if (!stag || stag.day !== pending.day || stag.sha256 !== pending.bodySha) {
      await store.saveMemory(memory => { memory.journal = { ...normalizeJournal(memory.journal), pending: null, lastAttempt: { at, day: pending.day, status: 'pending-discarded' } }; });
      clearStaging();
      return { ok: false, status: 'pending-discarded', day: pending.day };
    }
    const result = await commitBatch(stag, Number(pending.at) || at);
    await store.appendActivity({ kind: 'diary-recovered', day: stag.day, diaryId: result.diaryId ?? null, revision: result.revision ?? null, at });
    return { ...result, status: 'recovered' };
  }

  async function processNow({ day = null, force = false, at = now() } = {}) {
    if (disposed) return { ok: false, error: 'disposed' };
    if (running) return { ok: false, error: 'busy' };
    running = true;
    try {
      await store.ensure();
      repairHistory();
      const recovered = await resumePending({ at });
      if (recovered?.ok) return recovered;
      const targetDay = day || projectDay(at);
      const evidence = await collectDayEvidence(store, targetDay);
      const evidenceHash = evidenceHashOf(evidence);
      const current = normalizeJournal(store.memory.journal);
      if (!force && current.lastDay === targetDay && current.lastEvidenceHash === evidenceHash) {
        return { ok: true, status: 'unchanged', day: targetDay };
      }
      if (evidence.experiences.length === 0 && evidence.memories.length === 0) {
        await store.saveMemory(memory => {
          memory.journal = { ...normalizeJournal(memory.journal), lastDay: targetDay, lastEvidenceHash: evidenceHash, lastAttempt: { at, day: targetDay, status: 'no-evidence' } };
        });
        return { ok: true, status: 'no-evidence', day: targetDay };
      }

      const existing = scanDiaries(root).find(row => row.day === targetDay && !row.archived) ?? null;
      const previous = existing ? readDiary(root, existing.id) : null;
      let draft = null;
      try {
        draft = await journalTurn({
          day: targetDay,
          experiences: evidence.experiences,
          memories: evidence.memories,
          insights: evidence.insights,
          traits: evidence.traits,
          previous: previous?.ok ? previous.text : null
        });
      } catch (error) {
        await store.saveMemory(memory => rememberAttempt(memory, targetDay, 'model-failed', error));
        return { ok: false, status: 'model-failed', day: targetDay, error: String(error?.message ?? error) };
      }

      if (!draft || draft.write === false) {
        await store.saveMemory(memory => {
          memory.journal = { ...normalizeJournal(memory.journal), lastDay: targetDay, lastEvidenceHash: evidenceHash, lastProcessedAt: at, lastAttempt: { at, day: targetDay, status: 'noop' } };
        });
        return { ok: true, status: 'noop', day: targetDay };
      }

      const draftBody = String(draft.body ?? '').trim();
      const appendText = String(draft.append ?? '').trim();
      // "接着写"：append 追加到今天末尾，不覆盖已有正文。
      let appendedBody = draftBody;
      if (appendText) {
        const existingToday = scanDiaries(root).find(row => row.day === targetDay && !row.archived) ?? null;
        const priorRaw = existingToday ? readDiary(root, existingToday.id) : null;
        const prior = priorRaw?.ok ? String(priorRaw.text ?? '').trimEnd() : '';
        appendedBody = prior ? `${prior}\n\n${appendText}` : appendText;
      }
      const body = appendedBody;
      if (!body) {
        await store.saveMemory(memory => rememberAttempt(memory, targetDay, 'invalid-body'));
        return { ok: false, status: 'invalid-body', day: targetDay };
      }
      const bytes = bytesOf(body);
      if (bytes > maxBytes) {
        await store.saveMemory(memory => rememberAttempt(memory, targetDay, 'too-long', new Error(`diary exceeds ${maxBytes} bytes`)));
        return { ok: false, status: 'too-long', day: targetDay, bytes, maxBytes };
      }
      // P2-A：没有 invoke 证据时，日记不得描写"用过工具/去查过/去看过"。
      // 只检查这一次新写的内容；追加模式下旧正文已通过过检查。
      if (bodyClaimsUnevidencedAction(appendText || draftBody || body, evidence.experiences)) {
        await store.saveMemory(memory => rememberAttempt(memory, targetDay, 'unevidenced-action', new Error('日记描写了未发生的工具/探查动作')));
        return { ok: false, status: 'unevidenced-action', day: targetDay };
      }
      const allowed = new Set([...evidence.experiences.map(item => item.id), ...evidence.memories.map(item => item.id)]);
      const insights = new Set(evidence.insights.map(item => item.id));
      const facts = [...new Set(Array.isArray(draft.facts) ? draft.facts : [])].filter(item => typeof item === 'string');
      const badFact = facts.find(id => !allowed.has(id) || insights.has(id));
      if (badFact) {
        await store.saveMemory(memory => rememberAttempt(memory, targetDay, 'invalid-facts', new Error(`unsupported fact ${badFact}`)));
        return { ok: false, status: 'invalid-facts', day: targetDay, fact: badFact };
      }
      const subjective = (Array.isArray(draft.subjective) ? draft.subjective : [])
        .filter(item => typeof item === 'string' && item.trim())
        .slice(0, 12)
        .map(item => item.trim().slice(0, 500));

      const stag = {
        day: targetDay,
        evidenceHash,
        body,
        sha256: sha(body),
        facts,
        subjective,
        insights: evidence.insights.map(item => item.id),
        traits: evidence.traits.map(item => item.id),
        mood: draft.mood ?? '',
        model: draft.model ?? null,
        at
      };
      writeStaging(stag);
      await store.saveMemory(memory => {
        memory.journal = {
          ...normalizeJournal(memory.journal),
          pending: { day: targetDay, bodySha: stag.sha256, evidenceHash, at }
        };
      });
      await onStage?.('staged', stag);

      const result = await commitBatch(stag, at);
      if (!result.ok) {
        await store.saveMemory(memory => rememberAttempt(memory, targetDay, result.status ?? 'write-failed'));
        return result;
      }
      return result;
    } finally {
      running = false;
    }
  }

  async function archiveNow({ at = now() } = {}) {
    const result = archiveDiaries(root, { now: new Date(at).toISOString() });
    if (result.ok && Array.isArray(result.moved) && result.moved.length > 0) {
      await store.saveMemory(memory => {
        const journal = normalizeJournal(memory.journal);
        memory.journal = { ...journal, archives: journal.archives + result.moved.length };
      });
    }
    return result;
  }

  function enqueue({ day = null } = {}) {
    if (disposed) return { ok: false, error: 'disposed' };
    pending = { day };
    if (timer) return { ok: true, queued: true };
    timer = setTimeout(async () => {
      timer = null;
      const job = pending;
      pending = null;
      try {
        await processNow({ day: job?.day ?? null });
      } catch (error) {
        logger?.warn?.('journal background failed', error);
      }
    }, debounceMs);
    timer.unref?.();
    return { ok: true, queued: true };
  }

  async function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      const job = pending;
      pending = null;
      return processNow({ day: job?.day ?? null });
    }
    return { ok: true, status: 'idle' };
  }

  function status() {
    return {
      enabled: true,
      pending: Boolean(timer),
      journal: normalizeJournal(store.memory.journal),
      diaryDays: scanDiaries(root).length
    };
  }

  function dispose() {
    disposed = true;
    if (timer) clearTimeout(timer);
    timer = null;
    pending = null;
  }

  return { processNow, archiveNow, enqueue, flush, status, dispose, readHistory, evidenceHashOf };
}
