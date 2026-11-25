export const DANMAKU_LIMITS = Object.freeze({ text: 80, items: 100000 });

const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
const unescapeXml = text => String(text ?? '').replace(/&(amp|lt|gt|quot|#39);/g, (_, key) => ENTITY[key] ?? _);

export function normalizeDanmakuText(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(.)\1{3,}/g, '$1$1$1')
    .slice(0, DANMAKU_LIMITS.text);
}

/** 解析官方弹幕 XML：<d p="time,mode,size,color,...">text</d>。 */
export function parseDanmakuXml(xml, { maxItems = DANMAKU_LIMITS.items } = {}) {
  const input = typeof xml === 'string' ? xml : '';
  const size = Math.max(1, Math.min(DANMAKU_LIMITS.items, Number(maxItems) || DANMAKU_LIMITS.items));
  const items = [];
  let total = 0;
  const re = /<d\b[^>]*\bp="([^"]*)"[^>]*>([\s\S]*?)<\/d>/g;
  let match;
  while ((match = re.exec(input)) !== null) {
    const time = Number.parseFloat(String(match[1]).split(',')[0]);
    const text = normalizeDanmakuText(unescapeXml(match[2]));
    if (!Number.isFinite(time) || !text) continue;
    total += 1;
    if (items.length < size) items.push({ time, text });
  }
  return { items, total, truncated: total > items.length };
}

// 轻量分词：优先用平台内置的 Intl.Segmenter，不做语义理解，也不引入 NLP 依赖。
// 停用词表刻意保持很小；回退路径只切整段/双字，避免“好可”这类跨词碎片。
const STOPWORDS = new Set([
  '这个', '那个', '什么', '就是', '没有', '可以', '一个', '我们', '你们', '他们',
  '自己', '现在', '真的', '感觉', '还是', '不过', '因为', '所以', '如果', '但是',
  '已经', '知道', '看到', '哈哈', '哈哈哈', '呵呵', '啊啊', '啊啊啊',
]);
const FALLBACK_STOP_CHARS = new Set('的了是我你他她它这那在有不就都也很吗啊吧呀哦嗯哈嘛');
let segmenter = null;
try {
  segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
} catch { segmenter = null; }

function cjkTokens(text) {
  const out = [];
  if (segmenter) {
    const parts = [...segmenter.segment(text)]
      .filter(part => part.isWordLike && /[\u3400-\u9fff]/.test(part.segment))
      .map(part => part.segment);
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (part.length >= 2) out.push(part);
      // 叠词常被切成两个单字（猫/猫）；只合并相邻同字，不跨字拼“好可”。
      else if (part.length === 1 && parts[i + 1] === part) {
        out.push(part + part);
        i += 1;
      }
    }
    return out;
  }
  const run = String(text);
  if (run.length <= 4) return [run];
  for (let i = 0; i + 1 < run.length; i += 1) {
    const pair = run.slice(i, i + 2);
    if (!FALLBACK_STOP_CHARS.has(pair[0]) && !FALLBACK_STOP_CHARS.has(pair[1])) out.push(pair);
  }
  return out;
}

export function quantile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * ratio)));
  return sorted[index];
}

/** 高频词 + 时间桶密度峰值。少于 30 条不报峰值，避免小样本噪声。 */
export function danmakuStats(items, { duration = 0, bucketSec = 30, topN = 8, peaks = 3 } = {}) {
  const rows = (Array.isArray(items) ? items : []).filter(row => Number.isFinite(row?.time) && row?.text);
  const total = rows.length;
  const words = new Map();
  const add = word => {
    if (word.length < 2 || STOPWORDS.has(word)) return;
    words.set(word, (words.get(word) ?? 0) + 1);
  };
  for (const row of rows) {
    for (const token of String(row.text).toLowerCase().match(/[a-z0-9]{2,}/g) ?? []) add(token);
    for (const run of String(row.text).match(/[\u3400-\u9fff]+/g) ?? []) {
      for (const token of cjkTokens(run)) add(token);
    }
  }
  const topWords = [...words.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .slice(0, Math.max(1, Number(topN) || 8))
    .map(([word, count]) => ({ word, count }));

  const span = Number(duration) > 0 ? Number(duration) : (rows.length ? Math.max(...rows.map(row => row.time)) + bucketSec : 0);
  const buckets = [];
  if (span > 0) {
    const width = Math.max(5, Math.min(60, Number(bucketSec) || 30));
    const count = Math.max(1, Math.ceil(span / width));
    for (let i = 0; i < count; i += 1) {
      buckets.push({ start: i * width, end: Math.min(span, (i + 1) * width), count: 0 });
    }
    for (const row of rows) {
      const index = Math.min(buckets.length - 1, Math.floor(row.time / width));
      buckets[index].count += 1;
    }
  }

  const peakRows = [];
  if (total >= 30 && buckets.length) {
    const average = total / buckets.length;
    const threshold = Math.max(3, average * 1.8);
    const candidates = buckets
      .map((bucket, index) => ({ ...bucket, index }))
      .filter(bucket => bucket.count >= threshold)
      .sort((a, b) => (b.count - a.count) || (a.index - b.index));
    for (const bucket of candidates) {
      if (peakRows.length >= Math.max(1, Number(peaks) || 3)) break;
      if (peakRows.some(row => Math.abs(row.index - bucket.index) <= 1)) continue;
      peakRows.push(bucket);
    }
    peakRows.sort((a, b) => a.index - b.index);
  }

  return {
    total,
    duration: span,
    topWords,
    buckets: buckets.map(({ start, end, count }) => ({ start, end, count })),
    peaks: peakRows.map(({ start, end, count }) => ({ start, end, count })),
    sampled: false,
  };
}
