// 能力概览：域 + 数量 + 工具名，带字符预算。
export const OVERVIEW_MAX_CHARS = 600;

export function buildOverview(catalog, { maxChars = OVERVIEW_MAX_CHARS } = {}) {
  if (!catalog?.ok) return '能力目录暂不可用，这一轮只能对话。';
  if (catalog.total === 0) return '这一轮没有可用的工具，只能说话。';
  const groups = catalog.groups ?? [];
  const head = `能力概览（共 ${catalog.total} 个，${groups.length} 个域）：`;
  const tail = '具体工具用 search，参数用 describe。';
  const detail = groups
    .map(group => `${group.domain}(${group.count})：${group.tools.map(tool => tool.split('.').slice(1).join('.') || tool).join('/')}`)
    .join('；');
  let text = `${head}${detail}。${tail}`;
  if (text.length <= maxChars) return text;
  // 超预算：只留域和数量
  text = `${head}${groups.map(group => `${group.domain}(${group.count})`).join('；')}。${tail}`;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}
