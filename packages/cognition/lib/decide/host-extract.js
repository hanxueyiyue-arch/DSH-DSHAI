// 记忆抽取模型适配器：把一批 turn episode 交给宿主 agent，取回候选记忆 JSON。
// 与 host-agent-model 同样的会话约束：无工具、一次性会话、超时即弃。
// 只产出候选；落盘校验由 memory/extract.js 与 write.addMemory 负责。

import { randomUUID } from 'node:crypto';

const HARNESS_MARK = 'cognition-extract';

const SYSTEM_PROMPT = [
  '你是记忆抽取器。输入是一批刚发生的对话轮次（userText 是用户说的话，selfText 是你说的话）。',
  '只输出一个 JSON 对象：{"memories":[{"kind":"fact|inference|uncertain","layer":"episodic|preference","title":"","content":"","quote":"","confidence":0.6,"importance":3,"tags":[]}]}',
  '规则：',
  '1. 只记录输入里明确出现的信息，不推测、不补全、不编造。',
  '1b. 每条必须给 quote：从 userText 里逐字复制的片段，不改写、不跨句、不拼接。quote 会与原文核对；对不上的候选会被直接丢弃。',
  '1c. 否定必须保留。quote 里出现「不 / 别 / 没 / 未 / 无 / 讨厌 / 不喜欢」这类否定时，content 必须保留否定语义。',
  '    例：userText「我不太喜欢别人叫我老板」→ 只能记「用户不喜欢被叫老板」，绝不能记成「用户叫老板」或「用户称呼是我叫老板」。',
  '    例：userText「我对猫毛过敏，别推荐有猫的地方」→ 记「用户对猫毛过敏」+「不要推荐有猫的地方」，不能省掉否定。',
  '2. 最多 3 条；没有值得长期记的就输出 {"memories":[]}。',
  '3. 用户明确表达偏好时 layer=preference；其余 episodic。',
  '4. selfText 是你自己说过的话，不是事实依据：不要从自己的回复里提取用户的习惯、经历或偏好。',
  '5. 没有用户原话直接支持的推断，kind 必须是 inference 或 uncertain，不能写 fact。',
  '6. title 不超过 40 字，content 不超过 300 字；tags 用 1–3 个短词。',
  '7. 不要记录寒暄、语气词、临时的情绪波动。',
  // 2026-11-24：线上 36 条记忆正文把她写成了「助手/助理」（含11条 preference），
  // 而她的名字是助手、用户 11-19 已明确要求不要自称助手。根因不是她嘴的问题，
  // 是抽取这一步缺一条"怎么指代她自己"的规矩——模型只好默认用「助手」。
  '8. 指代你自己时，一律用「我」「我的」；**禁止**用「助手」「助理」「AI」「机器人」称呼或指代你自己，转述用户的话时同样（不要写「用户让助手继续逛B站」，要写「用户让我继续逛B站」；不要写「用户希望助手主动说话」，要写「用户希望我主动说话」）。'
].join('\n');

function buildMessage(prompt) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(prompt ?? '') }],
    source: { kind: 'user', harness: HARNESS_MARK }
  };
}

function parseCandidateJson(text) {
  let raw = String(text ?? '').trim();
  if (!raw) return [];
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1));
      if (Array.isArray(parsed)) return parsed;
      if (Array.isArray(parsed?.memories)) return parsed.memories;
    } catch { /* 落到下面的数组尝试 */ }
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

export function createHostExtractTurn({
  ctx,
  provider = 'deepseek-account',
  model = 'deepseek-flash',
  maxOutputTokens = 600,
  timeoutMs = 120_000,
  reasoningEffort = 'off',
  budgetGate = null,
  logger = console
} = {}) {
  async function extractOnce({ episodes = [] } = {}) {
    const agents = ctx?.get?.('agents');
    if (!agents || typeof agents.create !== 'function') {
      throw new Error('宿主 agent 服务不可用');
    }
    const sessionId = `${HARNESS_MARK}-${randomUUID()}`;
    let output = '';
    let failure = null;
    let usage = null;
    const off = typeof ctx.on === 'function'
      ? ctx.on('session/event', (session, event) => {
        if (session?.id !== sessionId) return;
        if (event?.type === 'turn/end') {
          const reason = event.data?.reason;
          if (reason?.kind === 'error') failure = new Error(String(reason.error?.message ?? '记忆抽取失败'));
          return;
        }
        if (event?.type !== 'assistant/message') return;
        usage = event.data?.message?.usage ?? event.data?.usage ?? usage;
        const blocks = event.data?.message?.content;
        if (!Array.isArray(blocks)) return;
        const text = blocks
          .filter((block) => block?.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('');
        if (text) output = text.slice(-4000);
      })
      : null;

    let handle = null;
    let timer = null;
    try {
      handle = await agents.create({
        sessionId,
        agentOptions: {
          provider,
          model,
          ...(reasoningEffort ? { reasoningEffort } : {}),
          maxTokens: maxOutputTokens
        }
      });
      const scoped = handle.agent?.ctx;
      if (scoped?.tools && typeof scoped.tools.restrict === 'function') {
        scoped.tools.restrict({ allow: [] });
      }
      const sessionTitle = ctx?.get?.('sessionTitle');
      if (sessionTitle && typeof sessionTitle.rename === 'function') {
        sessionTitle.rename(handle.agent?.session, 'DSHAI 记忆抽取');
      }
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('记忆抽取超时')), timeoutMs);
        timer.unref?.();
      });
      const run = (async () => {
        await handle.agent.followup(buildMessage(`${SYSTEM_PROMPT}\n\n${JSON.stringify({ episodes })}`));
        if (typeof handle.agent.whenIdle === 'function') await handle.agent.whenIdle();
      })();
      await Promise.race([run, timeout]);
      if (failure) throw failure;
      return { result: parseCandidateJson(output), usage };
    } catch (error) {
      logger?.warn?.('[cognition] 记忆抽取模型失败', { error: error?.message });
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      off?.();
      try { await handle?.dispose?.(); } catch { /* 会话拆除失败不影响结果 */ }
    }
  }

  async function extractTurn(input = {}) {
    if (!budgetGate) return (await extractOnce(input)).result;
    const { result } = await budgetGate.wrap(
      { kind: 'extract', provider, model, maxOutputTokens },
      () => extractOnce(input)
    );
    return result;
  }

  return extractTurn;
}
