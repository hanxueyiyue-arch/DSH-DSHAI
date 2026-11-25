import { mkdir, open, readFile, rename, rm, stat, writeFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { blankFilters, normalizeFilters } from './filters.js';
import { blankDmState, normalizeDmState } from './dm.js';

// All reads/writes stay inside dsh-dshai/bilibili/；不触碰 BrainMem / Autonomy 的数据目录。
export const SCHEMA = 1;
export const DATA_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-dshai', 'bilibili');
export const STATE_FILE = join(DATA_DIR, 'state.json');
export const POLICY_FILE = join(DATA_DIR, 'policy.json');
export const POLICY_META_FILE = join(DATA_DIR, 'policy.meta.json');
export const BACKUP_DIR = join(DATA_DIR, 'backups');

export const dateKey = () => new Date().toISOString().slice(0, 10);
export const clipped = (value, max = 500) => String(value ?? '').trim().slice(0, max);

export function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error('请求已取消');
    error.name = 'AbortError';
    throw error;
  }
}

export const isAbortError = error => error?.name === 'AbortError' || error?.code === 'ABORT_ERR';

const historyEntry = entry => {
  if (!entry || typeof entry !== 'object' || typeof entry.type !== 'string') return null;
  const out = { type: clipped(entry.type, 40), at: typeof entry.at === 'string' ? clipped(entry.at, 40) : null };
  for (const key of ['runId', 'requestId', 'mid']) {
    if (typeof entry[key] === 'string') out[key] = clipped(entry[key], 64);
  }
  if (typeof entry.reason === 'string') out.reason = clipped(entry.reason, 100);
  if (Array.isArray(entry.scopes)) out.scopes = entry.scopes.filter(x => typeof x === 'string').slice(0, 5).map(x => clipped(x, 40));
  return out;
};

/** 账号身份与审计：只保留公开身份信息与审计事件，绝不保存 Cookie / Token。 */
export function blankAccount() {
  return { mid: null, name: null, at: null, lastLoginAt: null, history: [], preference: null };
}

const normalizePreference = raw => {
  if (!raw || typeof raw !== 'object') return null;
  return {
    requestsDisabled: raw.requestsDisabled === true,
    reason: typeof raw.reason === 'string' ? clipped(raw.reason, 200) : '',
    at: typeof raw.at === 'string' ? clipped(raw.at, 40) : null,
    runId: typeof raw.runId === 'string' ? clipped(raw.runId, 64) : null,
  };
};

export function normalizeAccount(raw) {
  const acc = raw && typeof raw === 'object' ? raw : {};
  const mid = Number.isSafeInteger(acc.mid) ? String(acc.mid)
    : (typeof acc.mid === 'string' && /^\d{1,20}$/.test(acc.mid) ? acc.mid : null);
  return {
    mid,
    name: typeof acc.name === 'string' ? clipped(acc.name, 200) : null,
    at: typeof acc.at === 'string' ? clipped(acc.at, 40) : null,
    lastLoginAt: typeof acc.lastLoginAt === 'string' ? clipped(acc.lastLoginAt, 40) : null,
    history: Array.isArray(acc.history) ? acc.history.map(historyEntry).filter(Boolean).slice(-100) : [],
    preference: normalizePreference(acc.preference),
  };
}

export const blank = () => ({
  schema: SCHEMA,
  observations: [],
  drafts: [],
  quota: { day: '', used: 0, hourStart: 0, hourUsed: 0 },
  traffic: { until: 0, streak: 0, reason: null, endpoint: null },
  migratedFrom: null,
  account: blankAccount(),
  filters: blankFilters(),
  // 私信发送意图、墓碑与审计；不含凭证/token。
  dm: blankDmState(),
});

export function normalize(state) {
  if (!state || state.schema !== SCHEMA || !Array.isArray(state.observations) || !Array.isArray(state.drafts)) {
    throw new Error('dsh-dshai/bilibili/state.json 格式错误（schema 必须为 1，observations/drafts 必须为数组）；请先备份');
  }
  if (!state.quota || typeof state.quota !== 'object') state.quota = { day: '', used: 0, hourStart: 0, hourUsed: 0 };
  state.quota.hourStart = Number.isFinite(state.quota.hourStart) ? state.quota.hourStart : 0;
  state.quota.hourUsed = Number.isFinite(state.quota.hourUsed) ? state.quota.hourUsed : 0;
  if (!state.traffic || typeof state.traffic !== 'object') state.traffic = { until: 0, streak: 0, reason: null, endpoint: null };
  state.traffic.until = Number.isFinite(state.traffic.until) ? state.traffic.until : 0;
  state.traffic.streak = Number.isFinite(state.traffic.streak) ? state.traffic.streak : 0;
  if (state.migratedFrom === undefined) state.migratedFrom = null;
  state.account = normalizeAccount(state.account);
  state.filters = normalizeFilters(state.filters);
  state.dm = normalizeDmState(state.dm);
  return state;
}

let writeTail = Promise.resolve();

// 跨进程写锁：两个 DSH 进程不得交错读改写同一 state 文件。O_EXCL 锁文件，
// 短暂等待，陈旧锁可回收（进程崩溃不至于永久卡死）。
const WRITE_LOCK = join(DATA_DIR, '.write.lock');
const LOCK_WAIT_MS = 4_000;
const LOCK_STALE_MS = 15_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const WRITE_LOCK_TOKEN = randomUUID();

function lockPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

async function readLockRecord() {
  try {
    const record = JSON.parse(await readFile(WRITE_LOCK, 'utf8'));
    return record && typeof record === 'object' ? record : null;
  } catch {
    return null;
  }
}

async function withCrossProcessLock(signal, fn) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    throwIfAborted(signal);
    let handle = null;
    try {
      handle = await open(WRITE_LOCK, 'wx', 0o600);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const info = await stat(WRITE_LOCK).catch(() => null);
      const holder = await readLockRecord();
      const holderAlive = holder !== null && holder.pid !== process.pid && lockPidAlive(holder.pid);
      if (!holderAlive && info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await rm(WRITE_LOCK, { force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error('另一个 DSHAI 实例正在写入同一数据目录，本次写入已拒绝（单实例约束）');
      }
      await sleep(50);
      continue;
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, token: WRITE_LOCK_TOKEN, at: new Date().toISOString() }));
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(WRITE_LOCK, { force: true }).catch(() => undefined);
      throw error;
    }
    try {
      return await fn();
    } finally {
      await handle.close().catch(() => undefined);
      const current = await readLockRecord();
      if (current?.pid === process.pid && current?.token === WRITE_LOCK_TOKEN) {
        await rm(WRITE_LOCK, { force: true }).catch(() => undefined);
      }
    }
  }
}

export async function readState() {
  try { return normalize(JSON.parse(await readFile(STATE_FILE, 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return blank(); throw error; }
}

// 每进程串行 + 临时文件改名原子写。两个 DSH 进程不得共享同一 DSH_HOME。
export function updateState(mutate, { backupBefore = false, signal } = {}) {
  const run = writeTail.then(async () => {
    throwIfAborted(signal);
    await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
    return withCrossProcessLock(signal, async () => {
      throwIfAborted(signal);
      const state = await readState();
      throwIfAborted(signal);
      const original = backupBefore ? JSON.stringify(state, null, 2) : null;
      const result = await mutate(state);
      throwIfAborted(signal);
      if (backupBefore) {
        await mkdir(BACKUP_DIR, { recursive: true, mode: 0o700 });
        const file = join(BACKUP_DIR, `state-${Date.now()}-${randomUUID()}.json`);
        await writeFile(file, original, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      }
      const tmp = join(DATA_DIR, `state-${randomUUID()}.tmp`);
      try {
        throwIfAborted(signal);
        await writeFile(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        throwIfAborted(signal);
        await rename(tmp, STATE_FILE);
      } catch (error) {
        await unlink(tmp).catch(() => undefined);
        throw error;
      }
      return result;
    });
  });
  writeTail = run.then(() => undefined, () => undefined);
  return run;
}

/** 只读视图：配额按原有"UTC 计数日"规则折算，不写入文件。 */
export function quotaForToday(state) {
  const day = dateKey();
  const currentHour = state?.quota?.day === day
    && Number.isFinite(state.quota.hourStart)
    && Date.now() - state.quota.hourStart < 60 * 60 * 1000;
  const base = state?.quota?.day === day ? { day, used: Number(state.quota.used) || 0 } : { day, used: 0 };
  return { ...base, hourUsed: currentHour ? Number(state.quota.hourUsed) || 0 : 0 };
}

// 测试数据识别只看显式标记（isTest / testRecord），不依赖任何历史文本指纹。
export function isTestDraft(entry) {
  if (!entry || typeof entry !== 'object' || entry.isTest === false) return false;
  return entry.isTest === true || entry.testRecord === true;
}

export function isTestObservation(entry) {
  if (!entry || typeof entry !== 'object' || entry.isTest === false) return false;
  return entry.isTest === true || entry.testRecord === true;
}

const observationId = entry => entry?.id ?? entry?.createdAt ?? '';

export function testRecordList(state) {
  return [
    ...state.observations.filter(isTestObservation).map((x, i) => ({
      kind: 'observation', id: observationId(x) || `observation-${i}`, label: clipped(x.videos?.[0]?.title, 100),
    })),
    ...state.drafts.filter(isTestDraft).map(x => ({
      kind: 'draft', id: x.id, label: clipped(x.text, 100),
    })),
  ];
}

export async function cleanTestRecord({ kind, id, confirmation } = {}) {
  if (confirmation !== 'DELETE_TEST_DATA') throw new Error('需要明确确认 DELETE_TEST_DATA');
  if (!['observation', 'draft'].includes(kind) || !clipped(id, 128)) throw new Error('无效的 kind 或 id');
  return updateState(state => {
    const rows = kind === 'observation' ? state.observations : state.drafts;
    const matches = rows.filter(x => (kind === 'observation' ? observationId(x) : x.id) === id);
    const matcher = kind === 'observation' ? isTestObservation : isTestDraft;
    if (matches.length !== 1 || !matcher(matches[0])) {
      throw new Error('只能删除一条明确匹配的测试数据；其他数据不受影响');
    }
    const remaining = rows.filter(x => x !== matches[0]);
    if (kind === 'observation') state.observations = remaining; else state.drafts = remaining;
    return { deleted: true, kind, id, automaticBackup: true };
  }, { backupBefore: true });
}
