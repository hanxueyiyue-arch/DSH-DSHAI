// 四项上线前修复的最小回归测试（在候选仓内运行）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const pkg = name => new URL(`../packages/${name}/`, import.meta.url).href;

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('PASS', name); }
  else { fail += 1; console.log('FAIL', name, extra); }
};

// ---------- 1. Bus 浏览工具不再匿名兜底 ----------
{
  const { createBilibiliBrowseTool } = await import(`${pkg('bus')}lib/tools/bilibili.js`);
  const source = readFileSync(new URL('../packages/bus/lib/tools/bilibili.js', import.meta.url), 'utf8');

  const noService = await createBilibiliBrowseTool({ getService: () => null }).invoke({ max: 1 });
  check('无 bilibili 服务时拒绝而不是匿名请求', noService.ok === false && noService.error?.code === 'bilibili-unavailable', JSON.stringify(noService));

  const refused = await createBilibiliBrowseTool({
    getService: () => ({ observePopular: async () => { throw Object.assign(new Error('未登录'), { code: 'BILIBILI_NOT_LOGGED_IN' }); } })
  }).invoke({ max: 1 });
  check('bilibili 拒绝时透传错误码', refused.ok === false && refused.error?.code === 'BILIBILI_NOT_LOGGED_IN', JSON.stringify(refused));

  const ok = await createBilibiliBrowseTool({
    getService: () => ({ observePopular: async () => ({ videos: [{ bvid: 'BV1xx', title: 't', owner: 'u' }] }) })
  }).invoke({ max: 1 });
  check('正常经 bilibili 服务返回', ok.ok === true && ok.via === 'bilibili-service' && ok.items?.[0]?.bvid === 'BV1xx', JSON.stringify(ok));

  check('工具文件里没有匿名 fetch / 热门 API', !/fetch\(|api\.bilibili\.com|POPULAR/.test(source));
}

// ---------- 2. owner-session 尊重 accepted ----------
{
  const { createOwnerSession } = await import(`${pkg('bus')}lib/channels/owner-session.js`);
  let reply = { accepted: false, error: 'EVENT_QUEUE_FULL' };
  let ingestCalls = 0;
  const message = { messageId: 'm1', from: '10001', text: '你好', at: Date.now() };
  const session = createOwnerSession({
    bili: { socialReceive: async () => ({ messages: [message] }) },
    facade: { bus: { ingest: async () => { ingestCalls += 1; return reply; } } },
    getService: () => ({ idle: async () => {} }),
    ownerMid: '10001',
    latestOnly: true,
    clock: () => Date.now()
  });

  await session.pollOnce();
  check('accepted:false 不推进接收', session.status().accepted === 0 && session.status().rejected === 1, JSON.stringify(session.status()));

  reply = { accepted: true, duplicate: false };
  await session.pollOnce();
  check('后续接受成功', session.status().accepted === 1, JSON.stringify(session.status()));

  reply = { accepted: true, duplicate: true };
  const before = session.status().accepted;
  await session.pollOnce();
  check('重复消息单独计数、不重复接受', session.status().accepted === before && session.status().duplicates === 1, JSON.stringify(session.status()));
  check('ingest 至少被调用两次', ingestCalls >= 2, String(ingestCalls));
}

// ---------- 3. Cognition 无 usage 不释放预留 ----------
{
  const { createBudgetGate } = await import(`${pkg('cognition')}lib/decide/budget-gate.js`);
  let settle = 0;
  let release = 0;
  const budget = {
    reserve: async () => {},
    settle: async () => { settle += 1; },
    release: async () => { release += 1; }
  };
  const gate = createBudgetGate({ getBudget: () => budget });

  await gate.wrap({ kind: 'decision', provider: 'p', model: 'm' }, async () => ({ result: { ok: true }, usage: null }));
  check('无 usage 时不 release', release === 0 && settle === 0, `release=${release} settle=${settle}`);

  await gate.wrap({ kind: 'decision', provider: 'p', model: 'm' }, async () => ({ result: { ok: true }, usage: { inputTokens: 10, outputTokens: 5 } }));
  check('有 usage 时 settle', settle === 1 && release === 0, `release=${release} settle=${settle}`);
}

// ---------- 4. HTTP 测试入口必须鉴权 ----------
{
  const { createHttpChatChannel } = await import(`${pkg('bus')}lib/channel-http.js`);
  let threw = false;
  try { createHttpChatChannel({ facade: {}, getService: () => ({}) }); } catch { threw = true; }
  check('缺 token 拒绝创建', threw === true);

  const facade = {
    setTransport() {},
    status: () => ({ bound: true }),
    bus: { ingest: async () => ({ accepted: true }) }
  };
  const token = 'test-token-1234567890';
  const channel = createHttpChatChannel({
    facade,
    getService: () => ({ idle: async () => {} }),
    token
  });
  const info = await channel.start();
  try {
    const unauthorized = await fetch(info.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi' }) });
    check('无 token 返回 401', unauthorized.status === 401);

    const authorized = await fetch(info.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: 'hi' })
    });
    check('带 token 可以提交', authorized.status === 200);
  } finally {
    await channel.close();
  }
}

console.log(`\n结果：pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
