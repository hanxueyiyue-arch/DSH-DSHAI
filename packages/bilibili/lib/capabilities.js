/**
 * 阶段 1a：B 站平台能力目录。
 *
 * 这里只登记“平台能力”，不登记聊天/私信/后台入口。入口可以不同，但同一个
 * capabilityId 只能有一套默认限制。未实现的能力必须显式标 implemented:false，
 * 不能向 Autonomy 伪装成可调用。
 */

export const CAPABILITY_CATEGORIES = Object.freeze({
  PUBLIC_READ: 'read.public',
  PRIVATE_READ: 'read.private',
  SOCIAL_WRITE: 'write.social',
  REACTION_WRITE: 'write.reaction',
  RELATION_WRITE: 'write.relationship',
  PUBLISH_WRITE: 'write.publish',
  ACCOUNT_WRITE: 'write.account',
  MESSAGE_WRITE: 'write.message',
});

const PUBLIC_READ = CAPABILITY_CATEGORIES.PUBLIC_READ;
const PRIVATE_READ = CAPABILITY_CATEGORIES.PRIVATE_READ;
const SOCIAL_WRITE = CAPABILITY_CATEGORIES.SOCIAL_WRITE;
const REACTION_WRITE = CAPABILITY_CATEGORIES.REACTION_WRITE;
const RELATION_WRITE = CAPABILITY_CATEGORIES.RELATION_WRITE;
const PUBLISH_WRITE = CAPABILITY_CATEGORIES.PUBLISH_WRITE;
const ACCOUNT_WRITE = CAPABILITY_CATEGORIES.ACCOUNT_WRITE;
const MESSAGE_WRITE = CAPABILITY_CATEGORIES.MESSAGE_WRITE;

const READ = { requiresLogin: true, sideEffect: false, implemented: true };

/**
 * @typedef {Object} Capability
 * @property {string} id
 * @property {string} label
 * @property {string} category
 * @property {'low'|'medium'|'high'|'critical'} risk
 * @property {boolean} implemented
 * @property {boolean} requiresLogin
 * @property {boolean} sideEffect
 * @property {'public'|'owner'|'self'|'any'} targetScope
 * @property {'allow'|'deny'} defaultState
 * @property {string} reason
 * @property {string|null} serviceMethod
 */

/** @type {ReadonlyArray<Capability>} */
export const CAPABILITIES = Object.freeze([
  // ---- 已实现的公开读取 ----
  Object.freeze({
    id: 'feed.popular.read', label: '热门视频', category: PUBLIC_READ, risk: 'low',
    ...READ, targetScope: 'public', defaultState: 'allow',
    reason: '读取热门/推荐视频列表与公开元数据', serviceMethod: 'observePopular',
  }),
  Object.freeze({
    id: 'video.read', label: '视频信息', category: PUBLIC_READ, risk: 'low',
    ...READ, targetScope: 'public', defaultState: 'allow',
    reason: '读取单个视频的公开信息与评论样本', serviceMethod: 'readVideo',
  }),
  Object.freeze({
    id: 'video.search', label: '视频搜索', category: PUBLIC_READ, risk: 'low',
    ...READ, targetScope: 'public', defaultState: 'allow',
    reason: '按关键词搜索公开视频', serviceMethod: 'discover',
  }),
  Object.freeze({
    id: 'video.subtitles', label: '官方字幕', category: PUBLIC_READ, risk: 'low',
    ...READ, targetScope: 'public', defaultState: 'allow',
    reason: '读取视频官方字幕', serviceMethod: 'readSubtitles',
  }),
  Object.freeze({
    id: 'video.audience', label: '弹幕与评论', category: PUBLIC_READ, risk: 'low',
    ...READ, targetScope: 'public', defaultState: 'allow',
    reason: '读取视频公开弹幕与评论', serviceMethod: 'readAudience',
  }),
  Object.freeze({
    id: 'user.videos.read', label: 'UP 主视频列表', category: PUBLIC_READ, risk: 'low',
    ...READ, targetScope: 'public', defaultState: 'allow',
    reason: '读取 UP 主公开视频列表', serviceMethod: 'listUserVideos',
  }),

  // ---- 已实现的私有读取 / 用户私信 ----
  Object.freeze({
    id: 'dm.read', label: '读取用户私信', category: PRIVATE_READ, risk: 'high',
    ...READ, targetScope: 'owner', defaultState: 'allow',
    reason: '读取与绑定用户 UID 的私信会话', serviceMethod: 'socialReceive',
  }),
  Object.freeze({
    id: 'dm.send', label: '发送用户私信', category: MESSAGE_WRITE, risk: 'high',
    implemented: true, requiresLogin: true, sideEffect: true,
    targetScope: 'owner', defaultState: 'allow',
    reason: '向绑定用户 UID 发送私信（回复或自主发起）', serviceMethod: 'socialSend',
  }),

  // ---- 尚未实现的公开读取 ----
  Object.freeze({
    id: 'feed.recommend.read', category: PUBLIC_READ, risk: 'low',
    implemented: false, requiresLogin: true, sideEffect: false,
    targetScope: 'public', defaultState: 'allow',
    reason: '个性化推荐流尚未接入', serviceMethod: null,
  }),
  Object.freeze({
    id: 'search.user.read', category: PUBLIC_READ, risk: 'low',
    implemented: false, requiresLogin: true, sideEffect: false,
    targetScope: 'public', defaultState: 'allow',
    reason: '用户搜索尚未接入', serviceMethod: null,
  }),
  Object.freeze({
    id: 'live.read', category: PUBLIC_READ, risk: 'low',
    implemented: false, requiresLogin: true, sideEffect: false,
    targetScope: 'public', defaultState: 'allow',
    reason: '直播信息与弹幕读取尚未接入', serviceMethod: null,
  }),
  Object.freeze({
    id: 'article.read', category: PUBLIC_READ, risk: 'low',
    implemented: false, requiresLogin: true, sideEffect: false,
    targetScope: 'public', defaultState: 'allow',
    reason: '专栏读取尚未接入', serviceMethod: null,
  }),
  Object.freeze({
    id: 'favorite.read', category: PRIVATE_READ, risk: 'medium',
    implemented: false, requiresLogin: true, sideEffect: false,
    targetScope: 'self', defaultState: 'deny',
    reason: '自己的收藏夹读取尚未接入', serviceMethod: null,
  }),

  // ---- 明确禁止的写入（当前未实现，先登记） ----
  Object.freeze({
    id: 'comment.write', category: SOCIAL_WRITE, risk: 'high',
    implemented: false, requiresLogin: true, sideEffect: true,
    targetScope: 'public', defaultState: 'deny',
    reason: '公开评论、回复、@ 尚未开放', serviceMethod: null,
  }),
  Object.freeze({
    id: 'danmaku.write', category: SOCIAL_WRITE, risk: 'high',
    implemented: false, requiresLogin: true, sideEffect: true,
    targetScope: 'public', defaultState: 'deny',
    reason: '弹幕发送尚未开放', serviceMethod: null,
  }),
  Object.freeze({
    id: 'like.write', category: REACTION_WRITE, risk: 'medium',
    implemented: false, requiresLogin: true, sideEffect: true,
    targetScope: 'public', defaultState: 'deny',
    reason: '点赞尚未开放', serviceMethod: null,
  }),
  Object.freeze({
    id: 'favorite.write', category: REACTION_WRITE, risk: 'medium',
    implemented: false, requiresLogin: true, sideEffect: true,
    targetScope: 'public', defaultState: 'deny',
    reason: '收藏尚未开放', serviceMethod: null,
  }),
  Object.freeze({
    id: 'coin.write', category: REACTION_WRITE, risk: 'critical',
    implemented: false, requiresLogin: true, sideEffect: true,
    targetScope: 'public', defaultState: 'deny',
    reason: '投币涉及真实资产，尚未开放', serviceMethod: null,
  }),
  Object.freeze({
    id: 'follow.write', category: RELATION_WRITE, risk: 'medium',
    implemented: false, requiresLogin: true, sideEffect: true,
    targetScope: 'public', defaultState: 'deny',
    reason: '关注/取关尚未开放', serviceMethod: null,
  }),
  Object.freeze({
    id: 'block.write', category: RELATION_WRITE, risk: 'high',
    implemented: false, requiresLogin: true, sideEffect: true,
    targetScope: 'public', defaultState: 'deny',
    reason: '拉黑/举报尚未开放', serviceMethod: null,
  }),
  Object.freeze({
    id: 'dynamic.write', category: PUBLISH_WRITE, risk: 'high',
    implemented: false, requiresLogin: true, sideEffect: true,
    targetScope: 'public', defaultState: 'deny',
    reason: '发布/转发动态尚未开放', serviceMethod: null,
  }),
  Object.freeze({
    id: 'article.write', category: PUBLISH_WRITE, risk: 'high',
    implemented: false, requiresLogin: true, sideEffect: true,
    targetScope: 'public', defaultState: 'deny',
    reason: '专栏发布尚未开放', serviceMethod: null,
  }),
  Object.freeze({
    id: 'upload.write', category: PUBLISH_WRITE, risk: 'critical',
    implemented: false, requiresLogin: true, sideEffect: true,
    targetScope: 'public', defaultState: 'deny',
    reason: '视频投稿尚未开放', serviceMethod: null,
  }),
  Object.freeze({
    id: 'live.write', category: PUBLISH_WRITE, risk: 'critical',
    implemented: false, requiresLogin: true, sideEffect: true,
    targetScope: 'public', defaultState: 'deny',
    reason: '直播开播/互动尚未开放', serviceMethod: null,
  }),
  Object.freeze({
    id: 'reserve.write', category: PUBLISH_WRITE, risk: 'medium',
    implemented: false, requiresLogin: true, sideEffect: true,
    targetScope: 'public', defaultState: 'deny',
    reason: '视频预约尚未开放', serviceMethod: null,
  }),
  Object.freeze({
    id: 'season.write', category: PUBLISH_WRITE, risk: 'medium',
    implemented: false, requiresLogin: true, sideEffect: true,
    targetScope: 'public', defaultState: 'deny',
    reason: '合集/章节修改尚未开放', serviceMethod: null,
  }),
  Object.freeze({
    id: 'staff.write', category: PUBLISH_WRITE, risk: 'high',
    implemented: false, requiresLogin: true, sideEffect: true,
    targetScope: 'public', defaultState: 'deny',
    reason: '联合投稿尚未开放', serviceMethod: null,
  }),
  Object.freeze({
    id: 'profile.write', category: ACCOUNT_WRITE, risk: 'high',
    implemented: false, requiresLogin: true, sideEffect: true,
    targetScope: 'self', defaultState: 'deny',
    reason: '修改昵称/头像/签名尚未开放', serviceMethod: null,
  }),
]);

const BY_ID = new Map(CAPABILITIES.map(item => [item.id, item]));

export function getCapability(id) {
  return BY_ID.get(String(id ?? '')) ?? null;
}

export function isKnownCapability(id) {
  return BY_ID.has(String(id ?? ''));
}

export function listCapabilities() {
  return CAPABILITIES.map(item => ({ ...item }));
}

export function capabilitiesByCategory(category) {
  return listCapabilities().filter(item => item.category === category);
}
