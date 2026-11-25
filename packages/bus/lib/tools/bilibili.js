// B 站只读浏览工具：只通过 bilibili 插件读取热门列表。
// bus 不自行发请求、不匿名兜底；未登录/未授权时直接透传 bilibili 的拒绝。

function compact(text, limit) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

export function mapPopularItem(item) {
  const duration = Number(item?.duration) || null;
  const view = Number(item?.stat?.view) || null;
  const bvid = item?.bvid ?? null;
  const title = compact(item?.title, 120);
  return {
    bvid,
    // 标题带 bvid：这样观察记忆里能看到 id，下一轮可以直接读这个视频。
    title: bvid ? `[${bvid}] ${title}` : title,
    excerpt: compact(item?.desc, 160),
    tags: [compact(item?.tname, 20)].filter(Boolean),
    owner: compact(item?.owner?.name, 40),
    duration,
    view
  };
}

function fromServiceVideos(videos, max) {
  return (Array.isArray(videos) ? videos : []).slice(0, max).map(video => {
    const bvid = video?.bvid ?? null;
    const title = compact(video?.title, 120);
    return {
      bvid,
      title: bvid ? `[${bvid}] ${title}` : title,
      excerpt: compact(video?.description ?? video?.desc, 160),
      tags: [compact(video?.tname, 20)].filter(Boolean),
      owner: compact(video?.owner, 40),
      duration: Number(video?.duration) || null,
      view: Number(video?.view) || null
    };
  });
}

export function createBilibiliBrowseTool({ getService = null } = {}) {
  return {
    readOnly: true,
    cost: 'free',
    description: '只读公开热门视频（经 bilibili 插件；未登录或无授权时拒绝，不匿名兜底）',
    args: { max: [1, 5] },
    async invoke(args = {}) {
      const max = Math.min(5, Math.max(1, Number(args?.max) || 1));
      const service = typeof getService === 'function' ? getService() : null;
      if (!service || typeof service.observePopular !== 'function') {
        return {
          ok: false,
          error: {
            code: 'bilibili-unavailable',
            message: 'bilibili 插件未加载或未提供 observePopular；bus 不绕过授权'
          }
        };
      }

      try {
        const observed = await service.observePopular({
          count: max,
          method: 'scheduled',
          handOff: false,
          actor: { kind: 'tool' }
        });
        const videos = Array.isArray(observed?.videos)
          ? observed.videos
          : (Array.isArray(observed?.result?.videos) ? observed.result.videos : []);
        const items = fromServiceVideos(videos, max);
        if (items.length === 0) {
          return { ok: false, error: { code: 'empty-list', message: 'bilibili 返回的热门列表为空' } };
        }
        return { ok: true, tool: 'bilibili.browse', via: 'bilibili-service', items };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: String(error?.code ?? 'bilibili-refused'),
            message: compact(error?.message ?? 'bilibili 拒绝本次浏览', 160)
          }
        };
      }
    }
  };
}
