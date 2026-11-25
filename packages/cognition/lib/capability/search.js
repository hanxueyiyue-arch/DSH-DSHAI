// 能力检索：名字 / 前缀 / 描述 / 中文二元组 / 英文词。
// 返回"名字 + 一句话"，不带参数（参数用 describe 查）。
const clip = (text, limit) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
const norm = text => String(text ?? '').toLowerCase().replace(/\s+/g, '').trim();

function queryTerms(query) {
  const text = String(query ?? '').toLowerCase();
  const terms = new Set();
  for (const word of text.match(/[a-z][a-z0-9._-]+/g) ?? []) terms.add(word);
  for (const run of text.match(/[\u3400-\u9fff]+/g) ?? []) {
    if (run.length <= 2) { terms.add(run); continue; }
    for (let i = 0; i + 1 < run.length; i += 1) terms.add(run.slice(i, i + 2));
  }
  return terms;
}

function scoreTool(item, query) {
  const q = norm(query);
  const name = norm(item.tool);
  const desc = norm(item.description);
  if (!q) return 0;
  let base = 0;
  if (name === q) base = 100;
  else if (name.startsWith(q)) base = 90;
  else if (name.includes(q)) base = 80;
  else if (desc.includes(q)) base = 60;
  let hits = 0;
  let best = 0;
  for (const term of queryTerms(query)) {
    if (name.includes(term)) { hits += 1; best = Math.max(best, 50); continue; }
    if (desc.includes(term)) { hits += 1; best = Math.max(best, 30); }
  }
  return Math.max(base, best + Math.min(40, hits * 8));
}

export function searchCatalog(catalog, { query = '', limit = 5, allLimit = 20 } = {}) {
  if (!catalog?.ok) return { ok: false, reason: 'catalog-unavailable', query, total: 0, items: [] };
  const q = String(query ?? '').trim();
  const wantsAll = q === '' || q === '*';
  const rows = wantsAll
    ? catalog.items.slice().sort((a, b) => a.tool.localeCompare(b.tool)).slice(0, allLimit)
    : catalog.items
        .map(item => ({ item, score: scoreTool(item, q) }))
        .filter(row => row.score > 0)
        .sort((a, b) => b.score - a.score || a.item.tool.localeCompare(b.item.tool))
        .slice(0, limit)
        .map(row => row.item);
  return {
    ok: true,
    query: q,
    total: rows.length,
    items: rows.map(item => ({
      tool: item.tool,
      summary: clip(item.description, 60),
      domain: item.domain,
      executable: item.executable
    }))
  };
}
