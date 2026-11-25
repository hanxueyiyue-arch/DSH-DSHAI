// 第 3 项改动：update 关系必须带"明确替换说法"，否则不取代旧条。
//
// 背景（2026-11-25 实测线上数据）：
//   - 8 对被捕取代的记录，正文相似度 0.152~0.514，全部是"标题相同但讲的是另一件事"
//   - 而"真更新"与"真误伤"的正文相似度区间完全重叠（0.061~0.391 vs 0.032~0.250），
//     任何 bodySim 阈值都无法区分，所以改用语义硬门槛 REPLACES。
import { addMemory, classifyRelation } from '../packages/cognition/lib/memory/write.js';

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('PASS', name); }
  else { fail += 1; console.log('FAIL', name, extra); }
};

const now = Date.parse('2026-11-25T12:00:00Z');
const mk = over => ({
  kind: 'fact',
  layer: 'episodic',
  title: '用户喜欢喝咖啡',
  content: '用户说每天早上都要喝一杯黑咖啡，不加糖，也不加奶。',
  importance: 3,
  source: { messageId: `m-${Math.random().toString(36).slice(2)}` },
  ...over,
});

// ---------- A. 真更新：带替换说法 → 仍然 update ----------
{
  const cases = [
    ['改喝无咖啡因', '用户说每天早上都要喝一杯黑咖啡，不加糖，也不加奶。', '用户说他其实喝不了咖啡因，喝完心慌，改喝无咖啡因的了。'],
    ['升级到新系统', '用户在用 Windows 10 系统。', '用户已经升级到 Windows 11 系统了。'],
    ['路径改成', '助手的日记保存路径是 data/diary。', '助手的日记保存路径改成了 data/journal。'],
    ['预算调整成', '用户设的预算是每天 2 元。', '用户的预算调整成每天 3 元。'],
  ];
  for (const [label, oldText, newText] of cases) {
    const v = classifyRelation(
      { memories: [{ id: 'old', kind: 'fact', title: '用户喜欢喝咖啡', content: oldText }] },
      { kind: 'fact', title: '用户喜欢喝咖啡', content: newText }
    );
    check(`真更新｜${label} → update`, v.relation === 'update', JSON.stringify(v));
  }
}

// ---------- B. 真误伤：线上 8 对的原始文本 → 不再取代 ----------
{
  const pairs = [
    ['用户希望我自主浏览内容并分享', '用户希望我在无法和他聊天时自己去找点内容看，看到有意思的可以分享给他。',
      '我不是白跑一趟的，是有记录的，只是检索不到，这个要改算法还是去翻日志？'],
    ['这个项目已经投入不少预算了[', '这个项目已经投入了不少预算了[笑哭]',
      '我之前讲过它们本来就是一体了吗[笑哭]'],
    ['用户要修内容权限问题', '用户确认了我能主动浏览内容但拿不到正文后，表示会去修一下权限或数据返回的问题。',
      '忙完了，你还能看到内容吗？我是不是得修一下？'],
    ['用户想为我做主动做事的权限开关', '用户原本想做的是给我一个「主动做事的权限开关」，而不是叫醒功能。',
      '这个initiate不是权限开关吗？你现在可以主动找我说话了啊，你试试'],
    ['用户发现日记功能有问题并要求修复', '用户指出「你的日记」存在问题（用了笑哭表情），并要求顺手把它再修一下。',
      '？？？你改动什么了？？？你知道改哪里吗[笑哭]，复看一遍你自己第二段日记的内容，不觉得别扭吗'],
  ];
  for (const [title, oldText, newText] of pairs) {
    const v = classifyRelation(
      { memories: [{ id: 'old', kind: 'fact', title, content: oldText }] },
      { kind: 'fact', title: `更正：${title}`, content: newText }
    );
    check(`真误伤｜${title.slice(0, 16)} → 不取代`, v.relation !== 'update', JSON.stringify(v));
  }
}

// ---------- C. 写库级验证：误伤那对不再让旧行失效 ----------
{
  const store = { memories: [] };
  const a = addMemory(store, mk({ title: '用户希望我自主浏览内容并分享', content: '用户希望我在无法和他聊天时自己去找点内容看。' }), { now });
  const b = addMemory(store, mk({
    title: '更正：用户希望我自主浏览内容并分享',
    content: '我不是白跑一趟的，是有记录但检索不到，这个要改算法？',
  }), { now: now + 1000 });
  check('写库｜旧行不再被取代', !store.memories.find(r => r.id === a.id)?.supersededBy, String(store.memories.find(r => r.id === a.id)?.supersededBy));
  check('写库｜两条都保留', store.memories.length === 2, String(store.memories.length));
  check('写库｜新行没有 supersedes', !b.supersedes, String(b.supersedes));
}

// ---------- D. 写库级验证：真更新仍然让旧行失效 ----------
{
  const store = { memories: [] };
  const a = addMemory(store, mk({ content: '用户说每天早上都要喝一杯黑咖啡，不加糖，也不加奶。' }), { now });
  const b = addMemory(store, mk({ content: '用户说他其实喝不了咖啡因，喝完心慌，改喝无咖啡因的了。' }), { now: now + 1000 });
  check('写库｜真更新触发 update', b.relation === 'update', JSON.stringify(b.relation));
  check('写库｜真更新旧行失效', Boolean(store.memories.find(r => r.id === a.id)?.supersededBy));
  check('写库｜真更新新行记 supersedes', Boolean(b.supersedes));
}

// ---------- E. 原有行为不能回归 ----------
{
  // E1 duplicate
  const store = { memories: [] };
  addMemory(store, mk(), { now });
  const dup = addMemory(store, mk(), { now: now + 500 });
  check('duplicate｜完全重复并进原行', dup.merged === 'duplicate', JSON.stringify(dup));
  check('duplicate｜不新增行', store.memories.length === 1, String(store.memories.length));

  // E2 contradict
  const s2 = { memories: [] };
  addMemory(s2, mk({ content: '用户喜欢喝黑咖啡，每天早上都要喝一杯。' }), { now });
  const contra = addMemory(s2, mk({ content: '用户不喜欢喝黑咖啡，说太苦了不想再喝。' }), { now: now + 1000 });
  check('contradict｜否定相反仍成立', contra.relation === 'contradict', JSON.stringify(contra.relation));
  check('contradict｜两行都留', s2.memories.length === 2, String(s2.memories.length));

  // E3 action 不参与（H 守卫）
  const s3 = { memories: [] };
  addMemory(s3, { kind: 'action', layer: 'episodic', title: '执行发送', content: '我对用户说：甲' }, { now });
  addMemory(s3, { kind: 'action', layer: 'episodic', title: '执行发送', content: '我对用户说：乙' }, { now: now + 1000 });
  check('H 守卫｜action 不互相取代', s3.memories.every(r => !r.supersededBy));
  const skipped = classifyRelation({ memories: [] }, { kind: 'action', title: 'x', content: 'y' });
  check('H 守卫｜action 直接 event-kind 跳过', skipped.skipped === 'event-kind', JSON.stringify(skipped));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
