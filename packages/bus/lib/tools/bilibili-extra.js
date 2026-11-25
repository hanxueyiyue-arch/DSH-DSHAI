// B 站只读能力的总线适配器（bilibili.*）
//
// 目的：认知内核只能调用总线注册表里的工具，而 B 站的 7 个能力原来只注册在
// 宿主 agent 的 ctx.tools 上（dshai_*），她一个都用不了。这里把其中
// 只读的 4 个接进总线（bilibili.browse 已存在，它就是 swim）：
//   bilibili.video      读 BV 详情 + 评论样本
//   bilibili.discover   按关键词搜视频
//   bilibili.subtitles  读官方字幕
//   bilibili.audience   读弹幕统计 + 评论样本
//
// 说明：
//  - 起草评论/动态（draft_comment）与草稿列表（drafts）按决定暂不接入；
//  - 全部 readOnly，只读公开数据，不改登录态、不发消息；
//  - 返回结构对齐认知内核的 observation 提取：{ ok, tool, items:[{title,excerpt,tags}] }。

const CLIP = (text, limit) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
const NUM = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

function videoItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = CLIP(raw.title ?? raw.name, 120);
  if (!title) return null;
  const excerpt = CLIP(raw.desc ?? raw.description ?? raw.excerpt ?? '', 160);
  const tags = [];
  if (typeof raw.tname === 'string' && raw.tname) tags.push(CLIP(raw.tname, 20));
  if (raw.bvid) tags.push(String(raw.bvid));
  return { title, excerpt, tags };
}

function commentItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = CLIP(raw.content ?? raw.text ?? raw.message, 160);
  if (!text) return null;
  return { title: '评论', excerpt: text, tags: ['评论'] };
}

function unwrap(result) {
  // bilibili 服务可能返回 { ok, result } 包装，也可能直接返回结果
  if (result && typeof result === 'object' && !Array.isArray(result) && result.result && typeof result.result === 'object') {
    return result.result;
  }
  return result;
}

function errorOf(error) {
  return {
    code: String(error?.code ?? 'bilibili-tool-failed').slice(0, 60),
    message: CLIP(error?.message ?? error, 160)
  };
}

function normalizeVideoResult(result) {
  const src = unwrap(result) ?? {};
  const items = [];
  const video = videoItem(src.video ?? src);
  if (video) items.push(video);
  const comments = Array.isArray(src.comments) ? src.comments : (Array.isArray(src.comments?.items) ? src.comments.items : []);
  for (const raw of comments.slice(0, 3)) {
    const item = commentItem(raw);
    if (item) items.push(item);
  }
  return { items, stats: src.video?.stats ?? src.stats ?? null };
}

function normalizeDiscoverResult(result) {
  const src = unwrap(result) ?? {};
  const rows = Array.isArray(src.items) ? src.items : (Array.isArray(src.candidates) ? src.candidates : []);
  return {
    // 搜索结果要能"直接接着看"：把 bvid 放进标题，摘要压短，
    // 这样认知内核的观察记忆/最近观察里能带着 id，下一轮可以直接调 bilibili.video。
    items: rows.slice(0, 5).map(row => {
      const item = videoItem(row);
      if (!item) return null;
      const bvid = typeof row?.bvid === 'string' ? row.bvid.trim() : '';
      return {
        ...item,
        title: bvid ? `[${bvid}] ${item.title}` : item.title,
        excerpt: ''
      };
    }).filter(Boolean),
    filtered: Array.isArray(src.filtered) ? src.filtered.length : null
  };
}

const fmtClock = seconds => {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

function normalizeSubtitlesResult(result) {
  const src = unwrap(result) ?? {};
  if (src.available === false) {
    return { items: [], available: false, reason: CLIP(src.reason ?? '', 80) };
  }
  const rows = Array.isArray(src.items)
    ? src.items.map(row => ({
        text: CLIP(row?.text ?? row?.content ?? '', 200),
        from: Number(row?.from) || 0,
        to: Number(row?.to) || 0
      })).filter(row => row.text)
    : (typeof src.text === 'string' ? [{ text: CLIP(src.text, 700), from: 0, to: 0 }] : []);
  if (rows.length === 0) return { items: [], available: false, reason: 'empty' };

  // 一次只带回一段：带时间范围，并在标题里写清"下一段从哪秒开始"。
  // 800 字窗口放不下时，她会用 from=<nextFrom> 自己接着读。
  const BUDGET = 700;
  const parts = [];
  let used = 0;
  let end = rows[0].from;
  for (const row of rows) {
    if (parts.length > 0 && used + row.text.length > BUDGET) break;
    parts.push(row.text);
    used += row.text.length + 1;
    end = row.to || row.from;
  }
  const nextFrom = Math.max(0, Math.ceil(end));
  const bvid = CLIP(src.bvid ?? '', 20);
  return {
    items: [{
      title: `字幕：${bvid}（本段到 ${fmtClock(end)}，续读用 from=${nextFrom}）`,
      excerpt: `[${fmtClock(rows[0].from)}–${fmtClock(end)}] ${parts.join(' ')}`.slice(0, 760),
      tags: ['字幕']
    }],
    available: true,
    truncated: parts.length < rows.length || src.truncated === true,
    nextFrom,
    lang: CLIP(src.lang ?? '', 20)
  };
}

function normalizeAudienceResult(result) {
  const src = unwrap(result) ?? {};
  const items = [];
  // bilibili 服务返回的是 danmaku（不是 stats）：total/sampled/topWords/peaks/samples
  const danmaku = (src.danmaku && typeof src.danmaku === 'object') ? src.danmaku : null;
  if (danmaku) {
    const total = NUM(danmaku.total, null);
    const sampled = NUM(danmaku.sampled, null);
    const tops = Array.isArray(danmaku.topWords)
      ? danmaku.topWords.map(row => CLIP(row?.text ?? row?.word ?? row, 12)).filter(Boolean).slice(0, 5)
      : [];
    if (total !== null || sampled !== null || tops.length > 0) {
      items.push({
        title: '弹幕统计',
        excerpt: `${total !== null ? `共 ${total} 条` : ''}${sampled !== null ? `，采样 ${sampled}` : ''}${tops.length ? `；高频：${tops.join('、')}` : ''}`.trim(),
        tags: ['弹幕']
      });
    }
    const samples = Array.isArray(danmaku.samples) ? danmaku.samples : [];
    for (const row of samples.slice(0, 3)) {
      const text = CLIP(row?.text ?? '', 120);
      if (text) items.push({ title: '弹幕', excerpt: text, tags: ['弹幕'] });
    }
  }
  const comments = Array.isArray(src.comments) ? src.comments : (Array.isArray(src.comments?.items) ? src.comments.items : []);
  for (const raw of comments.slice(0, 3)) {
    const text = CLIP(raw?.text ?? raw?.content ?? '', 160);
    if (text) items.push({ title: '评论', excerpt: text, tags: ['评论'] });
  }
  return { items };
}

function makeTool({ name, description, args, invoke, normalize }) {
  return {
    name,
    readOnly: true,
    cost: 'free',
    description,
    args,
    async invoke(input = {}) {
      try {
        const raw = await invoke(input);
        const normalized = normalize(raw);
        return { ok: true, tool: name, ...normalized };
      } catch (error) {
        return { ok: false, error: errorOf(error) };
      }
    }
  };
}

export function createBilibiliExtraTools({ getService } = {}) {
  const service = () => {
    const found = typeof getService === 'function' ? getService() : null;
    if (!found) throw new Error('bilibili 服务不可用');
    return found;
  };
  const actor = { kind: 'tool' };

  const tools = [
    makeTool({
      name: 'bilibili.video',
      description: '读一个 B 站视频的公开标题、简介、UP 主与最多 3 条评论样本。只读，不播放、不下载。',
      args: { bvid: 'BV 号，例如 BV1... 格式的 12 位编号' },
      invoke: input => service().readVideo({ bvid: String(input?.bvid ?? '').trim(), actor }),
      normalize: normalizeVideoResult
    }),
    makeTool({
      name: 'bilibili.discover',
      description: '按关键词搜索 B 站视频，返回少量候选（标题、简介、标签）；只读，不下载、不播放。',
      args: {
        keyword: '搜索关键词，最多 80 字',
        limit: '返回条数 1-10，默认 5',
        order: '排序：totalrank（默认）/ click / pubdate'
      },
      invoke: input => service().discover({
        keyword: String(input?.keyword ?? '').trim().slice(0, 80),
        limit: NUM(input?.limit, 5),
        order: ['totalrank', 'click', 'pubdate'].includes(input?.order) ? input.order : 'totalrank',
        actor
      }),
      normalize: normalizeDiscoverResult
    }),
    makeTool({
      name: 'bilibili.subtitles',
      description: '读一个视频的官方字幕，可按时间区间截断；每次最多带回约 700 字，标题会写"本段到 mm:ss，续读用 from=秒"，照着继续读即可；没有字幕时明确返回缺失，不编造。',
      args: {
        bvid: 'BV 号',
        cid: '分 P 的 cid；省略取视频首页',
        from: '起始秒，默认 0',
        to: '结束秒；省略表示到结尾',
        maxChars: '正文字数上限 500-12000，默认 4000',
        full: 'true 时返回全部字幕正文'
      },
      invoke: input => service().readSubtitles({
        bvid: String(input?.bvid ?? '').trim(),
        ...(input?.cid !== undefined ? { cid: NUM(input.cid, 0) } : {}),
        from: NUM(input?.from, 0),
        to: input?.to === undefined || input?.to === null || input?.to === '' ? null : NUM(input.to, null),
        maxChars: NUM(input?.maxChars, 4000),
        full: input?.full === true || input?.full === 'true',
        actor
      }),
      normalize: normalizeSubtitlesResult
    }),
    makeTool({
      name: 'bilibili.audience',
      description: '读一个视频的弹幕统计与最多 3 条评论样本；不返回弹幕全量原文。',
      args: {
        bvid: 'BV 号',
        cid: '分 P 的 cid；省略取视频首页',
        aid: 'av 号；省略取视频首页',
        danmakuLimit: '最多解析弹幕条数 1-50000，默认 2000',
        commentLimit: '评论样本 1-20，默认 8'
      },
      invoke: input => service().readAudience({
        bvid: String(input?.bvid ?? '').trim(),
        ...(input?.cid !== undefined ? { cid: NUM(input.cid, 0) } : {}),
        ...(input?.aid !== undefined ? { aid: NUM(input.aid, 0) } : {}),
        danmakuLimit: NUM(input?.danmakuLimit, 2000),
        commentLimit: NUM(input?.commentLimit, 8),
        actor
      }),
      normalize: normalizeAudienceResult
    })
  ];

  return tools;
}

// 供测试直接验证映射（不经过总线）
export const __normalizers = {
  video: normalizeVideoResult,
  discover: normalizeDiscoverResult,
  subtitles: normalizeSubtitlesResult,
  audience: normalizeAudienceResult
};
