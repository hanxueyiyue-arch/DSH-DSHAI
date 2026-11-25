/**
 * 阶段 1a：统一平台执行边界。
 *
 * 所有外部平台操作（工具、service、私信 transport 的业务入口）最终都应经过
 * `execute(capabilityId, ...)`。这里不实现 B 站协议，只负责：
 *   1. 找到能力；
 *   2. 交给 Policy 判断；
 *   3. 只有允许时才调用具体 handler。
 *
 * 注意：caller 只用于审计和“谁可以触发自主/用户请求”，不是入口权限表。
 */

import { getCapability, listCapabilities } from './capabilities.js';

export class OperationsError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'OperationsError';
    this.code = code;
    this.details = details;
  }
}

export function createOperations({ policy, intents = null } = {}) {
  if (!policy) throw new Error('createOperations 需要 policy');

  async function execute(capabilityId, input, caller, handler, context = {}) {
    const capability = getCapability(capabilityId);
    if (!capability) {
      throw new OperationsError('UNCLASSIFIED_CAPABILITY', `未登记的 B 站能力：${capabilityId}`, {
        capabilityId,
      });
    }
    let effectiveCaller = caller;
    let intentPayload = null;
    // 私有读取与写入都必须有受控凭证；公开读取不需要。
    const requiresIntent = capability.sideEffect === true || capability.category === 'read.private';
    if (requiresIntent) {
      if (!intents) {
        throw new OperationsError('INTENT_AUTHORITY_MISSING', '受控操作缺少意图签发器', {
          capabilityId: capability.id,
        });
      }
      if (typeof context.intent !== 'string' || !context.intent) {
        throw new OperationsError('INTENT_REQUIRED', '受控操作必须携带意图凭证', {
          capabilityId: capability.id,
        });
      }
      if (!input?.intentId) {
        throw new OperationsError('INTENT_ID_REQUIRED', '受控操作必须提供 intentId', {
          capabilityId: capability.id,
        });
      }
      if (capability.targetScope && context.targetMid == null) {
        throw new OperationsError('INTENT_TARGET_REQUIRED', '目标型操作必须提供目标账号', {
          capabilityId: capability.id,
        });
      }
      if ((capability.id === 'dm.send' || capability.id === 'dm.read') && !context.sessionId) {
        throw new OperationsError('INTENT_SESSION_REQUIRED', '私信操作必须绑定当前登录会话', {
          capabilityId: capability.id,
        });
      }
      try {
        intentPayload = intents.verify(context.intent, {
          capabilityId: capability.id,
          targetMid: context.targetMid,
          intentId: input?.intentId ?? null,
          sessionId: context.sessionId ?? null,
          epoch: context.epoch ?? null,
          text: capability.id === 'dm.send' ? input?.text ?? null : null,
        });
      } catch (error) {
        throw new OperationsError(error?.code || 'INTENT_INVALID', error?.message || '意图凭证无效', {
          capabilityId: capability.id,
        });
      }
      // 一次性凭证在 verify 时即消费：Policy 拒绝或后续网络失败都不会让同一 token 重放。
      // 若 handler 尚未执行，可用同一 intentId 重新签发；若 handler 已落 intent，
      // social.sendWithGrant 的 intentId 幂等会阻止二次发送，unknown 结果不得重发。
      effectiveCaller = {
        kind: intentPayload.origin,
        trusted: true,
        jti: intentPayload.jti,
        intentId: intentPayload.intentId,
        sourceRefs: intentPayload.sourceRefs,
      };
    }
    const { intent: _intent, ...policyContext } = context;
    const verdict = await policy.evaluate(capability, {
      ...policyContext,
      caller: effectiveCaller,
      intentPayload,
    });
    if (!verdict.ok) {
      throw new OperationsError(verdict.code, verdict.reason, {
        ...verdict,
        capabilityId: capability.id,
      });
    }
    if (typeof handler !== 'function') {
      throw new OperationsError('OPERATION_HANDLER_MISSING', `${capabilityId} 缺少执行实现`, {
        capabilityId,
      });
    }
    try {
      return await handler(input);
    } catch (error) {
      // 业务错误原样抛出；这里不把网络失败伪装成权限拒绝。
      throw error;
    }
  }

  async function list() {
    const policyStatus = await policy.status();
    return {
      policy: policyStatus,
      intentAuthority: Boolean(intents),
      items: listCapabilities(),
    };
  }

  async function status() {
    return policy.status();
  }

  function revokeIntents() {
    return typeof intents?.revokeAll === 'function' ? intents.revokeAll() : null;
  }

  return {
    execute,
    list,
    status,
    revokeIntents,
    policy,
  };
}
