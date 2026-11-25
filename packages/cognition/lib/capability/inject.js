// 本轮注入：概览 + 手边工具（预置/最近/常用 + 搜索结果），带字符预算。
import { buildOverview, OVERVIEW_MAX_CHARS } from './overview.js';
import { selectForInjection, SEED_TOOLS } from './skills.js';

export const INJECT_BUDGET_CHARS = 1200;
export const PENDING_LIMIT = 5;

export const SEARCH_ACTIONS = Object.freeze(['search', 'describe']);

function toToolEntry(item) {
  return {
    tool: item.tool,
    readOnly: item.readOnly,
    cost: item.cost,
    description: item.description,
    args: item.args
  };
}

function charsOf(overview, tools) {
  return overview.length + JSON.stringify(tools).length;
}

export function buildInjection({
  catalog,
  skills = null,
  pending = [],
  budgetChars = INJECT_BUDGET_CHARS,
  overviewChars = OVERVIEW_MAX_CHARS
} = {}) {
  if (!catalog?.ok) {
    return {
      ok: false,
      reason: 'catalog-unavailable',
      overview: buildOverview(catalog, { maxChars: overviewChars }),
      tools: [],
      actions: [],
      chars: 0,
      sources: { seed: 0, pending: 0, memory: 0 }
    };
  }

  const actions = catalog.total > 0 ? [...SEARCH_ACTIONS] : [];

  const byName = new Map(catalog.items.map(item => [item.tool, item]));
  // 1) 上一轮搜索到的工具（临时，只活一轮）
  const pendingItems = (Array.isArray(pending) ? pending : [])
    .map(row => byName.get(typeof row === 'string' ? row : row?.tool))
    .filter(Boolean)
    .slice(0, PENDING_LIMIT);
  // 2) 使用印象（最近 3 + 常用 2）；记录还很少时，把预置工具补进来，保持"手边熟工具"
  let memoryRows = [];
  let usedSeed = false;
  if (skills && Array.isArray(skills.items) && skills.items.length > 0) {
    memoryRows = selectForInjection(skills);
    if (skills.items.length < 3) {
      usedSeed = true;
      for (const tool of SEED_TOOLS) {
        if (memoryRows.some(row => row.tool === tool)) continue;
        memoryRows.push({ tool });
      }
    }
  } else {
    usedSeed = true;
    memoryRows = SEED_TOOLS.map(tool => ({ tool }));
  }
  const memoryItems = memoryRows.map(row => byName.get(row.tool)).filter(Boolean);

  // 搜索结果优先，其次手边工具；去重
  const merged = [];
  const seen = new Set();
  for (const item of [...pendingItems, ...memoryItems]) {
    if (seen.has(item.tool)) continue;
    seen.add(item.tool);
    merged.push(item);
  }

  let overview = buildOverview(catalog, { maxChars: overviewChars });
  let tools = merged.map(toToolEntry);

  const isPending = tool => pendingItems.some(item => item.tool === tool);
  // 裁剪 1：临时搜索结果保留最多 3 条
  while (tools.length > 0 && charsOf(overview, tools) > budgetChars) {
    if (tools.filter(row => isPending(row.tool)).length <= 3) break;
    const last = [...tools].reverse().find(row => isPending(row.tool));
    if (!last) break;
    tools = tools.filter(row => row.tool !== last.tool);
  }
  // 裁剪 2：手边工具从末尾砍
  while (tools.length > 0 && charsOf(overview, tools) > budgetChars) {
    const last = [...tools].reverse().find(row => !isPending(row.tool));
    if (!last) break;
    tools = tools.filter(row => row.tool !== last.tool);
  }
  // 裁剪 3：概览降级
  if (charsOf(overview, tools) > budgetChars) {
    overview = buildOverview(catalog, { maxChars: Math.max(80, Math.floor(overviewChars * 0.5)) });
  }

  return {
    ok: true,
    overview,
    tools,
    actions,
    chars: charsOf(overview, tools),
    sources: { seed: usedSeed ? tools.filter(row => SEED_TOOLS.includes(row.tool)).length : 0, pending: tools.filter(row => isPending(row.tool)).length, memory: tools.length }
  };
}
