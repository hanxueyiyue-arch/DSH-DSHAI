// 偏好层的「支持度」机制：用户反复说同一件事 → 加强原条目，不新建重复行。
//
// 由来（2026-11-24）：44 条偏好里已经有 1 组完全同名、1 组近似重复；以前每次写入都是 push 新行，
// 所以「用户又强调了一遍」这件事在数据上完全看不出来。有了 support 之后：
//   support=1 → 说过一次；support≥2 → 反复确认过；confidence 随确认上调。
import { readFileSync } from 'node:fs';
// 发布包内不再区分 staging/live，统一用相对定位
const LIVE = new URL('../packages/cognition/lib/', import.meta.url).href;
const STG = new URL('../packages/cognition/lib/', import.meta.url).href;
const { addMemory, findSimilarPreference } = await import(`${STG}memory/write.js`);
const { buildCorePreferences } = await import(`${STG}decide/model-decide.js`);

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('PASS', name); }
  else { fail += 1; console.log('FAIL', name, extra); }
};

const now = Date.parse('2026-11-24T12:00:00Z');
const store = { memories: [] };
const pref = (title, content, confidence = 0.6) => ({ kind: 'fact', layer: 'preference', title, content, confidence, importance: 3, source: { level: 'model-extraction', messageId: `m-${title}` } });

// ---------- 首次写入 ----------
{
  const r = addMemory(store, pref('日记每篇上限6000字', '用户要求日记每篇字数上限为6000字。'), { now });
  check('首次写入成功', r.ok && !r.existing, JSON.stringify(r));
  const row = store.memories[0];
  check('新偏好带 support=1', row.support === 1, String(row.support));
  check('新偏好带 lastConfirmedAt', row.lastConfirmedAt === now, String(row.lastConfirmedAt));
}

// ---------- 重复确认 ----------
{
  const before = store.memories.length;
  const r = addMemory(store, pref('日记每篇上限6000字', '用户要求日记每篇字数上限为6000字。'), { now: now + 60_000 });
  check('重复确认不新增行', store.memories.length === before, `${before} → ${store.memories.length}`);
  check('返回 merged 标记', r.merged === 'preference-support', JSON.stringify(r));
  const row = store.memories[0];
  check('support 累加到 2', row.support === 2, String(row.support));
  check('置信度上调', row.confidence > 0.6, String(row.confidence));
  check('置信度不超过 0.98', row.confidence <= 0.98, String(row.confidence));
  check('更新了最近确认时间', row.lastConfirmedAt === now + 60_000, String(row.lastConfirmedAt));
}

// ---------- 近似但不完全相同也能合并 ----------
{
  const before = store.memories.length;
  addMemory(store, pref('日记每篇上限 6000 字', '用户要求：日记每篇字数上限为 6000 字。'), { now: now + 120_000 });
  check('标点/空格不同的同一条也能合并', store.memories.length === before, `${before} → ${store.memories.length}`);
  check('support 累加到 3', store.memories[0].support === 3, String(store.memories[0].support));
}

// ---------- 不同偏好不会被误合并 ----------
{
  const before = store.memories.length;
  addMemory(store, pref('不要自称助手', '用户要求不要用「助手」称呼自己。'), { now: now + 180_000 });
  check('不同偏好正常新建', store.memories.length === before + 1, `${before} → ${store.memories.length}`);
}

// ---------- 支持度只对 preference 层生效 ----------
{
  const s2 = { memories: [] };
  // 完全相同的两条 episodic：走 H 的 duplicate 判定并成一行（不是支持度机制）
  addMemory(s2, { kind: 'fact', layer: 'episodic', title: '同一件旧事', content: '一模一样的内容，说的是同一件事。', source: { messageId: 'a' } }, { now });
  addMemory(s2, { kind: 'fact', layer: 'episodic', title: '同一件旧事', content: '一模一样的内容，说的是同一件事。', source: { messageId: 'b' } }, { now });
  check('episodic 重复由 H 合并成一行', s2.memories.length === 1, String(s2.memories.length));
  check('episodic 行没有 support 字段', s2.memories.every(r => r.support === undefined));
  // 不同的两件事仍各建一行
  addMemory(s2, { kind: 'fact', layer: 'episodic', title: '另一件不相干的事', content: '用户下午去了趟医院复查眼睛，结果一切正常。', source: { messageId: 'c' } }, { now });
  check('不同的 episodic 正常新建', s2.memories.length === 2, String(s2.memories.length));
}

// ---------- 归档/被取代的不参与合并 ----------
{
  const s3 = { memories: [] };
  addMemory(s3, pref('旧约定', '这是旧约定。'), { now });
  s3.memories[0].archivedAt = now;
  const before = s3.memories.length;
  addMemory(s3, pref('旧约定', '这是旧约定。'), { now: now + 60_000 });
  check('已归档的偏好不参与合并', s3.memories.length === before + 1, `${before} → ${s3.memories.length}`);

  const s4 = { memories: [] };
  addMemory(s4, pref('被取代的约定', '这是被取代的约定。'), { now });
  s4.memories[0].supersededBy = 'mem-new';
  const b4 = s4.memories.length;
  addMemory(s4, pref('被取代的约定', '这是被取代的约定。'), { now: now + 60_000 });
  check('已被取代的偏好不参与合并', s4.memories.length === b4 + 1, `${b4} → ${s4.memories.length}`);
}

// ---------- findSimilarPreference 阈值 ----------
{
  const s5 = { memories: [] };
  addMemory(s5, pref('用户希望我记性更好', '用户希望我记住更多事情。'), { now });
  check('相同标题能命中', Boolean(findSimilarPreference(s5, { title: '用户希望我记性更好', content: '用户希望我记住更多事情。' })));
  check('完全不同的不命中', !findSimilarPreference(s5, { title: '不要自称助手', content: '别用助手称呼自己。' }));
}

// ---------- 常驻块：支持度高的排前面 ----------
{
  const rows = [
    { id: 'p1', kind: 'fact', layer: 'preference', title: '只说过一次', content: 'x', importance: 3, support: 1, confidence: 0.6, occurredAt: now },
    { id: 'p2', kind: 'fact', layer: 'preference', title: '反复确认过', content: 'y', importance: 3, support: 4, confidence: 0.85, occurredAt: now - 86400_000 },
    { id: 'p3', kind: 'fact', layer: 'preference', title: '重要但只说过一次', content: 'z', importance: 5, support: 1, confidence: 0.6, occurredAt: now }
  ];
  const out = buildCorePreferences(rows);
  const ids = out.items.map(i => i.id);
  check('重要度优先', ids[0] === 'p3', ids.join(','));
  check('同重要度下支持度高的优先', ids.indexOf('p2') < ids.indexOf('p1'), ids.join(','));
  check('支持度≥2 时标注确认次数', out.items.some(i => i.line.includes('用户确认过 4 次')), JSON.stringify(out.items.map(i => i.line)));
}

console.log(`\n结果：pass=${pass} fail=${fail}`);
if (fail > 0) process.exitCode = 1;
