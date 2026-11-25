// 人格编年史：append-only 快照。每 7 天最多一条，模板生成、不调模型。
// 与日记共用"文档"根下的不同文件夹：<root>/documents/persona/、<root>/documents/diary/。
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { derivedPersona, ensurePersona } from './persona.js';

export const CHRONICLE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
export const CHRONICLE_MIN_NEW_MEMORIES = 5;

export function documentsRoot(store) {
  return join(store.root, 'documents');
}

export function chronicleDir(store) {
  return join(documentsRoot(store), 'persona');
}

export function chronicleFile(store) {
  return join(chronicleDir(store), 'chronicle.jsonl');
}

export function diaryDocsDir(store) {
  return join(documentsRoot(store), 'diary');
}

function readLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

export function listChronicle(store, { limit = 30 } = {}) {
  const rows = readLines(chronicleFile(store));
  return rows.slice(-Math.max(1, limit)).reverse();
}

export function readChronicle(store, id) {
  return readLines(chronicleFile(store)).find(row => row.id === id) ?? null;
}

/**
 * 距上一条 ≥7 天，且新增高重要度记忆 ≥5 条，才写一条。
 * 返回 { appended, entry?, reason }。
 */
export function maybeAppendChronicle(store, { now = Date.now(), intervalMs = CHRONICLE_INTERVAL_MS, minNewMemories = CHRONICLE_MIN_NEW_MEMORIES } = {}) {
  const persona = ensurePersona(store, { now });
  const existing = readLines(chronicleFile(store));
  const last = existing[existing.length - 1] ?? null;
  if (last && Number(last.at) && now - Number(last.at) < intervalMs) {
    return { appended: false, reason: 'interval-not-reached', lastAt: last.at ?? null };
  }
  const derived = derivedPersona(store, { now });
  const newMemories = last ? Math.max(0, derived.basedOn.memories - Number(last.basedOn?.memories ?? 0)) : derived.basedOn.memories;
  if (last && newMemories < minNewMemories) {
    return { appended: false, reason: 'not-enough-new-memories', newMemories };
  }
  const entry = {
    id: `chronicle-${now}`,
    at: now,
    trigger: existing.length === 0 ? 'initial' : 'scheduled',
    windowDays: derived.windowDays,
    basedOn: derived.basedOn,
    topics: derived.topics,
    current: { text: derived.summary.slice(0, 600), chars: derived.summary.length },
    evidence: derived.evidence.slice(0, 8),
    personaVersion: persona.version ?? 1
  };
  const file = chronicleFile(store);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
  return { appended: true, entry };
}
