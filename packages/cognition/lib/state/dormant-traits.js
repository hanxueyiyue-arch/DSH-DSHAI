// 倾向沉底区 + 整理状态。
//
// 为什么要有它：活跃池上限（TRAIT_LIMIT）满了以后，按价值挤出来的条目不能再凭空消失
// ——11-21 那次就是 `items.slice(-24)` 把最早的 5 条（含 3 条置信度最高的）静默吃掉。
// 现在改成“挤出 → 写到这里”，可查、可人工取回，不参与模型输入。
//
// 另一个文件 personality/reconcile.json 只记两件事：
//   restoredSeedVersion —— 种子已补到哪一版（避免每次启动重复补、重复合并）
//   retiredLabels       —— 被合并掉的标签（避免下次启动又从种子补回来）

import { join } from 'node:path';
import { readJson, writeJsonAtomic, appendJsonl } from './atomic.js';
import { labelSimilarity, TRAIT_SIMILARITY, TRAIT_LIMIT } from '../self/traits.js';

export const DORMANT_SCHEMA = 1;
export const DORMANT_LIMIT = 2000;

export function dormantPath(root) {
  return join(root, 'personality', 'dormant-traits.json');
}

export function dormantArchivePath(root) {
  return join(root, 'personality', 'dormant-archive.jsonl');
}

export function reconcileStatePath(root) {
  return join(root, 'personality', 'reconcile.json');
}

// 沉底只是“暂存”，历史留最近 3 条快照就够，避免文件无界增长。
function trimItem(item) {
  if (!item || typeof item.id !== 'string') return null;
  const history = Array.isArray(item.history) ? item.history.slice(-3) : [];
  return { ...item, history, dormantAt: item.dormantAt ?? Date.now() };
}

export async function readDormantTraits(root) {
  const data = await readJson(dormantPath(root));
  return Array.isArray(data?.items) ? data.items.filter(Boolean) : [];
}

export async function writeDormantTraits(root, items) {
  const list = Array.isArray(items) ? items.map(trimItem).filter(Boolean) : [];
  await writeJsonAtomic(dormantPath(root), {
    schema: DORMANT_SCHEMA,
    updatedAt: new Date().toISOString(),
    items: list
  });
  return { total: list.length };
}

// 去重 + 按最近更新排序；超出上限的部分单独返回，交给调用方归档，不再静默丢弃。
export function partitionDormant(existing, incoming, { limit = DORMANT_LIMIT } = {}) {
  const byId = new Map();
  for (const row of [...(existing ?? []), ...(incoming ?? [])]) {
    const item = trimItem(row);
    if (item) byId.set(item.id, item);
  }
  const list = [...byId.values()];
  const sorted = list.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
  return { kept: sorted.slice(0, limit), dropped: sorted.slice(limit) };
}

export function mergeDormantTraits(existing, incoming, { limit = DORMANT_LIMIT } = {}) {
  return partitionDormant(existing, incoming, { limit }).kept;
}

export async function appendDormantTraits(root, items) {
  if (!Array.isArray(items) || items.length === 0) return { added: 0, total: 0, archived: 0 };
  const before = await readDormantTraits(root);
  const { kept, dropped } = partitionDormant(before, items);
  if (dropped.length > 0) {
    // 沉底池满：超出的不删，追加到归档流水（append-only）。
    for (const row of dropped) {
      await appendJsonl(dormantArchivePath(root), {
        schema: 1,
        archivedAt: new Date().toISOString(),
        reason: 'dormant-overflow',
        trait: row
      });
    }
  }
  await writeDormantTraits(root, kept);
  return { added: Math.max(0, kept.length - before.length), total: kept.length, archived: dropped.length };
}

// 沉底回升：
//  - 活跃池里有同义条目 → 把沉底的证据并回去（合并，不重复）；
//  - 没有同义条目且活跃池有空位 → 直接回升；
//  - 没有同义条目也没空位 → 继续沉底（不制造无证据的换血）。
export function mergeDormantIntoActive(active, dormant, { similarity = TRAIT_SIMILARITY, limit = TRAIT_LIMIT } = {}) {
  const list = Array.isArray(active) ? active.map(row => ({ ...row, support: [...(row.support ?? [])], counter: [...(row.counter ?? [])], history: [...(row.history ?? [])] })) : [];
  const rest = [];
  const merged = [];
  const promoted = [];
  for (const row of Array.isArray(dormant) ? dormant : []) {
    if (!row || typeof row.label !== 'string') continue;
    const hit = row.status === 'disabled'
      ? null
      : list.find(item => item.status !== 'disabled' && labelSimilarity(item.label, row.label) >= similarity);
    if (hit) {
      const supportKeys = new Set(hit.support.map(item => item.key));
      for (const item of row.support ?? []) {
        if (!item || supportKeys.has(item.key)) continue;
        hit.support.push(item);
        supportKeys.add(item.key);
      }
      const counterKeys = new Set(hit.counter.map(item => item.key));
      for (const item of row.counter ?? []) {
        if (!item || counterKeys.has(item.key)) continue;
        hit.counter.push(item);
        counterKeys.add(item.key);
      }
      hit.confidence = Math.max(Number(hit.confidence) || 0, Number(row.confidence) || 0);
      hit.updatedAt = Math.max(Number(hit.updatedAt) || 0, Number(row.updatedAt) || 0);
      hit.history = [...hit.history, ...(row.history ?? [])].slice(-128);
      merged.push({ from: row.id, into: hit.id, label: row.label });
      continue;
    }
    if (list.length < limit) {
      list.push({
        ...row,
        status: row.status === 'disabled' ? 'uncertain' : (row.status ?? 'active'),
        dormantAt: undefined
      });
      promoted.push({ id: row.id, label: row.label });
      continue;
    }
    rest.push(row);
  }
  return { active: list, dormant: rest, merged, promoted };
}

export async function readReconcileState(root) {
  const data = await readJson(reconcileStatePath(root));
  return {
    restoredSeedVersion: Number(data?.restoredSeedVersion) || 0,
    retiredLabels: Array.isArray(data?.retiredLabels) ? data.retiredLabels.filter(label => typeof label === 'string') : []
  };
}

export async function writeReconcileState(root, { restoredSeedVersion = 0, retiredLabels = [] } = {}) {
  await writeJsonAtomic(reconcileStatePath(root), {
    schema: 1,
    updatedAt: new Date().toISOString(),
    restoredSeedVersion: Number(restoredSeedVersion) || 0,
    retiredLabels: [...new Set(retiredLabels.map(String))].slice(-200)
  });
}

