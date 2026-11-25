import z from '@deepseek-ai/schemastery';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createBiliClient } from './client.js';
import { createAccount } from './account.js';
import { createBilibiliService, BILIBILI_SERVICE, PUBLIC_METHODS } from './service.js';
import { bilibiliTools, stringOutput } from './tools.js';
import { registerBilibiliDashboard } from './dashboard.js';
import { createWebRetry } from './web-retry.js';
import { readState, updateState, POLICY_FILE, POLICY_META_FILE } from './storage.js';
import { createSocialRequest } from './social-request.js';
import { createRealSocialTransport } from './social-transport.js';
import { createCapabilityPolicy } from './capability-policy.js';
import { createOperations } from './operations.js';
import { createIntentVerifier } from './intent-verifier.js';
import { loadTestHooks, requireTestHook } from './test-hooks.js';
import { socialTransportMode } from './social-mode.js';

export const name = 'dsh-dshai-bilibili';

// 只依赖 tools；brainmem / autonomy 通过 ctx.get() 可选读取，缺席即降级。
export const inject = ['tools'];

export const Config = z.object({
  fishName: z.string().default('助手').description('助手的名字，仅在观察结果中展示'),
  readHourly: z.number().default(300).description('B 站公开接口每小时读取上限（30-3000，按滚动小时）'),
  readDaily: z.number().default(2000).description('B 站公开接口每日读取上限（100-10000，按 UTC 计数日）'),
  // 用户私信通道默认开启读取与发送；可用 none / real-read 显式降级。
  socialTransport: z.string().default('none').description('私信通道：real-send（读取+发送）、real-read（只读）或 none（默认）'),
  // 登录即授权（指南 §0.8）：成功扫码且绑定严格一致时，自动签发 dm:owner read+send
  // 会话级 grant。置 false 恢复“必须手动 socialGrant”的旧行为。
  // 默认 false —— 且它与 socialTransport 是两道独立开关：只开其中一道不会产生发送能力。
  socialAutoGrant: z.boolean().default(false).description('扫码登录成功后自动签发用户私信会话授权（默认 false；需与 socialTransport 同时开启）'),
  ownerMid: z.string().default('').description('用户 B 站 mid；留空则需手动 socialBind。仅在 socialAutoGrant 也为 true 时，扫码后才会自动绑定并签发私信授权'),
  intentProvider: z.string().default('dsh-dshai-autonomy').description('Ed25519 意图公钥的可信提供者 fiber 名（隔离测试可覆盖）'),
  testHooks: z.string().default('').description('仅隔离测试装配使用；指向 CommonJS 测试钩子模块，生产必须为空'),
});

export { PUBLIC_METHODS, BILIBILI_SERVICE };

export function apply(ctx, config = {}) {
  const fishName = String(config.fishName || '助手').slice(0, 50);
  const readHourly = Math.max(30, Math.min(3000, Number(config.readHourly) || 300));
  const readDaily = Math.max(100, Math.min(10000, Number(config.readDaily) || 2000));
  const ownerMidRaw = String(config.ownerMid || '').trim();
  if (ownerMidRaw && !/^[0-9]{5,20}$/.test(ownerMidRaw)) {
    throw new Error('ownerMid 必须是 5-20 位 B 站 mid');
  }
  const testHooks = loadTestHooks({
    configPath: config.testHooks,
    env: process.env.DSH_HOST_TEST_ASSEMBLY,
    requireModule: createRequire(import.meta.url),
  });
  const testMode = Boolean(testHooks);
  const client = testMode
    ? requireTestHook(testHooks, 'createClient')({ readHourly, readDaily })
    : createBiliClient({ readHourly, readDaily });
  if (!client) throw new Error('TEST_HOOKS_INCOMPLETE: createClient returned null');

  // account and social transport are built only after the client exists.
  const account = testMode
    ? requireTestHook(testHooks, 'createAccount')({ client, store: { readState, updateState } })
    : createAccount({ client, store: { readState, updateState } });
  if (!account) throw new Error('TEST_HOOKS_INCOMPLETE: createAccount returned null');
  ctx.effect(() => () => account.dispose());

  // 默认 real-send：真实读取与受控发送都开启；发送仍受 owner 绑定、每日上限、
  // 授权、Budget、幂等与结果确认约束。
  const mode = socialTransportMode(config.socialTransport);
  const socialTransport = !mode.enabled
    ? null
    : testMode
      ? requireTestHook(testHooks, 'createSocialTransport')({
        account,
        readEnabled: mode.readEnabled,
        sendEnabled: mode.sendEnabled,
      })
      : createRealSocialTransport({
        request: createSocialRequest({ account }),
        readEnabled: mode.readEnabled,
        sendEnabled: mode.sendEnabled,
      });
  if (testMode && mode.enabled && !socialTransport) {
    throw new Error('TEST_HOOKS_INCOMPLETE: createSocialTransport returned null');
  }

  // 阶段 1a：行为限制独立于登录会话持久化；文件缺失/损坏时由 Policy fail-closed。
  const policy = createCapabilityPolicy({ filePath: POLICY_FILE, metaPath: POLICY_META_FILE });
  const intents = createIntentVerifier({
    ctx,
    expectedProvider: config.intentProvider || 'dsh-dshai-autonomy',
  });
  const operations = createOperations({ policy, intents });
  if (!operations) throw new Error('Bilibili 生产装配必须创建统一 Operations');

  // 敏感管理能力的私有对象：只交给 dashboard 与服务内部，普通插件拿不到。
  const adminSession = Object.freeze({ id: randomUUID() });
  const service = createBilibiliService({
    client, fishName, readHourly, readDaily,
    getAutonomy: () => ctx.get('autonomy'),
    account,
    socialTransport,
    socialAutoGrant: config.socialAutoGrant === true,
    ownerMid: ownerMidRaw,
    operations,
    adminSession,
  });

  // 形状守卫：公开面必须与 PUBLIC_METHODS 完全一致，防止偷传内部方法。
  for (const key of Object.keys(service)) {
    if (!['name', 'version', ...PUBLIC_METHODS].includes(key)) {
      throw new Error(`bilibili 服务接口出现未登记成员 ${key}；请先更新 PUBLIC_METHODS`);
    }
  }

  ctx.provide(BILIBILI_SERVICE, service);
  if (process.env.DSH_HOST_TEST_ASSEMBLY === '1') {
    ctx.provide('bilibili-admin-session', adminSession);
  }

  for (const item of bilibiliTools(service)) {
    ctx.tools.register(defineTool({ ...item, output: stringOutput, timeoutMs: 20_000 }));
  }

  // 独立账号/许可面板：只依赖本插件服务。没有 webServer（headless）时静默跳过。
  ctx.effect(() => {
    const retry = createWebRetry({
      getWebServer: () => (typeof ctx.get === 'function' ? ctx.get('webServer') : undefined),
      register: () => registerBilibiliDashboard(ctx, { getService: () => service, adminSession }),
      log: error => console.warn('[dsh-dshai-bilibili] 设置页注册失败，稍后重试：' + (error?.message || error)),
    });
    retry.start();
    return () => retry.stop();
  }, 'dsh-dshai-bilibili: account dashboard');
}


