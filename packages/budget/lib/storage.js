/**
 * 预算插件的文件存储：独立目录、跨进程写锁、原子替换、可选备份。
 *
 * 安全约束：
 * - 账本损坏时**不覆盖、不清空、不自动创建空账本**；读取结果明确标记
 *   `corrupt`/`legacy`，由 service 进入 fail-closed。
 * - 损坏证据会复制到 `backups/corrupt-<hash>.json`，原文件保持原样。
 * - 写锁带随机 token；释放前校验 token，避免误删其他进程新持有的锁。
 */

import { createHash, randomUUID } from 'node:crypto'
import { chmod, copyFile, mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { normalizeConfig } from './config.js'
import { blankSavings, parseSavings } from './savings.js'
import { blankState, legacyHasConsumption, parseState } from './state.js'

const LOCK_TIMEOUT_MS = 4_000
const LOCK_STALE_MS = 15_000
const LOCK_RETRY_MS = 25

/** 解析数据目录与文件路径。 */
export function resolvePaths({ home } = {}) {
  const baseHome = typeof home === 'string' && home.length > 0 ? home : process.env.DSH_HOME || join(homedir(), '.dsh')
  const dataDir = join(baseHome, 'dsh-dshai', 'budget')
  return {
    home: baseHome,
    dataDir,
    stateFile: join(dataDir, 'state.json'),
    savingsFile: join(dataDir, 'savings.json'),
    configFile: join(dataDir, 'config.json'),
    backupDir: join(dataDir, 'backups'),
    configBackupDir: join(dataDir, 'config-backups'),
    lockFile: join(dataDir, '.write.lock'),
  }
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function readLockInfo(lockFile) {
  try {
    const raw = await readFile(lockFile, 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** 清理陈旧锁：只删除“文件足够旧且持有者已死/内容损坏”的锁。 */
async function clearStaleLock(lockFile) {
  let info = null
  try {
    const st = await stat(lockFile)
    if (Date.now() - st.mtimeMs <= LOCK_STALE_MS) return false
    info = await readLockInfo(lockFile)
  } catch (error) {
    return error?.code === 'ENOENT'
  }
  if (info !== null && processAlive(Number(info?.pid))) return false
  await unlink(lockFile).catch(() => {})
  return true
}

/** 取跨进程写锁；释放前校验 token。 */
export async function withWriteLock(lockFile, fn) {
  const token = randomUUID()
  const started = Date.now()
  for (;;) {
    let handle = null
    try {
      handle = await open(lockFile, 'wx', 0o600)
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, at: Date.now() }))
      await handle.sync()
      await handle.close()
      handle = null
      try {
        return await fn()
      } finally {
        const info = await readLockInfo(lockFile)
        if (info?.token === token) await unlink(lockFile).catch(() => {})
      }
    } catch (error) {
      await handle?.close().catch(() => {})
      if (error?.code !== 'EEXIST') throw error
      if (await clearStaleLock(lockFile)) continue
      if (Date.now() - started > LOCK_TIMEOUT_MS) {
        const lockError = new Error('预算文件正在被其他进程写入，请稍后重试')
        lockError.code = 'LOCK_BUSY'
        throw lockError
      }
      await sleep(LOCK_RETRY_MS)
    }
  }
}

/** 原子写 JSON：临时文件 + fsync + rename。 */
export async function writeJsonAtomic(file, value) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  let handle = null
  try {
    handle = await open(tmp, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    await rename(tmp, file)
    await chmod(file, 0o600).catch(() => {})
  } catch (error) {
    await handle?.close().catch(() => {})
    await unlink(tmp).catch(() => {})
    throw error
  }
}

async function backup(file, dir, prefix) {
  try {
    await stat(file)
  } catch {
    return null
  }
  await mkdir(dir, { recursive: true })
  const target = join(dir, `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  await copyFile(file, target)
  await chmod(target, 0o600).catch(() => {})
  return target
}

/** 存储服务：所有写操作都串行化。 */
export function createStorage({ home, log = null, now = () => new Date() } = {}) {
  const paths = resolvePaths({ home })
  let queue = Promise.resolve()

  /** 把损坏原文复制为证据；返回证据路径。原文件不动。 */
  async function quarantine(text) {
    try {
      const hash = createHash('sha256').update(text).digest('hex').slice(0, 16)
      await mkdir(paths.backupDir, { recursive: true })
      const target = join(paths.backupDir, `corrupt-${hash}.json`)
      try {
        await stat(target)
      } catch {
        await writeFile(target, text, { mode: 0o600 })
      }
      return target
    } catch (error) {
      log?.warn?.('[budget] 保存损坏账本证据失败', error)
      return null
    }
  }

  /**
   * 读取账本，返回分类结果：
   * `{kind:'empty'|'v2'|'legacy'|'invalid', state?, raw?, reason?, evidence?}`。
   */
  async function readState() {
    let text
    try {
      text = await readFile(paths.stateFile, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return { kind: 'empty' }
      return { kind: 'invalid', reason: `读取账本失败：${error?.code ?? error?.message ?? error}` }
    }
    let raw
    try {
      raw = JSON.parse(text)
    } catch (error) {
      const evidence = await quarantine(text)
      return { kind: 'invalid', reason: `账本不是合法 JSON：${error?.message ?? error}`, evidence }
    }
    const parsed = parseState(raw)
    if (parsed.kind === 'invalid') {
      const evidence = await quarantine(text)
      return { ...parsed, evidence }
    }
    return parsed
  }

  async function readConfigRaw() {
    try {
      return JSON.parse(await readFile(paths.configFile, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') log?.warn?.('[budget] 读取 config.json 失败，按未配置处理', error)
      return null
    }
  }

  /**
   * 读取储蓄账本，返回 `{kind:'empty'|'v1'|'invalid', savings?, raw?, reason?, evidence?}`。
   * 损坏时 fail-closed（不当作 0，也不覆盖原文件）。
   */
  async function readSavings() {
    let text
    try {
      text = await readFile(paths.savingsFile, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return { kind: 'empty' }
      return { kind: 'invalid', reason: `读取储蓄账本失败：${error?.code ?? error?.message ?? error}` }
    }
    let raw
    try {
      raw = JSON.parse(text)
    } catch (error) {
      const evidence = await quarantine(text)
      return { kind: 'invalid', reason: `储蓄账本不是合法 JSON：${error?.message ?? error}`, evidence }
    }
    const parsed = parseSavings(raw)
    if (parsed.kind === 'invalid') {
      const evidence = await quarantine(text)
      return { ...parsed, evidence }
    }
    return parsed
  }

  /** 读配置：返回 `{config, errors, exists}`。 */
  async function readConfig() {
    const raw = await readConfigRaw()
    if (raw === null) return { config: null, errors: [], exists: false }
    const result = normalizeConfig(raw)
    return { config: result.config, errors: result.errors, exists: true, raw }
  }

  /**
   * 在写锁内读-改-写 state。
   *
   * 只有 `empty`（首次创建）或合法 `v2` 才允许写入；损坏账本与旧账本
   * 一律拒绝，避免“读到空 → 写回空”把历史账本清零。
   */
  function updateState(mutate, { backupBefore = false, allowLegacy = false } = {}) {
    const run = queue.then(async () => {
      await mkdir(paths.dataDir, { recursive: true })
      return withWriteLock(paths.lockFile, async () => {
        const parsed = await readState()
        if (parsed.kind === 'invalid') {
          const error = new Error(`预算账本无法读取（${parsed.reason}），为避免覆盖历史数据已停止写入`)
          error.code = 'LEDGER_INVALID'
          error.evidence = parsed.evidence ?? null
          throw error
        }
        if (parsed.kind === 'legacy' && !allowLegacy) {
          const error = new Error('预算账本仍是旧版美元 Schema，必须先完成受控迁移')
          error.code = 'LEDGER_LEGACY'
          throw error
        }
        const state = parsed.kind === 'empty' || parsed.kind === 'legacy' ? blankState() : parsed.state
        if (backupBefore) await backup(paths.stateFile, paths.backupDir, 'state')
        await mutate(state, { now: now(), paths })
        state.updatedAt = now().toISOString()
        await writeJsonAtomic(paths.stateFile, state)
        return state
      })
    })
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * 在同一把写锁内读-改-写 state 与 savings。
   *
   * 顺序：先写 savings，再写 state。若两次写之间进程崩溃，可能出现
   * “savings 已占用/扣减、state 仍是旧预留”的窗口；`reconcileHolds` 会释放
   * 已不在 pending/uncertain 预留中的占用，宁可少扣也不把用户的额度锁死。
   */
  function updateAll(mutate, { backupBefore = false } = {}) {
    const run = queue.then(async () => {
      await mkdir(paths.dataDir, { recursive: true })
      return withWriteLock(paths.lockFile, async () => {
        const parsedState = await readState()
        if (parsedState.kind === 'invalid') {
          const error = new Error(`预算账本无法读取（${parsedState.reason}），为避免覆盖历史数据已停止写入`)
          error.code = 'LEDGER_INVALID'
          error.evidence = parsedState.evidence ?? null
          throw error
        }
        if (parsedState.kind === 'legacy') {
          const error = new Error('预算账本仍是旧版美元 Schema，必须先完成受控迁移')
          error.code = 'LEDGER_LEGACY'
          throw error
        }
        const parsedSavings = await readSavings()
        if (parsedSavings.kind === 'invalid') {
          const error = new Error(`储蓄账本无法读取（${parsedSavings.reason}），为避免覆盖历史数据已停止写入`)
          error.code = 'LEDGER_INVALID'
          error.evidence = parsedSavings.evidence ?? null
          throw error
        }
        if (parsedState.kind === 'empty' && parsedSavings.kind === 'v1') {
          const error = new Error('储蓄账本存在但预算账本为空：两份文件不同步，请人工核对')
          error.code = 'LEDGER_INVALID'
          throw error
        }
        const state = parsedState.kind === 'empty' ? blankState() : parsedState.state
        const savings = parsedSavings.kind === 'v1' ? parsedSavings.savings : blankSavings(now().toISOString())
        if (backupBefore) {
          await backup(paths.stateFile, paths.backupDir, 'state')
          await backup(paths.savingsFile, paths.backupDir, 'savings')
        }
        const at = now()
        const result = await mutate(state, savings, { now: at, paths })
        state.updatedAt = at.toISOString()
        savings.updatedAt = at.toISOString()
        await writeJsonAtomic(paths.savingsFile, savings)
        await writeJsonAtomic(paths.stateFile, state)
        return { state, savings, result }
      })
    })
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * 写配置。配置只由用户发起，插件内部只读；写入前备份旧文件。
   */
  function writeConfig(rawConfig) {
    const run = queue.then(async () => {
      await mkdir(paths.dataDir, { recursive: true })
      return withWriteLock(paths.lockFile, async () => {
        const result = normalizeConfig(rawConfig)
        if (result.config === null) {
          const error = new Error(`预算配置无效：${result.errors.join('；')}`)
          error.code = 'INVALID_CONFIG'
          throw error
        }
        const backupFile = await backup(paths.configFile, paths.configBackupDir, 'config')
        await writeJsonAtomic(paths.configFile, rawConfig)
        return { config: result.config, backupFile }
      })
    })
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** 列出可恢复的账本备份（新→旧）。 */
  async function listBackups() {
    try {
      const names = await readdir(paths.backupDir)
      return names
        .filter((name) => /^state-\d/.test(name) && name.endsWith('.json'))
        .sort()
        .reverse()
        .map((name) => join(paths.backupDir, name))
    } catch {
      return []
    }
  }

  /**
   * 旧 v1（美元微元）账本受控迁移：仅在旧账本无任何消费/占用时执行。
   * 迁移前备份原文件，迁移后写 v2 空状态并记审计；有消费则拒绝。
   */
  function migrateLegacyToV2() {
    const run = queue.then(async () => {
      await mkdir(paths.dataDir, { recursive: true })
      return withWriteLock(paths.lockFile, async () => {
        const parsed = await readState()
        if (parsed.kind === 'v2') return { migrated: false, reason: 'already-v2', backupFile: null }
        if (parsed.kind === 'invalid') {
          const error = new Error(`预算账本无法读取（${parsed.reason}），拒绝迁移`)
          error.code = 'LEDGER_INVALID'
          throw error
        }
        if (parsed.kind === 'legacy' && legacyHasConsumption(parsed.raw)) {
          const error = new Error('旧版美元账本存在消费或未结算占用，不能自动迁移；请人工核对后处理')
          error.code = 'LEDGER_LEGACY'
          throw error
        }
        const backupFile = await backup(paths.stateFile, paths.backupDir, 'legacy-v1')
        const state = blankState()
        state.audit.push({
          type: 'budget-migrated',
          at: now().toISOString(),
          runId: null,
          detail: parsed.kind === 'legacy' ? '从 v1 美元账本迁移（无消费记录）' : '无可读账本，创建 v2',
        })
        await writeJsonAtomic(paths.stateFile, state)
        return { migrated: parsed.kind === 'legacy', reason: null, backupFile }
      })
    })
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** 从备份恢复账本；调用方必须已做用户确认。 */
  async function restoreState(backupFile) {
    const target = resolve(backupFile)
    const root = resolve(paths.backupDir)
    const rel = relative(root, target)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      const error = new Error('只允许从预算备份目录恢复账本')
      error.code = 'INVALID_ARGUMENT'
      throw error
    }
    const text = await readFile(target, 'utf8')
    const parsed = parseState(JSON.parse(text))
    if (parsed.kind !== 'v2') {
      const error = new Error(`备份账本不可用：${parsed.kind === 'legacy' ? '旧版美元 Schema' : parsed.reason ?? parsed.kind}`)
      error.code = 'INVALID_ARGUMENT'
      throw error
    }
    const run = queue.then(async () => {
      await mkdir(paths.dataDir, { recursive: true })
      return withWriteLock(paths.lockFile, async () => {
        const current = await readState()
        if (current.kind === 'invalid') {
          const currentText = await readFile(paths.stateFile, 'utf8').catch(() => null)
          if (currentText !== null) await quarantine(currentText)
        }
        await writeJsonAtomic(paths.stateFile, parsed.state)
        return parsed.state
      })
    })
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  return { paths, readState, readSavings, readConfig, updateState, updateAll, writeConfig, listBackups, restoreState, migrateLegacyToV2 }
}
