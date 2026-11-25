// 工具使用印象：存在 stateRoot/skills/tool-usage.json。
// 不设上限、不做衰减：条目只随"用过的工具种类"增长；次数只用于强化印象。
export const USAGE_RECENT = 3;
export const USAGE_FREQUENT = 2;
export const SKILLS_SCHEMA = 1;

const DAY_MS = 86_400_000;
const round2 = value => Math.round(value * 100) / 100;

function perDayOf(row) {
  const days = Math.max(1, Math.floor((row.lastAt - row.firstAt) / DAY_MS) + 1);
  return round2(row.count / days);
}

export function blankSkills(now = Date.now()) {
  return { schema: SKILLS_SCHEMA, updatedAt: new Date(now).toISOString(), items: [] };
}

export function normalizeSkills(value, { now = Date.now() } = {}) {
  const raw = value && typeof value === 'object' ? value : {};
  const rows = [];
  const seen = new Set();
  for (const row of Array.isArray(raw.items) ? raw.items : []) {
    const tool = typeof row?.tool === 'string' ? row.tool.trim() : '';
    if (!tool || seen.has(tool)) continue;
    seen.add(tool);
    const count = Math.max(1, Number(row.count) || 1);
    const firstAt = Number(row.firstAt) || 0;
    const lastAt = Number(row.lastAt) || firstAt;
    const item = {
      tool,
      purpose: String(row.purpose ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
      count,
      perDay: 0,
      firstAt,
      lastAt
    };
    item.perDay = perDayOf(item);
    rows.push(item);
  }
  return { schema: SKILLS_SCHEMA, updatedAt: String(raw.updatedAt ?? new Date(now).toISOString()), items: rows };
}

export function recordUsage(state, { tool, purpose = '', now = Date.now() } = {}) {
  const next = normalizeSkills(state, { now });
  if (typeof tool !== 'string' || !tool.trim()) return next;
  const key = tool.trim();
  const found = next.items.find(item => item.tool === key);
  if (found) {
    found.count += 1;
    found.lastAt = now;
    if (purpose) found.purpose = String(purpose).slice(0, 60);
    found.perDay = perDayOf(found);
  } else {
    next.items.push({ tool: key, purpose: String(purpose ?? '').slice(0, 60), count: 1, perDay: 1, firstAt: now, lastAt: now });
  }
  next.updatedAt = new Date(now).toISOString();
  return next;
}

// 注入选择：最近 3 + 使用最多 2，去重，≤5
export function selectForInjection(state, { recent = USAGE_RECENT, frequent = USAGE_FREQUENT } = {}) {
  const rows = normalizeSkills(state).items;
  const picked = [...rows].sort((a, b) => b.lastAt - a.lastAt).slice(0, recent);
  const rest = rows
    .filter(row => !picked.some(item => item.tool === row.tool))
    .sort((a, b) => b.count - a.count || b.perDay - a.perDay || b.lastAt - a.lastAt);
  picked.push(...rest.slice(0, frequent));
  return picked;
}

// 冷启动预置：没有任何使用记录时，手边放这三个最常用的。
export const SEED_TOOLS = Object.freeze(['bilibili.browse', 'diary.write', 'heartbeat.set']);
