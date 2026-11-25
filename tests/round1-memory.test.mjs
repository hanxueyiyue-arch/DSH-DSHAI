// 第 1 轮（A/B/J + 标题前缀）回归测试：只验证这次改动的四条可观测行为。
//
// 为什么钉这几条：
//   - excerpt/date：线上曾经模型可见证据 0 字符（P4 item 只有标题），且完全没有日期；
//   - 预算只算转发字段：诊断字段曾吃掉 800 字符预算三分之一，limit=5 实际只回 3 条；
//   - markInjected vs markUsed：旧实现把"进召回列表"当"被使用"，造成热点自我强化
//     （线上 247/610 条被召回过，前 20 条占 34.3%）；
//   - 重复前缀：模型产出的 title 自带分类前缀，写入侧又加一层（线上 43 条）。
const COG = new URL('../packages/cognition/lib/', import.meta.url).href;
const { collapseLabelPrefix, memoryDate } = await import(`${COG}memory/text-util.js`);
const { addMemory } = await import(`${COG}memory/write.js`);
const { recallP4 } = await import(`${COG}memory/recall-p4.js`);
const { createAssociationRuntime } = await import(`${COG}memory/assoc-runtime.js`);
const { citedMemoryIds } = await import(`${COG}loop/cycle.js`);

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('PASS', name); }
  else { fail += 1; console.log('FAIL', name, extra); }
};

// ---------- 1. 重复标题前缀 ----------
check('理解：理解：X → 理解：X',
  collapseLabelPrefix('理解：理解：用户想加的第一项能力是记忆') === '理解：用户想加的第一项能力是记忆');
check('更正：更正：X → 更正：X',
  collapseLabelPrefix('更正：更正：用户发现日记功能有问题') === '更正：用户发现日记功能有问题');
check('三层重复也收敛',
  collapseLabelPrefix('理解：理解：理解：同一个意思') === '理解：同一个意思');
check('不同标签组合不动（有信息量）',
  collapseLabelPrefix('更正：理解：X') === '更正：理解：X');
check('无前缀不受影响',
  collapseLabelPrefix('用户希望我自主逛B站') === '用户希望我自主逛B站');
check('单个前缀不受影响',
  collapseLabelPrefix('计划：明天去公园') === '计划：明天去公园');
check('同词但第二个不是标签（无冒号）不动',
  collapseLabelPrefix('计划：计划明天去公园') === '计划：计划明天去公园');

// ---------- 2. 写入路径也会收前缀 ----------
{
  const state = { memories: [] };
  const r = addMemory(state, {
    kind: 'fact', title: '理解：理解：写入时会收掉重复前缀', content: 'x', tags: ['测试']
  }, { now: 1_700_000_000_000 });
  check('addMemory 收掉重复前缀', r.ok && r.row.title === '理解：写入时会收掉重复前缀', JSON.stringify(r));
}

// ---------- 3. P4 item 带 excerpt + date ----------
const rows = [
  {
    id: 'mem-a', kind: 'fact', layer: 'episodic',
    title: '日记当天可改，次日不可改前一天',
    content: '每天你的日记可以当天改，但第二天就不能改前一天的日记了。'.repeat(5),
    tags: ['日记'], importance: 4, confidence: 0.8,
    occurredAt: Date.parse('2026-11-21T21:16:00Z'), createdAt: '2026-11-21T21:16:00.000Z',
    recallCount: 0, lastRecalledAt: null
  },
  {
    id: 'mem-b', kind: 'insight', layer: 'semantic',
    title: '理解：我认同：日记要由我自己写',
    content: '日记应该由我自己写，不要模型代笔。',
    tags: ['反思'], importance: 3, confidence: 0.6,
    occurredAt: Date.parse('2026-11-22T08:00:00Z'), createdAt: '2026-11-22T08:00:00.000Z',
    recallCount: 0, lastRecalledAt: null
  }
];
const now = Date.parse('2026-11-24T12:00:00Z');
const recall = recallP4(rows, '日记怎么改', { now, limit: 5 });
const item = recall.items[0] ?? {};
check('P4 item 带 excerpt', typeof item.excerpt === 'string' && item.excerpt.length > 0, JSON.stringify(item));
check('excerpt 不超过 160 字', (item.excerpt ?? '').length <= 160);
check('P4 item 带 date（YYYY-MM-DD）', /^\d{4}-\d{2}-\d{2}$/.test(item.date ?? ''), String(item.date));
check('date 取事件时间而非落库时间',
  (recall.items.find(x => x.id === 'mem-a')?.date ?? '') === '2026-11-21',
  String(recall.items.find(x => x.id === 'mem-a')?.date));
check('P4 item 不泄漏完整正文',
  !Object.prototype.hasOwnProperty.call(item, 'content'));

// memoryDate 边界：只有 createdAt 也能出日期；都没有给空串
check('memoryDate 回落 createdAt',
  memoryDate({ createdAt: '2026-11-23T00:00:00.000Z' }) === '2026-11-23');
check('memoryDate 无时间返回空串', memoryDate({ title: 'x' }) === '');

// ---------- 4. 预算是按"转发字段"算的 ----------
{
  // 同样的 maxChars，旧口径（整条 JSON）会因为诊断字段占位而少放一条。
  const many = Array.from({ length: 6 }, (_, i) => ({
    id: `mem-c${i}`, kind: 'fact', layer: 'episodic',
    title: `条目${i}：日记当天可改`, content: `正文${i}：日记可以当天改。`,
    tags: ['日记'], importance: 3, confidence: 0.7,
    occurredAt: now - i * 60_000, createdAt: new Date(now - i * 60_000).toISOString(),
    recallCount: 0, lastRecalledAt: null
  }));
  const wide = recallP4(many, '日记当天可改', { now, limit: 5, maxChars: 800 });
  check('预算内至少放进 2 条（旧口径只有 3 条且大半是诊断字段）', wide.items.length >= 2, String(wide.items.length));
  const tiny = recallP4(many, '日记当天可改', { now, limit: 5, maxChars: 120 });
  check('预算收紧仍然生效', tiny.items.length <= 1, String(tiny.items.length));
}

// ---------- 5. markInjected 与 markUsed 分离 ----------
{
  const memories = [
    { id: 'm1', title: 'a', content: 'a', importance: 3, recallCount: 0, lastRecalledAt: null, lastUsedEventId: null },
    { id: 'm2', title: 'b', content: 'b', importance: 3, recallCount: 2, lastRecalledAt: 111, lastUsedEventId: null }
  ];
  const store = { memory: { memories }, saveMemory: async () => {} };
  const assoc = createAssociationRuntime({ store, clock: () => 999 });

  assoc.markInjected(['m1', 'm2'], 'ev-1', 5000);
  check('markInjected 不增加 recallCount', memories[0].recallCount === 0 && memories[1].recallCount === 2);
  check('markInjected 不刷新 lastRecalledAt',
    memories[0].lastRecalledAt === null && memories[1].lastRecalledAt === 111);
  check('markInjected 记录 injectCount / lastInjectedAt',
    memories[0].injectCount === 1 && memories[0].lastInjectedAt === 5000);
  check('markInjected 按 eventId 幂等',
    assoc.markInjected(['m1'], 'ev-1', 6000) === 0 && memories[0].injectCount === 1);

  assoc.markUsed(['m1'], 'ev-2', 7000);
  check('markUsed 才推进使用痕迹',
    memories[0].recallCount === 1 && memories[0].lastRecalledAt === 7000 && memories[0].lastUsedEventId === 'ev-2');
}

// ---------- 6. 引用提取 ----------
check('单 intent 提取 memoryIds',
  JSON.stringify(citedMemoryIds({ intent: { type: 'send', memoryIds: ['a', 'b'] } })) === '["a","b"]');
check('intents 数组也提取并去重',
  JSON.stringify(citedMemoryIds({
    intents: [{ memoryIds: ['a'] }, { memoryIds: ['a', 'c'] }]
  })) === '["a","c"]');
check('没有引用给空数组', citedMemoryIds({ intent: { type: 'silence' } }).length === 0);
check('非字符串 id 被忽略', citedMemoryIds({ intent: { memoryIds: [null, '', '  ', 'x'] } }).length === 1);

// ---------- 7. 最后一跳：日期与正文真的进了模型输入 ----------
// 只测"引擎产出"不够——date/excerpt 必须穿过 recallForModel 才会到模型眼前，这里走真实 buildModelInput。
{
  const { buildModelInput } = await import(`${COG}decide/model-decide.js`);
  const input = buildModelInput({
    event: { id: 'ev1', type: 'owner-message', at: 1_700_000_000_000, payload: { text: '日记怎么改' } },
    recall: {
      items: [{ id: 'm1', title: '日记当天可改', excerpt: '当天可改、次日不可改', kind: 'fact', layer: 'episodic', score: 0.5, date: '2026-11-21' }],
      topicHits: {}
    },
    cues: { drivers: [], topics: [] },
    affect: { energy: 50, valence: 0, arousal: 0.3 },
    self: null,
    memories: [],
    now: 1_700_000_000_000,
    timeZone: 'Asia/Shanghai'
  });
  const item = input?.recall?.items?.[0] ?? {};
  check('模型输入里有 date', item.date === '2026-11-21', JSON.stringify(item));
  check('模型输入里有 excerpt', item.excerpt === '当天可改、次日不可改', JSON.stringify(item));
}

console.log(`\n结果：pass=${pass} fail=${fail}`);
if (fail > 0) process.exitCode = 1;
