// 存在感摘要：只把“距上次说话多久、最近来回多少、现在几点”整理成事实。
// 它不判断该不该发、也不限制时间；判断留给模型与长期习惯。
// 数据来源是活动流水（event-received / intent-emitted），不读网络、不起定时器。

const SLOT_LABELS = [
  { until: 6, label: '深夜' },
  { until: 9, label: '清晨' },
  { until: 12, label: '上午' },
  { until: 14, label: '中午' },
  { until: 18, label: '下午' },
  { until: 23, label: '晚上' },
  { until: 24, label: '深夜' }
];

function hourOf(at, timeZone) {
  const readHour = tz => {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(new Date(at));
    const hour = Number(parts.find(item => item.type === 'hour')?.value);
    return Number.isInteger(hour) ? hour % 24 : null;
  };
  try {
    return readHour(typeof timeZone === 'string' && timeZone !== '' ? timeZone : 'UTC');
  } catch {
    // 时区无效时退回 UTC：宁可给一个真实时段，也不让整条输入失败。
    try {
      return readHour('UTC');
    } catch {
      return null;
    }
  }
}

function slotOf(hour) {
  if (hour === null) return null;
  return SLOT_LABELS.find(item => hour < item.until)?.label ?? null;
}

// 习惯键要用稳定的时段名；取不到时段时退回 'unknown'。
export function timeSlot(at = Date.now(), timeZone = '') {
  return slotOf(hourOf(at, timeZone)) ?? 'unknown';
}

function timeOf(row) {
  const value = Number(row?.at);
  return Number.isFinite(value) ? value : null;
}

export function presenceSummary({ activities = [], now = Date.now(), timeZone = '', window = 20 } = {}) {
  const rows = (Array.isArray(activities) ? activities : [])
    .map(row => ({ row, at: timeOf(row) }))
    .filter(item => item.at !== null);

  const ownerMessages = rows.filter(
    item => item.row.kind === 'event-received' && item.row.type === 'owner-message'
  );
  const selfSends = rows.filter(item => item.row.kind === 'intent-emitted' && item.row.intentType === 'send');

  const lastOwnerAt = ownerMessages.length ? ownerMessages[ownerMessages.length - 1].at : null;
  const lastSelfAt = selfSends.length ? selfSends[selfSends.length - 1].at : null;

  const limit = Math.max(1, Number(window) || 20);
  const recentRows = rows.slice(-limit);
  const recentOwner = recentRows.filter(
    item => item.row.kind === 'event-received' && item.row.type === 'owner-message'
  ).length;
  const recentSelf = recentRows.filter(
    item => item.row.kind === 'intent-emitted' && item.row.intentType === 'send'
  ).length;

  const unansweredSelf = lastOwnerAt === null ? selfSends.length : selfSends.filter(item => item.at > lastOwnerAt).length;

  const hour = hourOf(now, timeZone);

  return {
    window: limit,
    counted: recentRows.length,
    current: { hour, slot: slotOf(hour) },
    lastOwnerAt,
    lastSelfAt,
    sinceOwnerMs: lastOwnerAt === null ? null : Math.max(0, now - lastOwnerAt),
    sinceSelfMs: lastSelfAt === null ? null : Math.max(0, now - lastSelfAt),
    unansweredSelf,
    recent: {
      ownerMessages: recentOwner,
      selfMessages: recentSelf,
      selfSentAfterLastOwner: lastOwnerAt !== null && lastSelfAt !== null && lastSelfAt > lastOwnerAt
    }
  };
}
