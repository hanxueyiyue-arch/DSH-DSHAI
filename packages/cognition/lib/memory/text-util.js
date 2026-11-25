// 文本小工具：活代码唯一需要从旧数据层借用的两个纯函数。
// 单独成文件是为了让活的认知链路不再 import S3 的 brainmem 数据层（memory/storage.js）。

/** 截断到指定长度，去掉首尾空白。 */
export const clipped = (value, max = 500) => String(value ?? '').trim().slice(0, max);

/** UTC 日期键，形如 2026-11-21。 */
export const dateKey = () => new Date().toISOString().slice(0, 10);

/**
 * 记忆的"多旧"：事件发生时间优先（occurredAt），缺省回落落库时间（createdAt）。
 *
 * 只给 YYYY-MM-DD，不给时分：模型要判的是"多旧"，秒级精度没有信息量，每行却要多耗 8 个字符的注入预算。
 * 一律按 UTC 切片，避免同一份库在两台机器上渲染出不同文本（测试也才能钉死）。
 * 没有可用时间就返回空串，调用方据此不渲染占位符。
 */
export function memoryDate(row) {
  const occurred = Number(row?.occurredAt);
  const created = Date.parse(row?.createdAt ?? '');
  const at = Number.isFinite(occurred) && occurred > 0 ? occurred : created;
  return Number.isFinite(at) ? new Date(at).toISOString().slice(0, 10) : '';
}

// 同标签连续重复：'理解：理解：X' / '更正：更正：X'。用反向引用，标签本身不必转义。
const DUP_LABEL = /^([^：:\s]{1,8})[：:]\s*\1[：:]\s*/;

/**
 * 收掉重复的标题前缀。
 *
 * 由来：写入侧会给标题加分类前缀（`理解：` 在 reflection、`更正：` 在 encode），
 * 而模型产出的 title 本身已经模仿了这套前缀，于是出现 '理解：理解：X'（线上 43 条）。
 * 只折叠"同一个标签连着出现"，'更正：理解：X' 这种不同标签的组合不动——那是有信息量的。
 */
export function collapseLabelPrefix(raw) {
  let text = String(raw ?? '').trim();
  for (let guard = 0; guard < 4 && DUP_LABEL.test(text); guard += 1) {
    text = text.replace(DUP_LABEL, '$1：');
  }
  return text;
}
