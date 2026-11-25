// 技术保护：只防“同一动作被重复执行/异常循环”，不做人格行为配额。
// 不设置正常联系间隔、每日次数、免打扰或连续未回复暂停。
import { createHash } from 'node:crypto';

// 完全相同的动作在短窗口内重复出现，视为异常循环；不是“多久才能再说话”。
export const DUPLICATE_WINDOW_MS = 120_000;
export const RECENT_ACTIONS_MAX = 64;

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function normalizedText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function actionSignature(intent) {
  if (!intent || typeof intent !== 'object') return '';
  const type = String(intent.type ?? '');
  let body = '';
  if (type === 'send') {
    // replyTo 区分“回答不同消息”；主动开口没有 replyTo，完全相同的文本才算重复。
    body = stableStringify({
      target: intent.to ?? intent.replyTo ?? 'owner',
      replyTo: intent.replyTo ?? null,
      text: normalizedText(intent.text)
    });
  } else if (type === 'wake') {
    body = stableStringify({ wakeAt: Math.floor(Number(intent.wakeAt) / 60_000) });
  } else if (type === 'invoke') {
    body = stableStringify({ tool: intent.tool, args: intent.args ?? null });
  } else {
    body = stableStringify(intent);
  }
  return createHash('sha1').update(`${type}\n${body}`).digest('hex');
}

export function recentDuplicate(records, signature, now, windowMs = DUPLICATE_WINDOW_MS) {
  if (!Array.isArray(records) || !signature) return null;
  return (
    records.find(
      item =>
        item &&
        item.signature === signature &&
        Number.isFinite(Number(item.at)) &&
        now - Number(item.at) >= 0 &&
        now - Number(item.at) < windowMs
    ) ?? null
  );
}

export function rememberAction(records, signature, at) {
  const list = Array.isArray(records) ? records : [];
  if (!signature) return list;
  return [...list.filter(item => item?.signature !== signature), { signature, at }]
    .slice(-RECENT_ACTIONS_MAX);
}
