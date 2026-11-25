// 第二轮：四层融合（归一化 / RRF+基线保护 / 加权和 / MMR）+ 自适应门槛 + 回指宽召回。
// 断言的是"结构性质"，不是具体分数——分数由 eval 脚本负责，单元测试只钉住不该被改坏的行为。
const COG = new URL('../packages/cognition/lib/', import.meta.url).href;
const {
  recallP4, P4_PARAMS, normalizeLexical, adaptiveThreshold, needsBroadRecall,
  fuseRRF, enforceBaselineQuota, mmrOrder
} = await import(`${COG}memory/recall-p4.js`);

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('PASS', name); }
  else { fail += 1; console.log('FAIL', name, extra); }
};

const now = Date.parse('2026-11-24T12:00:00Z');
const row = (id, title, content, extra = {}) => ({
  id, kind: 'fact', layer: 'episodic', title, content,
  importance: 3, occurredAt: now - 86400_000, tags: [], ...extra
});

// ---------- 第 0 层：sigmoid 归一化 ----------
{
  const q = '我们之前聊过的那个科普视频';
  const mid = normalizeLexical(24.1, q); // 11-20 字档的中位数
  check('sigmoid：等于本档中位数时约 0.5', Math.abs(mid - 0.5) < 0.02, mid.toFixed(3));
  check('sigmoid：分数越高越接近 1', normalizeLexical(200, q) > 0.95, normalizeLexical(200, q).toFixed(3));
  check('sigmoid：分数越低越接近 0', normalizeLexical(0.5, q) < 0.1, normalizeLexical(0.5, q).toFixed(3));
  check('sigmoid：恒在 0~1', [0, 1, 50, 500].every(s => { const v = normalizeLexical(s, q); return v >= 0 && v <= 1; }));
  check('sigmoid：长度分档（同一分数，长问句中点更高→值更低）',
    normalizeLexical(24.1, '啊') > normalizeLexical(24.1, '这是一段很长很长的问题描述用来测试长度分档行为的差异'));
}

// ---------- 第 4 层：自适应门槛 ----------
{
  const shortQ = '在吗';
  const longQ = '你还记得我们之前聊过的那个关于细胞内的共生的视频吗，我想再听一遍';
  check('门槛：短问句比基准更严', adaptiveThreshold(shortQ) > P4_PARAMS.thetaBase);
  check('门槛：长问句比基准更宽', adaptiveThreshold(longQ) < P4_PARAMS.thetaBase);
  const flat = [10, 9, 9, 8, 8];
  const peaked = [100, 40, 30, 20, 10];
  check('门槛：头部分明时放宽（让尾部也进候选）', adaptiveThreshold('普通长度的问题', peaked) <= adaptiveThreshold('普通长度的问题', flat));
}

// ---------- 回指宽召回 ----------
{
  check('回指线索：上次', needsBroadRecall('上次那个视频叫什么来着'));
  check('回指线索：还记得吗', needsBroadRecall('你还记得吗'));
  check('回指线索：之前说', needsBroadRecall('之前说要做的那个'));
  check('回指线索：普通问题不触发', !needsBroadRecall('今天天气怎么样'));
}

// ---------- 第 1 层：RRF ----------
{
  const fused = fuseRRF({ a: ['x', 'y'], b: ['y', 'x'] }, { k: 60 });
  check('RRF：两通道都排第一的条目得分最高或并列',
    fused.length === 2 && Math.abs(fused[0].score - fused[1].score) < 1e-9);
  const biased = fuseRRF({ a: ['x', 'y'], b: ['z'] }, { k: 60, weights: { a: 1, b: 1 } });
  check('RRF：只被单通道选中的条目也在融合结果里', biased.length === 3);
  check('RRF：权重为 0 的通道被忽略', fuseRRF({ a: ['x'], b: ['y'] }, { k: 60, weights: { a: 1, b: 0 } }).length === 1);
}

// ---------- 基线保护 ----------
{
  const baseline = new Set(['b1', 'b2', 'b3']);
  const list = [
    { id: 'n1', blend: 0.9 }, { id: 'n2', blend: 0.8 }, { id: 'n3', blend: 0.7 },
    { id: 'b1', blend: 0.2 }, { id: 'b2', blend: 0.1 }, { id: 'b3', blend: 0.05 }
  ];
  const out = enforceBaselineQuota(list, baseline, { limit: 4, floor: 0.5 });
  const kept = out.filter(item => baseline.has(item.id)).length;
  check('基线保护：最终输出至少有 ceil(limit×floor) 条来自基线', kept >= 2, `${kept} 条`);
  check('基线保护：输出长度不超过 limit', out.length <= 4, String(out.length));
  const noFloor = enforceBaselineQuota(list, baseline, { limit: 4, floor: 0 });
  check('基线保护：floor=0 时完全按分数取', noFloor.map(i => i.id).join(',') === 'n1,n2,n3,b1');
}

// ---------- 第 3 层：MMR ----------
{
  const items = [
    { id: 'a', title: '缓存设计', excerpt: '缓存与索引共用淘汰策略', blend: 1 },
    { id: 'b', title: '缓存设计', excerpt: '缓存与索引共用淘汰策略', blend: 0.99 },
    { id: 'c', title: '索引结构', excerpt: '索引向存储层转移', blend: 0.9 }
  ];
  const out = mmrOrder(items, { lambda: 0.7, limit: 2 });
  check('MMR：优先选与已选内容不重复的条目', out.map(i => i.id).includes('c'), out.map(i => i.id).join(','));
  const single = mmrOrder([items[0]], { lambda: 0.7, limit: 2 });
  check('MMR：单条输入原样返回', single.length === 1);
}

// ---------- 端到端 ----------
{
  const rows = [
    row('m1', '缓存设计', '缓存与索引来自同一套淘汰策略', { importance: 4 }),
    row('m2', '索引结构', '索引数据向存储层转移', { importance: 3 }),
    row('m3', '晚饭吃了面', '用户煮了面', { importance: 1 }),
    row('m4', '缓存淘汰', 'LRU 参与缓存淘汰', { importance: 3 })
  ];
  const r = recallP4(rows, '缓存是怎么淘汰的', { now, limit: 3 });
  check('端到端：返回 p4 模式与诊断字段', r.mode === 'p4' && Array.isArray(r.items));
  check('端到端：相关性最高的排第一', /缓存|索引/.test(`${r.items[0]?.title}${r.items[0]?.excerpt}`), r.items[0]?.title);
  check('端到端：包含三条通道诊断', Boolean(r.channels) && 'legacy' in r.channels && 'wake' in r.channels && 'phrase' in r.channels);
  check('端到端：字符预算内', r.items.reduce((a, i) => a + JSON.stringify(i).length, 0) <= r.charBudget + 400);

  const broad = recallP4(rows, '上次那个缓存的方案你还记得吗', { now, limit: 2 });
  check('端到端：回指查询触发宽召回标记', broad.broad === true, String(broad.broad));

  const quiet = recallP4(rows, '量子纠缠的贝尔不等式', { now, limit: 3 });
  check('端到端：完全无关的查询可以空答或得分很低',
    quiet.items.length === 0 || quiet.items.every(i => i.score < 0.5), `${quiet.items.length} 条`);
}

console.log(`\n结果：pass=${pass} fail=${fail}`);
if (fail > 0) process.exitCode = 1;
