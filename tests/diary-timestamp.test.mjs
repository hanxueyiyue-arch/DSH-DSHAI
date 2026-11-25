// 日记时间戳回归测试。
//
// 两个真 bug（2026-11-24 发现）：
//   1. UI：把 "2026-11-21" 交给 Date.parse → 按 UTC 零点解析 → 上海显示成 08:00
//   2. 写入：service.js 的 createDiary 用 diaryStampForDay(day)（当天 12:00+08:00）当 at，
//      于是 index.json 里所有条目都是本地正午，和文件实际写入时间对不上
//
// 这类 bug 在源码里是"一行之差"，跑功能测试也未必露馅，所以用源码契约锁住。
import { readFileSync } from 'node:fs';

const PKG = new URL('../packages/cognition/', import.meta.url);
const client = readFileSync(new URL('client.js', PKG), 'utf8');
const service = readFileSync(new URL('lib/api/service.js', PKG), 'utf8');

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('PASS', name); }
  else { fail += 1; console.log('FAIL', name, extra); }
};

// ---------- UI 侧 ----------
check('client.js 只有一个 fmtTime 定义', (client.match(/function fmtTime\(/g) ?? []).length === 1);
check('client.js 只有一个 fmtDate 定义（避免互相覆盖）', (client.match(/function fmtDate\(/g) ?? []).length === 1);
check('fmtTime 对纯日期做了本地解析保护', /YYYY-MM-DD[\s\S]{0,200}T00:00:00/.test(client));
check('存在 fmtDay（日记只显示日期）', (client.match(/function fmtDay\(/g) ?? []).length === 1);
check('日记列表用 fmtDay(row.day) 渲染标题', /fmtDay\(row\.day/.test(client));
check('日记副标题不再直接用 fmtTime(row.day)', !/fmtTime\(row\.day/.test(client));

// 复刻 fmtTime 的保护逻辑，验证 +8 小时错位确实消失
const fmtTimeCore = v => {
  let raw = v;
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) raw = raw.trim() + 'T00:00:00';
  const d = new Date(typeof raw === 'number' ? raw : Date.parse(raw));
  return isNaN(d) ? String(v) : d.toLocaleString('zh-CN', { hour12: false });
};
const rendered = fmtTimeCore('2026-11-21');
check('纯日期渲染不再出现 08:00', !rendered.includes('08:00'), rendered);
check('纯日期渲染落在当天 00:00', rendered.includes('2026') && rendered.includes('00:00'), rendered);

// ---------- 写入侧 ----------
check('service.js 不再把 diaryStampForDay 的结果当 at', !/at:\s*diaryStampForDay\(/.test(service));
check('service.js 用真实 clock() 作为日记时间', /const writtenAt = new Date\(clock\(\)\)\.toISOString\(\)/.test(service));
check('service.js 把 writtenAt 传给 createDiary', /createDiary\([\s\S]{0,200}at:\s*writtenAt/.test(service));

console.log(`\n结果：pass=${pass} fail=${fail}`);
if (fail > 0) process.exitCode = 1;
