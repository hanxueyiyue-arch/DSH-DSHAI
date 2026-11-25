/**
 * ⚠️ 当前未被任何代码引用（死代码），保留待用。
 *
 * 为什么留：DSHAI 的成长变化（人设演化、改名、性别/资料修订）以后可能复用这里的规则，
 * 尤其是「改名必须经可信来源批准」与「性别一次性锁定」这两条约束。
 *
 * 现状：
 *   - 现役身份由 self.json（name/gender/profileText）+ 身份编辑界面维护，本文件不参与。
 *   - 接回时需要先决定：谁写入、审批走哪条通道（UI 一次性令牌见 persona-gate.js，也在归档里）。
 *   - 在接回之前它不产生任何运行时行为，删掉也不影响现有功能。
 */
/**
 * 初始人设卡（V0.5.1）。
 *
 * 设计要点（见 docs/V0.5.0-ALGORITHM-UPGRADE-DESIGN.md §4.10）：
 *   - 只存**初始**快照与**当前**值；"当前"是派生视图，不需要另一套写者。
 *   - 性别：初始化即锁定，只允许 24 小时内纠错一次，之后永久不可改。
 *   - 初始人设：一段自由文本，初次 + 最多 3 次修改（共 4 次提交）后锁定。
 *   - 姓名：可由 Agent 提议，但**必须**经可信来源批准（UI 确认或宿主批准），
 *     Agent 自己写的一律不算。
 *   - 任何字段变更都追加一条 history，不覆盖历史，也不把历史当作权限依据。
 *
 * 本文件是纯函数层：不读写文件、不感知时间来源（`at` 由调用方传入）。
 */
import { createHash } from 'node:crypto';

export const PERSONA_SCHEMA = 1;
export const GENDERS = Object.freeze(['male', 'female']);
export const PROFILE_MAX_CHARS = 2000;
/** 初次 + 3 次修改 = 共 4 次提交。`revisionCount` 记的是"修改次数"，最大 3。 */
export const PROFILE_MAX_REVISIONS = 3;
/**
 * 姓名长度上限。
 *
 * 用户于 2026-11-08 裁决定稿 **32 个字符**（此前 20 与 32 并存，D-007 关闭）。
 * 计的是 Unicode 码点数，不是字节数；空白先 trim，超出即拒绝，不做静默截断。
 */
export const NAME_MAX_CHARS = 32;
export const GENDER_CORRECTION_WINDOW_MS = 24 * 60 * 60 * 1000;
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
export const APPROVAL_SOURCES = Object.freeze(['ui-confirm', 'host-approval']);

const fail = (code, message) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

const isText = value => typeof value === 'string' && value.trim().length > 0;
const chars = text => [...String(text)].length;
// 控制字符（含换行）不允许出现在姓名里：既难看也容易被用来伪造展示。
const CONTROL = /[\u0000-\u001f\u007f]/;

export function blankPersona() {
  return {
    schema: PERSONA_SCHEMA,
    initializedAt: null,
    initial: null,
    name: null,
    gender: null,
    profile: { text: '', revisionCount: 0, locked: false, lockedAt: null, updatedAt: null },
    pending: null,
    history: [],
    version: 0,
  };
}

/** 读旧 state 时的容错：缺字段补空，多余字段保留（不升 schema）。 */
export function normalizePersona(raw) {
  if (!raw || typeof raw !== 'object') return blankPersona();
  const base = blankPersona();
  const persona = {
    ...base,
    ...raw,
    profile: { ...base.profile, ...(raw.profile && typeof raw.profile === 'object' ? raw.profile : {}) },
    history: Array.isArray(raw.history) ? raw.history.filter(item => item && typeof item === 'object') : [],
  };
  persona.version = Number.isInteger(raw.version) ? raw.version : 0;
  return persona;
}

function validateName(value) {
  if (!isText(value)) throw fail('PERSONA_NAME_INVALID', '姓名不能为空');
  const trimmed = value.trim();
  if (chars(trimmed) > NAME_MAX_CHARS) throw fail('PERSONA_NAME_INVALID', `姓名过长（上限 ${NAME_MAX_CHARS} 字符）`);
  if (CONTROL.test(trimmed)) throw fail('PERSONA_NAME_INVALID', '姓名不能包含换行或控制字符');
  return trimmed;
}

function validateProfile(value) {
  if (typeof value !== 'string') throw fail('PERSONA_PROFILE_INVALID', '人设必须是文本');
  if (chars(value) > PROFILE_MAX_CHARS) throw fail('PERSONA_PROFILE_INVALID', `人设上限 ${PROFILE_MAX_CHARS} 字`);
  return value;
}

const sha256Hex = text => createHash('sha256').update(String(text), 'utf8').digest('hex');

function pushHistory(persona, entry) {
  persona.history.push(entry);
  persona.version += 1;
}

/** 状态：未设置 / 只填了一部分 / 已锁定 / 仍在演化（未锁定但已初始化）。 */
export function personaState(persona) {
  if (!persona || !persona.initializedAt) return 'unset';
  if (!persona.name || !persona.gender) return 'partial';
  if (persona.profile?.locked && persona.gender?.value) return 'locked';
  return 'evolving';
}

/**
 * 初始化：姓名、性别、初始人设一次写入。
 * 初始化之前允许空文本（用户可能只想先填名字），但**必须**有一次显式初始化。
 */
export function initPersona(persona, { name, gender, profile = '', at = new Date().toISOString() } = {}) {
  if (persona.initializedAt) throw fail('PERSONA_ALREADY_INITIALIZED', '人设已经初始化，不能再次初始化');
  const value = validateName(name);
  if (!GENDERS.includes(gender)) throw fail('PERSONA_GENDER_INVALID', '性别只能是 male 或 female');
  const text = validateProfile(profile);
  persona.name = { value, updatedAt: at };
  persona.gender = { value: gender, lockedAt: at, correctedAt: null, correctionUsed: false };
  persona.profile = { text, revisionCount: 0, locked: false, lockedAt: null, updatedAt: at };
  persona.initial = { name: value, gender, profileText: text, at };
  persona.initializedAt = at;
  pushHistory(persona, { at, field: 'init', source: 'user-init', name: value, gender, profileChars: chars(text) });
  return persona;
}

/** 修改初始人设：最多 3 次，第 3 次修改后立即锁定。 */
export function updateProfile(persona, { text, at = new Date().toISOString() } = {}) {
  if (!persona.initializedAt) throw fail('PERSONA_NOT_INITIALIZED', '人设尚未初始化');
  if (persona.profile.locked) throw fail('PERSONA_PROFILE_LOCKED', '初始人设已锁定，不能再修改');
  const value = validateProfile(text);
  const revisionCount = (persona.profile.revisionCount || 0) + 1;
  const locked = revisionCount >= PROFILE_MAX_REVISIONS;
  persona.profile = {
    text: value,
    revisionCount,
    locked,
    lockedAt: locked ? at : null,
    updatedAt: at,
  };
  pushHistory(persona, {
    at, field: 'profile', source: 'user-ui',
    revision: revisionCount, chars: chars(value), sha256: sha256Hex(value),
    ...(locked ? { locked: true } : {}),
  });
  return persona;
}

/** 24 小时内的一次性性别纠错；过期或已用过一律拒绝。 */
export function correctGender(persona, { gender, at = new Date().toISOString() } = {}) {
  if (!persona.initializedAt || !persona.gender) throw fail('PERSONA_NOT_INITIALIZED', '人设尚未初始化');
  if (!GENDERS.includes(gender)) throw fail('PERSONA_GENDER_INVALID', '性别只能是 male 或 female');
  if (persona.gender.correctionUsed) throw fail('PERSONA_GENDER_LOCKED', '性别已锁定（纠错机会已用过）');
  const lockedAt = Date.parse(persona.gender.lockedAt);
  const now = Date.parse(at);
  if (!Number.isFinite(lockedAt) || !Number.isFinite(now) || now - lockedAt > GENDER_CORRECTION_WINDOW_MS || now < lockedAt) {
    throw fail('PERSONA_GENDER_LOCKED', '性别已锁定（超过 24 小时纠错窗口）');
  }
  const from = persona.gender.value;
  persona.gender = { ...persona.gender, value: gender, correctedAt: at, correctionUsed: true };
  pushHistory(persona, { at, field: 'gender', from, to: gender, source: 'user-ui', correction: true });
  return persona;
}

/**
 * Agent 提议改名：只写 `pending`，不改 `name`。
 * `id` 由调用方给出便于测试；缺省随机。
 */
export function proposeName(persona, { value, at = new Date().toISOString(), id = null } = {}) {
  if (!persona.initializedAt) throw fail('PERSONA_NOT_INITIALIZED', '人设尚未初始化');
  const next = validateName(value);
  const pendingId = typeof id === 'string' && id ? id : `p-${Math.random().toString(36).slice(2, 10)}`;
  persona.pending = {
    id: pendingId,
    value: next,
    createdAt: at,
    expiresAt: new Date(Date.parse(at) + PENDING_TTL_MS).toISOString(),
  };
  pushHistory(persona, { at, field: 'name-proposal', to: next, source: 'agent-proposal', pendingId });
  return persona.pending;
}

/**
 * 批准改名。`approvalSource` 必须是 ui-confirm 或 host-approval，且 `approvalRef` 非空。
 * 注意：本函数**无法**判断 ref 的真伪——那是路由层的责任；这里只拒绝"没有来源"的调用。
 */
export function approveName(persona, { pendingId, approvalSource, approvalRef, at = new Date().toISOString() } = {}) {
  if (!persona.initializedAt) throw fail('PERSONA_NOT_INITIALIZED', '人设尚未初始化');
  if (!APPROVAL_SOURCES.includes(approvalSource)) {
    throw fail('PERSONA_APPROVAL_SOURCE', '改名必须来自可信来源（UI 确认或宿主批准），Agent 自述不算');
  }
  if (!isText(approvalRef)) throw fail('PERSONA_APPROVAL_REF', '缺少批准凭据');
  const pending = persona.pending;
  if (!pending) throw fail('PERSONA_PENDING_MISSING', '没有待批准的人名提案');
  if (pendingId && pendingId !== pending.id) throw fail('PERSONA_PENDING_MISSING', '提案编号不匹配');
  if (Date.parse(at) > Date.parse(pending.expiresAt)) {
    persona.pending = null;
    throw fail('PERSONA_PENDING_EXPIRED', '提案已过期，请重新提议');
  }
  const from = persona.name?.value ?? null;
  persona.name = { value: pending.value, updatedAt: at };
  persona.pending = null;
  pushHistory(persona, { at, field: 'name', from, to: pending.value, source: 'owner-approved', approvalSource, approvalRef });
  return persona;
}

/**
 * 派生视图：初始人设（只读快照）+ 当前人设 + 状态。
 * 不返回 history（另有 personaHistory），避免一次把全部变更塞进 prompt。
 */
export function personaView(persona) {
  const p = normalizePersona(persona);
  return {
    state: personaState(p),
    initial: p.initial ? { name: p.initial.name, gender: p.initial.gender, profileText: p.initial.profileText, at: p.initial.at } : null,
    current: {
      name: p.name?.value ?? null,
      gender: p.gender?.value ?? null,
      profileText: p.profile?.text ?? '',
      profileRevision: p.profile?.revisionCount ?? 0,
      profileLocked: p.profile?.locked === true,
      genderCorrectionUsed: p.gender?.correctionUsed === true,
    },
    pending: p.pending ? { id: p.pending.id, value: p.pending.value, expiresAt: p.pending.expiresAt } : null,
    version: p.version,
  };
}
