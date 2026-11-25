/**
 * 阶段 1b：B 站行为限制的持久化 Policy 与一次性初始化标记。
 *
 * 设计要点：
 * - Policy 与登录会话分离；不保存 Cookie/Token，也不因退出登录而删除。
 * - 首次安装：无 policy + 无 meta → uninitialized。只允许公开读取；私有读取和
 *   写入保持拒绝，直到已认证用户在设置页执行一次性初始化。
 * - 已初始化但文件丢失/损坏/标记不一致 → missing/corrupt/recovery。受保护操作
 *   继续拒绝，不自动生成新默认配置，也不覆盖损坏文件。
 * - 有效文件默认允许“公开读取 + 绑定用户私信”，其余写入默认拒绝；用户可逐项改。
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CAPABILITY_CATEGORIES, getCapability } from './capabilities.js';

export const POLICY_VERSION = 1;
export const POLICY_META_VERSION = 1;
export const POLICY_STATES = Object.freeze(['allow', 'deny']);
export const POLICY_READY_STATES = Object.freeze(['valid']);
export const POLICY_FAULT_STATES = Object.freeze(['missing', 'corrupt', 'recovery']);

const CATEGORY_DEFAULTS = Object.freeze({
  [CAPABILITY_CATEGORIES.PUBLIC_READ]: 'allow',
  [CAPABILITY_CATEGORIES.PRIVATE_READ]: 'deny',
  [CAPABILITY_CATEGORIES.SOCIAL_WRITE]: 'deny',
  [CAPABILITY_CATEGORIES.REACTION_WRITE]: 'deny',
  [CAPABILITY_CATEGORIES.RELATION_WRITE]: 'deny',
  [CAPABILITY_CATEGORIES.PUBLISH_WRITE]: 'deny',
  [CAPABILITY_CATEGORIES.ACCOUNT_WRITE]: 'deny',
  [CAPABILITY_CATEGORIES.MESSAGE_WRITE]: 'deny',
});

const PRODUCT_OVERRIDES = Object.freeze({
  'dm.read': 'allow',
  'dm.send': 'allow',
});

const FAIL_CLOSED_OVERRIDES = Object.freeze({
  'dm.read': 'deny',
  'dm.send': 'deny',
});

export class PolicyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PolicyError';
    this.code = code;
    this.details = details;
  }
}

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const normalizeState = value => (POLICY_STATES.includes(value) ? value : null);

export function createDefaultPolicy({ allowOwnerDm = true, now = () => Date.now() } = {}) {
  return {
    version: POLICY_VERSION,
    updatedAt: new Date(now()).toISOString(),
    categories: { ...CATEGORY_DEFAULTS },
    capabilities: allowOwnerDm
      ? { 'dm.read': 'allow', 'dm.send': 'allow' }
      : { 'dm.read': 'deny', 'dm.send': 'deny' },
  };
}

export function policyHash(policy) {
  return createHash('sha256').update(JSON.stringify(policy)).digest('hex');
}

function validatePolicy(raw) {
  if (!isPlainObject(raw)) return { ok: false, reason: 'policy 必须是对象' };
  if (raw.version !== POLICY_VERSION) return { ok: false, reason: `policy.version 必须是 ${POLICY_VERSION}` };
  const categories = isPlainObject(raw.categories) ? raw.categories : {};
  const capabilities = isPlainObject(raw.capabilities) ? raw.capabilities : {};
  for (const [key, value] of Object.entries(categories)) {
    if (!Object.values(CAPABILITY_CATEGORIES).includes(key)) {
      return { ok: false, reason: `未知分类 ${key}` };
    }
    if (!normalizeState(value)) return { ok: false, reason: `分类 ${key} 的状态必须是 allow/deny` };
  }
  for (const [key, value] of Object.entries(capabilities)) {
    if (!getCapability(key)) return { ok: false, reason: `未知能力 ${key}` };
    if (!normalizeState(value)) return { ok: false, reason: `能力 ${key} 的状态必须是 allow/deny` };
  }
  return { ok: true, value: { categories, capabilities } };
}

function validateMeta(raw) {
  if (!isPlainObject(raw)) return { ok: false, reason: 'meta 必须是对象' };
  if (raw.version !== POLICY_META_VERSION) return { ok: false, reason: 'meta.version 不匹配' };
  if (typeof raw.policyHash !== 'string' || !/^[0-9a-f]{64}$/.test(raw.policyHash)) {
    return { ok: false, reason: 'meta.policyHash 无效' };
  }
  return { ok: true };
}

export async function writePolicyFile({ filePath, policy }) {
  const validated = validatePolicy(policy);
  if (!validated.ok) throw new PolicyError('POLICY_INVALID', `Policy 无效：${validated.reason}`);
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(policy, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  await rename(tmp, filePath);
  return filePath;
}

export async function writePolicyMeta({
  metaPath,
  policy,
  initializedBy = 'dashboard',
  now = () => Date.now(),
} = {}) {
  if (!metaPath) throw new PolicyError('POLICY_META_PATH_REQUIRED', '缺少初始化标记路径');
  const meta = {
    version: POLICY_META_VERSION,
    policyHash: policyHash(policy),
    initializedAt: new Date(now()).toISOString(),
    initializedBy: String(initializedBy || 'dashboard').slice(0, 80),
  };
  await mkdir(dirname(metaPath), { recursive: true, mode: 0o700 });
  const tmp = `${metaPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(meta, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  await rename(tmp, metaPath);
  return meta;
}

async function readOptional(filePath) {
  try {
    return { exists: true, text: await readFile(filePath, 'utf8') };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, text: null };
    return { exists: true, text: null, error: `读取失败：${error.message}` };
  }
}

function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, reason: `JSON 解析失败：${error.message}` };
  }
}

/**
 * @param {Object} options
 * @param {string} options.filePath
 * @param {string} [options.metaPath]
 * @param {() => number} [options.now]
 */
export function createCapabilityPolicy({
  filePath,
  metaPath = filePath ? `${filePath}.meta` : null,
  now = () => Date.now(),
} = {}) {
  if (!filePath) throw new Error('createCapabilityPolicy 需要 filePath');

  let readyPromise = null;
  let snapshot = {
    status: 'unloaded',
    data: null,
    meta: null,
    error: null,
    path: filePath,
    metaPath,
    loadedAt: null,
  };

  const effectiveFor = () => {
    if (snapshot.status !== 'valid') {
      return {
        categories: { ...CATEGORY_DEFAULTS },
        capabilities: { ...FAIL_CLOSED_OVERRIDES },
        source: snapshot.status,
      };
    }
    return {
      categories: { ...CATEGORY_DEFAULTS, ...(snapshot.data?.categories ?? {}) },
      capabilities: { ...PRODUCT_OVERRIDES, ...(snapshot.data?.capabilities ?? {}) },
      source: 'file',
    };
  };

  async function load() {
    const [policyRead, metaRead] = await Promise.all([
      readOptional(filePath),
      metaPath ? readOptional(metaPath) : Promise.resolve({ exists: false, text: null }),
    ]);

    // 首次安装：没有 Policy，也没有初始化标记。
    if (!policyRead.exists && !metaRead.exists) {
      snapshot = {
        status: 'uninitialized', data: null, meta: null,
        error: null, path: filePath, metaPath, loadedAt: now(),
      };
      return snapshot;
    }

    // 有标记但没有 Policy：已初始化过的配置丢失。
    if (!policyRead.exists) {
      snapshot = {
        status: 'missing', data: null, meta: null,
        error: '初始化标记存在，但 policy.json 缺失', path: filePath, metaPath, loadedAt: now(),
      };
      return snapshot;
    }

    // Policy 本身不可读 / 不可解析 / 结构无效。
    if (policyRead.error || policyRead.text == null) {
      snapshot = {
        status: 'corrupt', data: null, meta: null,
        error: policyRead.error || 'policy.json 不可读', path: filePath, metaPath, loadedAt: now(),
      };
      return snapshot;
    }
    const parsed = parseJson(policyRead.text);
    if (!parsed.ok) {
      snapshot = {
        status: 'corrupt', data: null, meta: null,
        error: parsed.reason, path: filePath, metaPath, loadedAt: now(),
      };
      return snapshot;
    }
    const validated = validatePolicy(parsed.value);
    if (!validated.ok) {
      snapshot = {
        status: 'corrupt', data: null, meta: null,
        error: validated.reason, path: filePath, metaPath, loadedAt: now(),
      };
      return snapshot;
    }
    const data = {
      version: POLICY_VERSION,
      updatedAt: parsed.value.updatedAt ?? null,
      categories: validated.value.categories,
      capabilities: validated.value.capabilities,
    };
    const currentHash = policyHash(data);

    // Policy 存在但初始化标记缺失 / 损坏 / 指纹不符：不自动扩大授权。
    if (!metaRead.exists) {
      snapshot = {
        status: 'recovery', data, meta: null,
        error: 'policy.json 存在，但初始化标记缺失', path: filePath, metaPath,
        policyHash: currentHash, loadedAt: now(),
      };
      return snapshot;
    }
    if (metaRead.error || metaRead.text == null) {
      snapshot = {
        status: 'recovery', data, meta: null,
        error: metaRead.error || '初始化标记不可读', path: filePath, metaPath,
        policyHash: currentHash, loadedAt: now(),
      };
      return snapshot;
    }
    const metaParsed = parseJson(metaRead.text);
    const metaValidated = metaParsed.ok ? validateMeta(metaParsed.value) : metaParsed;
    if (!metaValidated.ok) {
      snapshot = {
        status: 'recovery', data, meta: null,
        error: `初始化标记无效：${metaValidated.reason}`, path: filePath, metaPath,
        policyHash: currentHash, loadedAt: now(),
      };
      return snapshot;
    }
    if (metaParsed.value.policyHash !== currentHash) {
      snapshot = {
        status: 'recovery', data, meta: metaParsed.value,
        error: '初始化标记与 policy.json 指纹不一致', path: filePath, metaPath,
        policyHash: currentHash, loadedAt: now(),
      };
      return snapshot;
    }

    snapshot = {
      status: 'valid', data, meta: metaParsed.value,
      error: null, path: filePath, metaPath, policyHash: currentHash, loadedAt: now(),
    };
    return snapshot;
  }

  function ready() {
    if (!readyPromise) readyPromise = load();
    return readyPromise;
  }

  function reload() {
    readyPromise = null;
    return ready();
  }

  async function status() {
    await ready();
    return {
      status: snapshot.status,
      initialized: snapshot.status === 'valid',
      recoverable: POLICY_FAULT_STATES.includes(snapshot.status),
      version: snapshot.data?.version ?? POLICY_VERSION,
      updatedAt: snapshot.data?.updatedAt ?? null,
      error: snapshot.error,
      path: snapshot.path,
      metaPath: snapshot.metaPath,
      policyHash: snapshot.policyHash ?? null,
      expectedHash: snapshot.meta?.policyHash ?? null,
    };
  }

  async function evaluate(capability, context = {}) {
    await ready();
    if (!capability) {
      return { ok: false, code: 'UNCLASSIFIED_CAPABILITY', reason: '未知能力，拒绝执行' };
    }
    if (capability.implemented !== true) {
      return {
        ok: false,
        code: 'not_implemented',
        reason: `${capability.id} 尚未实现，不能假装可调用`,
        capabilityId: capability.id,
      };
    }
    if (capability.requiresLogin === true && context.loggedIn !== true) {
      return { ok: false, code: 'not_logged_in', reason: '需要先登录 B 站', capabilityId: capability.id };
    }

    // 私有读取同样只能由 Autonomy 或可信用户聊天发起，避免任意调用者读私信。
    if (capability.category === CAPABILITY_CATEGORIES.PRIVATE_READ) {
      const kind = context.caller?.kind;
      const trustedOwnerChat = kind === 'owner-chat' && context.caller?.trusted === true;
      if (kind !== 'autonomy' && !trustedOwnerChat) {
        return {
          ok: false,
          code: 'CALLER_NOT_TRUSTED',
          reason: '只有 Autonomy 或可信用户聊天可以读取私有内容',
          capabilityId: capability.id,
        };
      }
    }

    const effective = effectiveFor();
    const configured = effective.capabilities[capability.id]
      ?? effective.categories[capability.category]
      ?? 'deny';

    // 目标范围：用户私信只能发给绑定用户 UID；self 只能操作自己。
    if (capability.targetScope === 'owner') {
      const owner = context.ownerMid == null ? null : String(context.ownerMid);
      const target = context.targetMid == null ? owner : String(context.targetMid);
      if (!owner || !target || owner !== target) {
        return {
          ok: false,
          code: 'TARGET_NOT_ALLOWED',
          reason: '目标不是绑定的用户 UID',
          capabilityId: capability.id,
        };
      }
    }
    if (capability.targetScope === 'self') {
      const self = context.selfMid == null ? null : String(context.selfMid);
      const target = context.targetMid == null ? self : String(context.targetMid);
      if (!self || !target || self !== target) {
        return {
          ok: false,
          code: 'TARGET_NOT_ALLOWED',
          reason: '目标不是当前登录账号',
          capabilityId: capability.id,
        };
      }
    }

    // 写入只接受真实可信来源：Autonomy，或带 trusted 标记的用户聊天。
    // 注意：这里不按“本次决策读过 external 内容”一刀切拒绝；外部内容不能铸造
    // 意图，但 Autonomy 可以基于外部内容形成自己的合法决策。
    if (capability.sideEffect === true) {
      const kind = context.caller?.kind;
      const trustedOwnerChat = kind === 'owner-chat' && context.caller?.trusted === true;
      if (kind !== 'autonomy' && !trustedOwnerChat) {
        return {
          ok: false,
          code: 'CALLER_NOT_TRUSTED',
          reason: '只有 Autonomy 或可信用户聊天可以触发平台写入',
          capabilityId: capability.id,
        };
      }
    }

    if (configured !== 'allow') {
      const code = snapshot.status === 'uninitialized'
        ? 'POLICY_UNINITIALIZED'
        : snapshot.status === 'missing'
          ? 'POLICY_MISSING'
          : snapshot.status === 'recovery'
            ? 'POLICY_RECOVERY'
            : snapshot.status === 'corrupt'
              ? 'POLICY_CORRUPT'
              : 'denied';
      return {
        ok: false,
        code,
        reason: capability.sideEffect || capability.category === CAPABILITY_CATEGORIES.PRIVATE_READ
          ? '当前行为限制拒绝该操作'
          : '当前 Policy 拒绝该能力',
        capabilityId: capability.id,
        policyStatus: snapshot.status,
      };
    }

    return {
      ok: true,
      capabilityId: capability.id,
      policyStatus: snapshot.status,
      policySource: effective.source,
    };
  }

  function requireUser(actor) {
    if (!(actor?.kind === 'user' && actor?.authenticated === true)) {
      throw new PolicyError('POLICY_USER_REQUIRED', '只有已认证用户可以修改行为限制');
    }
  }

  async function initializePolicy({ actor, policy = createDefaultPolicy({ allowOwnerDm: true, now }) } = {}) {
    requireUser(actor);
    await ready();
    if (snapshot.status === 'valid') {
      throw new PolicyError('POLICY_ALREADY_INITIALIZED', '行为限制已经初始化，不需要重复初始化');
    }
    if (snapshot.status === 'corrupt') {
      throw new PolicyError('POLICY_CORRUPT', 'Policy 文件损坏，不能执行初始化；请先恢复或备份后重建');
    }
    if (snapshot.status !== 'uninitialized') {
      throw new PolicyError('POLICY_RECOVERY_REQUIRED', '存在未完成的恢复状态，不能执行首次初始化', {
        status: snapshot.status,
      });
    }
    const validated = validatePolicy(policy);
    if (!validated.ok) throw new PolicyError('POLICY_INVALID', `Policy 无效：${validated.reason}`);
    await writePolicyFile({ filePath, policy });
    try {
      await writePolicyMeta({ metaPath, policy, initializedBy: actor.id || 'user', now });
    } catch (error) {
      await reload();
      throw new PolicyError('POLICY_META_WRITE_FAILED', 'Policy 已写入，但初始化标记写入失败；已进入可诊断恢复状态', {
        cause: error?.message,
      });
    }
    await reload();
    return status();
  }

  async function recoverPolicy({ actor, mode = 'adopt', confirm = null } = {}) {
    requireUser(actor);
    await ready();
    if (snapshot.status === 'valid') {
      throw new PolicyError('POLICY_ALREADY_INITIALIZED', '行为限制已经有效，不需要恢复');
    }
    if (snapshot.status === 'uninitialized') {
      throw new PolicyError('POLICY_NOT_INITIALIZED', '尚未初始化；请使用一次性初始化');
    }
    if (snapshot.status === 'recovery') {
      if (mode !== 'adopt') {
        throw new PolicyError('POLICY_RECOVERY_MODE_INVALID', '初始化标记恢复只接受 adopt');
      }
      await writePolicyMeta({
        metaPath,
        policy: snapshot.data,
        initializedBy: actor.id || 'user',
        now,
      });
      await reload();
      return status();
    }
    if (snapshot.status === 'missing') {
      if (mode !== 'recreate') {
        throw new PolicyError('POLICY_RECOVERY_MODE_INVALID', 'Policy 丢失恢复只接受 recreate');
      }
      const policy = createDefaultPolicy({ allowOwnerDm: true, now });
      await writePolicyFile({ filePath, policy });
      await writePolicyMeta({ metaPath, policy, initializedBy: actor.id || 'user', now });
      await reload();
      return status();
    }
    if (snapshot.status === 'corrupt') {
      if (mode !== 'reset' || confirm !== 'RESET') {
        throw new PolicyError('POLICY_RESET_CONFIRM_REQUIRED', '损坏的 Policy 必须显式确认 reset（confirm=RESET）');
      }
      await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
      const backup = `${filePath}.corrupt.${now()}`;
      await rename(filePath, backup);
      const policy = createDefaultPolicy({ allowOwnerDm: true, now });
      await writePolicyFile({ filePath, policy });
      await writePolicyMeta({ metaPath, policy, initializedBy: actor.id || 'user', now });
      await reload();
      return { ...(await status()), backupPath: backup };
    }
    throw new PolicyError('POLICY_RECOVERY_UNSUPPORTED', `不支持的恢复状态：${snapshot.status}`);
  }

  async function updateCapability(capabilityId, state, { actor } = {}) {
    const capability = getCapability(capabilityId);
    if (!capability) throw new PolicyError('UNCLASSIFIED_CAPABILITY', `未知能力 ${capabilityId}`);
    const next = normalizeState(state);
    if (!next) throw new PolicyError('POLICY_INVALID', '状态必须是 allow/deny');
    requireUser(actor);
    await ready();
    if (snapshot.status === 'corrupt') {
      throw new PolicyError('POLICY_CORRUPT', 'Policy 文件损坏，拒绝覆盖；请先人工恢复或备份后重建');
    }
    if (snapshot.status !== 'valid') {
      const code = snapshot.status === 'missing' ? 'POLICY_MISSING'
        : snapshot.status === 'recovery' ? 'POLICY_RECOVERY'
          : snapshot.status === 'uninitialized' ? 'POLICY_UNINITIALIZED' : 'POLICY_NOT_READY';
      throw new PolicyError(code, 'Behavior Policy 尚未完成初始化或处于恢复状态，不能修改', {
        status: snapshot.status,
      });
    }
    const base = {
      version: POLICY_VERSION,
      updatedAt: new Date(now()).toISOString(),
      categories: { ...snapshot.data.categories },
      capabilities: { ...snapshot.data.capabilities },
    };
    base.capabilities[capabilityId] = next;
    await writePolicyFile({ filePath, policy: base });
    try {
      await writePolicyMeta({ metaPath, policy: base, initializedBy: actor.id || 'user', now });
    } catch (error) {
      await reload();
      throw new PolicyError('POLICY_META_WRITE_FAILED', 'Policy 已写入，但初始化标记更新失败；已进入恢复状态', {
        cause: error?.message,
      });
    }
    await reload();
    return status();
  }

  return {
    filePath,
    metaPath,
    ready,
    status,
    evaluate,
    initializePolicy,
    recoverPolicy,
    updateCapability,
    get effective() { return effectiveFor(); },
  };
}
