// tick 时段表：一天最多 6 段，必须覆盖 00:00–24:00，不可重叠/跨午夜。
// 纯函数 + 设置文件读写；scheduler 只依赖 nextTickAt。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const MAX_SEGMENTS = 6;
export const MIN_TICK_MS = 60_000;
export const MAX_TICK_MS = 24 * 60 * 60_000;
export const DAY_MINUTES = 24 * 60;

/** 默认单段：整天按 fallbackTickMs 走。 */
export function defaultSegments(fallbackTickMs = 30 * 60_000) {
  const tickMs = clampTick(fallbackTickMs) ?? 30 * 60_000;
  return [{ start: '00:00', end: '24:00', startMin: 0, endMin: DAY_MINUTES, tickMs }];
}

export function clampTick(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return null;
  return Math.max(MIN_TICK_MS, Math.min(MAX_TICK_MS, Math.round(n)));
}

function parseMinute(text, { allow24 = false } = {}) {
  if (typeof text !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (minute < 0 || minute > 59) return null;
  if (hour === 24) return allow24 && minute === 0 ? DAY_MINUTES : null;
  if (hour < 0 || hour > 23) return null;
  return hour * 60 + minute;
}

/** 归一化并校验。任何非法都返回 ok:false；调用方负责回退，不能因此让进程启动失败。 */
export function normalizeSegments(raw, { fallbackTickMs = 30 * 60_000 } = {}) {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: true, segments: defaultSegments(fallbackTickMs), errors: [] };
  }
  if (raw.length > MAX_SEGMENTS) {
    return { ok: false, segments: defaultSegments(fallbackTickMs), errors: [`最多 ${MAX_SEGMENTS} 段`] };
  }
  const errors = [];
  const list = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') { errors.push('段必须是对象'); continue; }
    const startMin = parseMinute(row.start);
    const endMin = parseMinute(row.end, { allow24: true });
    const tickMs = clampTick(row.tickMs);
    if (startMin === null) errors.push(`start 非法：${row.start}`);
    if (endMin === null) errors.push(`end 非法：${row.end}`);
    if (tickMs === null) errors.push(`tickMs 非法：${row.tickMs}`);
    if (startMin === null || endMin === null || tickMs === null) continue;
    if (startMin >= endMin) errors.push(`段 ${row.start}–${row.end} 必须 start < end（不允许跨午夜）`);
    list.push({ start: row.start, end: row.end, startMin, endMin, tickMs });
  }
  if (errors.length > 0) return { ok: false, segments: defaultSegments(fallbackTickMs), errors };

  list.sort((a, b) => a.startMin - b.startMin);
  let cursor = 0;
  for (const seg of list) {
    if (seg.startMin !== cursor) {
      errors.push(seg.startMin > cursor
        ? `空档：${cursor}–${seg.startMin} 分钟没有覆盖`
        : `重叠：${seg.start} 与上一段重叠`);
      break;
    }
    cursor = seg.endMin;
  }
  if (errors.length === 0 && cursor !== DAY_MINUTES) {
    errors.push(`末尾空档：${cursor}–${DAY_MINUTES} 分钟没有覆盖`);
  }
  if (errors.length > 0) return { ok: false, segments: defaultSegments(fallbackTickMs), errors };
  return { ok: true, segments: list, errors: [] };
}

function atMinute(base, minute) {
  const d = new Date(base);
  d.setHours(0, 0, 0, 0);
  return d.getTime() + minute * 60_000;
}

/** 当前时刻落在哪一段（本地时间）。 */
export function segmentAt(segments, now = Date.now()) {
  const d = new Date(now);
  const minute = d.getHours() * 60 + d.getMinutes();
  return segments.find(seg => minute >= seg.startMin && minute < seg.endMin) ?? null;
}

function nextInSegment(seg, now) {
  const duration = seg.endMin - seg.startMin;
  if (seg.tickMs >= duration * 60_000) return null; // 间隔 ≥ 段长：本段不 tick
  const base = atMinute(now, seg.startMin);
  const end = atMinute(now, seg.endMin);
  if (now < base) {
    const first = base + seg.tickMs;
    return first < end ? first : null;
  }
  if (now >= end) {
    const nextBase = base + 24 * 60 * 60_000;
    const nextEnd = end + 24 * 60 * 60_000;
    const first = nextBase + seg.tickMs;
    return first < nextEnd ? first : null;
  }
  const k = Math.floor((now - base) / seg.tickMs) + 1;
  const candidate = base + k * seg.tickMs;
  return candidate < end ? candidate : null;
}

/** 下一次 tick 的绝对时间；没有可触发的段时返回 null。 */
export function nextTickAt(segments, now = Date.now()) {
  let best = null;
  for (const seg of segments) {
    const candidate = nextInSegment(seg, now);
    if (candidate !== null && candidate > now && (best === null || candidate < best)) best = candidate;
  }
  return best;
}

export function schedulePath(dshHome = process.env.DSH_HOME || process.cwd()) {
  return join(dshHome, 'dsh-dshai', 'bus', 'settings.json');
}

/** 读设置文件；没有/损坏/非法都返回 null，调用方保留上一份有效值。 */
export function readStoredSegments({ dshHome, fallbackTickMs = 30 * 60_000 } = {}) {
  try {
    const parsed = JSON.parse(readFileSync(schedulePath(dshHome), 'utf8'));
    if (Array.isArray(parsed?.segments)) {
      const checked = normalizeSegments(parsed.segments, { fallbackTickMs });
      return checked.ok ? { segments: checked.segments, errors: [] } : { segments: null, errors: checked.errors };
    }
    // 兼容旧的 {tickMs}：迁移成单段
    const tickMs = clampTick(parsed?.tickMs);
    if (tickMs !== null) return { segments: defaultSegments(tickMs), errors: [] };
  } catch { /* 没有文件或 JSON 损坏 */ }
  return { segments: null, errors: [] };
}

export function writeStoredSegments(segments, { dshHome } = {}) {
  const checked = normalizeSegments(segments);
  if (!checked.ok) throw new Error(`tick 时段非法：${checked.errors.join('；')}`);
  const file = schedulePath(dshHome);
  mkdirSync(dirname(file), { recursive: true });
  const payload = {
    segments: checked.segments.map(({ start, end, tickMs }) => ({ start, end, tickMs })),
    updatedAt: new Date().toISOString()
  };
  writeFileSync(file, Buffer.from(JSON.stringify(payload, null, 2) + '\n', 'utf8'));
  return checked.segments;
}

export function segmentView(seg) {
  return { start: seg.start, end: seg.end, tickMs: seg.tickMs, minutes: Math.round(seg.tickMs / 60_000) };
}
