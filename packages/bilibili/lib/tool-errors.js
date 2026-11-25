// Tool-boundary error handling (T-003).
// Known errors map to a fixed whitelist of safe texts; unknown errors become a
// stable package code plus a short correlation id. Raw message/path/token/stack
// never leave this module.

import { createHash } from 'node:crypto';

const KNOWN = Object.freeze({
  ACCESS_UNAVAILABLE: '当前无法确认内容访问许可：操作已拒绝。',
  INVALID_SCOPE: '浏览许可范围不合法。',
  REQUEST_NOT_FOUND: '找不到对应的许可申请。',
  APPROVAL_REQUIRED: '需要由已认证的用户批准。',
  SESSION_MISMATCH: '该批准来自其他运行会话，不能使用。',
  REQUEST_NOT_PENDING: '该申请已结束，不能再处理。',
  ACCESS_REQUEST_SUPPRESSED: '用户已暂停新的浏览或登录申请。',
  LOGIN_NOT_APPROVED: '登录申请尚未获批，不能开始扫码。',
  FILTERS_REQUIRE_USER: '内容限制只能由已认证的用户修改。',
  MIGRATION_CONFLICT: '旧数据迁移冲突，未写入。',
  FILTER_KEYWORD_EXCLUDED: '标题命中排除关键词，已跳过。',
  FILTER_KEYWORD_NOT_INCLUDED: '标题未命中允许关键词，已跳过。',
  FILTER_UPPER_EXCLUDED: 'UP 主命中排除名单，已跳过。',
  FILTER_UPPER_NOT_INCLUDED: 'UP 主不在允许名单，已跳过。',
  FILTER_CATEGORY_EXCLUDED: '分区命中排除名单，已跳过。',
  FILTER_CATEGORY_NOT_INCLUDED: '分区不在允许名单，已跳过。',
  FILTER_METADATA_UNKNOWN: '缺少分区等必要元数据，按未通过处理。',
  INVALID_DRAFT_KIND: '草稿类型只能是 comment 或 dynamic',
  INVALID_BVID: '评论草稿须提供合法 BV 号',
  DRAFT_EMPTY: '草稿不能为空',
});

const FAILURE_CODE = 'BILIBILI_TOOL_FAILURE';
const FAILURE_TEXT = 'B 站工具执行失败';

function correlationId(tool, code, error) {
  const source = `${tool}\u0000${code}\u0000${String(error?.message ?? '')}\u0000${Date.now()}\u0000${Math.random()}`;
  return createHash('sha256').update(source).digest('hex').slice(0, 12);
}

export function toSafeToolError(tool, error) {
  const rawCode = typeof error?.code === 'string' ? error.code : '';
  const known = Object.prototype.hasOwnProperty.call(KNOWN, rawCode) ? KNOWN[rawCode] : null;

  let message;
  let code;
  let event = null;
  if (known) {
    message = known;
    code = rawCode;
  } else {
    event = correlationId(tool, rawCode, error);
    code = FAILURE_CODE;
    message = `${FAILURE_TEXT}（错误码 ${code}，事件 ${event}）`;
  }

  const safe = new Error(message);
  safe.name = 'ToolExecutionError';
  safe.code = code;
  if (event) safe.eventId = event;
  try {
    console.error('[dsh-dshai] tool failure', { tool, code, event });
  } catch {
    // logging must never change the tool outcome
  }
  return safe;
}

export function wrapToolErrors(tool) {
  const original = tool.execute;
  if (typeof original !== 'function') return tool;
  return {
    ...tool,
    async execute(...args) {
      try {
        return await original.apply(tool, args);
      } catch (error) {
        throw toSafeToolError(tool.name, error);
      }
    },
  };
}
