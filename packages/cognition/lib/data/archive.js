// 重要数据备份/迁移：把单状态根导出为 ZIP（含 manifest 与逐文件 SHA256），
// 先在空目标上恢复；非空目标默认拒绝，需显式 overwrite 且自动先备份。

import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { createZip, readZip } from './zip.js';

export const BACKUP_SCHEMA = 1;
export const BACKUP_KIND = 'cognition-backup';
const STATE_FILES = ['self.json', 'memory.json', 'behavior.json'];
const DATA_DIRS = ['experience', 'diary', 'archive', 'activity', 'trace'];

const sha256 = data => createHash('sha256').update(data).digest('hex');

async function walk(dir, base, out) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, base, out);
    else if (entry.isFile()) out.push(relative(base, full).split(sep).join('/'));
  }
}

async function readJsonOrNull(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

export async function collectEntries(root, { includeActivity = false, includeTrace = false } = {}) {
  const paths = [];
  for (const file of STATE_FILES) {
    try { if ((await stat(join(root, file))).isFile()) paths.push(file); } catch { /* 缺失跳过 */ }
  }
  for (const dirName of DATA_DIRS) {
    if (dirName === 'activity' && !includeActivity) continue;
    if (dirName === 'trace' && !includeTrace) continue;
    const found = [];
    await walk(join(root, dirName), root, found);
    paths.push(...found);
  }
  paths.sort();
  const entries = [];
  for (const path of paths) entries.push({ path, data: await readFile(join(root, path)) });
  return entries;
}

export function countsOf(entries) {
  const files = new Map(entries.map(entry => [entry.path, entry.data]));
  const memory = files.has('memory.json') ? JSON.parse(files.get('memory.json').toString('utf8')) : null;
  const self = files.has('self.json') ? JSON.parse(files.get('self.json').toString('utf8')) : null;
  const memories = Array.isArray(memory?.memories) ? memory.memories.length : 0;
  let archived = 0;
  for (const [path, data] of files) {
    if (!path.startsWith('archive/') || !path.endsWith('.jsonl')) continue;
    for (const line of data.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try { if (JSON.parse(line)?.kind === 'memory') archived += 1; } catch { /* 跳过坏行 */ }
    }
  }
  const diary = [...files.keys()].filter(path => path.startsWith('diary/') && path.endsWith('.md')).length;
  const experience = [...files.keys()].filter(path => path.startsWith('experience/')).length;
  return {
    memories,
    dormant: Array.isArray(self?.habitsDormant) ? self.habitsDormant.length : 0,
    habits: Array.isArray(self?.habits) ? self.habits.length : 0,
    diary,
    experience,
    archived
  };
}

export async function exportArchive({ root, includeActivity = false, includeTrace = false, clock = () => Date.now() } = {}) {
  if (!root) throw new Error('exportArchive: 缺少状态根');
  const allEntries = await collectEntries(root, { includeActivity, includeTrace });
  const manifest = {
    schema: BACKUP_SCHEMA,
    kind: BACKUP_KIND,
    createdAt: new Date(clock()).toISOString(),
    includeActivity,
    includeTrace,
    counts: countsOf(allEntries),
    files: allEntries.map(entry => ({
      path: entry.path,
      bytes: entry.data.length,
      sha256: sha256(entry.data)
    }))
  };
  const entries = [...allEntries, { path: 'manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8') }];
  return { buffer: createZip(entries), manifest };
}

export function loadArchive(buffer) {
  let files;
  try { files = readZip(buffer); }
  catch (error) {
    throw Object.assign(new Error('备份文件损坏，无法读取'), { code: 'BACKUP_CORRUPT', cause: error });
  }
  if (!files.has('manifest.json')) throw Object.assign(new Error('备份缺少 manifest.json'), { code: 'BACKUP_MANIFEST_MISSING' });
  let manifest;
  try { manifest = JSON.parse(files.get('manifest.json').toString('utf8')); }
  catch { throw Object.assign(new Error('manifest.json 不是合法 JSON'), { code: 'BACKUP_MANIFEST_INVALID' }); }
  if (manifest?.schema !== BACKUP_SCHEMA || manifest?.kind !== BACKUP_KIND) {
    throw Object.assign(new Error('备份格式或版本不匹配'), { code: 'BACKUP_SCHEMA_UNSUPPORTED' });
  }
  const problems = [];
  for (const item of Array.isArray(manifest.files) ? manifest.files : []) {
    const data = files.get(item.path);
    if (!data) { problems.push({ path: item.path, problem: 'missing' }); continue; }
    if (sha256(data) !== item.sha256) problems.push({ path: item.path, problem: 'checksum-mismatch' });
    if (Number(item.bytes) !== data.length) problems.push({ path: item.path, problem: 'size-mismatch' });
  }
  return { files, manifest, problems };
}

export async function inspectRoot(root) {
  const self = await readJsonOrNull(join(root, 'self.json'));
  const memory = await readJsonOrNull(join(root, 'memory.json'));
  const memories = Array.isArray(memory?.memories) ? memory.memories.length : 0;
  const named = Boolean(self?.identity?.name);
  return {
    exists: Boolean(self || memory),
    empty: !self && !memory,
    memories,
    named,
    habits: Array.isArray(self?.habits) ? self.habits.length : 0
  };
}

export async function previewImport({ root, buffer }) {
  const archive = loadArchive(buffer);
  const target = await inspectRoot(root);
  const conflicts = [];
  if (target.exists) {
    const memory = await readJsonOrNull(join(root, 'memory.json'));
    const incoming = archive.files.has('memory.json')
      ? JSON.parse(archive.files.get('memory.json').toString('utf8'))
      : null;
    const existing = new Map((memory?.memories ?? []).map(row => [row.id, row]));
    for (const row of incoming?.memories ?? []) {
      const current = existing.get(row.id);
      if (current && Number(current.updatedAt ?? 0) !== Number(row.updatedAt ?? 0)) conflicts.push({ id: row.id, title: row.title ?? '' });
    }
  }
  return {
    ok: archive.problems.length === 0,
    problems: archive.problems,
    manifest: archive.manifest,
    target,
    conflicts: conflicts.slice(0, 20),
    conflictCount: conflicts.length,
    canRestoreEmpty: !target.exists || target.memories === 0,
    requiresOverwrite: target.exists && target.memories > 0
  };
}

export async function importArchive({ root, buffer, mode = 'empty-only', clock = () => Date.now() } = {}) {
  const archive = loadArchive(buffer);
  if (archive.problems.length > 0) {
    throw Object.assign(new Error(`备份校验失败：${archive.problems.length} 个文件有问题`), { code: 'BACKUP_CORRUPT', problems: archive.problems });
  }
  const target = await inspectRoot(root);
  if (target.memories > 0 && mode !== 'overwrite') {
    throw Object.assign(new Error('目标已有记忆，默认拒绝导入；请先导出备份并使用 overwrite 模式'), {
      code: 'TARGET_NOT_EMPTY',
      target
    });
  }
  let backupPath = null;
  if (target.exists) {
    backupPath = `${root}.backup-${new Date(clock()).toISOString().replace(/[:.]/g, '-')}`;
    await cp(root, backupPath, { recursive: true, filter: source => !source.endsWith('run.lock') });
  }
  for (const [path, data] of archive.files) {
    if (path === 'manifest.json') continue;
    const allowed = STATE_FILES.includes(path) || DATA_DIRS.some(dir => path.startsWith(`${dir}/`));
    if (!allowed || path.includes('..')) {
      throw Object.assign(new Error(`备份包含非法路径：${path}`), { code: 'BACKUP_PATH_INVALID' });
    }
    const full = join(root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, data);
  }
  return { ok: true, backupPath, manifest: archive.manifest, restoredFiles: archive.files.size - 1 };
}
