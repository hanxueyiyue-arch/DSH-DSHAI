/**
 * Autonomy-only Ed25519 intent issuer.
 *
 * The private key never leaves this module's closure. Bilibili only receives the
 * public key via `bilibili-intent-public-key`, verifies the signature, and
 * re-computes the message content hash before a DM send.
 *
 * This is best-effort same-process protection. It does not claim to stop
 * arbitrary malicious code that can read this module's private state.
 */

import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign as cryptoSign,
} from 'node:crypto';

export const INTENT_VERSION = 'v2';
export const INTENT_ORIGIN = 'autonomy';
export const INTENT_OP = 'dm.send';
export const PUBLIC_KEY_SERVICE = 'bilibili-intent-public-key';

export class IntentIssuerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'IntentIssuerError';
    this.code = code;
  }
}

const b64url = value => Buffer.from(value).toString('base64url');
const normalizeMid = value => {
  if (value == null) return null;
  const text = String(value).trim();
  return /^\d{1,20}$/.test(text) ? text : null;
};
const normalizeId = (value, max = 160) => {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, max) : null;
};

export function contentHashOf(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('base64url');
}

/**
 * Canonical bytes. Field order is fixed here, independent of JSON serialization.
 * The verifier must use the same function.
 */
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

export function createIntentIssuer({
  provider = 'dsh-dshai-autonomy',
  now = () => Date.now(),
  ttlMs = 5 * 60_000,
} = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicDer = publicKey.export({ type: 'spki', format: 'der' });
  const publicKeyB64 = b64url(publicDer);
  let epoch = 1;

  function issue({
    decisionId,
    intentId,
    capabilityId = 'dm.send',
    targetMid,
    text,
    sessionId = null,
    ttlMs: life = ttlMs,
  } = {}) {
    const boundDecisionId = normalizeId(decisionId, 160);
    const boundIntentId = normalizeId(intentId, 160);
    const boundTarget = normalizeMid(targetMid);
    if (!boundDecisionId) throw new IntentIssuerError('DECISION_ID_REQUIRED', '意图必须绑定 decisionId');
    if (!boundIntentId) throw new IntentIssuerError('INTENT_ID_REQUIRED', '意图必须绑定 intentId');
    if (!boundTarget) throw new IntentIssuerError('TARGET_REQUIRED', '意图必须绑定 targetMid');
    if (typeof capabilityId !== 'string' || !capabilityId) {
      throw new IntentIssuerError('CAPABILITY_REQUIRED', '意图必须绑定能力');
    }
    if (capabilityId === 'dm.send' && (typeof text !== 'string' || !text)) {
      throw new IntentIssuerError('CONTENT_REQUIRED', '私信意图必须绑定消息内容');
    }

    const issuedAt = Number(now());
    const expiresAt = issuedAt + Math.max(1_000, Math.min(30 * 60_000, Number(life) || ttlMs));
    const op = capabilityId === 'dm.read' ? 'dm.read' : 'dm.send';
    const payload = {
      v: INTENT_VERSION,
      jti: randomUUID(),
      decisionId: boundDecisionId,
      intentId: boundIntentId,
      capabilityId,
      targetMid: boundTarget,
      contentHash: contentHashOf(text),
      iat: issuedAt,
      exp: expiresAt,
      origin: INTENT_ORIGIN,
      op,
      sessionId: normalizeId(sessionId),
      epoch,
    };
    const body = b64url(JSON.stringify(payload));
    const sig = b64url(cryptoSign(null, canonicalIntent(payload), privateKey));
    return `${INTENT_VERSION}.${body}.${sig}`;
  }

  function revokeAll() {
    epoch += 1;
    return epoch;
  }

  return {
    issue,
    revokeAll,
    epoch: () => epoch,
    version: INTENT_VERSION,
    provider,
    publicInfo: Object.freeze({
      version: INTENT_VERSION,
      algorithm: 'ed25519',
      provider,
      publicKey: publicKeyB64,
    }),
  };
}
