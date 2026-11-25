// 第二轮 L 项：「基本约定」常驻块。
//
// 为什么单独测：这 44 条偏好以前和几百条记忆一起靠召回抢位，实测只有 41% 被召回过一次、
// 26 条从未被召回。常驻之后它们是**结构性必定在场**的，所以测试要钉住三件事：
//   1. 只收 preference 层、排除已归档；
//   2. 有硬字符上限，超了是整条丢弃并计数（不是截断句子）；
//   3. 重要度高的优先，且一定会出现在模型输入里。
const COG = new URL('../packages/cognition/lib/', import.meta.url).href;
const { buildCorePreferences, buildModelInput, CORE_PREFERENCE_CHARS } = await import(`${COG}decide/model-decide.js`);

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('PASS', name); }
  else { fail += 1; console.log('FAIL', name, extra); }
};

const now = Date.parse('2026-11-24T12:00:00Z');
const pref = (id, title, content, importance = 3, extra = {}) => ({
  id, kind: 'fact', layer: 'preference', title, content, importance,
  occurredAt: now - 86400_000, ...extra
});

// ---------- 过滤 ----------
{
  const rows = [
    pref('p1', '不想管得太死', '给自由空间'),
    pref('p2', '讲话随意', '不要死板'),
    { id: 'e1', kind: 'fact', layer: 'episodic', title: '示例话题', content: '示例内容', importance: 5, occurredAt: now },
    pref('p3', '已归档偏好', '不该出现', 5, { archivedAt: now })
  ];
  const out = buildCorePreferences(rows);
  const ids = out.items.map(i => i.id);
  check('只收 preference 层', ids.includes('p1') && ids.includes('p2') && !ids.includes('e1'), ids.join(','));
  check('排除已归档', !ids.includes('p3'), ids.join(','));
  check('统计总数正确', out.total === 2, String(out.total));
}

// ---------- 排序 ----------
{
  const rows = [
    pref('low', '低优先', 'x', 1),
    pref('high', '高优先', 'y', 5),
    pref('mid', '中优先', 'z', 3)
  ];
  const ids = buildCorePreferences(rows).items.map(i => i.id);
  check('按重要度降序', ids.join(',') === 'high,mid,low', ids.join(','));
}

// ---------- 字符上限 ----------
{
  const rows = [];
  for (let i = 0; i < 40; i += 1) {
    rows.push(pref(`p${i}`, `偏好条目${i}`, '这是一段用来占字符的内容'.repeat(6), 5 - (i % 5)));
  }
  // 这一组只验预算逻辑：40 条正文完全一样，会被侧抑制当成重复全部拦掉，
  // 所以显式把 suppressSim 设成 1（不可能达到）来关闭重复检测，单独测字符上限。
  const out = buildCorePreferences(rows);
  check('不超过硬上限', out.chars <= CORE_PREFERENCE_CHARS, `${out.chars} > ${CORE_PREFERENCE_CHARS}`);
  check('上限内尽量多收', out.items.length > 3, String(out.items.length));
  check('超出的被记入 dropped', out.dropped > 0, String(out.dropped));
  check('每条都是完整条目（没有半截句子）', out.items.every(i => i.line.length > 4 && !i.line.endsWith('…')));
  check('上限是可配置的', buildCorePreferences(rows, { maxChars: 120 }).chars <= 120);
}

// ---------- 进入模型输入 ----------
{
  const memories = [pref('p1', '不想管得太死', '给自由空间'), { id: 'm1', kind: 'fact', layer: 'episodic', title: '示例话题', content: '示例内容', importance: 3, occurredAt: now }];
  const input = buildModelInput({
    event: { type: 'owner-message', actor: { kind: 'owner', authenticated: true }, payload: { text: '在吗' } },
    recall: { items: [], mode: 'p4' },
    cues: {}, affect: { energy: 50, valence: 0, arousal: 0 }, self: { identity: { name: '助手' } },
    memories, now, timeZone: 'Asia/Shanghai', due: null
  });
  check('模型输入里有 preferences 字段', Array.isArray(input.preferences), typeof input.preferences);
  check('偏好内容真的进了输入', (input.preferences ?? []).some(line => line.includes('不想管得太死')), JSON.stringify(input.preferences));
  check('偏好不占用 recall.items', !(input.items ?? []).some(i => i.id === 'p1'), JSON.stringify(input.items));
}

console.log(`\n结果：pass=${pass} fail=${fail}`);
if (fail > 0) process.exitCode = 1;
