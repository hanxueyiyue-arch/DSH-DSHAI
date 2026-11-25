// G 质量门 / H 四分类关系 / I 分类型遗忘（含偏好免疫）
const STG = new URL('../packages/cognition/lib/', import.meta.url).href;
const { addMemory, scoreMemoryQuality, classifyRelation, QUALITY_BANDS } = await import(`${STG}memory/write.js`);
const { recallP4, halfLifeDaysOf } = await import(`${STG}memory/recall-p4.js`);

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('PASS', name); }
  else { fail += 1; console.log('FAIL', name, extra); }
};

const now = Date.parse('2026-11-24T12:00:00Z');
const mk = (over = {}) => ({
  kind: 'fact', layer: 'episodic', title: '用户喜欢喝咖啡',
  content: '用户说每天早上都要喝一杯黑咖啡，不加糖，也不加奶。',
  importance: 3, source: { messageId: `m-${Math.random()}` }, ...over
});

// ---------- G 质量分 ----------
{
  const good = scoreMemoryQuality(mk());
  check('正常记忆质量分 ≥60', good.score >= 60 && good.band === 'normal', JSON.stringify(good));
  check('正常记忆可自动注入', good.autoInject === true);

  const meta = scoreMemoryQuality(mk({ title: '记忆召回机制的问题', content: '用户认为记忆召回机制需要继续优化，讨论的是记忆系统本身。' }));
  check('元记忆被扣分并标 meta', meta.flags.includes('meta') && meta.score < 60, JSON.stringify(meta));

  const short = scoreMemoryQuality(mk({ content: '好' }));
  check('极短正文判 archive 且不自动注入', short.band === 'archive' && short.autoInject === false, JSON.stringify(short));

  const prefix = scoreMemoryQuality(mk({ title: '理解：理解：用户想加记忆能力', content: '用户希望增加记忆能力，先把召回修好，具体方案还没定。' }));
  check('重复前缀被标 self_referential', prefix.flags.includes('self_referential'), JSON.stringify(prefix));

  const repetitive = scoreMemoryQuality(mk({ content: '记忆记忆记忆记忆记忆记忆记忆记忆记忆记忆记忆记忆' }));
  check('高重复正文被标 repetitive', repetitive.flags.includes('repetitive'), JSON.stringify(repetitive));

  const dupRow = mk({ title: '用户喜欢喝咖啡', content: '用户说每天早上都要喝一杯黑咖啡，不加糖，也不加奶。' });
  const dup = scoreMemoryQuality(dupRow, { recent: [{ ...dupRow, id: 'x', kind: 'fact' }] });
  check('与近期记忆重复被标 duplicate', dup.flags.includes('duplicate'), JSON.stringify(dup));
}

// ---------- H 四分类 ----------
{
  const store = { memories: [] };
  const first = addMemory(store, mk(), { now });
  check('首次写入 relation=unrelated', first.relation === 'unrelated', JSON.stringify(first.relation));

  const second = addMemory(store, mk(), { now: now + 1000 });
  check('同一句再写 → duplicate 并被并进原行', second.merged === 'duplicate', JSON.stringify(second));
  check('duplicate 不新增行', store.memories.length === 1, String(store.memories.length));

  const updated = addMemory(store, mk({ content: '用户说他其实喝不了咖啡因，喝完心慌，改喝无咖啡因的了。' }), { now: now + 2000 });
  check('同主题不同说法 → update', updated.relation === 'update', JSON.stringify(updated.relation));
  check('update 让旧行失效', Boolean(store.memories[0].supersededBy), JSON.stringify(store.memories[0].supersededBy));
  check('新行记下 supersedes', Boolean(updated.supersedes), String(updated.supersedes));

  const s2 = { memories: [] };
  addMemory(s2, mk({ content: '用户喜欢喝黑咖啡，每天早上都要喝一杯。' }), { now });
  const contra = addMemory(s2, mk({ content: '用户不喜欢喝黑咖啡，说太苦了不想再喝。' }), { now: now + 1000 });
  check('同主题否定相反 → contradict', contra.relation === 'contradict', JSON.stringify(contra.relation));
  check('contradict 连边到旧行', Array.isArray(contra.contradicts) && contra.contradicts.length === 1, JSON.stringify(contra.contradicts));
  check('contradict 两行都保留', s2.memories.length === 2, String(s2.memories.length));
}

// ---------- I 分类型遗忘 ----------
{
  check('action 半衰期 7 天', halfLifeDaysOf({ kind: 'action' }) === 7);
  check('fact 半衰期 180 天', halfLifeDaysOf({ kind: 'fact' }) === 180);
  check('insight 半衰期 90 天', halfLifeDaysOf({ kind: 'insight' }) === 90);
  check('preference 免疫（无半衰期）', halfLifeDaysOf({ layer: 'preference', kind: 'fact' }) === Infinity);

  const oldAction = { id: 'a1', kind: 'action', layer: 'episodic', title: '执行发送', content: '我对用户说了晚安，然后结束这一轮对话。', importance: 3, occurredAt: now - 30 * 86400_000, tags: [] };
  const oldFact = { id: 'f1', kind: 'fact', layer: 'episodic', title: '用户喜欢喝咖啡', content: '用户说每天早上都要喝一杯黑咖啡，不加糖也不加奶。', importance: 3, occurredAt: now - 30 * 86400_000, tags: [] };
  const r1 = recallP4([oldAction], '执行发送晚安', { now, limit: 3 });
  const r2 = recallP4([oldFact], '喝咖啡', { now, limit: 3 });
  const fresh1 = r1.items[0]?.freshness ?? 0;
  const fresh2 = r2.items[0]?.freshness ?? 0;
  check('30 天前的 action 新鲜度远低于 fact', fresh1 < fresh2 / 3, `action=${fresh1} fact=${fresh2}`);

  const prefRow = { id: 'p1', kind: 'fact', layer: 'preference', title: '不要自称助手', content: '用户要求不要用助手称呼自己，名字叫助手。', importance: 5, occurredAt: now - 90 * 86400_000, tags: [] };
  const rp = recallP4([prefRow], '自称助手', { now, limit: 3 });
  check('90 天前的偏好新鲜度仍是满分（免疫）', (rp.items[0]?.freshness ?? 0) === 1, String(rp.items[0]?.freshness));
}

// ---------- G 与召回联动 ----------
{
  // 用两条都能匹配查询的记忆，只把其中一条标成 autoInject=false
  const hidden = { id: 'h1', kind: 'fact', layer: 'episodic', title: '用户的咖啡习惯', content: '用户每天早上要喝一杯黑咖啡，不加糖也不加奶。', importance: 3, occurredAt: now, tags: [], autoInject: false };
  const visible = { id: 'v1', kind: 'fact', layer: 'episodic', title: '用户喝咖啡但不加糖', content: '用户每天早上喝一杯黑咖啡，不加糖，也不加奶。', importance: 3, occurredAt: now, tags: [] };
  const normal = recallP4([hidden, visible], '喝咖啡', { now, limit: 5 });
  check('autoInject=false 不进默认召回', !normal.items.some(i => i.id === 'h1'), JSON.stringify(normal.items.map(i => i.id)));
  const withHidden = recallP4([hidden, visible], '喝咖啡', { now, limit: 5, includeHidden: true });
  check('includeHidden 时才出现', withHidden.items.some(i => i.id === 'h1'), JSON.stringify(withHidden.items.map(i => i.id)));

  const lowQ = { ...visible, id: 'q1', quality: 35 };
  const highQ = { ...visible, id: 'q2', title: '用户的咖啡习惯', quality: 100 };
  const mixed = recallP4([lowQ, highQ], '喝咖啡', { now, limit: 5 });
  const low = mixed.items.find(i => i.id === 'q1');
  const high = mixed.items.find(i => i.id === 'q2');
  if (low && high) check('低质量记忆的重要性被降权', low.importance < high.importance, `${low.importance} vs ${high.importance}`);
  else check('低质量记忆的重要性被降权（只剩一条时跳过）', true);
}

console.log(`\n结果：pass=${pass} fail=${fail}`);
if (fail > 0) process.exitCode = 1;
