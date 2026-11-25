/**
 * F6 私信 transport 适配层。
 *
 * 边界：
 * - Bilibili 负责真实收发、权限、频率与可靠性；Autonomy 只通过 service 的
 *   socialSend/socialReceive 调用，且必须持有用户签发的 grant。
 * - 真实 transport 未接入、未启用时一律 fail-closed；不会因为注入了 transport
 *   就自动获得真实发送能力。
 * - B 站私信接口不是官方稳定 API，真实适配器只写到这里并保持关闭；本阶段不发送
 *   任何真实私信，也不在测试中访问网络。
 */

import { normalizeMid } from './dm.js';

export const DM_ENDPOINTS = Object.freeze({
  send: 'https://api.vc.bilibili.com/web_im/v1/web_im/send_msg',
  sessions: 'https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions',
  messages: 'https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs',
});

export class SocialTransportError extends Error {
  constructor(message, { code = 'SOCIAL_TRANSPORT_ERROR', definitive = false } = {}) {
    super(message);
    this.name = 'SocialTransportError';
    this.code = code;
    this.definitive = definitive === true;
  }
}

const isUnknownRateCode = code => [-352, -412, -429, -509].includes(Number(code));

/**
 * 隔离测试用 fake transport。不联网；支持成功/失败/unknown/抛出四类结果。
 */
export function createFakeSocialTransport({
  messages = [], pages = null, cursor = null, behavior = 'ok', keyPrefix = 'fake',
} = {}) {
  const sent = [];
  let inbox = [...messages];
  const paged = Array.isArray(pages) ? pages.map(page => [...page]) : null;
  let mode = behavior;
  return {
    kind: 'fake',
    real: false,
    enabled: true,
    sent,
    get messages() { return [...inbox]; },
    setMessages(next) { inbox = Array.isArray(next) ? [...next] : []; },
    setBehavior(next) { mode = String(next || 'ok'); },
    async sendOwnerMessage({ receiverMid, text, intentId } = {}) {
      sent.push({ receiverMid: String(receiverMid ?? ''), text: String(text ?? ''), intentId });
      if (mode === 'throw') throw new SocialTransportError('模拟网络超时', { code: 'DM_TIMEOUT' });
      if (mode === 'definitive') {
        throw new SocialTransportError('模拟平台拒绝', { code: 'DM_REJECTED', definitive: true });
      }
      if (mode === 'unknown') return { unknown: true, code: 'DM_UNKNOWN' };
      if (mode === 'fail') return { ok: false, code: 'DM_REJECTED' };
      return { ok: true, key: `${keyPrefix}-${sent.length}` };
    },
    async fetchOwnerMessages({ cursor: pageCursor = null, size = 20 } = {}) {
      if (mode === 'throw') throw new SocialTransportError('模拟接收超时', { code: 'DM_TIMEOUT' });
      const limit = Math.max(1, Math.min(30, Number(size) || 20));
      if (paged) {
        const index = pageCursor == null || pageCursor === '' ? 0 : Math.max(0, Number(pageCursor) || 0);
        const page = paged[index] ?? [];
        return {
          messages: page.slice(0, limit),
          cursor: index + 1 < paged.length ? String(index + 1) : null,
        };
      }
      return { messages: inbox.slice(0, limit), cursor };
    },
  };
}

/**
 * 真实 B 站私信适配器（未验证，默认关闭）。
 *
 * request 由宿主注入，形如：
 *   async ({ endpoint, method, url, payload }) => ({ code, data, status? })
 * 这样测试/隔离环境可以完全不联网；生产接线时也必须由用户显式启用。
 *
 * 只有请求被明确判定为平台拒绝才返回 definitive；超时、网络错误、风控/限流、
 * 无法解析响应一律视为 unknown，由上层保持 unknown 且绝不自动重发。
 */
export function createRealSocialTransport({
  request, enabled = false, readEnabled = null, sendEnabled = null, csrf = null, timeoutMs = 15_000,
} = {}) {
  if (typeof request !== 'function') {
    throw new SocialTransportError('真实私信 transport 需要注入 request 函数', {
      code: 'SOCIAL_TRANSPORT_REQUEST_REQUIRED', definitive: true,
    });
  }
  // 读、写独立门禁：兼容旧的 enabled（同时控制两者），但真实只读验证必须能
  // 单独打开 readEnabled，而 sendEnabled 保持 false。
  const readActive = readEnabled == null ? enabled === true : readEnabled === true;
  const sendActive = sendEnabled == null ? enabled === true : sendEnabled === true;

  // 传输层熔断：只针对发送；平台限流/风控、5xx、超时/网络错误触发指数退避。
  // 这是传输安全，不参与 Autonomy 的日常联系策略，也不改变“正常连续发送”的语义。
  let sendBlockedUntil = 0;
  let sendFailures = 0;
  function noteSendFailure() {
    sendFailures = Math.min(sendFailures + 1, 6);
    const ms = Math.min(30 * 60_000, 60_000 * 2 ** (sendFailures - 1));
    sendBlockedUntil = Math.max(sendBlockedUntil, Date.now() + ms);
    return ms;
  }
  function noteSendSuccess() {
    sendFailures = 0;
    sendBlockedUntil = 0;
  }

  async function call(endpoint, method, payload) {
    const isRead = endpoint === 'messages' || endpoint === 'sessions';
    if (isRead ? !readActive : !sendActive) {
      const code = !readActive && !sendActive
        ? 'SOCIAL_TRANSPORT_DISABLED'
        : isRead ? 'SOCIAL_READ_DISABLED' : 'SOCIAL_SEND_DISABLED';
      throw new SocialTransportError(isRead ? '真实私信读取未启用' : '真实私信发送未启用', {
        code, definitive: true,
      });
    }
    try {
      const result = await request({
        endpoint, method, url: DM_ENDPOINTS[endpoint], payload,
        timeoutMs: Math.max(1000, Number(timeoutMs) || 15_000),
      });
      if (!result || typeof result !== 'object') {
        throw new SocialTransportError('私信接口返回无法解析', { code: 'DM_RESPONSE_INVALID' });
      }
      const status = Number(result.status);
      if (status === 429 || status === 412) {
        throw new SocialTransportError('私信接口限流或风控，结果未知', { code: 'DM_RATE_LIMITED' });
      }
      if (status >= 500) {
        throw new SocialTransportError('私信接口服务端错误', { code: 'DM_HTTP_5XX' });
      }
      if (status >= 400 && status < 500) {
        // HTTP 4xx 只说明请求被拒绝，不能证明消息一定没有送达（尤其是代理/网关
        // 超时、重试、鉴权边界）。默认保持 unknown，绝不自动重发。
        // 只有注入的 request 明确给出 definitive + delivered:false 证据才转 failed。
        const proven = result.definitive === true && result.delivered === false;
        throw new SocialTransportError('私信接口拒绝请求，送达结果未知', {
          code: 'DM_HTTP_4XX', definitive: proven,
        });
      }
      return result;
    } catch (error) {
      if (error instanceof SocialTransportError) throw error;
      // 网络错误、超时、中止：结果未知，不当作平台拒绝。
      throw new SocialTransportError('私信请求未能确认结果', {
        code: error?.code || 'DM_NETWORK_ERROR', definitive: false,
      });
    }
  }

  function assertCode(result) {
    if (!result || result.code == null) {
      throw new SocialTransportError('私信接口响应缺少状态码，无法确认', {
        code: 'DM_RESPONSE_UNCONFIRMED', definitive: false,
      });
    }
    const code = Number(result.code);
    if (code === 0) return result;
    if (isUnknownRateCode(code)) {
      throw new SocialTransportError('私信接口限流或风控，结果未知', {
        code: 'DM_RATE_LIMITED', definitive: false,
      });
    }
    // 业务错误码本身不足以证明“消息未送达”。只有 request 适配层能够给出
    // definitive + delivered:false 的证据时，才允许标记为确定失败。
    const proven = result.definitive === true && result.delivered === false;
    throw new SocialTransportError(proven ? '私信接口明确拒绝且确认未送达' : '私信接口返回错误，送达结果未知', {
      code: `DM_PLATFORM_${code}`, definitive: proven,
    });
  }

  return {
    kind: 'real',
    real: true,
    enabled: readActive || sendActive,
    readEnabled: readActive,
    sendEnabled: sendActive,
    get stats() { return request.stats ?? null; },
    sendBlockedUntil() { return sendBlockedUntil; },
    async sendOwnerMessage({ receiverMid, selfMid = null, text } = {}) {
      if (Date.now() < sendBlockedUntil) {
        throw new SocialTransportError('私信发送处于平台退避期，未发起请求', {
          code: 'DM_SEND_BACKOFF', definitive: false,
        });
      }
      const receiver = normalizeMid(receiverMid);
      if (!receiver) {
        throw new SocialTransportError('私信接收人 UID 非法', {
          code: 'SOCIAL_BINDING_REQUIRED', definitive: true,
        });
      }
      const payload = {
        'msg[sender_uid]': normalizeMid(selfMid) || '',
        'msg[receiver_id]': receiver,
        'msg[receiver_type]': 1,
        'msg[msg_type]': 1,
        'msg[msg_status]': 0,
        'msg[timestamp]': Math.floor(Date.now() / 1000),
        'msg[dev_id]': 'DSH-DSHAI',
        'msg[content]': JSON.stringify({ content: String(text ?? '') }),
      };
      if (csrf) payload.csrf = String(csrf);
      try {
        const result = assertCode(await call('send', 'POST', payload));
        const key = result?.data?.msg_key ?? result?.data?.msgKey ?? null;
        if (!key) {
          // 平台返回成功但没有消息键：无法确认，保持 unknown。
          throw new SocialTransportError('私信已提交但缺少消息键，无法确认', {
            code: 'DM_SEND_UNCONFIRMED', definitive: false,
          });
        }
        noteSendSuccess();
        return { ok: true, key: String(key) };
      } catch (error) {
        const code = String(error?.code || '');
        if (['DM_RATE_LIMITED', 'DM_HTTP_5XX', 'DM_NETWORK_ERROR', 'DM_TIMEOUT', 'ETIMEDOUT'].includes(code)) {
          noteSendFailure();
        }
        throw error;
      }
    },
    async fetchOwnerMessages({ talkerMid, cursor = null, size = 20 } = {}) {
      const talker = normalizeMid(talkerMid);
      if (!talker) {
        throw new SocialTransportError('用户 UID 非法，拒绝读取会话', {
          code: 'SOCIAL_BINDING_REQUIRED', definitive: true,
        });
      }
      const payload = {
        talker_id: talker,
        session_type: 1,
        size: Math.max(1, Math.min(30, Number(size) || 20)),
      };
      if (cursor != null && cursor !== '') payload.begin_seqno = String(cursor);
      const result = assertCode(await call('messages', 'GET', payload));
      const rows = result?.data?.messages ?? result?.data?.e_messages ?? [];
      const messages = (Array.isArray(rows) ? rows : [])
        .filter(row => Number(row?.msg_type ?? row?.msgType ?? 0) !== 5) // 5 = 撤回，不返回正文
        .map(row => ({
          key: String(row?.msg_key ?? row?.msgKey ?? row?.key ?? '').slice(0, 80),
          from: normalizeMid(row?.sender_uid ?? row?.senderUid ?? row?.from) || '',
          at: Number(row?.timestamp ?? row?.at ?? 0) || 0,
          text: String(row?.content?.content ?? row?.content ?? row?.text ?? '').slice(0, 2000),
        }))
        .filter(row => row.from);
      return {
        messages,
        cursor: result?.data?.next_cursor ?? result?.data?.next_seqno ?? null,
      };
    },
  };
}
