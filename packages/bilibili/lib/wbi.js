import { createHash } from 'node:crypto';

// B 站 WBI 混淆表；只做签名，不涉及账号凭证。
const MIXIN = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

const keyOf = url => String(url ?? '').split('/').at(-1).split('.')[0];

/**
 * 对同一串参数签名：参数按 key 排序，附加 wts，再拼 w_rid。
 * images 为 nav 返回的 wbi_img（img_url + sub_url）。
 */
export function signWbi(params, images, now = Date.now()) {
  const raw = keyOf(images?.img_url) + keyOf(images?.sub_url);
  if (raw.length !== 64) throw new Error('WBI 签名密钥缺失，请稍后重试');
  const key = MIXIN.map(index => raw[index]).join('').slice(0, 32);
  const values = { ...params, wts: Math.floor(Number(now) / 1000) };
  delete values.w_rid;
  const query = Object.keys(values)
    .sort()
    .map(name => `${encodeURIComponent(name)}=${encodeURIComponent(String(values[name]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  return `${query}&w_rid=${createHash('md5').update(query + key).digest('hex')}`;
}
