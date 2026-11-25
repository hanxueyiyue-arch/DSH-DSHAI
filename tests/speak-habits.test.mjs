// 说话习惯：合并、阈值、注入
const COG = new URL('../packages/cognition/lib/', import.meta.url).href;
const H = await import(`${COG}self/speak-habits.js`);
const { blankSelf } = await import(`${COG}state/schema.js`);
const { buildModelInput } = await import(`${COG}decide/model-decide.js`);

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('PASS', name); }
  else { fail += 1; console.log('FAIL', name, extra); }
};

const now = Date.now();
const allowed = new Set(['ep-1', 'ep-2']);

const created = H.mergeSpeakHabits([], [
  { label: '少用长句', statement: '我倾向于短句，不一次说太多', evidence: ['ep-1'], confidence: 0.6 }
], { now, allowedEvidence: allowed });
check('新建说话习惯', created.items.length === 1 && created.applied[0]?.action === 'created', JSON.stringify(created));
check('证据保留', created.items[0].evidence.includes('ep-1'));

const filtered = H.mergeSpeakHabits([], [
  { label: '编造', statement: '我倾向于编造', evidence: ['ep-404'], confidence: 0.6 }
], { now, allowedEvidence: allowed });
check('越界证据被丢弃', filtered.items.length === 0 && filtered.skipped[0]?.reason === 'no-evidence', JSON.stringify(filtered));

const merged = H.mergeSpeakHabits(created.items, [
  { label: '少用长句', statement: '我倾向于短句，不列清单', evidence: ['ep-2'], confidence: 0.7 }
], { now: now + 1, allowedEvidence: allowed });
check('同 label 合并', merged.items.length === 1 && merged.items[0].confidence === 0.7, JSON.stringify(merged));
check('证据并集', merged.items[0].evidence.length === 2, JSON.stringify(merged.items[0].evidence));
check('statement 更新', merged.items[0].statement.includes('不列清单'));

const active = H.activeSpeakHabits({ speakHabits: [
  { id: 'a', label: '低置信', statement: '我倾向于轻轻说', confidence: 0.4, evidence: ['ep-1'], createdAt: now, updatedAt: now },
  ...merged.items
] });
check('低于 0.55 不注入', active.length === 1 && active[0].label === '少用长句', JSON.stringify(active));
check('只暴露轻字段', active[0] && !('evidence' in active[0]), JSON.stringify(active[0]));

const blank = blankSelf();
check('self 默认 speakHabits=[]', Array.isArray(blank.speakHabits) && blank.speakHabits.length === 0);

const input = buildModelInput({
  event: { id: 'e', type: 'owner-message', at: now, actor: { kind: 'owner', authenticated: true }, payload: { text: '说话短一点' } },
  recall: { items: [] }, cues: { drivers: [], topics: [] },
  affect: { energy: 50, label: '平静', valence: 0, arousal: 0.2 },
  self: { identity: { name: '助手' } },
  memories: [], now, timeZone: 'Asia/Shanghai', due: null, activities: [], recent: [], openLoops: [], insights: [], diary: [],
  traits: [], speakHabits: active
});
check('模型输入包含 speakHabits', Array.isArray(input.speakHabits) && input.speakHabits[0]?.label === '少用长句', JSON.stringify(input.speakHabits));

// 同维度不同说法 -> 合并为一条
const dim1 = H.mergeSpeakHabits([], [
  { label: '别生硬', statement: '我倾向于用词别太生硬', dimension: '正式度', scope: 'core', evidence: ['ep-1'], confidence: 0.6 }
], { now, allowedEvidence: allowed });
const dim2 = H.mergeSpeakHabits(dim1.items, [
  { label: '随意一点', statement: '我倾向于说话可以随意一些', dimension: '正式度', scope: 'core', evidence: ['ep-2'], confidence: 0.65 }
], { now: now + 1, allowedEvidence: allowed });
check('同维度只保留一条', dim2.items.length === 1 && dim2.items[0].statement.includes('随意'), JSON.stringify(dim2));

// 核心层最多 3 条；情境层按 context 命中，总数 5
const many = [
  ...Array.from({ length: 4 }, (_, i) => ({ id: `c${i}`, label: `核心${i}`, statement: `核心倾向${i}`, dimension: `core-${i}`, scope: 'core', confidence: 0.8, evidence: ['ep-1'] })),
  { id: 'x1', label: '安慰', statement: '安慰时先接情绪', dimension: 'comfort', scope: 'context', contexts: ['comfort'], confidence: 0.8, evidence: ['ep-1'] },
  { id: 'x2', label: '解释', statement: '解释时先给结论', dimension: 'explain', scope: 'context', contexts: ['explain'], confidence: 0.7, evidence: ['ep-1'] }
];
const selected = H.activeSpeakHabits({ speakHabits: many }, { contexts: ['comfort', 'explain'] });
check('核心层最多 3 条', selected.filter(i => !['comfort','explain'].includes(i.dimension)).length === 3, JSON.stringify(selected));
check('情境层命中 2 条', selected.filter(i => i.dimension === 'comfort' || i.dimension === 'explain').length === 2, JSON.stringify(selected));
check('总上限 5 条', selected.length === 5, JSON.stringify(selected));

const contexts = H.speakContextsFor({ event: { type: 'owner-message', payload: { text: '今天有点累，心里难受' } }, affect: { valence: -0.3 } });
check('识别 comfort / owner_low', contexts.includes('comfort') && contexts.includes('owner_low'), JSON.stringify(contexts));

console.log(`\n结果：pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);

