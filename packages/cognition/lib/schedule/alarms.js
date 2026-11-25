// 闹钟/日程：每天固定时间，一次设置每天响；只在 Cognition 内部，不依赖总线调度。
// 规则（已定）：
//  - 每天固定时间（HH:MM），不支持星期；
//  - 错过的只补最近一次，超过 2 小时不补；
//  - 同一天同一个闹钟只响一次（lastFiredDay）。
export const ALARM_SCHEMA = 1;
export const ALARM_GRACE_MINUTES = 120;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const clip = (text, limit) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
const toMinutes = time => {
  const match = HHMM.exec(String(time ?? ''));
  if (!match) return -1;
  return Number(match[1]) * 60 + Number(match[2]);
};

export function blankAlarms(now = Date.now()) {
  return { schema: ALARM_SCHEMA, updatedAt: new Date(now).toISOString(), items: [] };
}

export function normalizeAlarms(value, { now = Date.now() } = {}) {
  const raw = value && typeof value === 'object' ? value : {};
  const items = [];
  const seen = new Set();
  for (const row of Array.isArray(raw.items) ? raw.items : []) {
    const id = typeof row?.id === 'string' ? row.id : '';
    const time = String(row?.time ?? '');
    if (!id || seen.has(id) || !HHMM.test(time)) continue;
    seen.add(id);
    items.push({
      id,
      time,
      label: clip(row.label, 60),
      enabled: row.enabled !== false,
      createdAt: Number(row.createdAt) || now,
      lastFiredDay: typeof row.lastFiredDay === 'string' ? row.lastFiredDay : null
    });
  }
  return {
    schema: ALARM_SCHEMA,
    updatedAt: String(raw.updatedAt ?? new Date(now).toISOString()),
    lastCheckAt: Number(raw.lastCheckAt) || 0,
    items
  };
}

export function addAlarm(state, { time, label = '', now = Date.now(), id } = {}) {
  const next = normalizeAlarms(state, { now });
  if (!HHMM.test(String(time ?? ''))) return { ok: false, reason: 'time-invalid' };
  if (next.items.length >= 20) return { ok: false, reason: 'too-many-alarms' };
  const alarmId = typeof id === 'string' && id ? id : `alarm-${now}-${Math.random().toString(36).slice(2, 8)}`;
  if (next.items.some(item => item.id === alarmId)) return { ok: false, reason: 'duplicate-id' };
  const alarm = { id: alarmId, time: String(time), label: clip(label, 60), enabled: true, createdAt: now, lastFiredDay: null };
  next.items.push(alarm);
  next.updatedAt = new Date(now).toISOString();
  return { ok: true, state: next, alarm };
}

export function removeAlarm(state, id, { now = Date.now() } = {}) {
  const next = normalizeAlarms(state, { now });
  const key = String(id ?? '').trim();
  const before = next.items.length;
  next.items = next.items.filter(item => item.id !== key);
  next.updatedAt = new Date(now).toISOString();
  return before === next.items.length ? { ok: false, reason: 'not-found' } : { ok: true, state: next };
}

export function listAlarms(state) {
  return normalizeAlarms(state).items;
}

// 本地时间：日期 + 当天分钟数
export function localClock(now, timeZone = 'Asia/Shanghai') {
  const zone = typeof timeZone === 'string' && timeZone ? timeZone : 'Asia/Shanghai';
  const parts = tz => new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(now));
  let rows;
  try { rows = parts(zone); } catch { rows = parts('UTC'); }
  const pick = type => rows.find(item => item.type === type)?.value ?? '';
  const year = pick('year');
  const month = pick('month');
  const day = pick('day');
  const hour = pick('hour');
  const minute = pick('minute');
  return {
    day: `${year}-${month}-${day}`,
    minutes: Number(hour) * 60 + Number(minute),
    hhmm: `${hour}:${minute}`
  };
}

// 这一分钟该响的闹钟（含错过的最近一次）
export function dueAlarms(state, { now = Date.now(), timeZone = 'Asia/Shanghai', graceMinutes = ALARM_GRACE_MINUTES } = {}) {
  const next = normalizeAlarms(state, { now });
  const { day, minutes: nowMinutes } = localClock(now, timeZone);
  const lastMinutes = next.lastCheckAt
    ? localClock(Math.min(next.lastCheckAt, now), timeZone).minutes
    : null;
  const due = [];
  for (const alarm of next.items) {
    if (!alarm.enabled) continue;
    if (alarm.lastFiredDay === day) continue;
    const at = toMinutes(alarm.time);
    if (at < 0) continue;
    const delta = nowMinutes - at;
    if (delta < 0 || delta > graceMinutes) continue;
    // 到点；或上次检查之后错过（进程刚起来时 lastMinutes 为 null，也按最近一次补）
    const missed = lastMinutes === null ? true : lastMinutes <= at && at < nowMinutes;
    if (delta === 0 || missed) due.push(alarm);
  }
  return due;
}

export function markFired(state, id, { now = Date.now(), timeZone = 'Asia/Shanghai' } = {}) {
  const next = normalizeAlarms(state, { now });
  const { day } = localClock(now, timeZone);
  const alarm = next.items.find(item => item.id === id);
  if (alarm) alarm.lastFiredDay = day;
  next.lastCheckAt = now;
  next.updatedAt = new Date(now).toISOString();
  return next;
}

export function markChecked(state, { now = Date.now() } = {}) {
  const next = normalizeAlarms(state, { now });
  next.lastCheckAt = now;
  next.updatedAt = new Date(now).toISOString();
  return next;
}
