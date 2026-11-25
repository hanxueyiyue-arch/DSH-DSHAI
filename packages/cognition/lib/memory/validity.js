/**
 * 记忆时间有效性四态（设计 §4.12.2）——唯一实现，供召回筛选与存储层共用。
 *
 * 四态：
 *   unknown   没有 validFrom / validUntil：老记忆，按"可检索"处理（保持 0.3.3 行为）
 *   not_yet   现在还没到 validFrom：可以检索到，但**不得当成当前已生效的事实**
 *   active    在窗口内且未被替换
 *   expired   now 已过 validUntil：默认不参与召回
 *
 * 优先级：supersededBy 存在即 superseded，压过一切时间判断——被替换的版本不该因为
 * 时间窗口还开着就回到当前事实里。
 *
 * 边界：`validUntil` 是**闭区间**（`now === validUntil` 仍算有效），`validFrom` 同为闭区间。
 * 这样"有效期到 11 月 8 日"包含 8 日当天，与代码里既有的 `now > until → expired` 一致；
 * 改边界会让 T1b/T1c 已锁定的语料数字漂移，所以这里只固化、不改动。
 *
 * 本模块是纯函数：不读文件、不写 state、不依赖当前时间（`now` 必须显式传入）。
 */

export const VALIDITY_STATES = Object.freeze(['unknown', 'not_yet', 'active', 'expired']);

const MAX_FIELD = 40;

/**
 * 纯日期（`YYYY-MM-DD`）按**北京时间**解释成整天。
 *
 * 为什么必须单独处理：`Date.parse('2026-11-08')` 得到的是 UTC 零点，等于北京时间
 * 8 日 08:00。如果直接拿它当 `validUntil`，"有效期到 8 日"的中午就已经过期了——
 * 这正是"到某天为止"最容易被写错的地方。
 *
 * 规则：
 *   validFrom  = 当天 00:00:00.000（含）
 *   validUntil = 当天 23:59:59.999（含）
 * 带时间的时间戳保持自身精度与偏移，不参与这套扩展。
 */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_ONLY_OFFSET = '+08:00';

/** 有效期字段校验失败。带上 `code`，调用方才能只对这一类错误做降级。 */
export function invalidValidity(message) {
  const error = new Error(message);
  error.code = 'INVALID_VALIDITY';
  return error;
}

function expandDateOnly(raw, name) {
  const match = DATE_ONLY.exec(raw);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // 先确认这一天真实存在（2026-02-30 会被 Date 静默滚到 3 月，必须自己拦）。
  const localMidnightAsUtc = Date.UTC(year, month - 1, day);
  const check = new Date(localMidnightAsUtc);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null;
  }
  const clock = name === 'validFrom' ? '00:00:00.000' : '23:59:59.999';
  return `${match[1]}-${match[2]}-${match[3]}T${clock}${DATE_ONLY_OFFSET}`;
}

/**
 * 把外部传入的有效期字段规范成可存储的形式。
 *
 * - `null` / `undefined` / 空串 → `null`（不写字段）
 * - 纯日期 `YYYY-MM-DD` → 按北京时间扩成整天（见 `expandDateOnly`）
 * - 合法时间（ISO 字符串 / Date / 毫秒数）→ ISO 字符串，保持原精度
 * - 其他一律拒绝：宁可保存失败，也不要静默丢一个"过期时间"
 */
export function normalizeValidity(input = {}) {
  const source = input ?? {};
  const out = { validFrom: null, validUntil: null };
  for (const name of ['validFrom', 'validUntil']) {
    const raw = source[name];
    if (raw === null || raw === undefined || raw === '') continue;
    if (typeof raw === 'string' && raw.length > MAX_FIELD) {
      throw invalidValidity(`${name} 过长（上限 ${MAX_FIELD} 字符）`);
    }
    if (typeof raw === 'string' && DATE_ONLY.test(raw)) {
      const expanded = expandDateOnly(raw, name);
      // 纯日期解析失败要报错，不能落到下面的 Date.parse——那会把 2 月 30 日滚到 3 月。
      if (!expanded) throw invalidValidity(`${name} 不是可解析的时间`);
      out[name] = expanded;
      continue;
    }
    const ms = raw instanceof Date ? raw.getTime() : (typeof raw === 'number' ? raw : Date.parse(raw));
    if (!Number.isFinite(ms)) throw invalidValidity(`${name} 不是可解析的时间`);
    out[name] = new Date(ms).toISOString();
  }
  if (out.validFrom && out.validUntil && Date.parse(out.validFrom) > Date.parse(out.validUntil)) {
    throw invalidValidity('validFrom 晚于 validUntil');
  }
  return out;
}

/** 四态判定。`now` 必须显式传入，避免同一次调用里出现两个时间基准。 */
/**
 * 把存储里的边界值转成毫秒。
 *
 * 为什么要额外处理纯日期：写入路径会把它扩成整天，但**老 state 或外部工具直接写进来的
 * 裸 `YYYY-MM-DD` 仍是常见形态**。若这里退回 `Date.parse`，`2026-11-08` 会变成 UTC 零点
 * （北京 08:00），读时就会重演"当天中午就过期"的 bug。所以读路径也走同一个 `expandDateOnly`。
 */
function boundMs(raw, name) {
  if (typeof raw !== 'string' || !raw) return NaN;
  if (DATE_ONLY.test(raw)) {
    const expanded = expandDateOnly(raw, name);
    return expanded === null ? NaN : Date.parse(expanded);
  }
  return Date.parse(raw);
}

export function timeState(memory, now = Date.now()) {
  if (memory && memory.supersededBy) return 'superseded';
  const from = boundMs(memory?.validFrom, 'validFrom');
  const until = boundMs(memory?.validUntil, 'validUntil');
  const hasFrom = Number.isFinite(from);
  const hasUntil = Number.isFinite(until);
  if (!hasFrom && !hasUntil) return 'unknown';
  if (hasUntil && now > until) return 'expired';
  if (hasFrom && now < from) return 'not_yet';
  return 'active';
}

/**
 * 这条记忆能不能当作"现在成立的事实"。
 *
 * 与 `timeState` 的区别：`unknown` 也算成立（老记忆没有窗口，不能因为缺字段就否认它），
 * `not_yet` 与 `expired` 都不成立。调用方如果只是"找找看"，应该用 `timeState`；
 * 如果要把内容写进"当前事实"，必须先过这一关。
 */
export function isCurrentFact(memory, now = Date.now()) {
  const state = timeState(memory, now);
  return state === 'active' || state === 'unknown';
}

/** 便于 diagnostics 展示的一行描述；不含正文。 */
export function describeValidity(memory, now = Date.now()) {
  const state = timeState(memory, now);
  return {
    state,
    currentFact: isCurrentFact(memory, now),
    validFrom: memory?.validFrom ?? null,
    validUntil: memory?.validUntil ?? null,
    supersededBy: memory?.supersededBy ?? null,
  };
}
