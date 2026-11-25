// 观察按来源合并 + 召回预算：验证"同一条视频只留一行、内部记进度"。
const STG = new URL('../packages/cognition/lib/', import.meta.url).href;
const { addMemory, upsertObservationSource, OBSERVATION_SECTIONS_MAX } = await import(`${STG}memory/write.js`);

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('PASS', name); }
  else { fail += 1; console.log('FAIL', name, extra); }
};

const now = Date.parse('2026-11-24T12:00:00Z');
const store = { memories: [] };
const obs = (key, text, progress, tool = 'bilibili.subtitles') => ({
  kind: 'observation', layer: 'episodic', title: '第五篇文献 part1',
  content: text, tags: ['BV1zzzzzzzzz', '字幕'], importance: 3,
  source: { level: 'observation', channel: 'tool', correlationId: `c-${Math.random()}`, key, tool, progress },
  occurredAt: now
});

// ---------- 首次：新建 ----------
const first = addMemory(store, obs('bvid:BV1zzzzzzzzz', '第一段字幕内容', { tool: 'bilibili.subtitles', from: 0, to: 700, nextFrom: 700, done: false }), { now });
check('首次写入新建一行', first.ok && store.memories.length === 1, JSON.stringify({ ok: first.ok, n: store.memories.length }));

// ---------- 再次读同一来源：合并 ----------
const second = upsertObservationSource(store, obs('bvid:BV1zzzzzzzzz', '第二段字幕内容', { tool: 'bilibili.subtitles', from: 700, to: 1400, nextFrom: 1400, done: false }), { now: now + 60_000 });
check('再次读取不新增行', store.memories.length === 1, String(store.memories.length));
check('返回合并标记', second?.merged === 'observation-source', JSON.stringify(second));
const row = store.memories[0];
check('sections 记录两段', Array.isArray(row.sections) && row.sections.length === 2, String(row.sections?.length));
check('progress 推进到 1400', row.progress?.to === 1400 && row.progress?.nextFrom === 1400, JSON.stringify(row.progress));
check('reads 计数为 2', row.reads === 2, String(row.reads));
check('内容更新为最新一段', row.content.includes('第二段'), row.content);

// ---------- 内容相同不重复记 section ----------
upsertObservationSource(store, obs('bvid:BV1zzzzzzzzz', '第二段字幕内容', { tool: 'bilibili.subtitles', from: 700, to: 1400, nextFrom: 1400, done: false }), { now: now + 120_000 });
check('重复内容不新增 section', store.memories[0].sections.length === 2, String(store.memories[0].sections.length));
check('但 reads 仍累加', store.memories[0].reads === 3, String(store.memories[0].reads));

// ---------- 读完标记 done ----------
upsertObservationSource(store, obs('bvid:BV1zzzzzzzzz', '最后一段', { tool: 'bilibili.subtitles', from: 1400, to: 1600, done: true }), { now: now + 180_000 });
check('读完后 done=true', store.memories[0].done === true, String(store.memories[0].done));
check('done 也写进 progress', store.memories[0].progress?.done === true, JSON.stringify(store.memories[0].progress));

// ---------- 不同 bvid 各自一行 ----------
upsertObservationSource(store, obs('bvid:BV1zzzzzzzzz', '别的视频', { tool: 'bilibili.video', from: 0, done: true }), { now: now + 240_000 });
check('不同来源不合并（返回 null 交由新建）', store.memories.length === 1, String(store.memories.length));
addMemory(store, obs('bvid:BV1zzzzzzzzz', '别的视频', { tool: 'bilibili.video', from: 0, done: true }), { now: now + 240_000 });
check('新建后共两行', store.memories.length === 2, String(store.memories.length));

// ---------- 没有 key 的观察（搜索列表）不参与合并 ----------
const before = store.memories.length;
const noKey = obs(null, '搜索列表结果', null);
noKey.source.key = undefined;
const skipped = upsertObservationSource(store, noKey, { now });
check('没有来源键时不合并', skipped === null, JSON.stringify(skipped));
check('没有来源键时行数不变', store.memories.length === before, String(store.memories.length));

// ---------- sections 上限 ----------
for (let i = 0; i < OBSERVATION_SECTIONS_MAX + 6; i += 1) {
  upsertObservationSource(store, obs('bvid:BV1zzzzzzzzz', `第 ${i} 段不同内容`, { tool: 'bilibili.subtitles', from: i * 100, to: (i + 1) * 100, nextFrom: (i + 1) * 100, done: false }), { now: now + 300_000 + i * 1000 });
}
check('sections 有上限', store.memories[0].sections.length <= OBSERVATION_SECTIONS_MAX, String(store.memories[0].sections.length));

console.log(`\n结果：pass=${pass} fail=${fail}`);
if (fail > 0) process.exitCode = 1;
