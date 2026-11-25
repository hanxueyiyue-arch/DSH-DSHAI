// 能力目录：从总线给过来的一份 capabilities 快照，生成规范化视图。
// 只读、纯函数；目录不可用时调用方需要能区分"目录没有"和"匹配为空"。
export function buildCatalog(tools = []) {
  const items = [];
  const seen = new Set();
  for (const raw of Array.isArray(tools) ? tools : []) {
    const tool = typeof raw?.tool === 'string' ? raw.tool.trim() : '';
    if (!tool || seen.has(tool)) continue;
    seen.add(tool);
    const args = raw.args && typeof raw.args === 'object' && !Array.isArray(raw.args) ? raw.args : {};
    const readOnly = raw.readOnly === true;
    const selfService = raw.selfService === true;
    items.push({
      tool,
      domain: tool.split('.')[0] || 'other',
      readOnly,
      selfService,
      cost: typeof raw.cost === 'string' ? raw.cost : 'free',
      description: String(raw.description ?? '').slice(0, 200),
      args,
      argsKeys: Object.keys(args),
      executable: readOnly || selfService
    });
  }
  const catalog = { ok: true, items, total: items.length };
  catalog.groups = groupByDomain(catalog);
  return catalog;
}

export function groupByDomain(catalog) {
  const map = new Map();
  for (const item of catalog?.items ?? []) {
    const list = map.get(item.domain) ?? [];
    list.push(item);
    map.set(item.domain, list);
  }
  return [...map.entries()].map(([domain, list]) => ({
    domain,
    count: list.length,
    tools: list.map(item => item.tool)
  }));
}

export function findTool(catalog, name) {
  if (!catalog?.ok) return null;
  const key = String(name ?? '').trim();
  if (!key) return null;
  return catalog.items.find(item => item.tool === key)
    ?? catalog.items.find(item => item.tool.toLowerCase() === key.toLowerCase())
    ?? null;
}
