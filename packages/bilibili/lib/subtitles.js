export const SUBTITLE_LIMITS = Object.freeze({ items: 5000, text: 500 });
export const SUBTITLE_PREFER = Object.freeze(['zh-CN', 'zh-Hans', 'zh', 'ai-zh']);

const clip = value => String(value ?? '').trim().slice(0, SUBTITLE_LIMITS.text);

/** 从 player/v2 的 subtitle.subtitles 里选一条可下载的官方字幕。 */
export function pickSubtitleTrack(tracks, { preferLangs = SUBTITLE_PREFER } = {}) {
  const rows = (Array.isArray(tracks) ? tracks : [])
    .map(track => ({
      lan: clip(track?.lan),
      lanDoc: clip(track?.lan_doc),
      url: clip(track?.subtitle_url),
      aiStatus: Number(track?.ai_status ?? 0),
    }))
    .filter(track => track.url);
  if (!rows.length) return null;
  for (const lang of preferLangs) {
    const hit = rows.find(track => track.lan === lang || track.lan.startsWith(`${lang}-`));
    if (hit) return hit;
  }
  return rows[0];
}

/** 归一 subtitleBody：{ body: [{ from, to, content }] }。不做翻译、不编造。 */
export function normalizeSubtitleBody(body, { lang = null, maxItems = SUBTITLE_LIMITS.items } = {}) {
  const raw = Array.isArray(body) ? body : (Array.isArray(body?.body) ? body.body : []);
  const items = raw.map(row => ({
    from: Number(row?.from),
    to: Number(row?.to),
    text: clip(row?.content ?? row?.text),
  })).filter(row => Number.isFinite(row.from) && Number.isFinite(row.to) && row.text);
  items.sort((a, b) => a.from - b.from);
  const size = Math.max(1, Math.min(SUBTITLE_LIMITS.items, Number(maxItems) || SUBTITLE_LIMITS.items));
  const truncated = items.length > size;
  const kept = truncated ? items.slice(0, size) : items;
  return {
    available: kept.length > 0,
    lang: lang ?? null,
    source: 'official',
    items: kept,
    truncated,
    reason: kept.length ? null : 'SUBTITLE_EMPTY',
  };
}
