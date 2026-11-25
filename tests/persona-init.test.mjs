// 人设初始化与锁定：修复"全新安装时人设卡在用户填写前就被锁死"的缺陷。
//
// 规则（修复后）：
//   1. 身份不完整（缺姓名或缺性别）→ 不生成人设文件、不锁定，留给用户首次填写
//   2. 身份完整 → 首次读取时落地人设卡并立即锁定（initial-lock）
//   3. 已锁定后再次写入 → 拒绝（persona-locked）
//   4. 锁定只锁"初设"，之后的人格由记忆派生（derivedPersona），不覆盖 initial
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensurePersona,
  personaView,
  derivedPersona,
  appendHistory
} from '../packages/cognition/lib/state/persona.js';

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('PASS', name); }
  else { fail += 1; console.log('FAIL', name, extra); }
};

const roots = [];
function makeStore(identity = {}) {
  const root = mkdtempSync(join(tmpdir(), 'persona-'));
  roots.push(root);
  return { root, self: { identity }, memory: { memories: [] } };
}

// ---------- A. 全新安装、身份为空 → 不锁定，可写 ----------
{
  const store = makeStore({});
  const p = ensurePersona(store, { now: 1000 });
  check('A 空身份 → locked 为 false', p.locked === false, String(p.locked));
  check('A 空身份 → initializedAt 为 null', p.initializedAt === null, String(p.initializedAt));
  check('A 空身份 → 不落盘 persona.json', !existsSync(join(store.root, 'persona.json')));
}

// ---------- B. 只填了姓名、没填性别 → 仍不锁定 ----------
{
  const store = makeStore({ name: '小鲸鱼' });
  const p = ensurePersona(store, { now: 2000 });
  check('B 只有姓名 → locked 为 false', p.locked === false, String(p.locked));
  check('B 只有姓名 → 不落盘', !existsSync(join(store.root, 'persona.json')));
}

// ---------- C. 姓名 + 性别齐全 → 落地并锁定 ----------
{
  const store = makeStore({ name: '小鲸鱼', gender: '女', profileText: '性格：傲娇、活泼。' });
  const p = ensurePersona(store, { now: 3000 });
  check('C 身份齐全 → locked 为 true', p.locked === true, String(p.locked));
  check('C 身份齐全 → initializedAt 已写', p.initializedAt === 3000, String(p.initializedAt));
  check('C 身份齐全 → initial 记录正确', p.initial?.name === '小鲸鱼' && p.initial?.gender === '女', JSON.stringify(p.initial));
  check('C 身份齐全 → persona.json 已落盘', existsSync(join(store.root, 'persona.json')));
  const saved = JSON.parse(readFileSync(join(store.root, 'persona.json'), 'utf8'));
  check('C 落盘内容 locked=true', saved.locked === true);
  check('C 落盘 history 记 initial-lock', saved.history?.[0]?.source === 'initial-lock', JSON.stringify(saved.history?.[0]?.source));
}

// ---------- D. 二次读取返回同一份（幂等） ----------
{
  const store = makeStore({ name: '阿蓝', gender: '男' });
  const a = ensurePersona(store, { now: 4000 });
  const b = ensurePersona(store, { now: 9999 });
  check('D 二次读取 initializedAt 不变', a.initializedAt === b.initializedAt, `${a.initializedAt} vs ${b.initializedAt}`);
}

// ---------- E. 用户填写后（self.identity 更新）→ 下一次 ensure 锁定 ----------
{
  const store = makeStore({});
  const before = ensurePersona(store, { now: 5000 });
  check('E 填写前未锁定', before.locked === false);
  // 模拟 setIdentity 写入 self.identity
  store.self.identity = { name: '新用户', gender: '女', profileText: '初始人设内容', revision: 1 };
  const after = ensurePersona(store, { now: 6000 });
  check('E 填写后锁定', after.locked === true, String(after.locked));
  check('E 填写后 initial 采用用户输入', after.initial?.name === '新用户', JSON.stringify(after.initial?.name));
}

// ---------- F. 锁定后 appendHistory 不覆盖 initial ----------
{
  const store = makeStore({ name: '小鲸鱼', gender: '女', profileText: '初设文本' });
  const base = ensurePersona(store, { now: 7000 });
  const next = appendHistory(store, { at: 8000, source: 'growth', note: '长了一点' });
  check('F history 追加一条', next.history.length === base.history.length + 1, String(next.history.length));
  check('F initial 未被覆盖', next.initial?.profileText === '初设文本', JSON.stringify(next.initial?.profileText));
  check('F version 递增', next.version === base.version + 1, `${next.version} vs ${base.version}`);
}

// ---------- G. personaView 暴露 locked 与 derived ----------
{
  const store = makeStore({ name: '小鲸鱼', gender: '女' });
  const view = personaView(store, { now: 9000 });
  check('G view.locked 为 true', view.locked === true);
  check('G view.initial 存在', view.initial !== null);
  check('G view.derived 是对象', view.derived !== null && typeof view.derived === 'object');
  check('G view.history 是数组', Array.isArray(view.history));
}

// ---------- H. derivedPersona 从记忆派生，不改 initial ----------
{
  const store = makeStore({ name: '小鲸鱼', gender: '女' });
  const now = 10 * 24 * 3600 * 1000;
  store.memory.memories = [
    { kind: 'fact', importance: 4, createdAt: new Date(now - 3 * 24 * 3600 * 1000).toISOString(), title: '她喜欢深海' },
    { kind: 'insight', importance: 3, createdAt: new Date(now - 5 * 24 * 3600 * 1000).toISOString(), title: '她说话变短了' }
  ];
  const derived = derivedPersona(store, { now });
  const basedOn = Number(derived?.basedOn?.memories ?? 0);
  check('H derived 统计到近期记忆', basedOn >= 1, JSON.stringify(derived).slice(0, 140));
  check('H derived 有 summary 文本', typeof derived?.summary === 'string' && derived.summary.length > 0);
  const persona = ensurePersona(store, { now });
  check('H initial 不因记忆变化', persona.initial?.name === '小鲸鱼');
}

// ---------- 清理 ----------
for (const root of roots) { try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } }

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
