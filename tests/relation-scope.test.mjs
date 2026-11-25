// 第 3 轮 H 的回归测试：四分类只能作用于"知识型"记忆。
//
// 事故（2026-11-25 凌晨实测）：H 上线后，每条新的 action（执行发送/安排唤醒）都把上一条
// supersededBy 掉——因为它们标题相同、正文不同，正好命中"同主题不同说法 → update"的规则。
// 一晚上误伤 16 条行动记录，行动流水只剩最后一条。
const STG = new URL('../packages/cognition/lib/', import.meta.url).href;
const { addMemory, classifyRelation } = await import(`${STG}memory/write.js`);

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('PASS', name); }
  else { fail += 1; console.log('FAIL', name, extra); }
};

const now = Date.parse('2026-11-25T04:00:00Z');

// ---------- action：绝不 update ----------
{
  const s = { memories: [] };
  const texts = ['我对用户说：第一条完全不同的回复内容，长度也够。', '我对用户说：第二条又是另一段话，跟前一条无关。', '我对用户说：第三条继续不同，讲的是别的事情。'];
  const results = texts.map((text, i) => addMemory(s, {
    kind: 'action', layer: 'episodic', title: '执行发送', content: text, source: { messageId: `a${i}` }
  }, { now: now + i * 1000 }));
  check('三条 action 各自成行', s.memories.length === 3, String(s.memories.length));
  check('action 都不会被标 supersededBy', s.memories.every(r => !r.supersededBy), JSON.stringify(s.memories.map(r => r.supersededBy)));
  check('action 的关系判定是 unrelated', results.every(r => r.relation === 'unrelated'), JSON.stringify(results.map(r => r.relation)));
  check('classifyRelation 对 action 直接跳过', classifyRelation(s, { kind: 'action', title: '执行发送', content: '随便' }).skipped === 'event-kind');
}

// ---------- observation：由来源合并管，不走 update ----------
{
  const s = { memories: [] };
  addMemory(s, { kind: 'observation', layer: 'episodic', title: '某个视频', content: '第一次看到的内容，足够长的一段描述。', source: { messageId: 'o1', key: 'bvid:BV1x' } }, { now });
  const r2 = addMemory(s, { kind: 'observation', layer: 'episodic', title: '某个视频', content: '第二次看到的内容，也足够长的一段描述。', source: { messageId: 'o2', key: 'bvid:BV1x' } }, { now: now + 1000 });
  check('observation 不走 update', r2.relation === 'unrelated', String(r2.relation));
  check('observation 不互相取代', s.memories.every(r => !r.supersededBy));
}

// ---------- fact：update 仍然生效 ----------
{
  const s = { memories: [] };
  const a = addMemory(s, { kind: 'fact', layer: 'episodic', title: '用户喜欢喝咖啡', content: '用户每天早上都要喝一杯黑咖啡，不加糖不加奶。', source: { messageId: 'f1' } }, { now });
  const b = addMemory(s, { kind: 'fact', layer: 'episodic', title: '用户喜欢喝咖啡', content: '用户说他喝不了咖啡因，改喝无咖啡因的饮料了。', source: { messageId: 'f2' } }, { now: now + 1000 });
  check('fact 同主题不同说法 → update', b.relation === 'update', String(b.relation));
  check('旧 fact 被取代', Boolean(s.memories.find(r => r.id === a.id)?.supersededBy));
}

// ---------- insight：contradict 仍然生效 ----------
{
  const s = { memories: [] };
  // 否定极性判定是"一方带否定词、另一方不带"，所以这里要构造真正的极性相反的一对
  addMemory(s, { kind: 'insight', layer: 'semantic', title: '被质疑时的反应', content: '被质疑时我先查证据，再回答，不急着下结论。', source: { messageId: 'i1' } }, { now });
  const b = addMemory(s, { kind: 'insight', layer: 'semantic', title: '被质疑时的反应', content: '被质疑时我直接查证据再回答，急着下结论也可以。', source: { messageId: 'i2' } }, { now: now + 1000 });
  check('insight 否定相反 → contradict', b.relation === 'contradict', String(b.relation));
  check('contradict 会连边', Array.isArray(b.contradicts) && b.contradicts.length === 1);
  check('contradict 两行都保留', s.memories.length === 2, String(s.memories.length));
}

// ---------- duplicate 仍然生效（知识型） ----------
{
  const s = { memories: [] };
  const body = '用户希望我记住每天的日记上限是六千字，超了就要压缩。';
  addMemory(s, { kind: 'fact', layer: 'episodic', title: '日记上限', content: body, source: { messageId: 'd1' } }, { now });
  const dup = addMemory(s, { kind: 'fact', layer: 'episodic', title: '日记上限', content: body, source: { messageId: 'd2' } }, { now: now + 1000 });
  check('知识型完全重复 → duplicate 并进原行', dup.merged === 'duplicate', JSON.stringify(dup));
  check('duplicate 不新增行', s.memories.length === 1, String(s.memories.length));
}

console.log(`\n结果：pass=${pass} fail=${fail}`);
if (fail > 0) process.exitCode = 1;
