import { randomUUID } from 'node:crypto';
import { updateState, readState, clipped } from './storage.js';

const KINDS = Object.freeze(['comment', 'dynamic']);

/** 草稿只存本地，不具备任何发送能力（本包没有任何 POST 接口）。 */
export async function draftComment({ kind, targetBvid, text, isTest = false } = {}) {
  if (!KINDS.includes(kind)) throw Object.assign(new Error('草稿类型只能是 comment 或 dynamic'), { code: 'INVALID_DRAFT_KIND' });
  if (kind === 'comment' && !/^BV[A-Za-z0-9]{10}$/.test(String(targetBvid || ''))) throw Object.assign(new Error('评论草稿须提供合法 BV 号'), { code: 'INVALID_BVID' });
  if (!clipped(text, 500)) throw Object.assign(new Error('草稿不能为空'), { code: 'DRAFT_EMPTY' });
  const draft = {
    id: randomUUID(), at: new Date().toISOString(), kind,
    targetBvid: clipped(targetBvid, 20), text: clipped(text, 500),
    ...(isTest === true ? { isTest: true } : {}),
  };
  await updateState(state => {
    state.drafts.push(draft);
    state.drafts = state.drafts.slice(-30);
  });
  return { savedLocally: true, sentToBilibili: false, draft };
}

export async function listDrafts() {
  const state = await readState();
  return { drafts: state.drafts.slice(-10) };
}

export async function lastObservation() {
  const state = await readState();
  return state.observations.at(-1) ?? null;
}
