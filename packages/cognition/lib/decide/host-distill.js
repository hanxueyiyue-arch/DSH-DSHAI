// 浏览经历提炼器：把一次浏览压成 1–2 句可回忆的事实（仍然写进同一个 memory.json）。
// 与记忆抽取器同样的会话约束：无工具、一次性会话、超时即弃。
import { randomUUID } from 'node:crypto';

const HARNESS_MARK = 'cognition-distill';

const SYSTEM_PROMPT = [
  '你是浏览经历提炼器。输入是一次浏览得到的观察记录（title 是视频/内容标题，content 是原文摘录）。',
  '任务：把它压缩成能被她以后回忆起来的短句。',
  '只输出一个 JSON 对象：{"items":[{"fromId":"输入里的 id","title":"","content":"","tags":[]}]}',
  '规则：',
  '1. 只使用输入里出现的信息，不推测、不补全、不编造。',
  '2. content 用「我看了……」或「我看到……」开头，1–2 句，不超过 120 字；保留关键名词：作品名、角色、数字、时间点、地点。',
  '3. title 不超过 24 字，用作品/主题名，不要照抄长标题。',
  '4. tags 用 1–3 个短词（例如「游戏」「B站」「预告」）。',
  '5. 原文里没有实质内容的（只有「一次浏览」「没有内容」），输出 {"items":[]}。',
  '6. 不要写评论、不要写建议、不要写「用户」相关的内容。'
].join('\n');

function buildMessage(prompt) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(prompt ?? '') }],
    source: { kind: 'user', harness: HARNESS_MARK }
  };
}

function parseJson(text) {
  let raw = String(text ?? '').trim();
  if (!raw) return [];
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1));
      if (Array.isArray(parsed?.items)) return parsed.items;
      if (Array.isArray(parsed)) return parsed;
    } catch { /* 落到数组尝试 */ }
  }
  const a = raw.indexOf('[');
  const b = raw.lastIndexOf(']');
  if (a >= 0 && b > a) {
    try {
      const parsed = JSON.parse(raw.slice(a, b + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch { /* 忽略 */ }
  }
  return [];
}

export function createHostDistillTurn({
  ctx,
  provider = 'deepseek-account',
  model = 'deepseek-flash',
  maxOutputTokens = 400,
  timeoutMs = 120_000,
  reasoningEffort = 'off',
  budgetGate = null,
  logger = console
} = {}) {
  async function distillOnce({ observations = [] } = {}) {
    const agents = ctx?.get?.('agents');
    if (!agents || typeof agents.create !== 'function') throw new Error('宿主 agent 服务不可用');
    const sessionId = `${HARNESS_MARK}-${randomUUID()}`;
    let output = '';
    let failure = null;
    // 必须把 provider 的 usage 带回给预算闸门：拿不到 usage 时 gate 不肯结算，
    // 预留会一直挂着、按 TTL 变成 uncertain 并永久占用当日额度。
    let usage = null;
    const off = typeof ctx.on === 'function'
      ? ctx.on('session/event', (session, event) => {
          if (session?.id !== sessionId) return;
          if (event?.type === 'turn/end') {
            const reason = event.data?.reason;
            if (reason?.kind === 'error') failure = new Error(String(reason.error?.message ?? '浏览提炼失败'));
            return;
          }
          if (event?.type !== 'assistant/message') return;
          usage = event.data?.message?.usage ?? event.data?.usage ?? usage;
          const blocks = event.data?.message?.content;
          if (!Array.isArray(blocks)) return;
          const text = blocks.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('');
          if (text) output = text.slice(-4000);
        })
      : null;

    let handle = null;
    let timer = null;
    try {
      handle = await agents.create({
        sessionId,
        agentOptions: { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}), maxTokens: maxOutputTokens }
      });
      const scoped = handle.agent?.ctx;
      if (scoped?.tools && typeof scoped.tools.restrict === 'function') scoped.tools.restrict({ allow: [] });
      const sessionTitle = ctx?.get?.('sessionTitle');
      if (sessionTitle && typeof sessionTitle.rename === 'function') {
        sessionTitle.rename(handle.agent?.session, 'DSHAI 浏览提炼');
      }
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('浏览提炼超时')), timeoutMs);
        timer.unref?.();
      });
      const run = (async () => {
        await handle.agent.followup(buildMessage(`${SYSTEM_PROMPT}\n\n${JSON.stringify({ observations })}`));
        if (typeof handle.agent.whenIdle === 'function') await handle.agent.whenIdle();
      })();
      await Promise.race([run, timeout]);
      if (failure) throw failure;
      // 与 host-extract 同形：run() 必须交回 { result, usage }，
      // 否则 gate 既结算不了（钱漏账）也取不到 result（提炼结果被丢）。
      return { result: parseJson(output), usage };
    } catch (error) {
      logger?.warn?.('[cognition] 浏览提炼模型失败', { error: error?.message });
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      off?.();
      try { await handle?.dispose?.(); } catch { /* 拆除失败不影响结果 */ }
    }
  }

  async function distillTurn(input = {}) {
    // 没有预算闸门时直接返回结果数组（与 host-extract 的 extractTurn 同形）。
    if (!budgetGate) return (await distillOnce(input)).result;
    // 有闸门时必须把 result 取出来再返回：gate.wrap 返回的是 { result, budget }。
    // 之前这里直接 return wrap(...)，调用方把它当数组用 → Array.isArray 为假 → 提炼结果全丢。
    const { result } = await budgetGate.wrap(
      { kind: 'distill', provider, model, maxOutputTokens },
      () => distillOnce(input)
    );
    return result;
  }

  return distillTurn;
}
