// bus UI API：CSRF、读取、保存时段、当前段修改；不启动真实 webServer。
const LIB = new URL('../packages/bus/lib/ui/routes.js', import.meta.url).href;
const { registerBusUi } = await import(LIB);
const S = await import(new URL('../packages/bus/lib/tick-schedule.js', import.meta.url).href);

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('PASS', name); }
  else { fail += 1; console.log('FAIL', name, extra); }
};

const routes = new Map();
let schedule = {
  segments: [
    { start: '00:00', end: '08:00', tickMs: 7_200_000 },
    { start: '08:00', end: '24:00', tickMs: 1_800_000 }
  ],
  current: { start: '08:00', end: '24:00', tickMs: 1_800_000 },
  nextTickAt: new Date(Date.now() + 60_000).toISOString()
};
const facade = {
  schedule: () => schedule,
  setSchedule: segments => { const checked = S.normalizeSegments(segments); if (!checked.ok) throw new Error(checked.errors.join('；')); schedule = { ...schedule, segments: checked.segments }; return { segments: checked.segments }; },
  setHeartbeat: ms => ({ tickMs: ms })
};
const ctx = {
  get: name => name === 'webServer'
    ? { register: ({ path, handler }) => { routes.set(path, handler); return () => routes.delete(path); } }
    : name === 'connection'
      ? { requestRejection: () => false }
      : null
};

const dispose = registerBusUi({ ctx, facade });

async function call(path, { method = 'GET', headers = {}, body = null } = {}) {
  const handler = routes.get(path);
  if (!handler) throw new Error(`route missing: ${path}`);
  const req = {
    method,
    headers,
    url: path,
    async *[Symbol.asyncIterator]() { if (body !== null) yield Buffer.from(JSON.stringify(body)); }
  };
  let status = 200;
  let text = '';
  const res = {
    setHeader() {},
    set statusCode(v) { status = v; },
    get statusCode() { return status; },
    end(chunk) { text = chunk ?? ''; }
  };
  await handler(req, res);
  return { status, body: text ? JSON.parse(text) : null };
}

const csrfRes = await call('/bus/api/csrf');
check('拿到 CSRF', csrfRes.status === 200 && typeof csrfRes.body?.token === 'string' && csrfRes.body.token.length > 10);

const getRes = await call('/bus/api/schedule');
check('读取时段', getRes.status === 200 && getRes.body?.segments?.length === 2, JSON.stringify(getRes.body));

const noCsrf = await call('/bus/api/schedule', { method: 'POST', body: { segments: schedule.segments } });
check('POST 缺 CSRF 被拒', noCsrf.status === 403);

const post = await call('/bus/api/schedule', {
  method: 'POST',
  headers: { 'x-csrf-token': csrfRes.body.token },
  body: { segments: [{ start: '00:00', end: '24:00', tickMs: 3_600_000 }] }
});
check('保存单段', post.status === 200 && post.body?.segments?.length === 1);

const bad = await call('/bus/api/schedule', {
  method: 'POST',
  headers: { 'x-csrf-token': csrfRes.body.token },
  body: { segments: [{ start: '00:00', end: '23:00', tickMs: 3_600_000 }] }
});
check('空档被服务端拒绝', bad.status === 400);

const cur = await call('/bus/api/current-tick', {
  method: 'POST',
  headers: { 'x-csrf-token': csrfRes.body.token },
  body: { minutes: 45 }
});
check('修改当前段成功', cur.status === 200 && cur.body?.tickMs === 2_700_000, JSON.stringify(cur.body));

const curBad = await call('/bus/api/current-tick', {
  method: 'POST',
  headers: { 'x-csrf-token': csrfRes.body.token },
  body: { minutes: 0 }
});
check('非法分钟被拒', curBad.status === 400);

dispose();
check('注销路由', routes.size === 0, String(routes.size));

console.log(`\n结果：pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);

