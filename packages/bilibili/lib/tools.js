export const stringOutput = {
  schema: { type: 'string' },
  render(_args, value) { return [{ type: 'text', text: String(value) }]; },
};

import { wrapToolErrors } from './tool-errors.js';

const present = value => JSON.stringify(value, null, 2);

/** 四个工具的名称、描述、参数与返回形态逐字对齐 v0.3.0 冻结契约。 */
export function bilibiliTools(service) {
  return [
    {
      name: 'dshai_swim',
      description: '手动带助手看 B 站热门列表（最多 5 个公开视频元数据），并保存一次观察。不得声称已看完视频。',
      parameters: { count: { type: 'integer', description: '看 1 到 5 个，默认 3' } },
      async execute({ count } = {}, exec) {
        return present(await service.swim({ count: count || 3, signal: exec?.signal }));
      },
    },
    {
      name: 'dshai_read_video',
      description: '读取视频的公开元信息（标题/简介/UP 主/统计）和最多 5 条公开评论。这只拿到"这个视频是什么"，拿不到视频讲了什么；要了解视频内容本身，必须接着调用 dshai_subtitles（同一个 bvid，支持 from/to 按秒分段续读、maxChars 控制字数）。',
      parameters: { bvid: { type: 'string', required: true, description: '例如 BV1... 格式的 12 位视频编号' } },
      async execute({ bvid } = {}, exec) {
        return present(await service.readVideo({ bvid, signal: exec?.signal }));
      },
    },
    {
      name: 'dshai_draft_comment',
      description: '起草 B 站评论或动态，仅存本地，不具备发送功能。',
      parameters: {
        kind: { type: 'string', required: true, description: 'comment 或 dynamic' },
        targetBvid: { type: 'string', description: '评论目标 BV 号；动态可留空' },
        text: { type: 'string', required: true },
        isTest: { type: 'boolean', description: '仅显式 true 会作为可清理的测试草稿' },
      },
      async execute(args = {}) {
        return present(await service.draftComment(args));
      },
    },
    {
      name: 'dshai_list_drafts',
      description: '查看最后 10 条本地评论/动态草稿，绝不发送。',
      parameters: {},
      async execute() {
        return present(await service.listDrafts());
      },
    },
    {
      name: 'dshai_discover',
      description: '按关键词搜索 B 站视频，返回少量候选和规则挡下的原因；只读，不下载、不播放。',
      parameters: {
        keyword: { type: 'string', required: true, description: '搜索关键词，最多 80 字' },
        limit: { type: 'integer', description: '返回条数 1-10，默认 5' },
        order: { type: 'string', description: '排序：totalrank（默认）/ click / pubdate' },
      },
      async execute({ keyword, limit, order } = {}, exec) {
        return present(await service.discover({ keyword, limit, order, signal: exec?.signal }));
      },
    },
    {
      name: 'dshai_subtitles',
      description: '读取视频的官方字幕，可按时间区间和字数上限截断；没有字幕时明确返回缺失，不编造。',
      parameters: {
        bvid: { type: 'string', required: true, description: '例如 BV1... 格式的 12 位视频编号' },
        cid: { type: 'integer', description: '分 P 的 cid；省略时取视频首页' },
        from: { type: 'number', description: '起始秒，默认 0' },
        to: { type: 'number', description: '结束秒；省略表示到结尾' },
        maxChars: { type: 'integer', description: '正文字数上限 500-12000，默认 4000；full=true 时忽略' },
        full: { type: 'boolean', description: 'true 返回全部字幕正文，可能很长；默认 false' },
      },
      async execute({ bvid, cid, from, to, maxChars, full } = {}, exec) {
        return present(await service.readSubtitles({ bvid, cid, from, to, maxChars, full, signal: exec?.signal }));
      },
    },
    {
      name: 'dshai_audience',
      description: '读取视频弹幕统计与样本、以及评论样本（评论正文完整，不截断）；不返回弹幕全量原文。',
      parameters: {
        bvid: { type: 'string', required: true, description: '例如 BV1... 格式的 12 位视频编号' },
        cid: { type: 'integer', description: '分 P 的 cid；省略时取视频首页' },
        aid: { type: 'integer', description: 'av 号；省略时取视频首页' },
        danmakuLimit: { type: 'integer', description: '最多解析弹幕条数 1-50000，默认 2000' },
        commentLimit: { type: 'integer', description: '评论样本 1-20，默认 8' },
      },
      async execute({ bvid, cid, aid, danmakuLimit, commentLimit } = {}, exec) {
        return present(await service.readAudience({ bvid, cid, aid, danmakuLimit, commentLimit, signal: exec?.signal }));
      },
    },
  ].map(tool => wrapToolErrors(tool));
}
