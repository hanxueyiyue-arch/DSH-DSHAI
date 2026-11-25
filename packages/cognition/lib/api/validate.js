// 事件与身份的入口校验。只做形状检查，不做语义/权限判断。

import { ACTOR_KINDS, EVENT_TYPES } from '../state/schema.js';

export const EVENT_ID_MAX = 128;

export function normalizeTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'event-not-object' };
  }
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (id === '' || id.length > EVENT_ID_MAX) return { ok: false, error: 'event-id-invalid' };
  if (!EVENT_TYPES.includes(raw.type)) return { ok: false, error: 'unknown-event-type' };

  const at = normalizeTimestamp(raw.at);
  if (at === null) return { ok: false, error: 'event-at-invalid' };

  if (raw.actor !== undefined) {
    if (!raw.actor || typeof raw.actor !== 'object' || Array.isArray(raw.actor)) {
      return { ok: false, error: 'event-actor-invalid' };
    }
    if (!ACTOR_KINDS.includes(raw.actor.kind)) return { ok: false, error: 'event-actor-kind-invalid' };
    if (raw.actor.authenticated !== undefined && typeof raw.actor.authenticated !== 'boolean') {
      return { ok: false, error: 'event-actor-auth-invalid' };
    }
  }

  if (raw.payload !== undefined && (typeof raw.payload !== 'object' || raw.payload === null || Array.isArray(raw.payload))) {
    return { ok: false, error: 'event-payload-invalid' };
  }

  return {
    ok: true,
    event: {
      ...raw,
      id,
      at
    }
  };
}

const GENDERS = ['', '男', '女', '其他'];

export function normalizeIdentity(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'identity-not-object' };
  }
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (name === '' || name.length > 40) return { ok: false, error: 'identity-name-invalid' };
  const gender = raw.gender === undefined ? '' : String(raw.gender).trim();
  if (!GENDERS.includes(gender)) return { ok: false, error: 'identity-gender-invalid' };
  const profileText = raw.profileText === undefined ? '' : String(raw.profileText).trim();
  if (profileText.length > 500) return { ok: false, error: 'identity-profile-too-long' };
  return { ok: true, identity: { name, gender, profileText } };
}
