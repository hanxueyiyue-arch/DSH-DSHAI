// 延迟社交反馈：用户后续明确评价才改变兴趣/动机；普通回复不算。
// 证据身份：用户消息 id 为主；没有消息 id 时才退回文本哈希作辅助键。

import { createHash } from 'node:crypto';

const POSITIVE = ['挺好', '很好', '不错', '喜欢', '谢谢', '太棒', '厉害', '有用', '说得对', '说得好', '开心', '靠谱'];
const NEGATIVE = ['不好', '不对', '不喜欢', '讨厌', '别再', '烦', '没用', '无聊', '错了', '失望', '冒犯', '不合适', '不妥', '过分'];
const REFERENCE = /你(?:刚才|刚刚|上一条|上次|之前|那条)|你的(?:回复|消息)|刚才那句|上一条/;

export function classifyDelayedFeedback(text) {
  const value = String(text ?? '').trim();
  if (!value || !REFERENCE.test(value)) return null;
  const negative = NEGATIVE.filter(cue => value.includes(cue)).length;
  const positive = POSITIVE.filter(cue => value.includes(cue)).length;
  if (negative === 0 && positive === 0) return null;
  // 明确否定优先：出现“不喜欢/不好/冒犯”等，即使同时含正面词也按负面处理。
  if (negative > 0) return { type: 'explicit-negative', positive, negative };
  return { type: 'explicit-positive', positive, negative };
}

export function textHash(text) {
  const normalized = String(text ?? '').replace(/\s+/g, '').trim();
  return createHash('sha1').update(normalized).digest('hex').slice(0, 16);
}

/**
 * 主要证据身份用用户消息 id：不同消息即使文字相同，也是两次真实交流。
 * 只有调用方拿不到消息 id 时，才退回 actionId+文本哈希。
 */
export function feedbackKey(actionId, messageId, text) {
  const id = String(messageId ?? '').trim();
  if (id && id !== 'undefined' && id !== 'null') return `${actionId}:msg:${id}`;
  return `${actionId}:text:${textHash(text)}`;
}
