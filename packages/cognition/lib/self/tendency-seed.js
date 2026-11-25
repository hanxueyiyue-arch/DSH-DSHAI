// 倾向种子：只在“从没长出过倾向”时采纳一次。
//
// 为什么是包内静态种子，而不是启动时用 deriveTraits 重新推导：
// 种子是人能读懂、能改的固化内容；让 deriveTraits 每次重新猜会换出一批不同的标签，
// 等于用机器的推测覆盖使用者已经认可的那套自我认识。
//
// 公开版本里 tendency-seed.json 的 items 是空的 —— 不携带任何真实运行环境的人格数据。
// 使用者可以自己往里填结构相同的条目，机制照常工作：items 为空 = 没有种子，启动迁移直接跳过。
//
// 为什么判据是“items 为空”：
// disableTrait / revertTrait 都只改 status、不删条目，所以空数组等价于“从没长过”。
// 这样她以后真的把某条停用了，重启也不会被种子重新灌回来（不跟她的成长打架），
// 也天然幂等，不需要额外落一个 backfilledAt 标记
// （normalizePersonality 只保留 items/revision/updatedAt，别的字段存不住）。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizePersonality } from './traits.js';

const SEED_FILE = join(dirname(fileURLToPath(import.meta.url)), 'tendency-seed.json');

let cache;
let loaded = false;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// 读包内种子。文件缺失或损坏一律当作“没有种子”，绝不阻塞启动。
export function readTendencySeed({ logger = null, file = SEED_FILE } = {}) {
  if (loaded && file === SEED_FILE) return cache;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      logger?.warn?.('[cognition] 倾向种子读取失败，跳过回填', { error: error?.message });
    }
    if (file === SEED_FILE) { loaded = true; cache = null; }
    return null;
  }
  const items = normalizePersonality({ items: Array.isArray(parsed?.items) ? parsed.items : [] }).items;
  const seed = items.length > 0
    ? { version: Number(parsed?.version) || 1, revision: Number(parsed?.revision) || 1, items }
    : null;
  if (file === SEED_FILE) { loaded = true; cache = seed; }
  return seed;
}

// 纯函数：采纳种子。不改磁盘、不读时钟以外的外部状态。
// merge=false（启动迁移）：只在 items 为空时整批采纳。
// merge=true（人工调用补倾向）：在已有条目上只补“缺的标签”，不覆盖、不复活已停用的。
export function applyTendencySeed(behavior, { seed, now = Date.now(), merge = false } = {}) {
  if (!behavior || typeof behavior !== 'object') return { applied: false, reason: 'no-behavior', count: 0 };
  if (!seed || !Array.isArray(seed.items) || seed.items.length === 0) return { applied: false, reason: 'no-seed', count: 0 };
  const current = behavior.personality;
  const existing = Array.isArray(current?.items) ? current.items : [];
  if (existing.length > 0 && !merge) return { applied: false, reason: 'not-empty', count: 0 };

  const known = new Set(existing.map(item => item?.label).filter(label => typeof label === 'string'));
  const missing = seed.items.filter(item => typeof item?.label === 'string' && !known.has(item.label));
  if (missing.length === 0) return { applied: false, reason: 'nothing-missing', count: 0, total: existing.length };

  const items = [...existing, ...clone(missing)];
  behavior.personality = {
    items,
    revision: Math.max(1, (Number(current?.revision) || 0) + 1),
    updatedAt: now
  };
  return {
    applied: true,
    count: missing.length,
    total: items.length,
    merged: existing.length > 0,
    seedVersion: seed.version ?? 1
  };
}
