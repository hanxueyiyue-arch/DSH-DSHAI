/** BrainMem V2: deterministic, locally indexed, evidence-first, bounded-context memory.
 * No remote embeddings, model calls, automatic deletion, or arbitrary file access.
 */
import { lexemes } from './memory.js';
import { brainStrength } from './brainmem.js';
import { clipped, memoryDate } from './text-util.js';
import { filterPoolByValidity, validityFilterEnabled } from './recall-filter.js';

export const LAYERS = Object.freeze(['episodic', 'semantic', 'autobiographical', 'preference']);
/** 概念组：查询扩展与主题判断的唯一词表（不再复制第二份）。 */
export { CONCEPTS } from './concepts.js';
import { CONCEPTS } from './concepts.js';
const bounded = (v,lo,hi,d) => Number.isFinite(Number(v)) ? Math.max(lo,Math.min(hi,Math.floor(Number(v)))) : d;
export function memoryLayer(m) {
  if (LAYERS.includes(m?.layer)) return m.layer;
  if (m?.kind === 'preference') return 'preference';
  if (m?.kind === 'semantic' || m?.kind === 'human-reviewed-reconstruction') return 'semantic';
  if (m?.kind === 'autobiographical') return 'autobiographical';
  return 'episodic'; // Old V0.1/V0.2 records are inferred, not rewritten.
}
export function queryTerms(raw) {
  const q = clipped(raw,150).toLowerCase();
  const tokens = lexemes(q);
  const expansions = new Set();
  for (const group of CONCEPTS) {
    // Expansion is deliberately small and weaker than an exact match.
    if (group.some(term=>q.includes(term))) for(const term of group) for(const token of lexemes(term)) expansions.add(token);
  }
  for (const token of tokens) expansions.delete(token);
  return { tokens, expansions };
}
export function buildMemoryIndex(memories = []) {
  const docs = [], df = new Map(), postings = new Map();
  let totalLength = 0;
  for (const memory of memories) {
    if (!memory || typeof memory !== 'object' || !memory.id) continue;
    const title = clipped(memory.title,80), tags=clipped(memory.tags,120);
    const raw = `${title} ${tags} ${clipped(memory.content,1000)}`;
    const frequencies=new Map();
    for(const token of lexemes(raw)) frequencies.set(token,1);
    // Boost name/label matching without extra tokens sent to the model.
    for(const token of lexemes(`${title} ${tags}`)) frequencies.set(token,(frequencies.get(token)||0)+2);
    const length=[...frequencies.values()].reduce((a,b)=>a+b,0)||1;
    const doc={memory,frequencies,length}; const idx=docs.length;docs.push(doc); totalLength+=length;
    for (const token of frequencies.keys()) {
      df.set(token,(df.get(token)||0)+1);
      if (!postings.has(token)) postings.set(token,[]);
      postings.get(token).push(idx);
    }
  }
  return {docs,postings,df,avgLength:totalLength/(docs.length||1)};
}
export function searchIndex(index,query,{limit=20,now=Date.now()}={}) {
  const {tokens,expansions}=queryTerms(query);
  if (!tokens.size) return [];
  const sums=new Map();const n=index.docs.length, avg=index.avgLength||1;
  for (const [token,weight] of [...[...tokens].map(t=>[t,1]), ...[...expansions].map(t=>[t,0.24])]) {
    const rows=index.postings.get(token);if(!rows)continue;
    const idf=Math.log(1+(n-(index.df.get(token)||0)+0.5)/((index.df.get(token)||0)+0.5));
    for (const id of rows) {
      const d=index.docs[id],tf=d.frequencies.get(token)||0;
      const bm=idf*(tf*2.2/(tf+1.2*(0.25+0.75*d.length/avg)));
      sums.set(id,(sums.get(id)||0)+weight*bm);
    }
  }
  const matches=[];
  for(const [id,lexical] of sums){
    const memory=index.docs[id].memory;const retention=brainStrength(memory,now);
    // Importance and freshness influence ranking but never fabricate relevance.
    const score=lexical*(0.78+0.22*retention.strength);
    matches.push({memory,score,lexical,retention,layer:memoryLayer(memory)});
  }
  return matches.sort((a,b)=>b.score-a.score).slice(0,bounded(limit,1,50,20));
}
export function memoryOverview(memories,now=Date.now()){
  const counts=Object.fromEntries(LAYERS.map(l=>[l,0]));
  const stages={details:0,overview:0,trace:0};
  for(const m of memories){counts[memoryLayer(m)]++;
    const s=brainStrength(m,now);const stage=s.detailStrength>=0.48?'details':s.strength>=0.18?'overview':'trace';stages[stage]++;
  }
  return {active:memories.length,layers:counts,stages};
}
function compact(m,hit,excerptChars){
  const stage=hit.retention.detailStrength>=0.48?'details':hit.retention.strength>=0.18?'overview':'trace';
  const clean={id:m.id,title:clipped(m.title,70),layer:hit.layer,kind:m.kind||'legacy-unclassified',
    score:Number(hit.score.toFixed(3)),recallLevel:stage,date:memoryDate(m),
    source:m.source?.platform==='bilibili'?{platform:'bilibili',bvid:m.source.bvid,level:m.source.level}:
      m.source?.level?{level:m.source.level}:null};
  // Old evidence is retained on disk. A weak memory is deliberately not expanded.
  if(stage==='details') clean.excerpt=clipped(m.content,excerptChars);
  else if(stage==='overview')clean.excerpt='仅保留标题线索；需要核实时请查阅原始证据';
  else clean.excerpt='模糊痕迹；原始证据仍保存在本地';
  return clean;
}
/** Return a strict character budget, as a conservative, non-model-specific token proxy. */
export function compactContext(memories,query,{maxTokens=800,limit=6,now=Date.now()}={}){
  const tokens=bounded(maxTokens,200,1600,800), maxChars=tokens; // UTF-8 Chinese may take ~1 token/character.
  const desired=bounded(limit,1,10,6);
  const hits=searchIndex(buildMemoryIndex(memories),query,{limit:desired,now});
  const out={query:clipped(query,60),readOnly:true,evidenceOnly:true,items:[],truncated:false,charBudget:maxChars,note:'本地证据摘要；公开元数据不代表观看视频。'};
  // Slice by actual serialized JSON size. No unbounded memory bodies leak into model context.
  for(const hit of hits){
    const item=compact(hit.memory,hit,160);
    const next=JSON.stringify({...out,items:[...out.items,item]});
    if (next.length>maxChars) {
      let allowed=Math.min(160,Math.max(0,maxChars-JSON.stringify(out).length-JSON.stringify(item).length+item.excerpt.length-30));
      if (allowed<16) break;
      item.excerpt=clipped(item.excerpt,allowed);
      if(JSON.stringify({...out,items:[...out.items,item]}).length>maxChars) break;
    }
    out.items.push(item);
  }
  out.truncated=out.items.length<hits.length;
  return out;
}
/** Character-budgeted, read-only recall used by the Autonomy closed loop.
 * Evidence stays evidence: every item carries kind/source level/test flag so the
 * caller can weight it, and nothing here writes lastRecalledAt or recallCount. */
export function cycleRecall(memories, query, {
  limit = 6, maxChars = 800, includeTest = false, now = Date.now(), debug = false,
  validity = validityFilterEnabled(), includeNotYet = false,
} = {}) {
  const desired = bounded(limit, 1, 10, 6);
  const budget = bounded(maxChars, 200, 1600, 800);
  let pool = (Array.isArray(memories) ? memories : [])
    .filter(m => m && typeof m === 'object' && m.id && (includeTest || (m.kind !== 'test' && m.isTest !== true)));

  // 时间资格：默认关。开启后只裁"当前事实"的候选池，不参与打分。
  // `not_yet` 留作背景池：默认不出现，只有调用方显式要未来背景时才带标记返回。
  let notYetPool = [];
  let validityInfo = null;
  if (validity) {
    const split = filterPoolByValidity(pool, { now, includeNotYet: false });
    notYetPool = split.notYet.map(row => row.memory);
    validityInfo = { enabled: true, excluded: split.dropped.length, notYetAvailable: notYetPool.length };
    pool = split.kept.map(row => row.memory);
  }

  const hits = searchIndex(buildMemoryIndex(pool), query, { limit: 50, now });
  const out = {
    readOnly: true, evidenceOnly: true, query: clipped(query, 150),
    items: [], topicHits: {}, truncated: false, charBudget: budget, degraded: null,
    ...(validityInfo ? { validityFilter: { ...validityInfo, notYetIncluded: 0 } } : {}),
  };

  const render = (hit, extra = null) => {
    const m = hit.memory;
    const stage = hit.retention.detailStrength >= 0.48 ? 'details'
      : hit.retention.strength >= 0.18 ? 'overview' : 'trace';
    const item = {
      id: m.id, title: clipped(m.title, 70), kind: m.kind || 'legacy-unclassified', layer: hit.layer,
      sourceLevel: m.source?.level || null, platform: m.source?.platform || null,
      isTest: m.isTest === true || m.kind === 'test', createdAt: m.createdAt || null,
      tags: clipped(m.tags, 120), score: Number(Number(hit.score).toFixed(3)), recallLevel: stage,
      excerpt: stage === 'details' ? clipped(m.content, 160)
        : stage === 'overview' ? '仅保留标题线索；需要核实时请查阅原始证据'
          : '模糊痕迹；原始证据仍保存在本地',
    };
    return extra ? { ...item, ...extra } : item;
  };

  const push = (hit, extra) => {
    const item = render(hit, extra);
    if (JSON.stringify({ ...out, items: [...out.items, item] }).length > budget) { out.truncated = true; return false; }
    out.items.push(item);
    for (const topic of clipped(hit.memory.tags, 120).split(/\s+/).filter(Boolean)) {
      out.topicHits[topic] = (out.topicHits[topic] || 0) + 1;
    }
    return true;
  };

  for (const hit of hits) {
    if (out.items.length >= desired) { out.truncated = true; break; }
    if (!push(hit, null)) break;
  }

  // 未来背景：只在调用方明确要求时追加，且必须带 `notYet: true`——
  // 它不能混进当前事实里冒充"已经成立"。
  if (validity && includeNotYet && notYetPool.length) {
    const background = searchIndex(buildMemoryIndex(notYetPool), query, { limit: 50, now });
    for (const hit of background) {
      if (out.items.length >= desired) { out.truncated = true; break; }
      if (!push(hit, { notYet: true })) break;
      out.validityFilter.notYetIncluded += 1;
    }
  }

  if (out.items.length < hits.length) out.truncated = true;
  if (debug) {
    out.debug = {
      pool: pool.length,
      matched: hits.length,
      returned: out.items.length,
      filtered: Math.max(0, hits.length - out.items.length),
      truncated: out.truncated,
      ...(validityInfo ? { notYetPool: notYetPool.length } : {}),
    };
  }
  return out;
}
export function consolidationSuggestion(memories,query){
  const hits=searchIndex(buildMemoryIndex(memories),query,{limit:6}).slice(0,4);
  return {status:'unverified',persisted:false,sourceIds:hits.map(x=>x.memory.id),
    evidence:hits.map(x=>({id:x.memory.id,title:x.memory.title,layer:x.layer,source:x.memory.source||null})),
    proposal:hits.length>=2?'这些记录可能涉及同一主题。可人工核实后提炼一条语义或偏好记忆；不得将相关性当成事实。':'证据不足，不建议整合。',
    warning:'不会自动保存摘要、覆盖记忆或生成不存在的经历。'};
}
