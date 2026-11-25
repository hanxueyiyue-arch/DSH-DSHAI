/**
 * 独立经历与日记存储（V0.5.1）。
 *
 * 两个空间**物理分开**，因为它们性质不同：
 *
 *   experience/<YYYY-MM-DD>.jsonl     原始经历事件，**只能追加**，没有修改/删除入口
 *   diary/index.json                  日记索引（可重建的缓存，不是真源）
 *   diary/<YYYY-MM-DD>-<id>.md        日记正文（**只保留最新一版**）
 *   diary/archive/YYYY/MM/<file>.md   按月归档的历史日记（仍按 id 读取与修订）
 *
 * 关键约束：
 *   1. `reviseOf` 只能引用**日记** id；原始经历永远不可改，所以 `reviseOf` 指不到它。
 *   2. 日记修订**不再留全文历史**（用户 2026-11-08 决定）：只保留最终正文与元数据。
 *      旧版本留下的 `diary/revisions/**` 只读兼容，不再新增。
 *   3. 写入一律先写临时文件再 rename；单个文件原子，但"正文 + 索引"跨文件不是事务，
 *      所以失败时做补偿回滚，补偿也失败就明确报 `state-inconsistent`，由重建修复。
 *   4. 所有函数返回结构化状态而不是抛异常（除了调用参数本身非法）。
 *   5. 路径必须落在传入的 dataDir 之内，`..` 之类越界一律拒绝。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

/** 目录名集中在这里，别处不要拼字符串。 */
export const EXPERIENCE_DIR = 'experience';
export const DIARY_DIR = 'documents/diary';
export const ARCHIVE_DIR = 'archive';
export const DIARY_HISTORY_DIR = 'history';

/**
 * 容量限制（2026-11-08 用户裁决）：
 *   - 单篇日记 20 KB，按 **UTF-8 实际字节数**判断（不是字符数）；
 *   - 经历日志 5 MB 是**单文件分片阈值**，不是总容量上限；
 *   - 不再有"日记总篇数"上限，也不自动删除任何旧日记/旧经历。
 */
export const JOURNAL_LIMITS = Object.freeze({
  status: 'approved',
  diaryMaxBytes: 20 * 1024,
  experienceChunkBytes: 5 * 1024 * 1024,
  diaryMaxEntries: null,
});

/** 项目时间语义：北京时间 UTC+8（IANA 标识是 Asia/Shanghai，库里没有 Asia/Beijing）。 */
export const PROJECT_TZ_OFFSET_MINUTES = 480;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DIARY_ID = /^d-[0-9a-z-]{6,64}$/;
const MAX_TITLE = 120;
const MAX_MOOD = 30;

const isText = value => typeof value === 'string' && value.trim().length > 0;
const clip = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
const bytesOf = text => Buffer.byteLength(text, 'utf8');

/** 按项目时区（UTC+8）算日历日，不跟随宿主机器时区。 */
function dayOf(at, offsetMinutes = PROJECT_TZ_OFFSET_MINUTES) {
  const ms = typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms + offsetMinutes * 60_000);
  const pad = n => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** 统一时间入参：毫秒数、Date、ISO 字符串都接受；非法返回 null。 */
/** P8: 导出项目日计算（UTC+8），供日记编排复用。 */
export function projectDay(at, offsetMinutes = PROJECT_TZ_OFFSET_MINUTES) {
  return dayOf(at, offsetMinutes);
}

function toIso(at) {
  if (at instanceof Date) return Number.isFinite(at.getTime()) ? at.toISOString() : null;
  const ms = typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function inside(dataDir, ...parts) {
  const root = resolve(dataDir);
  const target = resolve(join(root, ...parts));
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error('journal path escapes data dir');
  }
  return target;
}

const ensure = dir => { mkdirSync(dir, { recursive: true }); return dir; };
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

/* ---------------------------------- 经历 ---------------------------------- */

export function experiencePath(dataDir, day, part = 1) {
  if (!DAY.test(day)) throw new Error('experience day must be YYYY-MM-DD');
  return inside(dataDir, EXPERIENCE_DIR, part <= 1 ? `${day}.jsonl` : `${day}-${part}.jsonl`);
}

/**
 * 追加一条经历事件。
 *
 * `id` 必须是已有的稳定经历 ID（`sourceEventId`），而不是新造一个——
 * 这样事件层和记忆层指向同一个经历，重放/对账才有意义。
 */
export function appendExperience(dataDir, entry = {}) {
  const { id, kind, at, title = '', content = '', tags = '', source = null, memoryId = null, outcome = null } = entry;
  if (!isText(id) || id.length > 160) return { ok: false, reason: 'bad-id', detail: 'id 必须是稳定的经历 ID（≤160）' };
  if (!isText(kind)) return { ok: false, reason: 'bad-kind', detail: 'kind 必填' };
  if (!isText(content)) return { ok: false, reason: 'empty-content', detail: 'content 必填' };
  const day = dayOf(at);
  const iso = toIso(at);
  if (!day || !iso) return { ok: false, reason: 'bad-time', detail: 'at 不是可解析的时间' };

  const record = {
    id, kind, at: iso, day,
    title: clip(title, MAX_TITLE), content,
    ...(tags ? { tags: clip(tags, 200) } : {}),
    ...(memoryId ? { memoryId } : {}),
    ...(outcome ? { outcome } : {}),
    ...(source ? { source } : {}),
    sha256: sha256(content),
  };

  try {
    ensure(inside(dataDir, EXPERIENCE_DIR));
    let part = 1;
    let file = experiencePath(dataDir, day, part);
    // 单文件上限：超了就在同一天开新分片，绝不原地截断已有记录。
    while (existsSync(file) && statSync(file).size + Buffer.byteLength(JSON.stringify(record)) + 1 > JOURNAL_LIMITS.experienceChunkBytes) {
      part += 1;
      file = experiencePath(dataDir, day, part);
      if (part > 99) return { ok: false, reason: 'chunk-limit', detail: '同一天分片过多' };
    }
    appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
    return { ok: true, id, file, part, day };
  } catch (error) {
    return { ok: false, reason: 'write-failed', detail: String(error?.message ?? error) };
  }
}

/** 读某一天的原始经历；坏行单独报告，不因为一行坏掉丢掉整天。 */
export function readExperience(dataDir, day) {
  if (!DAY.test(day)) throw new Error('experience day must be YYYY-MM-DD');
  const entries = [];
  const badLines = [];
  let part = 1;
  for (; part <= 99; part += 1) {
    const file = experiencePath(dataDir, day, part);
    if (!existsSync(file)) break;
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!line.trim()) return;
      try {
        entries.push(JSON.parse(line));
      } catch {
        badLines.push({ file, line: index + 1 });
      }
    });
  }
  return { entries, badLines, parts: Math.max(0, part - 1) };
}

export function listExperienceDays(dataDir) {
  const dir = inside(dataDir, EXPERIENCE_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map(name => /^(\d{4}-\d{2}-\d{2})(?:-\d+)?\.jsonl$/.exec(name))
    .filter(Boolean)
    .map(match => match[1])
    .filter((day, index, all) => all.indexOf(day) === index)
    .sort();
}

/** 读出全部经历事件（按天升序、片内原序）。 */
export function readAllExperience(dataDir) {
  const entries = [];
  const badLines = [];
  for (const day of listExperienceDays(dataDir)) {
    const got = readExperience(dataDir, day);
    entries.push(...got.entries);
    badLines.push(...got.badLines);
  }
  return { entries, badLines };
}

/**
 * 只读对账：`state.memories` 是权威，`experience/` 是追加镜像。
 *
 * 报告三类问题，**不修改任何东西**：
 *   missing       主记忆里有、镜像里没有
 *   duplicate     同一稳定 ID 出现多次
 *   hashMismatch  同一 ID 的正文哈希对不上（不静默覆盖）
 */
export function reconcileExperience(dataDir, memories = []) {
  const events = readAllExperience(dataDir).entries;
  const byId = new Map();
  for (const event of events) {
    if (!event || typeof event.id !== 'string') continue;
   byId.set(event.id, [...(byId.get(event.id) || []), event]);
  }
  const missing = [];
  const hashMismatch = [];
  const duplicate = [];
  for (const [id, list] of byId) {
    if (list.length > 1) duplicate.push({ id, count: list.length });
  }
  for (const memory of memories) {
    const id = memory?.sourceEventId;
    if (typeof id !== 'string' || !id) continue;
    const list = byId.get(id);
    if (!list || list.length === 0) { missing.push({ id, memoryId: memory.id ?? null }); continue; }
    const expected = sha256(String(memory.content ?? ''));
    // 两种不一致都要报：
    //   1) 事件自身的 sha256 与它的正文对不上 → 文件被改过（完整性）；
    //   2) 事件正文与权威记忆的正文对不上 → 镜像与 state 分叉（一致性）。
    const tampered = list.filter(event => event.sha256 !== sha256(String(event.content ?? '')));
    const diverged = list.filter(event => event.sha256 === sha256(String(event.content ?? ''))
      && event.sha256 !== expected);
    if (tampered.length > 0 || diverged.length > 0) {
      hashMismatch.push({
        id,
        memoryId: memory.id ?? null,
        expected,
        found: list.map(event => event.sha256 ?? null),
        reason: tampered.length > 0 ? 'event-tampered' : 'mirror-diverged',
      });
    }
  }
  return { ok: true, total: events.length, memories: memories.length, missing, duplicate, hashMismatch };
}

/**
 * 幂等补齐：只补 `missing`，遇到 `hashMismatch` 一律跳过并报告，绝不覆盖。
 * 供隔离环境演练使用；正式环境必须由用户授权后再调用。
 */
export function backfillExperience(dataDir, memories = [], { at = new Date().toISOString() } = {}) {
  const report = reconcileExperience(dataDir, memories);
  const conflictIds = new Set(report.hashMismatch.map(item => item.id));
  const appended = [];
  const skipped = [];
  const byId = new Map(memories.map(memory => [memory?.sourceEventId, memory]).filter(([id]) => typeof id === 'string' && id));
  for (const item of report.missing) {
    if (conflictIds.has(item.id)) { skipped.push({ id: item.id, reason: 'hash-conflict' }); continue; }
    const memory = byId.get(item.id);
    const result = appendExperience(dataDir, {
      id: item.id,
      kind: memory?.kind || 'unknown',
      at: memory?.createdAt || at,
      title: memory?.title || '',
      content: memory?.content || '',
      tags: memory?.tags || '',
      source: { backfilled: true },
      memoryId: memory?.id ?? null,
    });
    if (result.ok) appended.push(item.id); else skipped.push({ id: item.id, reason: result.reason });
  }
  return { ok: true, appended, skipped, conflicts: report.hashMismatch.map(item => item.id) };
}

/* ---------------------------------- 日记 ---------------------------------- */

const diaryIndexPath = dataDir => inside(dataDir, DIARY_DIR, 'index.json');
// 一篇逻辑日记可以有多段物理文件：第 1 段沿用旧命名 `<day>-<id>.md`（向后兼容），
// 第 2 段起是 `<day>-<id>-p2.md`。它们属于**同一篇**日记，共用一个 id 与一个索引条目。
const diaryBodyPath = (dataDir, day, id, part = 1) =>
  inside(dataDir, DIARY_DIR, part <= 1 ? `${day}-${id}.md` : `${day}-${id}-p${part}.md`);

const entryFiles = entry => {
  if (Array.isArray(entry?.files) && entry.files.length > 0) return entry.files;
  if (typeof entry?.file === 'string' && entry.file) return [entry.file];
  return [`${entry?.day}-${entry?.id}.md`];
};

function writeAtomic(file, text) {
  ensure(dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
}

// ── 两阶段写入：多个分片依次改名**不是**一个原子事务 ────────────────────────
// 没写完就被杀掉时，磁盘上会留下"新第 1 段 + 旧第 2 段"这种混合状态。
// 所以动正文之前先落一份计划（plan.json + 旧正文备份），提交后删计划；
// 启动/下次写入时 `recoverJournal` 按计划**补齐或回滚**，绝不把混合内容当正文。
const STAGING_DIR = '.staging';
const stagingRoot = dataDir => inside(dataDir, DIARY_DIR, STAGING_DIR);
const newPlanId = id => `${id}-${Date.now().toString(36)}-${process.pid.toString(36)}`;

function writePlan(dataDir, plan) {
  const dir = inside(stagingRoot(dataDir), plan.pid);
  ensure(dir);
  writeAtomic(join(dir, 'plan.json'), JSON.stringify(plan, null, 2));
  return dir;
}

function listPlans(dataDir) {
  const root = stagingRoot(dataDir);
  if (!existsSync(root)) return [];
  const plans = [];
  for (const item of readdirSync(root, { withFileTypes: true })) {
    if (!item.isDirectory()) continue;
    const file = join(root, item.name, 'plan.json');
    try {
      const plan = JSON.parse(readFileSync(file, 'utf8'));
      if (plan && typeof plan === 'object') plans.push({ ...plan, dir: join(root, item.name) });
    } catch { /* 计划本身坏了：下面 recover 时按"未知计划"处理 */ }
  }
  return plans;
}

function dropPlan(plan) {
  try { rmSync(plan.dir, { recursive: true, force: true }); } catch { /* 下次再清 */ }
}

/**
 * 恢复被中断的写入。
 *
 * - `op:'create'`：索引里没有这条 → 删掉已落地的分片（它们只是半篇）；有 → 已提交，清计划。
 * - `op:'revise'`：索引 `revision >= nextRevision` → 已提交，清计划；
 *   否则把 `prev/` 里的旧正文写回、删掉多出来的新分片（回到"全旧"）。
 *
 * 只处理 `.staging/` 下有计划的操作；孤儿文件不在这里删，交给 `rebuildDiaryIndex`
 * 与 `verifyJournal` 报告——静默删除用户写过的东西比留一个可见的问题更糟。
 */
export function recoverJournal(dataDir) {
  const recovered = [];
  for (const plan of listPlans(dataDir)) {
    const index = readDiaryIndex(dataDir);
    const entry = findEntry(index, plan.id);
    try {
      if (plan.op === 'create') {
        if (entry) { dropPlan(plan); recovered.push({ id: plan.id, op: 'create', action: 'cleaned-committed' }); continue; }
        for (const rel of plan.files || []) {
          try { unlinkSync(inside(dataDir, DIARY_DIR, rel)); } catch { /* 已经不在 */ }
        }
        dropPlan(plan);
        recovered.push({ id: plan.id, op: 'create', action: 'rolled-back' });
        continue;
      }
      if (plan.op === 'revise') {
        if (entry && Number(entry.revision) >= Number(plan.nextRevision)) {
          dropPlan(plan); recovered.push({ id: plan.id, op: 'revise', action: 'cleaned-committed' }); continue;
        }
        for (const item of plan.prev || []) {
          const backup = join(plan.dir, 'prev', item.rel);
          if (existsSync(backup)) writeAtomic(inside(dataDir, DIARY_DIR, item.rel), readFileSync(backup, 'utf8'));
        }
        const keep = new Set((plan.prev || []).map(item => item.rel));
        for (const rel of plan.files || []) {
          if (keep.has(rel)) continue;
          try { unlinkSync(inside(dataDir, DIARY_DIR, rel)); } catch { /* 已经不在 */ }
        }
        dropPlan(plan);
        recovered.push({ id: plan.id, op: 'revise', action: 'rolled-back' });
      }
    } catch (error) {
      recovered.push({ id: plan.id, op: plan.op, action: 'failed', detail: String(error?.message ?? error) });
    }
  }
  return { ok: true, recovered };
}

/** 只读一致性检查：索引 ↔ 分片 ↔ 字节数，外加"索引里没有的正文文件"。 */
export function verifyJournal(dataDir) {
  const index = readDiaryIndex(dataDir);
  const issues = [];
  const onDisk = new Map();
  for (const file of listDiaryFiles(dataDir)) {
    if (!onDisk.has(file.id)) onDisk.set(file.id, []);
    onDisk.get(file.id).push(file);
  }
  for (const entry of index.entries) {
    const files = entryFiles(entry);
    let total = 0;
    let missing = 0;
    for (const rel of files) {
      const full = inside(dataDir, DIARY_DIR, rel);
      if (!existsSync(full)) { missing += 1; continue; }
      total += statSync(full).size;
    }
    if (missing > 0) issues.push({ kind: 'missing-file', id: entry.id, missing });
    else if (Number.isFinite(entry.bytes) && total !== entry.bytes) {
      issues.push({ kind: 'byte-mismatch', id: entry.id, index: entry.bytes, disk: total });
    }
    onDisk.delete(entry.id);
  }
  for (const [id, files] of onDisk) {
    issues.push({ kind: 'orphan-file', id, files: files.map(f => f.file) });
  }
  return { ok: issues.length === 0, entries: index.entries.length, issues };
}


export function readDiaryIndex(dataDir) {
  const file = diaryIndexPath(dataDir);
  if (!existsSync(file)) return { version: 1, entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || !Array.isArray(parsed.entries)) return { version: 1, entries: [] };
    return { version: 1, entries: parsed.entries };
  } catch {
    // 索引是可重建缓存：坏了就当空的，正文文件还在，rebuild 能恢复。
    return { version: 1, entries: [], degraded: 'index-unreadable' };
  }
}

/** 收集活动目录与归档目录里的全部日记正文（相对 diary/ 的路径）。 */
export function listDiaryFiles(dataDir) {
  const root = inside(dataDir, DIARY_DIR);
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 4 || !existsSync(dir)) return;
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, item.name);
      if (item.isDirectory()) {
        // `.staging/` 里是未完成操作的备份与计划，不是正文；点开头的目录一律不扫。
        if (item.name.startsWith('.')) continue;
        walk(full, depth + 1); continue;
      }
      const match = /^(\d{4}-\d{2}-\d{2})-(d-[0-9a-z-]{6,64}?)(?:-p(\d+))?\.md$/.exec(item.name);
      if (!match) continue;
      found.push({
        id: match[2], day: match[1], part: match[3] ? Number(match[3]) : 1,
        file: relative(root, full).split(sep).join('/'), full,
      });
    }
  };
  walk(root, 0);
  return found;
}

/** 从正文文件重建索引；扫描活动目录**与**归档目录，损坏后可完整恢复。 */
export function rebuildDiaryIndex(dataDir) {
  recoverJournal(dataDir);
  const root = inside(dataDir, DIARY_DIR);
  const files = listDiaryFiles(dataDir);
  const previous = new Map(readDiaryIndex(dataDir).entries.map(entry => [entry.id, entry]));
  const groups = new Map();
  for (const item of files) {
    const group = groups.get(item.id) || [];
    group.push(item);
    groups.set(item.id, group);
  }
  const entries = [];
  for (const [id, group] of groups) {
    group.sort((a, b) => a.part - b.part);
    const first = group[0];
    const old = previous.get(id) || {};
    let chars = 0;
    let bytes = 0;
    for (const item of group) {
      const text = readFileSync(item.full, 'utf8');
      chars += [...text].length;
      bytes += bytesOf(text);
    }
    const stat = statSync(first.full);
    const archived = group.every(item => /^archive\//.test(item.file));
    entries.push({
      id, day: first.day, file: first.file, files: group.map(item => item.file), parts: group.length,
      chars, bytes,
      revision: Number.isInteger(old.revision) ? old.revision : 0,
      createdAt: typeof old.createdAt === 'string' ? old.createdAt : stat.mtime.toISOString(),
      updatedAt: typeof old.updatedAt === 'string' ? old.updatedAt : stat.mtime.toISOString(),
      ...(typeof old.mood === 'string' && old.mood ? { mood: old.mood } : {}),
      ...(old.isTest === true ? { isTest: true } : {}),
      ...(archived ? { archivedAt: old.archivedAt || stat.mtime.toISOString() } : {}),
    });
  }
  entries.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  ensure(root);
  writeAtomic(diaryIndexPath(dataDir), `${JSON.stringify({ version: 1, entries }, null, 2)}\n`);
  return { ok: true, entries: entries.length, rebuilt: true };
}

function saveIndex(dataDir, index) {
  ensure(inside(dataDir, DIARY_DIR));
  writeAtomic(diaryIndexPath(dataDir), `${JSON.stringify({ version: 1, entries: index.entries }, null, 2)}\n`);
}

const findEntry = (index, id) => index.entries.find(entry => entry.id === id) || null;

/**
 * 把一段超长正文按 UTF-8 字节切分，尽量在换行处断，保证每段 ≤ maxBytes。
 * 单行本身就超限时硬切，但**不切开多字节字符**（按 code point 累加）。
 */
export function splitTextByBytes(text, maxBytes = JOURNAL_LIMITS.diaryMaxBytes) {
  const parts = [];
  let current = '';
  let currentBytes = 0;
  const push = () => { if (current.trim()) parts.push(current); current = ''; currentBytes = 0; };
  for (const line of String(text).split(/(?<=\n)/)) {
    const lineBytes = bytesOf(line);
    if (currentBytes + lineBytes <= maxBytes) { current += line; currentBytes += lineBytes; continue; }
    if (currentBytes > 0) push();
    if (lineBytes <= maxBytes) { current = line; currentBytes = lineBytes; continue; }
    for (const ch of line) {
      const size = bytesOf(ch);
      if (currentBytes + size > maxBytes) push();
      current += ch; currentBytes += size;
    }
  }
  push();
  return parts;
}

/**
 * 新建一篇日记。
 *
 * `id` 由调用方给出，便于重试幂等：同一个 id 再写一次直接返回 `duplicate`，
 * 不会产生两份正文。超过单篇上限时返回 `too-long`，调用方可用
 * `splitTextByBytes` 拆成多篇（不截断、不丢内容）。
 */
export function createDiary(dataDir, { id, text, mood = '', at = new Date().toISOString(), day: requestedDay = null, isTest = false, faultAfterPart = 0 } = {}) {
  recoverJournal(dataDir);
  if (!isText(text)) return { ok: false, reason: 'empty-text', detail: '日记正文不能为空' };
  const bytes = bytesOf(text);
  const day = isText(requestedDay) && /^\d{4}-\d{2}-\d{2}$/.test(requestedDay) ? requestedDay : dayOf(at);
  const iso = toIso(at);
  if (!day || !iso) return { ok: false, reason: 'bad-time', detail: 'at 不是可解析的时间' };
  const diaryId = isText(id) ? id : `d-${Date.now().toString(36)}`;
  if (!DIARY_ID.test(diaryId)) return { ok: false, reason: 'bad-id', detail: '日记 id 形如 d-xxxx' };

  const index = readDiaryIndex(dataDir);
  if (findEntry(index, diaryId)) return { ok: false, reason: 'duplicate', detail: '同一 id 的日记已存在', id: diaryId };

  // 超过单篇上限时**不拒绝、也不新建第二篇**：切成本篇的多个物理分片，
  // 共用一个 id 与一个索引条目（用户 2026-11-08 明确：逻辑一篇，物理可多段）。
  const chunks = splitTextByBytes(text);
  if (chunks.length === 0) return { ok: false, reason: 'empty-text', detail: '日记正文不能为空' };
  const files = chunks.map((_, i) => `${day}-${diaryId}${i === 0 ? '' : `-p${i + 1}`}.md`);
  // 先落计划再动正文：中途被杀掉时，recoverJournal 能认出"这是半篇"并清掉。
  const plan = { pid: newPlanId(diaryId), op: 'create', id: diaryId, day, files, nextRevision: 0 };
  try { plan.dir = writePlan(dataDir, plan); } catch (error) {
    return { ok: false, reason: 'write-failed', detail: String(error?.message ?? error) };
  }
  const written = [];
  try {
    chunks.forEach((chunk, i) => {
      writeAtomic(diaryBodyPath(dataDir, day, diaryId, i + 1), chunk);
      written.push(files[i]);
      if (faultAfterPart > 0 && i + 1 === faultAfterPart) {
        throw Object.assign(new Error('simulated crash while writing parts'), { code: 'SIMULATED_CRASH' });
      }
    });
  } catch (error) {
    // 注入的"崩溃"必须像真崩溃一样留下现场：回滚留给 recoverJournal 做。
    if (error?.code === 'SIMULATED_CRASH') throw error;
    for (const rel of written) {
      try { unlinkSync(inside(dataDir, DIARY_DIR, rel)); } catch { /* 交给 rebuild 清理 */ }
    }
    dropPlan(plan);
    return { ok: false, reason: 'write-failed', detail: String(error?.message ?? error) };
  }

  const entry = {
    id: diaryId, day, file: files[0], files, parts: files.length,
    chars: [...text].length, bytes, revision: 0,
    createdAt: iso, updatedAt: iso,
    ...(mood ? { mood: clip(mood, MAX_MOOD) } : {}),
    ...(isTest === true ? { isTest: true } : {}),
  };
  index.entries.push(entry);
  try {
    saveIndex(dataDir, index);
  } catch (error) {
    // 正文写成了但索引没写成：删掉刚写的全部分片，避免"幽灵正文"。
    for (const rel of files) {
      try { unlinkSync(inside(dataDir, DIARY_DIR, rel)); } catch { /* 交给 rebuild 清理 */ }
    }
    dropPlan(plan);
    return { ok: false, reason: 'index-write-failed', detail: String(error?.message ?? error), id: diaryId };
  }
  dropPlan(plan);
  try { appendDiaryHistory(dataDir, { id: diaryId, day, revision: 0, text, at: iso, action: 'create' }); } catch { /* 历史失败不影响正文 */ }
  return { ok: true, id: diaryId, revision: 0, parts: files.length, file: files[0], files, day };
}

/**
 * 修订一篇已有日记。
 *
 * 用户 2026-11-08 决定：**只保留最终正文**，不再写 `revisions/` 全文快照。
 * 保留 `id` / `createdAt` / `updatedAt` / `revision` 计数等元数据。
 *
 * `reviseOf` 只查日记索引——原始经历没有索引项，所以指向经历的 id 会得到
 * `unknown-diary`，不需要额外的"是不是经历"判断。
 */
export function reviseDiary(dataDir, { reviseOf, text, mood = '', at = new Date().toISOString(), faultAfterPart = 0 } = {}) {
  recoverJournal(dataDir);
  if (!isText(text)) return { ok: false, reason: 'empty-text', detail: '日记正文不能为空' };
  if (!isText(reviseOf)) return { ok: false, reason: 'missing-revise-of', detail: 'reviseOf 必填' };
  const index = readDiaryIndex(dataDir);
  const entry = findEntry(index, reviseOf);
  if (!entry) {
    return { ok: false, reason: 'unknown-diary', detail: 'reviseOf 只能指向已存在的日记；原始经历不可修订' };
  }
  const bytes = bytesOf(text);
  const chunks = splitTextByBytes(text);
  if (chunks.length === 0) return { ok: false, reason: 'empty-text', detail: '日记正文不能为空' };

  const previousParts = [];
  for (const rel of entryFiles(entry)) {
    try {
      previousParts.push({ rel, text: readFileSync(inside(dataDir, DIARY_DIR, rel), 'utf8') });
    } catch (error) {
      return { ok: false, reason: 'body-missing', detail: String(error?.message ?? error) };
    }
  }

  const next = (Number.isInteger(entry.revision) ? entry.revision : 0) + 1;
  const iso = toIso(at) ?? new Date().toISOString();
  const newFiles = chunks.map((_, i) => `${entry.day}-${entry.id}${i === 0 ? '' : `-p${i + 1}`}.md`);
  // 修订同样先落计划 + 旧正文备份：覆盖到一半被杀掉时可以整篇回滚。
  const plan = {
    pid: newPlanId(entry.id), op: 'revise', id: entry.id, day: entry.day,
    files: newFiles, prev: previousParts.map(part => ({ rel: part.rel })), nextRevision: next,
  };
  try {
    plan.dir = writePlan(dataDir, plan);
    for (const part of previousParts) writeAtomic(join(plan.dir, 'prev', part.rel), part.text);
  } catch (error) {
    return { ok: false, reason: 'write-failed', detail: String(error?.message ?? error), id: entry.id };
  }
  try {
    chunks.forEach((chunk, i) => {
      writeAtomic(diaryBodyPath(dataDir, entry.day, entry.id, i + 1), chunk);
      if (faultAfterPart > 0 && i + 1 === faultAfterPart) {
        throw Object.assign(new Error('simulated crash while revising parts'), { code: 'SIMULATED_CRASH' });
      }
    });
  } catch (error) {
    if (error?.code === 'SIMULATED_CRASH') throw error;
    // 写新分片失败：把旧正文全部写回，删掉多出来的新分片，保证"要么全旧、要么全新"。
    try {
      for (const part of previousParts) writeAtomic(inside(dataDir, DIARY_DIR, part.rel), part.text);
      for (const rel of newFiles.slice(previousParts.length)) {
        try { unlinkSync(inside(dataDir, DIARY_DIR, rel)); } catch { /* 已被回滚覆盖 */ }
      }
    } catch { /* 回滚也失败：下面按 state-inconsistent 报 */ }
    dropPlan(plan);
    return { ok: false, reason: 'write-failed', detail: String(error?.message ?? error), id: entry.id };
  }
  // 新内容比旧内容短：删掉不再使用的旧分片，避免索引外的孤立文件被 rebuild 当成正文。
  for (const part of previousParts.slice(chunks.length)) {
    try { unlinkSync(inside(dataDir, DIARY_DIR, part.rel)); } catch { /* 交给 rebuild 清理 */ }
  }

  const oldMeta = { file: entry.file, files: entry.files, parts: entry.parts, chars: entry.chars, bytes: entry.bytes, revision: entry.revision, updatedAt: entry.updatedAt };
  entry.revision = next;
  entry.file = newFiles[0];
  entry.files = newFiles;
  entry.parts = newFiles.length;
  entry.chars = [...text].length;
  entry.bytes = bytes;
  entry.updatedAt = iso;
  if (mood) entry.mood = clip(mood, MAX_MOOD);
  try {
    saveIndex(dataDir, index);
  } catch (error) {
    // 索引没写成：把正文写回旧内容、索引元数据复原，避免"索引与正文不一致且无历史可回溯"。
    try {
      for (const part of previousParts) writeAtomic(inside(dataDir, DIARY_DIR, part.rel), part.text);
      for (const rel of newFiles.slice(previousParts.length)) {
        try { unlinkSync(inside(dataDir, DIARY_DIR, rel)); } catch { /* 已被回滚 */ }
      }
      Object.assign(entry, oldMeta);
      dropPlan(plan);
      return { ok: false, reason: 'index-write-failed', detail: String(error?.message ?? error), id: entry.id };
    } catch {
      return { ok: false, reason: 'state-inconsistent', detail: '正文已更新但索引写入失败，且回滚失败', id: entry.id };
    }
  }
  dropPlan(plan);
  try { appendDiaryHistory(dataDir, { id: entry.id, day: entry.day, revision: next, text, at: iso, action: 'revise' }); } catch { /* 历史失败不影响正文 */ }
  return { ok: true, id: entry.id, revision: next, parts: newFiles.length, file: newFiles[0] };
}

/**
 * 修订历史：同一篇日记只追加，不覆盖——保留"改之前是什么样"。
 * 文件：documents/diary/history/<id>.jsonl，每行一次修订。
 */
export function appendDiaryHistory(dataDir, { id, day, revision, text, at, action = 'revise' } = {}) {
  if (!isText(id) || !isText(text)) return false;
  const dir = inside(dataDir, DIARY_DIR, DIARY_HISTORY_DIR);
  mkdirSync(dir, { recursive: true });
  const row = {
    schema: 1,
    id,
    day: day ?? null,
    revision: Number.isInteger(revision) ? revision : 0,
    body: text,
    sha256: sha256(text),
    at: Number.isFinite(Number(at)) ? Number(at) : (Date.parse(at) || Date.now()),
    action
  };
  appendFileSync(inside(dir, `${id}.jsonl`), JSON.stringify(row) + '\n', 'utf8');
  return true;
}

export function readDiaryHistory(dataDir, id) {
  if (!isText(id)) return [];
  const file = inside(dataDir, DIARY_DIR, DIARY_HISTORY_DIR, `${id}.jsonl`);
  let raw = '';
  try { raw = readFileSync(file, 'utf8'); } catch { return []; }
  const rows = [];
  const seen = new Set();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (!row || typeof row !== 'object') continue;
      if (row.sha256) {
        if (seen.has(row.sha256)) continue;
        seen.add(row.sha256);
      }
      rows.push(row);
    } catch { /* 坏行跳过 */ }
  }
  return rows;
}

/** 归档：把上个月及更早的日记移入 `archive/YYYY/MM/`，并更新索引位置。 */
export function archiveDiaries(dataDir, { now = new Date().toISOString(), tzOffsetMinutes = PROJECT_TZ_OFFSET_MINUTES } = {}) {
  recoverJournal(dataDir);
  const today = dayOf(now, tzOffsetMinutes);
  if (!today) return { ok: false, reason: 'bad-time' };
  const monthStart = `${today.slice(0, 7)}-01`;
  const index = readDiaryIndex(dataDir);
  const moved = [];
  const skipped = [];
  const failed = [];

  for (const entry of index.entries) {
    if (!entry || typeof entry.day !== 'string') continue;
    if (entry.day >= monthStart) continue;                     // 本月不动
    const files = entryFiles(entry);
    if (files.every(rel => /^archive\//.test(rel))) { skipped.push({ id: entry.id, reason: 'already-archived' }); continue; }
    if (files.some(rel => /^archive\//.test(rel))) {
      // 一半在归档区一半在活动区：不猜，交给 rebuild/人工，避免把一篇日记拆成两处。
      failed.push({ id: entry.id, reason: 'partially-archived' });
      continue;
    }
    const [year, month] = entry.day.split('-');
    const plan = files.map(rel => ({
      source: inside(dataDir, DIARY_DIR, rel),
      rel: `${ARCHIVE_DIR}/${year}/${month}/${basename(rel)}`,
      target: inside(dataDir, DIARY_DIR, `${ARCHIVE_DIR}/${year}/${month}/${basename(rel)}`),
    }));
    // 先把"目标是否已存在且同内容"全部判完，再动手移动：避免移到一半发现冲突。
    let blocked = null;
    for (const item of plan) {
      if (!existsSync(item.source)) { blocked = { reason: 'body-missing' }; break; }
      if (!existsSync(item.target)) continue;
      const a = readFileSync(item.source, 'utf8');
      const b = readFileSync(item.target, 'utf8');
      if (a === b) item.sameContent = true;
      else { blocked = { reason: 'archive-conflict' }; break; }
    }
    if (blocked) { failed.push({ id: entry.id, reason: blocked.reason }); continue; }
    try {
      for (const item of plan) {
        if (item.sameContent) { unlinkSync(item.source); continue; }
        ensure(dirname(item.target));
        renameSync(item.source, item.target);
      }
    } catch (error) {
      failed.push({ id: entry.id, reason: String(error?.message ?? error) });
      continue;
    }
    entry.file = plan[0].rel;
    entry.files = plan.map(item => item.rel);
    entry.archivedAt = entry.archivedAt || toIso(now);
    moved.push({ id: entry.id, file: entry.file, parts: plan.length });
  }

  // 重跑一次也安全：只有真的移动过才写索引。
  if (moved.length > 0) {
    try {
      saveIndex(dataDir, index);
    } catch (error) {
      // 文件已移动但索引没更新：rebuild 能扫归档目录恢复，这里明确报告。
      return { ok: false, reason: 'index-write-failed', detail: String(error?.message ?? error), moved, skipped, failed };
    }
  }
  return { ok: true, monthStart, moved, skipped, failed };
}

/**
 * 只读扫描：把磁盘上的分片按 id 聚合，**不读也不写索引**。
 *
 * 为什么不用索引：索引是可重建缓存，可能损坏、可能落后于归档（用户刚手工挪过文件）。
 * 浏览/查找是只读操作，不能为了列个目录就去重写索引；扫描磁盘虽然慢一点，
 * 但"看到的就是磁盘上真实存在的"，而且归档目录本来就在扫描范围内。
 */
export function scanDiaries(dataDir) {
  const groups = new Map();
  for (const item of listDiaryFiles(dataDir)) {
    const group = groups.get(item.id) || [];
    group.push(item);
    groups.set(item.id, group);
  }
  const rows = [];
  for (const [id, group] of groups) {
    group.sort((a, b) => a.part - b.part);
    const first = group[0];
    let bytes = 0;
    for (const item of group) {
      try { bytes += statSync(item.full).size; } catch { /* 文件刚被挪走：按 0 计，不崩 */ }
    }
    const archived = group.every(item => /^archive\//.test(item.file));
    let updatedAt = null;
    try { updatedAt = statSync(group[group.length - 1].full).mtime.toISOString(); } catch { /* 同上 */ }
    rows.push({
      id,
      day: first.day,
      parts: group.length,
      bytes,
      archived,
      file: first.file,
      files: group.map(item => item.file),
      ...(updatedAt ? { updatedAt } : {}),
    });
  }
  // 最新的一天在前；同一天按 id 倒序，保证分页稳定（不依赖文件系统返回顺序）。
  rows.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : String(a.id) < String(b.id) ? 1 : -1));
  return rows;
}

/**
 * 分页浏览日记（只读）。
 *
 * `page` 从 1 开始；`limit` 夹在 1–100。返回的是**元数据**，不含正文——
 * 正文按 id 单篇读取，避免一次把几百篇全文塞进响应。
 */
export function listDiaries(dataDir, { page = 1, limit = 20, includeArchived = true } = {}) {
  const all = scanDiaries(dataDir).filter(row => includeArchived || !row.archived);
  const size = Math.min(100, Math.max(1, Number.isInteger(limit) ? limit : 20));
  const totalPages = Math.max(1, Math.ceil(all.length / size));
  const current = Math.min(totalPages, Math.max(1, Number.isInteger(page) ? page : 1));
  const start = (current - 1) * size;
  return {
    ok: true,
    page: current,
    limit: size,
    total: all.length,
    totalPages,
    entries: all.slice(start, start + size).map(row => ({
      id: row.id,
      day: row.day,
      parts: row.parts,
      bytes: row.bytes,
      archived: row.archived,
      ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
    })),
  };
}

/** 按 id 找磁盘上的分片（只读，不依赖索引）。id 非法直接返回 null，绝不拼路径。 */
export function findDiaryFiles(dataDir, id) {
  if (typeof id !== 'string' || !DIARY_ID.test(id)) return null;
  const group = listDiaryFiles(dataDir).filter(item => item.id === id);
  if (group.length === 0) return null;
  group.sort((a, b) => a.part - b.part);
  return { id, day: group[0].day, files: group.map(item => item.file), archived: group.every(item => /^archive\//.test(item.file)) };
}

export function readDiary(dataDir, id) {
  // 先信任索引；索引里没有（或索引坏了）再扫盘。两处都按同一份 id 校验，
  // 非法 id（含 `..`、斜杠、超长）在 findDiaryFiles 里就被挡掉。
  const entry = findEntry(readDiaryIndex(dataDir), id) || findDiaryFiles(dataDir, id);
  if (!entry) return { ok: false, reason: DIARY_ID.test(String(id)) ? 'unknown-diary' : 'bad-id' };
  try {
    // 多分片按写入顺序拼接，读出来仍是同一篇正文（一字不差、不插分隔符）。
    const text = entryFiles(entry)
      .map(rel => readFileSync(inside(dataDir, DIARY_DIR, rel), 'utf8'))
      .join('');
    return { ok: true, entry, text };
  } catch (error) {
    return { ok: false, reason: 'body-missing', detail: String(error?.message ?? error), entry };
  }
}

/**
 * 读某一篇的历史修订全文。
 *
 * 2026-11-08 起**不再写入**新的修订快照，这里只用于读取旧数据（只读兼容）。
 */
export function readDiaryRevisions(dataDir, id) {
  const dir = inside(dataDir, DIARY_DIR, 'revisions', id);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(name => {
      try {
        return JSON.parse(readFileSync(join(dir, name), 'utf8'));
      } catch {
        return { revision: Number(name.replace('.json', '')), degraded: 'unreadable' };
      }
    });
}
