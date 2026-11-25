// 真实传输通道样板：HTTP 聊天入口/出口。
// 与 DSH、B 站无关；GUI 或 B 站适配器按同一契约实现即可。
//
// 注意：这是**测试/本机样板**，没有被 lib/index.js 注册；不要把它直接接进正式环境。
// 必须提供 token，请求需带 `Authorization: Bearer <token>`，否则一律 401。
import { createServer } from 'node:http';

const MAX_BODY = 64 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('请求体过大'), { code: 'body-too-large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/**
 * 启动一个本机 HTTP 聊天通道。
 * - POST {path} {text} → 投一条 owner-message，等内核空闲后返回本轮 her 的回复
 * - GET  {path}/health → {ok:true}
 * 传输只是把 send 意图收进 outbox 并回执，不接任何外部平台。
 */
export function createHttpChatChannel({
  facade,
  getService,
  host = '127.0.0.1',
  port = 0,
  path = '/cognition/chat',
  token = '',
  clock = Date.now
} = {}) {
  if (!facade || typeof facade.setTransport !== 'function') {
    throw new TypeError('createHttpChatChannel 需要 cognition-bus facade');
  }
  if (typeof getService !== 'function') {
    throw new TypeError('createHttpChatChannel 需要 getService()');
  }
  if (typeof token !== 'string' || token.length < 16) {
    throw new TypeError('createHttpChatChannel 需要至少 16 位 token；未鉴权的 HTTP 入口不得使用');
  }

  const outbox = [];
  let seq = 0;
  let closed = false;

  facade.setTransport(async (intent) => {
    const text = typeof intent?.text === 'string' ? intent.text : '';
    outbox.push({ text, correlationId: intent?.correlationId ?? null, at: clock() });
    return { ok: true, messageId: `http-dm-${outbox.length}` };
  });

  async function submit(text) {
    if (typeof text !== 'string' || text.trim() === '') {
      throw Object.assign(new Error('消息不能为空'), { code: 'empty-message' });
    }
    const before = outbox.length;
    const at = clock();
    // 进程重启后 seq 会从 0 开始；id 必须全局唯一，否则会被内核的 recentEventIds 当成重投。
    const id = `http-${at}-${++seq}`;
    const service = getService();
    if (service && facade.status && facade.bind && facade.status().bound === false) {
      facade.bind(service);
    }
    await facade.bus.ingest({
      id,
      type: 'owner-message',
      at,
      actor: { kind: 'owner', authenticated: true },
      payload: { text }
    });
    const liveService = getService();
    if (liveService?.idle) await liveService.idle();
    return { id, at, replies: outbox.slice(before).map((item) => item.text).filter(Boolean) };
  }

  const server = createServer(async (req, res) => {
    try {
      const authorization = String(req.headers.authorization ?? '');
      if (authorization !== `Bearer ${token}`) {
        sendJson(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      const url = new URL(req.url ?? '/', `http://${host}`);
      if (req.method === 'GET' && url.pathname === `${path}/health`) {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method !== 'POST' || url.pathname !== path) {
        sendJson(res, 404, { ok: false, error: 'not-found' });
        return;
      }
      const raw = await readBody(req);
      let body;
      try {
        body = raw === '' ? {} : JSON.parse(raw);
      } catch {
        sendJson(res, 400, { ok: false, error: 'invalid-json' });
        return;
      }
      const result = await submit(body.text);
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      const code = error?.code ?? 'channel-error';
      const status = code === 'empty-message' ? 400 : code === 'body-too-large' ? 413 : 500;
      sendJson(res, status, { ok: false, error: code, message: error?.message ?? String(error) });
    }
  });

  return {
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      const address = server.address();
      const actual = typeof address === 'object' && address ? address.port : port;
      return { url: `http://${host}:${actual}${path}`, port: actual };
    },
    submit,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}
