// S3.10 习惯快路径：同一情境反复成功，做法被压缩成默认；失败退回审议。
// 只存“在这种情境下通常怎么做”，不存具体句子；纯函数，不读写磁盘。
// 调用方（cycle）负责在结果回来后记账并保存 self。

export const HABIT_LIMIT = 200;
export const HABIT_DORMANT_LIMIT = 500;
export const HABIT_FAST_THRESHOLD = 0.7;
export const HABIT_SUCCESS_GAIN = 0.05;
export const HABIT_FAILURE_PENALTY = 0.15;
export const HABIT_FAILURE_STREAK = 2;
export const HABIT_DECAY_DAYS = 60;
export const HABIT_ACTIONS = Object.freeze(['send-followup', 'silence']);

// 活跃池到 85% 时，先把“低信心且半年没用”的移入冷区；冷区可被下一次同类结果唤醒。
export const HABIT_COLD_TRIGGER = Math.ceil(HABIT_LIMIT * 0.85);
export const HABIT_COLD_CONFIDENCE = 0.3;
export const HABIT_COLD_UNUSED_DAYS = 180;
const DAY_MS = 86_400_000;

// 新习惯从“略微相信”开始；八次左右成功才够快路径，失败一次要几次成功才补回来。
const HABIT_INITIAL = 0.3;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round3 = value => Math.round(value * 1000) / 1000;

// 精力档位已从情境键里移除：它不该决定“这件事该怎么做”，
// 而且旧数据里所有习惯都学在 energy=0 的 low 档，保留会导致恢复后全部失联。
// 仍然导出，供旧键归一化与诊断使用。
export function energyBand(energy) {
  if (energy === null || energy === undefined || energy === '') return 'normal';
  const value = Number(energy);
  if (!Number.isFinite(value)) return 'normal';
  return value < 30 ? 'low' : 'normal';
}

function part(value) {
  const text = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[|\s]+/g, '-')
    .slice(0, 40);
  return text || 'none';
}

// 情境键：事件类型 | 话题类 | 时段。键要稳定，才能跨天累计。
export function habitKey({ eventType = 'tick', topic = null, slot = null } = {}) {
  return [part(eventType), part(topic), part(slot)].join('|');
}

export function findHabit(habits, key) {
  if (!Array.isArray(habits)) return null;
  return habits.find(row => row && row.key === key) ?? null;
}

// 旧键迁移：4 段键（eventType|topic|slot|energy）→ 3 段键，丢掉精力档。
export function normalizeHabitKey(key) {
  if (typeof key !== 'string') return key;
  const parts = key.split('|');
  if (parts.length === 4) return parts.slice(0, 3).join('|');
  return key;
}

// 不用时慢慢变淡；但只是降低信心，不删除记录。
export function effectiveConfidence(habit, now = Date.now()) {
  const raw = Number(habit?.confidence);
  if (!Number.isFinite(raw)) return 0;
  const last = Number(habit.lastAt);
  if (!Number.isFinite(last) || now <= last) return clamp(raw, 0, 0.95);
  const days = (now - last) / 86_400_000;
  return clamp(raw * Math.pow(2, -days / HABIT_DECAY_DAYS), 0, 0.95);
}

export function fastHabit(habits, key, { now = Date.now(), actions = HABIT_ACTIONS } = {}) {
  const habit = findHabit(habits, key);
  if (!habit) return null;
  if (!actions.includes(habit.action)) return null;
  // 连续失败说明这个情境变了，重新交给审议。
  if (Number(habit.failureStreak) >= HABIT_FAILURE_STREAK) return null;
  const confidence = round3(effectiveConfidence(habit, now));
  if (confidence < HABIT_FAST_THRESHOLD) return null;
  return { key: habit.key, action: habit.action, confidence };
}

export function recordHabitOutcome(self, { key, action, ok, at = Date.now() } = {}) {
  if (!self || typeof self !== 'object') return null;
  if (typeof key !== 'string' || key === '') return null;
  if (!HABIT_ACTIONS.includes(action)) return null;
  const normalized = normalizeHabitKey(key);
  if (!Array.isArray(self.habits)) self.habits = [];
  if (!Array.isArray(self.habitsDormant)) self.habitsDormant = [];

  let habit = self.habits.find(row => row && row.key === normalized);
  // 冷区里的旧习惯被同类结果唤醒时搬回活跃池，不重新从零学。
  if (!habit) {
    const dormantIndex = self.habitsDormant.findIndex(row => row && row.key === normalized);
    if (dormantIndex >= 0) {
      habit = self.habitsDormant.splice(dormantIndex, 1)[0];
      delete habit.dormantAt;
      self.habits.push(habit);
    }
  }
  if (!habit) {
    habit = {
      key: normalized,
      action,
      confidence: HABIT_INITIAL,
      successes: 0,
      failures: 0,
      failureStreak: 0,
      createdAt: at,
      lastAt: at
    };
    self.habits.push(habit);
  }

  if (ok) {
    habit.successes = (Number(habit.successes) || 0) + 1;
    habit.failureStreak = 0;
    habit.confidence = round3(clamp((Number(habit.confidence) || HABIT_INITIAL) + HABIT_SUCCESS_GAIN, 0, 0.95));
  } else {
    habit.failures = (Number(habit.failures) || 0) + 1;
    habit.failureStreak = (Number(habit.failureStreak) || 0) + 1;
    habit.confidence = round3(clamp((Number(habit.confidence) || HABIT_INITIAL) - HABIT_FAILURE_PENALTY, 0, 0.95));
  }
  habit.lastAt = at;

  // 先留高信心，其次留最近用过的；满了不直接删，先沉冷区。
  self.habits.sort(
    (a, b) =>
      (Number(b.confidence) || 0) - (Number(a.confidence) || 0) ||
      (Number(b.lastAt) || 0) - (Number(a.lastAt) || 0)
  );
  demoteDormantHabits(self, at);
  self.updatedAt = new Date(at).toISOString();

  return {
    key: normalized,
    action: habit.action,
    confidence: habit.confidence,
    successes: habit.successes,
    failures: habit.failures,
    failureStreak: habit.failureStreak
  };
}

export function normalizeHabits(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const rows = [];
  for (const row of value) {
    if (!row || typeof row !== 'object') continue;
    if (typeof row.key !== 'string' || row.key === '') continue;
    if (!HABIT_ACTIONS.includes(row.action)) continue;
    const key = normalizeHabitKey(row.key);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      key,
      action: row.action,
      confidence: clamp(Number(row.confidence) || 0, 0, 0.95),
      successes: Math.max(0, Number(row.successes) || 0),
      failures: Math.max(0, Number(row.failures) || 0),
      failureStreak: Math.max(0, Number(row.failureStreak) || 0),
      createdAt: Number(row.createdAt) || Date.now(),
      lastAt: Number(row.lastAt) || Number(row.createdAt) || Date.now()
    });
  }
  rows.sort(
    (a, b) => (Number(b.confidence) || 0) - (Number(a.confidence) || 0) || (Number(b.lastAt) || 0) - (Number(a.lastAt) || 0)
  );
  return rows.slice(0, HABIT_LIMIT);
}

export function normalizeDormant(value, activeKeys = new Set()) {
  if (!Array.isArray(value)) return [];
  const seen = new Set(activeKeys);
  const rows = [];
  for (const row of value) {
    if (!row || typeof row !== 'object') continue;
    if (typeof row.key !== 'string' || row.key === '') continue;
    if (!HABIT_ACTIONS.includes(row.action)) continue;
    const key = normalizeHabitKey(row.key);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      key,
      action: row.action,
      confidence: clamp(Number(row.confidence) || 0, 0, 0.95),
      successes: Math.max(0, Number(row.successes) || 0),
      failures: Math.max(0, Number(row.failures) || 0),
      failureStreak: Math.max(0, Number(row.failureStreak) || 0),
      createdAt: Number(row.createdAt) || Date.now(),
      lastAt: Number(row.lastAt) || Number(row.createdAt) || Date.now(),
      dormantAt: Number(row.dormantAt) || Number(row.lastAt) || Date.now()
    });
  }
  rows.sort((a, b) => (Number(b.lastAt) || 0) - (Number(a.lastAt) || 0));
  return rows.slice(0, HABIT_DORMANT_LIMIT);
}

// 满了只做“搬家”：低信心且半年没用的沉入冷区，不删除；活跃池仍保持上限。
export function demoteDormantHabits(self, now = Date.now()) {
  if (!self || typeof self !== 'object') return [];
  if (!Array.isArray(self.habits)) self.habits = [];
  if (!Array.isArray(self.habitsDormant)) self.habitsDormant = [];
  const moved = [];

  if (self.habits.length >= HABIT_COLD_TRIGGER) {
    for (const habit of [...self.habits]) {
      if (self.habits.length < HABIT_COLD_TRIGGER) break;
      const confidence = effectiveConfidence(habit, now);
      const lastAt = Number(habit.lastAt) || 0;
      if (confidence < HABIT_COLD_CONFIDENCE && now - lastAt > HABIT_COLD_UNUSED_DAYS * DAY_MS) {
        self.habits = self.habits.filter(row => row !== habit);
        self.habitsDormant.push({ ...habit, dormantAt: now });
        moved.push(habit.key);
      }
    }
  }

  if (self.habits.length > HABIT_LIMIT) {
    // 仍然超上限时按“最久没用”搬家，保证刚用过的这条不会被自己的结果挤走。
    const overflow = [...self.habits]
      .sort((a, b) => (Number(a.lastAt) || 0) - (Number(b.lastAt) || 0))
      .slice(0, self.habits.length - HABIT_LIMIT);
    const drop = new Set(overflow);
    self.habits = self.habits.filter(habit => !drop.has(habit));
    for (const habit of overflow) self.habitsDormant.push({ ...habit, dormantAt: now });
    moved.push(...overflow.map(habit => habit.key));
  }

  if (self.habitsDormant.length > HABIT_DORMANT_LIMIT) {
    self.habitsDormant.sort((a, b) => (Number(b.lastAt) || 0) - (Number(a.lastAt) || 0));
    self.habitsDormant = self.habitsDormant.slice(0, HABIT_DORMANT_LIMIT);
  }
  return moved;
}
