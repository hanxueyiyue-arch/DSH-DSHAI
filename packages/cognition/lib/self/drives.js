// 兴趣、好奇心、动机：行为侧的可演化状态，只影响权重，不设行为配额。
// 所有更新都是小幅、可衰减、可解释的；不读磁盘、不调模型。

const DAY_MS = 86_400_000;
const clamp01 = value => Math.max(0, Math.min(1, value));
const finite = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

// 话题提取只做轻量字面切分：不引入分词依赖，也不把结构标签当兴趣。
const STOP_CHARS = new Set(
  '我你他她它们的了是在有和就都也还又很挺太这那哪个什么怎样吗呢吧啊呀哦嗯把被给对从向与及或但如果因为所以然后而且不过虽然已经正在每天最近下次有点一点自己想要觉得可以会能说试学请帮'.split('')
);
const STOP_GRAMS = new Set(['时候', '现在', '感觉', '知道', '什么', '怎么', '这个', '那个', '一下', '还是', '就是', '但是', '因为', '所以', '如果', '已经', '正在', '每天', '最近', '下次', '有点', '一点', '自己', '想要', '觉得', '可以', '我们', '你们', '他们', '意思', '思的', '味比', '比上', '明显', '挺有', '有意']);

export const INTEREST_LIMIT = 24;
export const CURIOSITY_BASE = 0.2;
export const MOTIVATION_BASE = 0.4;

// 每日增量上限：避免“聊得越多越兴奋”一路顶到 1。
// 配合 2 天半衰期，curiosity 稳态约 0.54、motivation 约 0.67（落在 0.3–0.7）。
export const DAILY_GAIN_CAP = Object.freeze({ curiosity: 0.10, motivation: 0.08 });
const DRIVE_FIELDS = Object.freeze(['curiosity', 'motivation']);

// 半衰期（天）：好奇/动机是“今天有没有劲”，不该按周算。
const DRIVE_HALF_LIFE_DAYS = 2;
const INTEREST_HALF_LIFE_DAYS = 60;

function dayOf(now) {
  const date = new Date(Number(now));
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '';
}

// 正向增量受每日额度约束；负向（回落/惩罚）不受限，也不占额度。
function applyGain(drives, field, delta, now) {
  const value = Number(delta);
  if (!Number.isFinite(value) || value === 0) return 0;
  const current = clamp01(finite(drives[field], 0));
  if (value < 0) {
    drives[field] = clamp01(current + value);
    return value;
  }
  const day = dayOf(now);
  if (drives.gainDay !== day) {
    drives.gainDay = day;
    drives.gain = {};
  }
  const used = clamp01(finite(drives.gain?.[field], 0));
  const room = Math.max(0, (DAILY_GAIN_CAP[field] ?? 0) - used);
  const applied = Math.min(value, room);
  if (applied <= 0) return 0;
  drives[field] = clamp01(current + applied);
  drives.gain = { ...(drives.gain ?? {}), [field]: used + applied };
  return applied;
}

// 从一句用户原话里取内容词：先按虚词/停用字切成内容片段，再取片段本身或
// 相邻二字；过滤含虚词的字与常见套话。不引入分词依赖，也不针对单句堆词表。
export function topicsFromText(text, { limit = 4 } = {}) {
  const source = String(text ?? '');
  const counts = new Map();
  const add = gram => {
    if (gram.length < 2) return;
    if (STOP_GRAMS.has(gram)) return;
    if ([...gram].some(char => STOP_CHARS.has(char))) return;
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  };
  const segments = source
    .split(/[^\u3400-\u9fff]+/)
    .flatMap(run => run.split(new RegExp(`[${[...STOP_CHARS].join('')}]+`)))
    .filter(segment => segment.length >= 2);
  for (const segment of segments) {
    if (segment.length <= 3) {
      add(segment);
      continue;
    }
    for (let i = 0; i + 1 < segment.length; i += 1) add(segment.slice(i, i + 2));
    if (segment.length <= 5) add(segment);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, Math.max(1, limit))
    .map(([topic]) => topic);
}

export function blankDrives() {
  return {
    curiosity: CURIOSITY_BASE,
    motivation: MOTIVATION_BASE,
    updatedAt: null,
    decayedAt: null,
    gainDay: null,
    gain: {}
  };
}

export function normalizeDrives(value) {
  const data = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const gain = {};
  for (const field of DRIVE_FIELDS) {
    const used = Number(data.gain?.[field]);
    if (Number.isFinite(used) && used > 0) gain[field] = clamp01(used);
  }
  return {
    curiosity: clamp01(finite(data.curiosity, CURIOSITY_BASE)),
    motivation: clamp01(finite(data.motivation, MOTIVATION_BASE)),
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : null,
    decayedAt: typeof data.decayedAt === 'string' ? data.decayedAt : null,
    gainDay: typeof data.gainDay === 'string' && data.gainDay ? data.gainDay : null,
    gain
  };
}

function normalizeInterests(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries = Object.entries(value)
    .filter(([topic, weight]) => typeof topic === 'string' && topic.trim() && Number.isFinite(Number(weight)))
    .map(([topic, weight]) => [topic.trim().slice(0, 40), clamp01(Number(weight))])
    .sort((a, b) => b[1] - a[1])
    .slice(0, INTEREST_LIMIT);
  return Object.fromEntries(entries);
}

function decayFactor(lastAt, now, halfLifeDays) {
  const last = Number(lastAt);
  if (!Number.isFinite(last) || !Number.isFinite(now) || now <= last) return 1;
  return Math.pow(2, -((now - last) / DAY_MS) / halfLifeDays);
}

// 兴趣是“最近被反复触碰的话题”的慢变量；单次聊天不会把它推到顶。
export function observeEvent(behavior, { topics = [], question = false, now = Date.now() } = {}) {
  if (!behavior || typeof behavior !== 'object') return behavior;
  behavior.interests = normalizeInterests(behavior.interests);
  for (const topic of topics.slice(0, 6)) {
    const key = String(topic ?? '').trim().slice(0, 40);
    if (!key) continue;
    const current = clamp01(finite(behavior.interests[key], 0.15));
    behavior.interests[key] = Number(clamp01(current + 0.18 * (0.6 - current)).toFixed(4));
  }
  const drives = normalizeDrives(behavior.drives);
  // 增量受每日上限约束（负向不受限）
  applyGain(drives, 'curiosity', question ? 0.1 : -0.015, now);
  applyGain(drives, 'motivation', 0.02, now);
  drives.updatedAt = new Date(now).toISOString();
  behavior.drives = drives;
  return behavior;
}

// 行为结果回来：成功让相关话题更“想聊”，失败则收回一点，但不禁止再尝试。
export function observeOutcome(behavior, { ok = true, topics = [], proactive = false, now = Date.now(), weight = 1 } = {}) {
  if (!behavior || typeof behavior !== 'object') return behavior;
  const strength = Math.max(0.1, Math.min(1, Number(weight) || 1));
  behavior.interests = normalizeInterests(behavior.interests);
  const signal = ok ? 0.82 : 0.3;
  for (const topic of topics.slice(0, 6)) {
    const key = String(topic ?? '').trim().slice(0, 40);
    if (!key) continue;
    const current = clamp01(finite(behavior.interests[key], 0.15));
    behavior.interests[key] = Number(clamp01(current + 0.2 * (signal - current) * strength).toFixed(4));
  }
  const drives = normalizeDrives(behavior.drives);
  // 普通回复不消耗好奇；只有主动发问被接住时，才把这份好奇收一点。
  if (!ok) applyGain(drives, 'curiosity', 0.03 * strength, now);
  else if (proactive) applyGain(drives, 'curiosity', -0.02 * strength, now);
  applyGain(drives, 'motivation', ((ok ? 0.07 : -0.05) + (proactive ? 0.02 : 0)) * strength, now);
  drives.updatedAt = new Date(now).toISOString();
  behavior.drives = drives;
  return behavior;
}

// 长期不用会慢慢回落；只降权重，不删兴趣记录。
export function decayDrives(behavior, now = Date.now()) {
  if (!behavior || typeof behavior !== 'object') return behavior;
  behavior.interests = normalizeInterests(behavior.interests);
  const drives = normalizeDrives(behavior.drives);
  // R8：以“上次真正衰减的时间”为基准，而不是每次事件都从 updatedAt 重算；
  // 同时保证时钟回拨或同一时间重复调用不会二次衰减。
  const lastEvent = Date.parse(drives.updatedAt ?? '');
  const lastDecay = Date.parse(drives.decayedAt ?? '');
  const hasBase = Number.isFinite(lastEvent) || Number.isFinite(lastDecay);
  const base = Math.max(Number.isFinite(lastEvent) ? lastEvent : 0, Number.isFinite(lastDecay) ? lastDecay : 0);
  if (!Number.isFinite(now) || !hasBase || now <= base) return behavior;
  const factor = decayFactor(base, now, INTEREST_HALF_LIFE_DAYS);
  for (const [topic, weight] of Object.entries(behavior.interests)) {
    behavior.interests[topic] = Number((weight * factor).toFixed(4));
  }
  // 好奇/动机是“今天有没有劲”：2 天半衰期，配合每日增量上限形成稳态。
  const moodFactor = decayFactor(base, now, DRIVE_HALF_LIFE_DAYS);
  drives.curiosity = Number(
    clamp01(CURIOSITY_BASE + (drives.curiosity - CURIOSITY_BASE) * moodFactor).toFixed(4)
  );
  drives.motivation = Number(
    clamp01(MOTIVATION_BASE + (drives.motivation - MOTIVATION_BASE) * moodFactor).toFixed(4)
  );
  drives.decayedAt = new Date(now).toISOString();
  behavior.drives = drives;
  return behavior;
}

export function driveSummary(behavior, { limit = 3 } = {}) {
  const drives = normalizeDrives(behavior?.drives);
  const interests = Object.entries(normalizeInterests(behavior?.interests))
    .filter(([, weight]) => weight >= 0.03)
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(1, limit))
    .map(([topic, weight]) => ({ topic, weight }));
  return { curiosity: drives.curiosity, motivation: drives.motivation, interests };
}

// 召回偏置：给“最近在意的话题”一点额外权重，不改变证据本身。
export function interestBoost(behavior, topics = []) {
  const summary = driveSummary(behavior, { limit: 8 });
  const map = new Map(summary.interests.map(item => [item.topic, item.weight]));
  let best = 0;
  for (const topic of topics) best = Math.max(best, map.get(String(topic)) ?? 0);
  return clamp01(0.7 * best + 0.3 * summary.curiosity);
}
