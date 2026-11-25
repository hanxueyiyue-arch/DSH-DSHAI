import { readState, updateState, testRecordList as listTestRecords, cleanTestRecord as cleanTest, quotaForToday } from './storage.js';
import { swim, readVideo as readVideoImpl } from './observation.js';
import { draftComment as draftCommentImpl, listDrafts as listDraftsImpl, lastObservation as lastObservationImpl } from './drafts.js';
import { FilterError, applyFilters, evaluateVideo, normalizeFilters, requireUser } from './filters.js';
import { policyFromFilters } from './policy.js';
import { rankCandidates } from './discover.js';
import { pickSubtitleTrack, normalizeSubtitleBody } from './subtitles.js';
import { parseDanmakuXml, danmakuStats } from './danmaku.js';
import { createSocialService } from './social.js';
import { normalizeMid } from './dm.js';
import { listCapabilities } from './capabilities.js';

export const BILIBILI_SERVICE = 'bilibili';

/**
 * 其他插件唯一可调用的业务方法集合。
 * 协调规则：observations / drafts / quota / filters 只有本插件可以写；BrainMem 与 Autonomy
 * 只能通过这里读摘要或请本插件写入，不得直接访问 state.json。
 * 账号相关方法（accessState 起）只暴露状态机与服务接口；审批必须由已认证用户通过宿主侧调用。
 */
export const PUBLIC_METHODS = Object.freeze([
  'summary', 'quota', 'lastObservation', 'capabilities',
  'swim', 'observePopular', 'readVideo',
  'discover', 'readSubtitles', 'readAudience', 'listUserVideos',
  'listDrafts', 'draftComment',
  'getFilters', 'setFilters', 'setFilterMode',
  'testRecordList', 'cleanTestRecord',
  'accessState', 'requestAccess', 'approveAccess', 'denyAccess', 'revokeAccess',
  'suppressRequests', 'resumeRequests',
  'loginStatus', 'startLogin', 'pollLogin', 'cancelLogin', 'logout',
  'socialStatus', 'socialBind', 'socialGrant', 'socialRevoke', 'socialSend', 'socialReceive', 'socialResolve', 'socialArchive',
  'policyStatus', 'initializePolicy', 'updatePolicy', 'recoverPolicy',
]);

export function createBilibiliService({
  client, fishName = '助手', readHourly = 300, readDaily = 2000,
  getAutonomy = () => undefined, account = null, socialTransport = null,
  socialAutoGrant = false, operations = null, allowLegacyOperations = false,
  adminSession = null, allowLegacyAdmin = false, ownerMid = '',
} = {}) {
  if (!client) throw new Error('createBilibiliService 需要 client');
  if (!operations && allowLegacyOperations !== true) {
    const error = new Error('生产 Bilibili 服务必须通过统一 Operations 执行边界启动');
    error.code = 'OPERATIONS_REQUIRED';
    throw error;
  }

  // 登出时中止本插件所有在途内容请求；之后的请求由“未登录/未授权”直接拒绝。
  let runController = new AbortController();
  // buvid3 补齐每个登录会话只尝试一次，失败后不重复打 finger/spi。
  let buvidAttempted = false;
  const withRunSignal = signal => (signal
    ? AbortSignal.any([signal, runController.signal])
    : runController.signal);

  const accountOf = () => {
    if (!account) throw new Error('Bilibili 账号功能未启用');
    return account;
  };

  // 读取需要登录的接口前取当前会话凭证；缺 buvid3 时只补一次，失败不伪造。
  async function contentCredentials(signal) {
    const current = accountOf();
    let credentials = typeof current.credentials === 'function' ? current.credentials() : null;
    if (!credentials) return null;
    if (!credentials.buvid3 && !buvidAttempted && typeof client.ensureBuvid === 'function') {
      buvidAttempted = true;
      const enriched = await client.ensureBuvid(credentials, signal);
      if (enriched?.buvid3) {
        if (typeof current.updateCredentials === 'function') {
          await current.updateCredentials({ buvid3: enriched.buvid3 });
        }
        credentials = enriched;
      }
    }
    return credentials;
  }

  // ---- 社交（私信）服务：grant 由用户签发并只存在服务端；不把 token 交给模型/日志。----
  let social = null;
  let socialReady = null;
  // 登录自动授权的会话状态：
  // - autoGrantedLoginId 记录已签发过授权的登录会话，重复 poll 不会重复签发；
  // - autoGrantSuppressed 是“本会话内被用户紧急撤销”的标记，只有重新扫码才会清除。
  let autoGrantedLoginId = null;
  let autoGrantSuppressed = false;
  // 会话级失败关闭：logout/socialRevoke 一旦开始，旧会话的社交发送立即停止，
  // 即使后面的异步清理抛错或挂起，也不能靠新签发 intent 继续使用旧 grant。
  let socialRevoked = false;

  // 只读 transport 的凭证入口：只有“当前会话仍成功 + 存在有效 read grant”时才返回，
  // 且返回值只在内存中使用，不写入日志、不落盘、不暴露给 Agent 或公开工具。
  const getCredentials = async () => {
    const live = accountOf().loginStatus();
    const liveStatus = live?.status ?? live?.login?.status ?? (live?.account?.mid ? 'success' : 'idle');
    if (liveStatus !== 'success') {
      throw new Error('SOCIAL_CREDENTIALS_UNAVAILABLE');
    }
    const instance = await ensureSocial();
    const grants = instance.listGrants();
    const hasRead = grants.some(grant => (grant.scopes || []).includes('dm:owner')
      && (grant.capabilities || []).includes('read'));
    if (!hasRead) throw new Error('SOCIAL_READ_GRANT_REQUIRED');
    const read = typeof accountOf().credentials === 'function' ? await accountOf().credentials() : null;
    if (!read) throw new Error('SOCIAL_CREDENTIALS_UNAVAILABLE');
    return { sessdata: read.sessdata, biliJct: read.biliJct, buvid3: read.buvid3 };
  };

  async function ensureSocial() {
    if (social) return social;
    if (!socialReady) {
      socialReady = (async () => {
        const state = await readState();
        // transport 既支持“现成对象”，也支持工厂注入 { getCredentials }；
        // 对象式注入不提供凭证入口，真实只读 adapter 必须走工厂形式。
        const transport = typeof socialTransport === 'function'
          ? socialTransport({ getCredentials })
          : socialTransport;
        const instance = createSocialService({
          transport,
          beforeSend: async snapshot => {
            // 发送前落盘 sending 意图；崩溃后 recover() 只会转 unknown，不会重发。
            await updateState(next => { next.dm = snapshot; });
          },
        });
        instance.load(state.dm);
        const recovered = instance.recover();
        if (recovered.recovered) {
          await updateState(next => { next.dm = instance.snapshot(); });
        }
        social = instance;
        return instance;
      })();
    }
    return socialReady;
  }

  // P1-B: 首次登录即可用。ownerMid 来自宿主配置（可信），登录成功后自动完成
  // “绑定用户 + 初始化内容策略”，之后由 autoGrantFromLogin 签发只读/回复权限。
  const configuredOwnerMid = normalizeMid(ownerMid);
  async function ensureContentPolicyReady() {
    if (!operations?.policy) return false;
    try {
      const current = await operations.policy.status();
      if (current?.initialized) return false;
      await operations.policy.initializePolicy({
        actor: { kind: 'user', authenticated: true, id: 'bilibili-admin' },
      });
      return true;
    } catch {
      return false;
    }
  }
  async function bootstrapOwnerBinding(result, { sessionId = null } = {}) {
    if (!configuredOwnerMid) return null;
    if (result?.status !== 'success') return null;
    const live = await accountOf().loginStatus();
    const liveId = live?.id ?? live?.login?.id ?? null;
    if (sessionId && liveId && liveId !== sessionId) return null;
    const self = normalizeMid(result.account?.mid);
    if (!self || self === configuredOwnerMid) return null;
    const instance = await ensureSocial();
    const status = instance.status();
    const boundOwner = normalizeMid(status.ownerMid);
    const boundSelf = normalizeMid(status.selfMid);
    if (boundOwner && boundOwner !== configuredOwnerMid) return 'owner-conflict';
    if (boundOwner === configuredOwnerMid && boundSelf === self) {
      await ensureContentPolicyReady();
      return 'already-bound';
    }
    if (boundSelf && boundSelf !== self) return 'self-mismatch';
    instance.bind({ ownerMid: configuredOwnerMid, selfMid: self });
    await persistSocial();
    await ensureContentPolicyReady();
    return 'bound';
  }
  async function persistSocial() {
    if (!social) return;
    const snapshot = social.snapshot();
    await updateState(next => { next.dm = snapshot; });
  }

  const adminTokenOf = (input = {}) => input?.adminSession ?? input?.actor?.adminSession ?? null;
  const requireAdmin = (input = {}) => {
    if (adminSession && input?.adminSession === adminSession) return;
    if (allowLegacyAdmin && input?.kind === 'user' && input?.authenticated === true) return;
    if (allowLegacyAdmin && input?.actor?.kind === 'user' && input?.actor?.authenticated === true) return;
    if (allowLegacyAdmin && !input?.kind && !input?.actor) return;
    const error = new Error('只有已认证用户取得可信管理会话后可以管理社交授权；普通插件不能自报用户身份');
    error.code = 'ADMIN_SESSION_REQUIRED';
    throw error;
  };
  const requireSocialUser = actor => requireAdmin(actor);

  const currentSelfMid = async () => {
    const acct = account ? await account.accessState() : null;
    const mid = normalizeMid(acct?.account?.mid);
    if (!mid) {
      const error = new Error('需要先扫码登录，才能绑定或使用社交授权');
      error.code = 'SOCIAL_LOGIN_REQUIRED';
      throw error;
    }
    return mid;
  };

  // 登录成功后的自动授权：复用同一套 grant 模型，但只走内部 mintFromLogin，
  // 不接受 actor（手动 socialGrant 仍要求已认证用户）。任何前置条件不满足都
  // 只返回 null，不推断、不修复绑定，也不让登录本身失败。
  async function autoGrantFromLogin(result, { sessionId = null } = {}) {
    if (socialAutoGrant !== true || autoGrantSuppressed) return null;
    if (result?.status !== 'success') return null;
    const live = await accountOf().loginStatus();
    const liveStatus = live?.status ?? live?.login?.status ?? (live?.account?.mid ? 'success' : 'idle');
    const liveId = live?.id ?? live?.login?.id ?? null;
    // 迟到/重复防护：结果必须属于当前有效会话，且当前仍是 success。
    if (liveStatus !== 'success') return null;
    if (sessionId && liveId && liveId !== sessionId) return null;
    if (result.id && liveId && liveId !== result.id) return null;
    const loginId = result.id ?? liveId ?? null;
    if (loginId && autoGrantedLoginId === loginId) return null;
    const resultMid = normalizeMid(result.account?.mid);
    const liveMid = normalizeMid(live.account?.mid);
    if (!resultMid || !liveMid || resultMid !== liveMid) return null;
    const self = resultMid;
    const instance = await ensureSocial();
    const status = instance.status();
    const owner = normalizeMid(status.ownerMid);
    const bound = normalizeMid(status.selfMid);
    // 严格前置：用户已绑定、助手账号已绑定、绑定与本次登录一致、两者不相同。
    if (!owner || !bound || bound !== self || owner === self) return null;
    // 最终同步校验：在 issueGrant 之前同步读取本进程内的权威登录状态，
    // 中间不允许有 await。这样即使 ensureSocial 期间发生了重新登录/登出，
    // 也不可能把旧会话的结果签到新会话上。
    const expectId = loginId ?? null;
    const expectMid = self;
    const validate = ({ selfMid }) => {
      if (socialAutoGrant !== true || autoGrantSuppressed) return false;
      const live = accountOf().loginStatus();
      if (!live || typeof live.then === 'function') return false; // 只接受同步状态
      const liveStatus = live?.status ?? live?.login?.status ?? (live?.account?.mid ? 'success' : 'idle');
      if (liveStatus !== 'success') return false;
      const liveId = live?.id ?? live?.login?.id ?? null;
      if (expectId && liveId && liveId !== expectId) return false;
      const liveMid = normalizeMid(live?.account?.mid);
      if (!liveMid || liveMid !== expectMid) return false;
      const nowStatus = instance.status();
      if (normalizeMid(nowStatus.selfMid) !== selfMid) return false;
      if (normalizeMid(nowStatus.ownerMid) !== owner) return false;
      if (nowStatus.grants && nowStatus.grants.length > 0) return false; // 不得重复签发
      return true;
    };
    try {
      const issued = instance.mintFromLogin({
        selfMid: self, ownerMid: owner, validate, dailySendMax: 0,
      });
      await persistSocial();
      if (loginId) autoGrantedLoginId = loginId;
      return issued.grant;
    } catch {
      return null;
    }
  }

  const socialStatusOf = instance => {
    const grants = instance.listGrants();
    const status = instance.status();
    const liveLogin = account?.loginStatus?.();
    const loggedInMid = normalizeMid(liveLogin?.account?.mid);
    const sessionId = liveLogin?.login?.id ?? liveLogin?.id ?? null;
    const boundSelfMid = normalizeMid(status.selfMid);
    // 绑定仍指向旧账号时 fail-closed：页面提示重新绑定，且不允许直接签发 grant。
    const bindingValid = !status.ownerMid || (Boolean(loggedInMid)
      && (!boundSelfMid || boundSelfMid === loggedInMid));
    const info = instance.transportInfo
      ? instance.transportInfo()
      : { kind: 'unavailable', enabled: false, readEnabled: false, sendEnabled: false };
    const realRead = info.kind === 'real' && info.readEnabled === true;
    const realSend = info.kind === 'real' && info.sendEnabled === true;
    return {
      ...status,
      // 登录态以当前账号为准，避免换号/重启后继续显示上一账号的 selfMid。
      selfMid: loggedInMid || status.selfMid,
      sessionId: sessionId ? String(sessionId) : null,
      boundSelfMid: status.selfMid,
      bindingValid,
      grants,
      revoked: socialRevoked,
      active: !socialRevoked && grants.length === 1,
      // 自动授权只读状态：页面据此提示“已随登录授予/仅提示绑定/已紧急撤销”，
      // 不暴露 token，也不作为是否允许发送的依据（发送仍走 authorize）。
      autoGrant: {
        enabled: socialAutoGrant === true,
        suppressed: autoGrantSuppressed,
        grantedLoginId: autoGrantedLoginId,
        source: grants[0]?.source ?? null,
      },
      // fake 只用于隔离测试；real 读、写独立报告，避免“读取可用”被误读成“发送可用”。
      transport: info.kind,
      realTransportAvailable: info.kind === 'real' && (realRead || realSend),
      realReadAvailable: realRead,
      realSendAvailable: realSend,
      notice: info.kind === 'unavailable'
        ? '真实私信通道尚未接入：当前版本不会发送任何 B 站私信，授权仅保存设置，发送入口会拒绝。'
        : info.kind === 'fake'
          ? '隔离模拟通道：不会发送或接收真实 B 站私信。'
          : realRead && realSend
            ? null
            : realRead
              ? '真实私信读取已启用，发送保持关闭：当前不会发送任何 B 站私信。'
              : realSend
                ? '真实私信发送已启用，读取保持关闭。'
                : '真实私信通道尚未启用：授权仅保存设置，发送入口会拒绝。',
    };
  };

  const requireSocialTransport = (instance, operation) => {
    const info = instance.transportInfo
      ? instance.transportInfo()
      : { kind: 'unavailable', readEnabled: false, sendEnabled: false };
    if (info.kind === 'unavailable') {
      const error = new Error('真实私信通道尚未接入，拒绝收发');
      error.code = 'SOCIAL_TRANSPORT_UNAVAILABLE';
      throw error;
    }
    if (info.kind !== 'real') return;
    if (!info.readEnabled && !info.sendEnabled) {
      const error = new Error('真实私信通道尚未启用，拒绝收发');
      error.code = 'SOCIAL_TRANSPORT_DISABLED';
      throw error;
    }
    if (operation === 'send' && !info.sendEnabled) {
      const error = new Error('真实私信发送未启用，拒绝发送');
      error.code = 'SOCIAL_SEND_DISABLED';
      throw error;
    }
    if (operation === 'read' && !info.readEnabled) {
      const error = new Error('真实私信读取未启用，拒绝读取');
      error.code = 'SOCIAL_READ_DISABLED';
      throw error;
    }
  };

  // Fail-closed content gate: a missing or malformed account service must never
  // turn a network read into an unauthenticated request.
  const requireContent = async (reason) => {
    if (!account || typeof account.requireContentAccess !== 'function') {
      const error = new Error('Bilibili 账号服务不可用，拒绝发起内容网络请求');
      error.code = 'ACCESS_UNAVAILABLE';
      throw error;
    }
    const granted = await account.requireContentAccess(reason);
    if (typeof account.hasContentAccess === 'function' && !account.hasContentAccess()) {
      const error = new Error('Bilibili 内容许可状态未知，拒绝发起内容网络请求');
      error.code = 'ACCESS_UNAVAILABLE';
      throw error;
    }
    return granted;
  };

  // 阶段 1a：统一执行边界。operations 不存在时保留旧路径，便于现有调用方与测试平滑迁移。
  const toCaller = actor => {
    if (actor?.kind === 'autonomy') return { kind: 'autonomy', trusted: false };
    if (actor?.kind === 'owner-chat' && actor.trusted === true) {
      return { kind: 'owner-chat', trusted: true, id: actor.id ?? null };
    }
    // 兼容旧 service 调用约定：已认证 user 等价于可信用户聊天。
    if (actor?.kind === 'user' && actor.authenticated === true) {
      return { kind: 'owner-chat', trusted: true, id: actor.id ?? actor.mid ?? null };
    }
    return { kind: 'untrusted', trusted: false };
  };

  const loginSnapshot = () => {
    const live = account?.loginStatus?.();
    if (!live || typeof live.then === 'function') {
      return { loggedIn: false, status: 'unknown', mid: null, account: null };
    }
    const status = live?.status ?? live?.login?.status ?? (live?.account?.mid ? 'success' : 'idle');
    const mid = normalizeMid(live?.account?.mid);
    const sessionId = live?.login?.id ?? live?.id ?? null;
    return {
      loggedIn: status === 'success' && Boolean(mid),
      status,
      mid: mid || null,
      sessionId: sessionId ? String(sessionId) : null,
      account: live?.account ?? null,
    };
  };

  const readContext = caller => {
    const live = loginSnapshot();
    return { loggedIn: live.loggedIn, selfMid: live.mid, caller };
  };

  const runCapability = (capabilityId, input, caller, context, handler) => {
    if (!operations) {
      if (allowLegacyOperations !== true) {
        const error = new Error('Bilibili 服务缺少统一 Operations 执行边界');
        error.code = 'OPERATIONS_REQUIRED';
        throw error;
      }
      return handler(input);
    }
    return operations.execute(capabilityId, input, caller, handler, context);
  };

  // 内容限制读取：只读本插件 state；规则在取得元数据后执行，未知元数据 fail-closed。
  const filtersOf = async () => normalizeFilters((await readState()).filters);
  const filterVideos = filters => videos => applyFilters(videos, filters);
  const filterOne = filters => video => {
    const verdict = evaluateVideo(video, filters);
    if (!verdict.ok) {
      throw new FilterError(verdict.reason || '视频未通过用户内容限制', {
        code: verdict.code, reason: verdict.reason,
      });
    }
  };

  // 手动观察后，若 Autonomy 提供了接收方法则转交；否则跳过（不写他人数据）。
  // 转交失败绝不能影响本插件的工具结果：观察已经写入本地，Autonomy 的问题由其自行审计。
  const handOffManual = async ({ videos, method }) => {
    try {
      const autonomy = getAutonomy();
      if (typeof autonomy?.ingestObservation === 'function') {
        await autonomy.ingestObservation({ videos, method });
      }
    } catch { /* 降级：不影响 swim 的返回契约 */ }
  };

  const service = {
    name: BILIBILI_SERVICE,
    version: '0.3.15',

    // ---- 只读摘要（Autonomy 的 dshai_status 与 BrainMem 的 reflection_context 用它）----
    async summary() {
      const state = await readState();
      return {
        observationCount: state.observations.length,
        draftCount: state.drafts.length,
        quota: quotaForToday(state),
        readHourly,
        readDaily,
        traffic: state.traffic ?? null,
        lastObservation: state.observations.at(-1) ?? null,
        counts: { observations: state.observations.length, drafts: state.drafts.length },
        migratedFrom: state.migratedFrom ? { sha256: state.migratedFrom.sha256, at: state.migratedFrom.at } : null,
      };
    },

    async quota() {
      return quotaForToday(await readState());
    },

    async lastObservation() {
      return lastObservationImpl();
    },

    // 只读能力目录 + Policy 状态；真正的开关修改留给设置页的已认证用户入口。
    async capabilities() {
      if (!operations) {
        return {
          policy: { status: 'disabled' },
          items: listCapabilities().map(item => ({ ...item, effective: item.defaultState, effectiveSource: 'disabled' })),
        };
      }
      const listed = await operations.list();
      const effective = operations.policy?.effective;
      if (!effective) return listed;
      return {
        ...listed,
        items: listed.items.map(item => ({
          ...item,
          effective: effective.capabilities[item.id] ?? effective.categories[item.category] ?? 'deny',
          effectiveSource: effective.source,
        })),
      };
    },

    async policyStatus() {
      if (!operations?.policy) return { status: 'disabled', initialized: false, recoverable: false };
      return operations.policy.status();
    },

    async initializePolicy({ actor, policy, adminSession: adminToken } = {}) {
      if (!operations?.policy) throw new Error('Bilibili Policy 未启用');
      requireAdmin({ adminSession: adminToken ?? actor?.adminSession, actor });
      return operations.policy.initializePolicy({ actor: { kind: 'user', authenticated: true, id: 'bilibili-admin' }, policy });
    },

    async updatePolicy({ capabilityId, state, actor, adminSession: adminToken } = {}) {
      if (!operations?.policy) throw new Error('Bilibili Policy 未启用');
      requireAdmin({ adminSession: adminToken ?? actor?.adminSession, actor });
      return operations.policy.updateCapability(capabilityId, state, { actor: { kind: 'user', authenticated: true, id: 'bilibili-admin' } });
    },

    async recoverPolicy({ mode, confirm, actor, adminSession: adminToken } = {}) {
      if (!operations?.policy) throw new Error('Bilibili Policy 未启用');
      requireAdmin({ adminSession: adminToken ?? actor?.adminSession, actor });
      return operations.policy.recoverPolicy({ actor: { kind: 'user', authenticated: true, id: 'bilibili-admin' }, mode, confirm });
    },

    // ---- 手动观察（dshai_swim 工具；用户直接发起，保持旧契约）----
    // P1-A: an Agent-triggerable read still needs the same content permission as
    // the scheduled path. The check happens before any network call.
    async swim({ count = 3, signal, actor } = {}) {
      const caller = toCaller(actor);
      return runCapability('feed.popular.read', { count, signal, actor }, caller, readContext(caller), async () => {
        await requireContent('手动浏览热门列表');
        const filters = await filtersOf();
        return swim({
          count, method: 'manual', client, fishName, signal: withRunSignal(signal),
          afterObserve: handOffManual, filterVideos: filterVideos(filters),
        });
      });
    },

    // ---- 定时观察（Autonomy 调度器调用；自主访问必须持有当前运行会话的内容许可）----
    async observePopular({ count = 3, method = 'scheduled', signal, handOff = true, actor } = {}) {
      const caller = toCaller(actor);
      return runCapability('feed.popular.read', { count, method, signal, handOff, actor }, caller, readContext(caller), async () => {
        // Any observePopular path is a network read: manual callers (business services
        // holding ctx.get('bilibili')) must also pass the content permission check.
        await requireContent('观察热门列表');
        const filters = await filtersOf();
        const result = await swim({
          count, method, client, fishName, signal: withRunSignal(signal),
          afterObserve: handOff ? handOffManual : null,
          filterVideos: filterVideos(filters),
        });
        return {
          videos: result.videos, observedAt: result.observedAt, method,
          filtered: result.filtered, limitation: result.limitation,
        };
      });
    },

    async readVideo(args = {}) {
      const caller = toCaller(args.actor);
      return runCapability('video.read', args, caller, readContext(caller), async () => {
        // P1-A: reading one video is also a network read; permission first.
        await requireContent('读取视频详情');
        const filters = await filtersOf();
        return readVideoImpl({ ...args, client, filterVideo: filterOne(filters), signal: withRunSignal(args.signal) });
      });
    },

    // ---- Phase 2 只读能力：发现 / 字幕 / 弹幕与评论 ----
    // 三者都先过内容许可，再走 client 的预算与风控；Agent 工具只调用这里，不直接联网。
    async discover({ keyword, limit = 5, order = 'totalrank', signal, actor } = {}) {
      const caller = toCaller(actor);
      return runCapability('video.search', { keyword, limit, order, signal, actor }, caller, readContext(caller), async () => {
      const word = String(keyword ?? '').trim().slice(0, 80);
      if (!word) {
        const error = new Error('搜索关键词不能为空');
        error.code = 'DISCOVER_KEYWORD_REQUIRED';
        throw error;
      }
      await requireContent('搜索视频');
      const state = await readState();
      const size = Math.max(1, Math.min(10, Math.floor(Number(limit) || 5)));
      const callSignal = withRunSignal(signal);
      const credentials = await contentCredentials(callSignal);
      const rows = await client.search(word, { limit: size, order, signal: callSignal, credentials });
      const ranked = rankCandidates(rows, policyFromFilters(state.filters), {
        limit: size,
        seen: state.observations.map(row => row.bvid),
      });
      return {
        keyword: word,
        items: ranked.items.map(item => ({
          bvid: item.bvid,
          title: item.title,
          owner: item.owner.name,
          ownerMid: item.owner.mid,
          category: item.tname,
          durationSeconds: item.duration,
          stats: item.stats,
          score: item.score,
          reasons: item.reasons,
          url: `https://www.bilibili.com/video/${item.bvid}`,
        })),
        // 被规则挡下的条目只回报规则代码与原因，不把整条内容再送进模型。
        blocked: ranked.blocked.map(row => ({
          bvid: row.bvid, code: row.code, reason: row.reason, unknown: row.unknown === true,
        })),
        filtered: ranked.blocked.length,
      };
      });
    },

    async readSubtitles({ bvid, cid, from = 0, to = null, maxChars = 4000, full = false, signal, actor } = {}) {
      const caller = toCaller(actor);
      return runCapability('video.subtitles', { bvid, cid, from, to, maxChars, full, signal, actor }, caller, readContext(caller), async () => {
      await requireContent('读取字幕');
      const callSignal = withRunSignal(signal);
      const credentials = await contentCredentials(callSignal);
      const id = String(bvid ?? '').trim();
      if (!/^BV[A-Za-z0-9]{10}$/.test(id)) {
        const error = new Error('只支持合法格式的 BV 号');
        error.code = 'SUBTITLE_BVID_INVALID';
        throw error;
      }
      let pageCid = Number(cid) || 0;
      let duration = 0;
      if (!pageCid) {
        const video = await client.view(id, callSignal);
        filterOne(await filtersOf())(video);
        pageCid = Number(video?.cid) || 0;
        duration = Number(video?.durationSeconds) || 0;
      }
      if (!pageCid) {
        return {
          available: false, bvid: id, cid: null, lang: null, items: [], truncated: false,
          total: 0, nextFrom: null, reason: 'SUBTITLE_CID_REQUIRED',
        };
      }
      const page = await client.player(id, pageCid, callSignal, credentials);
      const track = pickSubtitleTrack(page?.subtitles);
      if (!track) {
        return {
          available: false, bvid: id, cid: pageCid, lang: null, items: [], truncated: false,
          total: 0, durationSeconds: duration || page?.duration || 0, nextFrom: null, reason: 'SUBTITLE_EMPTY',
        };
      }
      const body = await client.subtitleBody(track.url, withRunSignal(signal));
      const normalized = normalizeSubtitleBody(body, { lang: track.lan });
      const start = Math.max(0, Number(from) || 0);
      const end = to == null ? Number.POSITIVE_INFINITY : Math.max(start, Number(to) || 0);
      // full=true 是插件内部/显式工具参数：返回全部字幕正文，不做 12,000 字上限。
      const cap = full === true ? Number.POSITIVE_INFINITY : Math.max(500, Math.min(12000, Number(maxChars) || 4000));
      const items = [];
      let chars = 0;
      let truncated = normalized.truncated;
      for (const row of normalized.items) {
        if (row.to < start || row.from > end) continue;
        if (chars + row.text.length > cap) { truncated = true; break; }
        chars += row.text.length;
        items.push({ from: row.from, to: row.to, text: row.text });
      }
      // 处理 ③：把"下次从哪继续"显式返回，cognition 侧靠它记录阅读进度。
      // 只有真的被截断才有"下次"；区间读到头（truncated=false）就不该留下续读点。
      const nextFrom = truncated && items.length > 0 ? items[items.length - 1].to : null;
      return {
        available: items.length > 0,
        bvid: id,
        cid: pageCid,
        lang: track.lan,
        langDoc: track.lanDoc,
        source: 'official',
        durationSeconds: duration || page?.duration || 0,
        total: normalized.items.length,
        items,
        truncated,
        nextFrom,
        reason: items.length ? null : 'SUBTITLE_RANGE_EMPTY',
      };
      });
    },

    async readAudience({ bvid, cid, aid, danmakuLimit = 2000, commentLimit = 8, signal, actor } = {}) {
      const caller = toCaller(actor);
      return runCapability('video.audience', { bvid, cid, aid, danmakuLimit, commentLimit, signal, actor }, caller, readContext(caller), async () => {
      await requireContent('读取弹幕与评论');
      const callSignal = withRunSignal(signal);
      const credentials = await contentCredentials(callSignal);
      const id = String(bvid ?? '').trim();
      if (!/^BV[A-Za-z0-9]{10}$/.test(id)) {
        const error = new Error('只支持合法格式的 BV 号');
        error.code = 'AUDIENCE_BVID_INVALID';
        throw error;
      }
      let pageCid = Number(cid) || 0;
      let pageAid = Number(aid) || 0;
      let duration = 0;
      if (!pageCid || !pageAid) {
        const video = await client.view(id, callSignal);
        filterOne(await filtersOf())(video);
        pageCid = pageCid || Number(video?.cid) || 0;
        pageAid = pageAid || Number(video?.aid) || 0;
        duration = Number(video?.durationSeconds) || 0;
      }
      if (!pageCid) {
        return {
          bvid: id, cid: null, aid: pageAid || null, available: false,
          danmaku: { total: 0, sampled: 0, truncated: false, topWords: [], peaks: [], samples: [] },
          comments: { items: [], truncated: false }, reason: 'AUDIENCE_CID_REQUIRED',
        };
      }
      const xml = await client.danmakuXml(pageCid, callSignal, credentials);
      const parsed = parseDanmakuXml(xml, {
        maxItems: Math.max(1, Math.min(50_000, Math.floor(Number(danmakuLimit) || 2000))),
      });
      const stats = danmakuStats(parsed.items, { duration, topN: 8, peaks: 3 });
      const comments = pageAid
        ? await client.commentsMain(pageAid, { ps: Math.max(1, Math.min(20, Number(commentLimit) || 8)), signal: callSignal, credentials })
        : [];
      return {
        bvid: id,
        cid: pageCid,
        aid: pageAid || null,
        available: parsed.total > 0 || comments.length > 0,
        danmaku: {
          total: parsed.total,
          sampled: parsed.items.length,
          truncated: parsed.truncated,
          topWords: stats.topWords,
          peaks: stats.peaks,
          samples: parsed.items.slice(0, 8).map(row => ({ time: row.time, text: row.text.slice(0, 60) })),
        },
        comments: {
          items: comments.map(row => ({
            author: row.author, text: row.text, like: row.like,
          })),
          truncated: comments.length >= Math.max(1, Math.min(20, Number(commentLimit) || 8)),
        },
        reason: null,
      };
      });
    },

    // ---- UP 主视频列表：只读公开元数据；不新增 Agent 工具，供 Autonomy/其他业务层调用 ----
    async listUserVideos({ mid, limit = 20, order = 'pubdate', signal, actor } = {}) {
      const caller = toCaller(actor);
      return runCapability('user.videos.read', { mid, limit, order, signal, actor }, caller, readContext(caller), async () => {
      await requireContent('读取 UP 主视频列表');
      const id = String(mid ?? '').trim();
      if (!/^\d{1,20}$/.test(id)) {
        const error = new Error('mid 必须是纯数字');
        error.code = 'USER_VIDEOS_MID_INVALID';
        throw error;
      }
      const callSignal = withRunSignal(signal);
      const credentials = await contentCredentials(callSignal);
      const size = Math.max(1, Math.min(50, Math.floor(Number(limit) || 20)));
      const rows = await client.listUserVideos(id, {
        limit: size, order: ['pubdate', 'click'].includes(order) ? order : 'pubdate',
        signal: callSignal, credentials,
      });
      const evaluated = filterVideos(await filtersOf())(rows);
      return {
        mid: id,
        order: ['pubdate', 'click'].includes(order) ? order : 'pubdate',
        items: evaluated.allowed,
        filtered: evaluated.blocked.length,
        url: `https://space.bilibili.com/${id}/video`,
      };
      });
    },

    // ---- 用户内容限制（只有已认证用户可修改；Agent 只能读）----
    async getFilters() {
      return filtersOf();
    },

    async setFilters({ filters, actor, reason = '', adminSession: adminToken } = {}) {
      requireAdmin({ adminSession: adminToken ?? actor?.adminSession, actor });
      const next = normalizeFilters(filters);
      const updated = await updateState(state => {
        state.filters = {
          ...next,
          updatedAt: new Date().toISOString(),
          updatedBy: String(actor?.id || 'dashboard-session').slice(0, 40),
        };
        return state.filters;
      });
      return { filters: updated, note: String(reason || '').slice(0, 200) };
    },

    // 旧 allowlist 显式切换为“仅排序”：保留原 include 列表，不删除用户配置。
    async setFilterMode({ mode, actor, reason = '', adminSession: adminToken } = {}) {
      requireAdmin({ adminSession: adminToken ?? actor?.adminSession, actor });
      if (!['off', 'deny', 'allow'].includes(mode)) {
        const error = new Error('mode 必须是 off / deny / allow');
        error.code = 'FILTER_MODE_INVALID';
        throw error;
      }
      const current = await filtersOf();
      const updated = await updateState(state => {
        state.filters = {
          ...normalizeFilters({ ...current, enabled: mode !== 'off', mode }),
          updatedAt: new Date().toISOString(),
          updatedBy: String(actor?.id || 'dashboard-session').slice(0, 40),
        };
        return state.filters;
      });
      return { filters: updated, note: String(reason || '').slice(0, 200) };
    },

    // ---- 草稿：只存本地 ----
    async listDrafts() { return listDraftsImpl(); },
    async draftComment(args = {}) { return draftCommentImpl(args); },

    // ---- 跨插件测试数据清理（Autonomy 协调，按 owner 分派到本插件）----
    async testRecordList() {
      return listTestRecords(await readState());
    },

    async cleanTestRecord(args = {}) {
      return cleanTest(args);
    },

    // ---- 账号授权 / 运行会话许可 / 登录状态机（Step 4 UI 通过服务调用接入）----
    async accessState() {
      return accountOf().accessState();
    },

    async requestAccess(args = {}) {
      requireAdmin({ adminSession: args?.adminSession ?? args?.actor?.adminSession, actor: args?.actor });
      return accountOf().requestAccess(args);
    },

    async approveAccess(args = {}) {
      requireAdmin({ adminSession: args?.adminSession ?? args?.actor?.adminSession, actor: args?.actor });
      return accountOf().approveAccess(args);
    },

    async denyAccess(args = {}) {
      requireAdmin({ adminSession: args?.adminSession ?? args?.actor?.adminSession, actor: args?.actor });
      return accountOf().denyAccess(args);
    },

    async revokeAccess(args = {}) {
      requireAdmin({ adminSession: args?.adminSession ?? args?.actor?.adminSession, actor: args?.actor });
      return accountOf().revokeAccess();
    },

    async loginStatus() {
      return accountOf().loginStatus();
    },

    async startLogin(args = {}) {
      requireAdmin({ adminSession: args?.adminSession ?? args?.actor?.adminSession, actor: args?.actor });
      const fresh = args?.fresh === true;
      const before = await accountOf().loginStatus();
      // 未确认换号时：waiting/scanned 直接复用；success 不回二维码、不隐式换号。
      if (!fresh && (before?.status === 'waiting' || before?.status === 'scanned')) {
        return accountOf().startLogin({ fresh: false });
      }
      // 严格版 A：重新登录/换号先立即退出旧账号（取消会话、撤销访问、清本地凭证），
      // 再生成新二维码；新码生成失败也保持未登录，不恢复旧账号。
      // 先同步撤销旧 intent 并失败关闭旧会话：即使 logout 失败或卡住，
      // 旧账号即使仍显示登录成功，旧 grant 也不能靠新 intent 继续发送。
      socialRevoked = true;
      operations?.revokeIntents?.();
      await accountOf().logout();
      buvidAttempted = false;
      autoGrantSuppressed = false;
      autoGrantedLoginId = null;
      if (social) social.revokeAll();
      return accountOf().startLogin({ ...args, fresh: true });
    },

    async pollLogin(id, args = {}) {
      requireAdmin({ adminSession: args?.adminSession ?? args?.actor?.adminSession, actor: args?.actor });
      const before = await accountOf().loginStatus();
      const result = await accountOf().pollLogin(id);
      if (result?.status === 'success') {
        // 只接受“当前会话 + 当前登录 UID”的成功结果；迟到会话不得签发授权。
        const beforeId = before?.id ?? before?.login?.id ?? null;
        if (beforeId && (beforeId !== result.id || id !== result.id)) return { ...result, stale: true, autoGrant: null };
        // 新登录会话开始，解除上一会话的撤销失败关闭标记。
        socialRevoked = false;
        buvidAttempted = false;
        // 只签发授权，不建 intent、不发送：是否行动仍由 Autonomy 决定。
        const ownerBootstrap = await bootstrapOwnerBinding(result, { sessionId: result.id });
        const autoGrant = await autoGrantFromLogin(result, { sessionId: result.id });
        return { ...result, ownerBootstrap, autoGrant };
      }
      return result;
    },

    async cancelLogin(id, args = {}) {
      requireAdmin({ adminSession: args?.adminSession ?? args?.actor?.adminSession, actor: args?.actor });
      return accountOf().cancelLogin(id);
    },

    async logout(args = {}) {
      requireAdmin({ adminSession: args?.adminSession ?? args?.actor?.adminSession, actor: args?.actor });
      runController.abort(new Error('logout'));
      runController = new AbortController();
      buvidAttempted = false;
      // 先同步撤销旧 intent 并失败关闭社交发送，再等待异步登出清理。
      // 这样 logout 抛错或挂起时，旧凭证和新 intent 都不能继续使用。
      socialRevoked = true;
      operations?.revokeIntents?.();
      const result = await accountOf().logout();
      // 登出即撤销全部 B 站操作权限；社交授权也一并失效，且下一次登录是一个新会话。
      autoGrantedLoginId = null;
      autoGrantSuppressed = false;
      if (social) social.revokeAll();
      return result;
    },

    // 用户的持续指令：“以后不要再申请，直到我解除”。只有已认证用户可设置/解除。
    async suppressRequests(args = {}) {
      requireAdmin({ adminSession: args?.adminSession ?? args?.actor?.adminSession, actor: args?.actor });
      return accountOf().suppressRequests(args);
    },

    async resumeRequests(args = {}) {
      requireAdmin({ adminSession: args?.adminSession ?? args?.actor?.adminSession, actor: args?.actor });
      return accountOf().resumeRequests(args);
    },

    // ---- 受控私信（F6）：用户签发/撤销，Autonomy 持有授权后调用；无 Agent 写工具 ----
    async socialStatus() {
      return socialStatusOf(await ensureSocial());
    },

    async socialBind({ ownerMid, selfMid, actor } = {}) {
      requireSocialUser(actor);
      const instance = await ensureSocial();
      const self = await currentSelfMid();
      if (selfMid != null && String(selfMid) !== self) {
        const error = new Error('绑定账号与当前登录账号不一致，请先退出登录再切换');
        error.code = 'SOCIAL_ACCOUNT_MISMATCH';
        throw error;
      }
      instance.bind({ ownerMid, selfMid: self });
      await persistSocial();
      return socialStatusOf(instance);
    },

    async socialGrant({ actor, scopes, ttlMs, capabilities, dailySendMax } = {}) {
      requireSocialUser(actor);
      const instance = await ensureSocial();
      const self = await currentSelfMid();
      const current = instance.status();
      if (!current.ownerMid || String(current.selfMid) !== self) {
        const error = new Error('请先绑定 ownerMid，并确认绑定账号与当前登录账号一致');
        error.code = 'SOCIAL_BINDING_REQUIRED';
        throw error;
      }
      const { grant } = instance.mint({
        actor, selfMid: self, scopes, ttlMs, capabilities,
        dailySendMax: dailySendMax ?? 0,
      });
      // 经认证用户显式重新授权后，新会话级失败关闭标记解除。
      socialRevoked = false;
      await persistSocial();
      return { grant, status: socialStatusOf(instance) };
    },

    async socialRevoke({ actor } = {}) {
      requireSocialUser(actor);
      // 紧急撤销：先同步让未使用的一次性 intent 失效并失败关闭发送，
      // 再做可能失败的异步清理；ensureSocial 失败时旧 grant 也不能继续使用。
      socialRevoked = true;
      operations?.revokeIntents?.();
      // 本登录会话内不再自动重授；只有重新扫码（新会话）才恢复默认授权。
      autoGrantSuppressed = true;
      const instance = await ensureSocial();
      const result = instance.revokeAll();
      return { ...result, status: socialStatusOf(instance) };
    },

    async socialSend({ intentId, text, intent, provenance = [], actor } = {}) {
      const caller = toCaller(actor);
      // 旧路径（没有 operations）保留原门禁，避免既有测试行为回归。
      if (!operations && actor?.kind !== 'autonomy') {
        const error = new Error('只有 Autonomy 可调用私信发送服务');
        error.code = 'SOCIAL_ACTOR_DENIED';
        throw error;
      }
      if (socialRevoked) {
        const error = new Error('本会话的私信发送已被登出或紧急撤销，必须先重新授权');
        error.code = 'SOCIAL_REVOKED';
        throw error;
      }
      const instance = await ensureSocial();
      const live = loginSnapshot();
      const status = socialStatusOf(instance);
      const context = {
        loggedIn: live.loggedIn,
        sessionId: live.sessionId,
        selfMid: status.selfMid,
        ownerMid: status.ownerMid,
        targetMid: status.ownerMid,
        contentProvenance: Array.isArray(provenance) ? provenance.slice(0, 20) : [],
        intent,
        caller,
      };
      return runCapability('dm.send', { intentId, text, actor, intent }, caller, context, async () => {
        requireSocialTransport(instance, 'send');
        const selfMid = await currentSelfMid();
        const result = await instance.sendAsGranted({ intentId, text, selfMid });
        await persistSocial();
        return { ...result, requestStats: instance.transportStats?.() ?? null };
      });
    },

    async socialReceive({ cursor = null, size = 20, actor, intent, intentId } = {}) {
      const caller = toCaller(actor);
      if (!operations && actor?.kind !== 'autonomy') {
        const error = new Error('只有 Autonomy 可调用私信接收服务');
        error.code = 'SOCIAL_ACTOR_DENIED';
        throw error;
      }
      if (operations && caller.kind !== 'autonomy' && !(caller.kind === 'owner-chat' && caller.trusted === true)) {
        const error = new Error('只有 Autonomy 或可信用户聊天可以读取私信');
        error.code = 'SOCIAL_ACTOR_DENIED';
        throw error;
      }
      if (socialRevoked) {
        const error = new Error('本会话的私信读取已被登出或紧急撤销，必须先重新授权');
        error.code = 'SOCIAL_REVOKED';
        throw error;
      }
      const instance = await ensureSocial();
      const live = loginSnapshot();
      const status = socialStatusOf(instance);
      const context = {
        loggedIn: live.loggedIn,
        sessionId: live.sessionId,
        selfMid: status.selfMid,
        ownerMid: status.ownerMid,
        targetMid: status.ownerMid,
        contentProvenance: ['owner-dm'],
        intent,
        caller,
      };
      return runCapability('dm.read', { cursor, size, actor, intentId }, caller, context, async () => {
        requireSocialTransport(instance, 'read');
        const selfMid = await currentSelfMid();
        const result = await instance.receiveAsGranted({ cursor, size, selfMid });
        return { ...result, requestStats: instance.transportStats?.() ?? null };
      });
    },

    async socialResolve({ intentId, status, actor, reason = '' } = {}) {
      requireSocialUser(actor);
      const instance = await ensureSocial();
      const result = instance.resolveManually(intentId, { status, actor, reason });
      await persistSocial();
      return result;
    },

    async socialArchive({ before, actor } = {}) {
      requireSocialUser(actor);
      const instance = await ensureSocial();
      const result = instance.archive({ before });
      await persistSocial();
      return result;
    },
  };

  return service;
}

