/**
 * Bilibili-side Ed25519 verifier with a one-time, best-effort provider binding.
 *
 * The public key is read from the `bilibili-intent-public-key` service provided
 * by Autonomy. Cordis 4.1.0 does not expose a public provider-identity API, so
 * this module inspects `ctx.reflect.store` and checks the providing fiber name.
 * That is an internal, non-stable Cordis boundary. A plugin that registers the
 * same service name first can cause a denial of service; it cannot make us
 * accept its key when the provider name does not match.
 */

import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';

export const INTENT_VERSION = 'v2';
export const PUBLIC_KEY_SERVICE = 'bilibili-intent-public-key';

export class IntentVerifierError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'IntentVerifierError';
    this.code = code;
  }
}

const b64url = value => Buffer.from(value).toString('base64url');
const normalizeMid = value => {
  if (value == null) return null;
  const text = String(value).trim();
  return /^\d{1,20}$/.test(text) ? text : null;
};

export function canonicalIntent(payload) {
  return Buffer.from([
    INTENT_VERSION,
    payload.jti,
    payload.decisionId,
    payload.intentId,
    payload.capabilityId,
    payload.targetMid ?? '',
    payload.contentHash,
    String(payload.iat),
    String(payload.exp),
    payload.origin,
    payload.op,
    payload.sessionId ?? '',
    String(payload.epoch ?? ''),
  ].join('\n'), 'utf8');
}

export function contentHashOf(text) {
  // Keep byte-for-byte parity with Autonomy's issuer.
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('base64url');
}

function providerName(impl) {
  try {
    return impl?.ctx?.fiber?.name ?? null;
  } catch {
    return null;
  }
}

export function createIntentVerifier({
  ctx = null,
  expectedProvider = 'dsh-dshai-autonomy',
  now = () => Date.now(),
} = {}) {
  const expected = Array.isArray(expectedProvider) ? expectedProvider : [expectedProvider];
  let bound = null;
  let revokedThrough = 0;
  const used = new Map();

  function* provisions() {
    const seen = new Set();
    const registry = ctx?.registry ?? ctx?.root?.registry;
    if (registry && typeof registry.values === 'function') {
      for (const runtime of registry.values()) {
        for (const fiber of runtime?.fibers ?? []) {
          for (const impl of fiber?.provisions ?? []) {
            if (!impl || seen.has(impl)) continue;
            seen.add(impl);
            yield impl;
          }
        }
      }
    }
    for (const source of [ctx?.root?.fiber?.provisions, ctx?.fiber?.provisions]) {
      if (!source || typeof source[Symbol.iterator] !== 'function') continue;
      for (const impl of source) {
        if (!impl || seen.has(impl)) continue;
        seen.add(impl);
        yield impl;
      }
    }
    for (const store of [ctx?.root?.reflect?.store, ctx?.reflect?.store]) {
      if (!store || typeof store !== 'object') continue;
      for (const impl of Object.values(store)) {
        if (!impl || seen.has(impl)) continue;
        seen.add(impl);
        yield impl;
      }
    }
  }

  function findProvision(name) {
    for (const impl of provisions()) {
      if (impl?.name === name && impl?.value != null) return impl;
    }
    return null;
  }

  function bind() {
    const impl = findProvision(PUBLIC_KEY_SERVICE);
    if (!impl) {
      const names = [...provisions()].map(item => item?.name).filter(Boolean);
      throw new IntentVerifierError('INTENT_TRUST_UNAVAILABLE', `未找到 Autonomy 意图公钥服务（可见：${names.join(',') || '无'}）`);
    }
    const name = providerName(impl);
    if (!name || !expected.includes(name)) {
      throw new IntentVerifierError(
        'INTENT_TRUST_PROVIDER',
        `意图公钥提供者不可信：${name ?? 'unknown'}（期望 ${expected.join(', ')}）`,
      );
    }
    const info = impl.value;
    if (info?.algorithm !== 'ed25519' || typeof info.publicKey !== 'string' || !info.publicKey) {
      throw new IntentVerifierError('INTENT_TRUST_INVALID', '意图公钥格式无效');
    }
    if (bound) {
      if (bound.impl !== impl || bound.publicKey !== info.publicKey) {
        throw new IntentVerifierError('INTENT_TRUST_CHANGED', '意图公钥在绑定后被替换');
      }
      return bound;
    }
    let key;
    try {
      key = createPublicKey({
        key: Buffer.from(info.publicKey, 'base64url'),
        format: 'der',
        type: 'spki',
      });
    } catch {
      throw new IntentVerifierError('INTENT_TRUST_INVALID', '意图公钥无法解析');
    }
    bound = { impl, publicKey: info.publicKey, key };
    return bound;
  }

  function purge() {
    const at = Number(now());
    for (const [jti, exp] of used) {
      if (!Number.isFinite(exp) || exp <= at) used.delete(jti);
    }
  }

  function verify(token, {
    capabilityId = null,
    targetMid = null,
    intentId = null,
    sessionId = null,
    epoch = null,
    text = null,
    consume = true,
  } = {}) {
    const trust = bind();
    if (typeof token !== 'string' || !token.startsWith(`${INTENT_VERSION}.`)) {
      throw new IntentVerifierError('INTENT_INVALID', '意图凭证格式无效');
    }
    const parts = token.split('.');
    if (parts.length !== 3) throw new IntentVerifierError('INTENT_INVALID', '意图凭证格式无效');
    const [, body, signature] = parts;
    let payload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      throw new IntentVerifierError('INTENT_INVALID', '意图凭证内容无效');
    }
    if (payload?.v !== INTENT_VERSION || payload.origin !== 'autonomy') {
      throw new IntentVerifierError('INTENT_INVALID', '意图凭证来源无效');
    }
    let sig;
    try {
      sig = Buffer.from(signature, 'base64url');
    } catch {
      throw new IntentVerifierError('INTENT_SIGNATURE_INVALID', '意图凭证签名格式无效');
    }
    if (!cryptoVerify(null, canonicalIntent(payload), trust.key, sig)) {
      throw new IntentVerifierError('INTENT_SIGNATURE_INVALID', '意图凭证签名无效');
    }
    const at = Number(now());
    if (Number(payload.exp) <= at) throw new IntentVerifierError('INTENT_EXPIRED', '意图凭证已过期');
    if (Number(payload.iat) <= revokedThrough) {
      throw new IntentVerifierError('INTENT_REVOKED', '意图凭证已因登出或撤销失效');
    }
    const expectedOp = capabilityId === 'dm.read' ? 'dm.read' : 'dm.send';
    if (payload.op !== expectedOp) throw new IntentVerifierError('INTENT_OP_MISMATCH', '意图凭证操作不匹配');
    if (capabilityId && payload.capabilityId !== capabilityId) {
      throw new IntentVerifierError('INTENT_CAPABILITY_MISMATCH', '意图凭证与能力不匹配');
    }
    if (intentId && payload.intentId !== String(intentId)) {
      throw new IntentVerifierError('INTENT_ID_MISMATCH', '意图凭证与发送意图不匹配');
    }
    const wantedTarget = normalizeMid(targetMid);
    if (wantedTarget && payload.targetMid !== wantedTarget) {
      throw new IntentVerifierError('INTENT_TARGET_MISMATCH', '意图凭证目标不匹配');
    }
    if (sessionId && payload.sessionId !== String(sessionId)) {
      throw new IntentVerifierError('INTENT_SESSION_MISMATCH', '意图凭证与当前登录会话不匹配');
    }
    if (epoch != null && Number(payload.epoch) !== Number(epoch)) {
      throw new IntentVerifierError('INTENT_EPOCH_MISMATCH', '意图凭证已因登出或撤销失效');
    }
    if (text != null) {
      if (typeof payload.contentHash !== 'string' || payload.contentHash !== contentHashOf(text)) {
        throw new IntentVerifierError('INTENT_CONTENT_MISMATCH', '意图凭证与消息内容不匹配');
      }
    }
    if (consume) {
      purge();
      if (used.has(payload.jti)) throw new IntentVerifierError('INTENT_REPLAYED', '意图凭证已被使用');
      used.set(payload.jti, Number(payload.exp) || 0);
    }
    return payload;
  }

  function revokeAll() {
    revokedThrough = Number(now());
    used.clear();
    return revokedThrough;
  }

  function status() {
    return {
      bound: Boolean(bound),
      provider: bound ? expected.join(',') : null,
      publicKey: bound ? bound.publicKey : null,
    };
  }

  return { verify, revokeAll, status, version: INTENT_VERSION };
}
