// tick 时段表：覆盖/重叠/跨午夜/间隔>=段长/重启计时
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const LIB = new URL('../packages/bus/lib/', import.meta.url).href;
const S = await import(`${LIB}tick-schedule.js`);

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('PASS', name); }
  else { fail += 1; console.log('FAIL', name, extra); }
};
const at = (h, m = 0) => new Date(2026, 10, 23, h, m, 0, 0).getTime();

// ---------- 归一化 ----------
{
  const one = S.normalizeSegments(null, { fallbackTickMs: 30 * 60_000 });
  check('默认单段覆盖 24h', one.ok && one.segments.length === 1 && one.segments[0].startMin === 0 && one.segments[0].endMin === 1440);

  const two = S.normalizeSegments([
    { start: '00:00', end: '08:00', tickMs: 2 * 60 * 60_000 },
    { start: '08:00', end: '24:00', tickMs: 30 * 60_000 }
  ]);
  check('两段覆盖 24h', two.ok && two.segments.length === 2);

  const gap = S.normalizeSegments([
    { start: '00:00', end: '08:00', tickMs: 60_000 },
    { start: '09:00', end: '24:00', tickMs: 60_000 }
  ]);
  check('空档被拒', gap.ok === false && gap.errors.some(e => e.includes('空档')));

  const overlap = S.normalizeSegments([
    { start: '00:00', end: '10:00', tickMs: 60_000 },
    { start: '09:00', end: '24:00', tickMs: 60_000 }
  ]);
  check('重叠被拒', overlap.ok === false && overlap.errors.some(e => e.includes('重叠')));

  const cross = S.normalizeSegments([
    { start: '23:00', end: '08:00', tickMs: 60_000 },
    { start: '08:00', end: '24:00', tickMs: 60_000 }
  ]);
  check('跨午夜被拒', cross.ok === false, JSON.stringify(cross.errors));

  const tooMany = S.normalizeSegments(Array.from({ length: 7 }, (_, i) => ({
    start: `${String(Math.floor(i * 3)).padStart(2, '0')}:00`,
    end: `${String(Math.floor(i * 3) + 3).padStart(2, '0')}:00`,
    tickMs: 60_000
  })));
  check('最多 6 段', tooMany.ok === false);
}

// ---------- 下一次 tick ----------
const segs = S.normalizeSegments([
  { start: '00:00', end: '08:00', tickMs: 2 * 60 * 60_000 },
  { start: '08:00', end: '24:00', tickMs: 30 * 60_000 }
]).segments;

check('段内第一次不是段起点', S.nextTickAt(segs, at(8, 0)) === at(8, 30), new Date(S.nextTickAt(segs, at(8, 0))).toLocaleString());
check('段中按间隔取下一个', S.nextTickAt(segs, at(8, 17)) === at(8, 30));
check('夜间 2 小时点', S.nextTickAt(segs, at(1, 0)) === at(2, 0));
check('临近段尾跳到下一段', S.nextTickAt(segs, at(7, 30)) === at(8, 30));
check('跨天取次日第一段', S.nextTickAt(segs, at(23, 45)) === at(26, 0) - 0 || S.nextTickAt(segs, at(23, 45)) === new Date(2026, 10, 24, 2, 0).getTime());

{
  const short = S.normalizeSegments([
    { start: '00:00', end: '01:00', tickMs: 2 * 60 * 60_000 },
    { start: '01:00', end: '24:00', tickMs: 30 * 60_000 }
  ]).segments;
  check('间隔≥段长时本段不 tick', S.nextTickAt(short, at(0, 10)) === at(1, 30));
}

// ---------- 设置文件 ----------
{
  const root = mkdtempSync(join(tmpdir(), 'tick-schedule-'));
  try {
    const list = [
      { start: '00:00', end: '08:00', tickMs: 2 * 60 * 60_000 },
      { start: '08:00', end: '24:00', tickMs: 30 * 60_000 }
    ];
    S.writeStoredSegments(list, { dshHome: root });
    const read = S.readStoredSegments({ dshHome: root });
    check('设置文件可读回', read.segments?.length === 2 && read.segments[0].tickMs === 2 * 60 * 60_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(`\n结果：pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
