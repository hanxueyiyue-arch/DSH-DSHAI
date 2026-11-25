/**
 * 关联图的存储层：append-only 事件真源 + 可重建缓存。
 *
 * 文件布局（目录由调用方给，测试一律给临时目录，绝不指向真实数据）：
 *   <dir>/assoc-events.jsonl   真源，只追加，每行一个事件
 *   <dir>/associations.json    缓存，可删，可重建
 *
 * 三条硬规则：
 *   1. 缓存坏了 → 从事件重放恢复。
 *   2. 事件日志有损坏 → **保留能读的行**，把损坏行号报出来（`degraded`），绝不猜测、绝不补边。
 *   3. 事件日志完全不可读 → 不重建、不覆盖缓存；返回已有的缓存并标 `source:'cache-events-damaged'`，
 *      宁可让图停在上一个可信状态，也不能用"半个日志"重放出一个看起来正常的图。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildGraph,
  emptyGraph,
  graphStats,
  parseGraphDocument,
  pruneGraph,
  serializeGraph,
  validateEvent,
} from './associations.js';

export const EVENTS_FILE = 'assoc-events.jsonl';
export const CACHE_FILE = 'associations.json';

const ensureDir = dir => {
  mkdirSync(dir, { recursive: true });
  return dir;
};

export const eventsPath = dir => join(dir, EVENTS_FILE);
export const cachePath = dir => join(dir, CACHE_FILE);

/** 规范化一行事件：键顺序固定，便于 diff 与逐字节断言。`ep` 只在存在时出现。 */
export function eventLine(event) {
  const body = { t: event.t, kind: event.kind, ids: [...event.ids], w: event.w };
  if (event.ep) body.ep = event.ep;
  return `${JSON.stringify(body)}\n`;
}

/**
 * 追加一条事件。非法事件**不写**，返回 `{ok:false, reason}`。
 * 追加是"一行一次 write"，不带缓冲，避免进程退出时丢半行以外的内容。
 */
export function appendEvent(dir, rawEvent) {
  const checked = validateEvent(rawEvent);
  if (!checked.ok) return { ok: false, reason: checked.reason };
  ensureDir(dir);
  appendFileSync(eventsPath(dir), eventLine(checked.event), 'utf8');
  return { ok: true, event: checked.event };
}

/**
 * 带经历编号的追加：同一 `(kind, ep, 关系集合)` 只允许写一次。
 *
 * 这是防"自我强化"的最小机制：一次共同回忆被系统在后续轮次里自动重放、重复返回时，
 * 调用方只需带上同一个 `ep`，第二次起就会被拒绝（`reason:'duplicate-episode'`），
 * 边权不会因为"返回次数多"而无限逼近 1。
 *
 * 去重键**必须带关系集合**：同一段经历里可能同时存在多组合法关系（例如"一起看了视频，
 * 又一起聊了里面的角色"），只按 `(kind, ep)` 去重会把后面那些合法关系当成重复丢掉。
 * 反过来，同样的 ep + 同样的 id 组合重复提交才是真的重复。
 *
 * 不带 `ep` 的事件无法去重（只能靠人/调用方自律），返回值里 `deduped:false`。
 */
export function appendEventOnce(dir, rawEvent) {
  const checked = validateEvent(rawEvent);
  if (!checked.ok) return { ok: false, reason: checked.reason, deduped: false };
  if (!checked.event.ep) return { ...appendEvent(dir, checked.event), deduped: false };
  const log = readEvents(dir);
  const signature = relationSignature(checked.event);
  const duplicate = log.events.some(event => event.kind === checked.event.kind && event.ep === checked.event.ep && relationSignature(event) === signature);
  if (duplicate) return { ok: false, reason: 'duplicate-episode', deduped: true };
  appendFileSync(eventsPath(dir), eventLine(checked.event), 'utf8');
  return { ok: true, event: checked.event, deduped: false };
}

/** 关系集合的规范签名：id 排序后拼接（同一组 id 换顺序视为同一关系）。 */
function relationSignature(event) {
  return [...event.ids].map(String).sort().join('\u0000');
}

/**
 * 读取事件日志。
 *
 * 返回 `{ events, lines, degraded }`：
 *   - `events`：所有能通过校验的事件，按文件顺序；
 *   - `lines`：非空行总数（用于报告"读了多少行"）；
 *   - `degraded`：`[{ line, reason }]`，空数组表示日志干净。
 *
 * 末行被截断（崩溃常见）只丢那一行并记 `truncated-line`；中间行坏了同样跳过并记行号。
 */
export function readEvents(dir) {
  const path = eventsPath(dir);
  if (!existsSync(path)) return { events: [], lines: 0, degraded: [], exists: false };
  const text = readFileSync(path, 'utf8');
  const rawLines = text.split('\n');
  const events = [];
  const degraded = [];
  let lines = 0;
  rawLines.forEach((line, index) => {
    if (!line.trim()) return;
    lines += 1;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      degraded.push({ line: index + 1, reason: 'invalid-json' });
      return;
    }
    const checked = validateEvent(parsed);
    if (!checked.ok) {
      degraded.push({ line: index + 1, reason: checked.reason });
      return;
    }
    events.push(checked.event);
  });
  return { events, lines, degraded, exists: true };
}

/**
 * 原子写缓存：先写临时文件再改名，避免半截 JSON。
 * `meta` 会被写进缓存文件，用来记住"这份缓存是不是残缺日志的产物"。
 */
export function writeCache(dir, graph, meta = null) {
  ensureDir(dir);
  const target = cachePath(dir);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, serializeGraph(graph, meta), 'utf8');
  renameSync(tmp, target);
  return target;
}

export function readCache(dir) {
  return readCacheDocument(dir)?.graph ?? null;
}

/** 读缓存连同 `meta`（`null` 表示无缓存或缓存损坏）。 */
export function readCacheDocument(dir) {
  const path = cachePath(dir);
  if (!existsSync(path)) return null;
  try {
    return parseGraphDocument(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function cacheMeta(log, mode) {
  const degraded = log.degraded.length > 0;
  return {
    replay: mode,
    degraded,
    degradedLines: log.degraded.map(entry => entry.line),
    degradedReasons: [...new Set(log.degraded.map(entry => entry.reason))],
    events: log.events.length,
    lines: log.lines,
  };
}

/**
 * 从事件日志重建图并写缓存。
 * 空日志（且文件存在）视为"合法的空图"，不是损坏。
 *
 * 若日志里**一行都读不出、却存在坏行**（全坏），则**不写缓存**：
 * 用空图覆盖上一份可信缓存，会让"日志坏了"退化成"图本来就是空的"。
 */
export function rebuild(dir) {
  const log = readEvents(dir);
  const degraded = log.degraded.length > 0;
  if (!log.events.length && degraded) {
    return {
      graph: null,
      stats: null,
      written: false,
      reason: 'events-unreadable',
      degraded: log.degraded,
      lines: log.lines,
      events: 0,
    };
  }
  const graph = pruneGraph(buildGraph(log.events));
  writeCache(dir, graph, cacheMeta(log, degraded ? 'partial' : 'full'));
  return {
    graph,
    written: true,
    stats: graphStats(graph),
    degraded: log.degraded,
    lines: log.lines,
    events: log.events.length,
  };
}

/**
 * 读取图（缓存优先）。
 *
 * `source` 取值：
 *   - `cache`                    缓存有效，事件日志未检查到损坏（或不存在）
 *   - `cache-events-damaged`     缓存有效，但事件日志有损坏行 → 用缓存，不覆盖
 *   - `rebuilt`                  缓存缺失/损坏 → 从事件重放
 *   - `rebuilt-partial`          缓存缺失/损坏 + 事件日志有损坏 → 用能读的部分重放，并报 `degraded`
 *   - `empty-events-unreadable`  缓存缺失 + 事件日志存在但一行都读不出 → 返回空图，**不写缓存**
 */
export function loadGraph(dir) {
  const cacheDoc = readCacheDocument(dir);
  const cache = cacheDoc?.graph ?? null;
  const log = readEvents(dir);
  const damaged = log.degraded.length > 0;
  const cacheFresh = Boolean(cacheDoc?.meta) && cacheDoc.meta.events === log.events.length;

  if (cache && (damaged || cacheFresh)) {
    return {
      graph: cache,
      stats: graphStats(cache),
      source: damaged ? 'cache-events-damaged' : 'cache',
      degraded: log.degraded,
      // 缓存自己记录的降级历史：即使事件日志后来被修好，也能看出"这份图是残缺日志重放出来的"。
      cacheMeta: cacheDoc.meta,
      cacheDegraded: Boolean(cacheDoc.meta?.degraded),
    };
  }

  if (!log.exists) {
    return { graph: emptyGraph(), stats: graphStats(emptyGraph()), source: 'empty-no-events', degraded: [], cacheMeta: null, cacheDegraded: false };
  }

  if (!log.events.length && damaged) {
    return {
      graph: emptyGraph(),
      stats: graphStats(emptyGraph()),
      source: 'empty-events-unreadable',
      degraded: log.degraded,
      cacheMeta: null,
      cacheDegraded: false,
    };
  }

  const graph = pruneGraph(buildGraph(log.events));
  if (log.events.length) writeCache(dir, graph, cacheMeta(log, damaged ? 'partial' : 'full'));
  return {
    graph,
    stats: graphStats(graph),
    source: damaged ? 'rebuilt-partial' : 'rebuilt',
    degraded: log.degraded,
    cacheMeta: log.events.length ? cacheMeta(log, damaged ? 'partial' : 'full') : null,
    cacheDegraded: damaged,
  };
}
