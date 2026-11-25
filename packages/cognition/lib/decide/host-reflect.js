// 反思模型适配器：把一批已发生的 turn 经历交给宿主 agent，取回有证据引用的 insight JSON。
// 与 host-extract 相同的会话约束：一次性会话、无工具、超时即弃、只产出候选。

import { randomUUID } from 'node:crypto';

const HARNESS_MARK = 'cognition-reflect';

const SYSTEM_PROMPT = [
  '你是长时认知的反思器。输入是若干条真实发生的对话轮次（episode），每条有 id、at、userText、selfText。',
  '只输出一个 JSON 对象：{"insights":[{"title":"","content":"","evidence":["episode-id"],"confidence":0.6}],"tendencies":[{"label":"","statement":"","evidence":["episode-id"],"confidence":0.6,"polarity":"support|counter"}],"speakHabits":[{"label":"","statement":"","dimension":"","scope":"core|context","contexts":[],"evidence":["episode-id"],"confidence":0.6}]}',  '规则：',
  '1. evidence 只能填输入 episodes 里真实出现的 id，至少一条；不得引用输入里没有的 episode、memory 或 insight。',
  '2. 只依据输入中的真实经历形成理解；不推测、不补全、不编造。',
  '3. selfText 是你自己说过的话，不能当成用户事实或外部事实的证据。',
  '4. 区分“曾经一起谈及”和“存在因果/情感/偏好联系”；只是同一次对话里出现，不足以断言两件事语义相关。',
  '5. 最多 3 条 insight；没有形成有证据的稳定理解时输出 {"insights":[]}。',
  '6. title 不超过 40 字，content 不超过 240 字；用第一人称陈述你的理解，不写建议清单。',
  '6c. 如果输入里已有 tendencyLabels，能表达同一件事就复用那个 label，不要换个说法造新标签；只有确实不同才新建。',
  '6b. tendencies 是对“我倾向于怎么做”的**描述**，不是建议、不是规则、不是承诺。写法示例：{"label":"被质疑时先查证据","statement":"被质疑时，我倾向于先翻记录再回答","confidence":0.6}。禁止写成“我应该…”“以后要…”。最多 2 条；没有就输出空数组。',
  '6d. 反证：如果这段经历里你的实际表现**和 tendencyLabels 里某条已有倾向不一致**（那条说你被质疑先查证据，这次你却先下结论），可以输出那条倾向并加 "polarity":"counter"，例如 {"label":"被质疑先查证据","polarity":"counter","evidence":["episode-id"],"confidence":0.6}。',
  '6e. counter 的 label 必须和 tendencyLabels 里的 label **逐字一致**，不要改写法、不要新造标签；counter 不需要写 statement。标签对不上的会被系统直接丢弃。',
  '6f. counter 只用于真实的反差（这次没那样做、反应正好相反），不是用来表达“我不确定”或“这条不重要”；没把握就别写。',
  '6g. 同一条倾向在同一次输出里最多出现一次；不要既支持又反证。',
  '7. 不确定就降低 confidence，不要用“总是/一定/从来”这类无证据的绝对说法。',
  '7b. speakHabits 只从用户对“说话方式/语气/措辞”的明确反应里提炼（嫌太正式、嫌罗嗦、喜欢短句、某类说法被纠正或被认可）。最多 1 条；没有就输出空数组。',
  '7c. speakHabits 的 statement 写“我倾向于……”，不是规则、不是“我应该/以后要”；label 不超过 20 字，confidence 0.4–0.8。只写表达方式，不要把话题偏好、内容喜好写成说话习惯。',
  '7d. 没有用户对说话方式的直接反应时，不要从 selfText 自己猜；宁可输出空数组。',
  '7e. dimension 是这条习惯管的维度（如 正式度 / 句子长度 / 直接程度 / 安慰 / 解释 / 闲聊 / 不追问），同一个维度只保留一条；如果已有 speakHabitDimensions 里的维度表达同一件事，**逐字复用**它。',
  '7f. scope=core 表示平时都适用；scope=context 表示只在某些情境用，contexts 只能从 comfort / explain / casual / task / owner_low / not_push 里选。',
  '8. 写到“我问过/我说过/我回复过/用户没有回答”这类自述时，只有输入里确实有对应 tool-result 或自身行动记录才可写；否则改写成“我不确定是否…”或不要写。',
  // 同 host-extract 第 8 条：反思也要直写 memories（kind=insight），
  // 线上 2 条 semantic insight 就是在这里把她说成「助手」的（例：「用户想让这个助手变得更好」）。
  '9. 指代你自己时，一律用「我」「我的」；**禁止**用「助手」「助理」「AI」「机器人」称呼或指代你自己，转述用户的意图时同样（写「用户想让我变得更好」，不写「用户想让这个助手变得更好」）。'
].join('\n');

function buildMessage(prompt) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(prompt ?? '') }],
    source: { kind: 'user', harness: HARNESS_MARK }
  };
}

function parseReflectionJson(text) {
  let raw = String(text ?? '').trim();
  if (!raw) return { insights: [] };
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1));
      if (Array.isArray(parsed?.insights)) return {
        insights: parsed.insights,
        tendencies: Array.isArray(parsed?.tendencies) ? parsed.tendencies : [],
        speakHabits: Array.isArray(parsed?.speakHabits) ? parsed.speakHabits : []
      };
      if (Array.isArray(parsed)) return { insights: parsed };
    } catch {
      // 落到数组尝试
    }
  }
  const a = raw.indexOf('[');
  const b = raw.lastIndexOf(']');
  if (a >= 0 && b > a) {
    try {
      const parsed = JSON.parse(raw.slice(a, b + 1));
      if (Array.isArray(parsed)) return { insights: parsed };
    } catch {
      // 忽略
    }
  }
  return { insights: [] };
}

export function createHostReflectTurn({
  ctx,
  provider = 'deepseek-account',
  model = 'deepseek-flash',
  maxOutputTokens = 700,
  timeoutMs = 120_000,
  reasoningEffort = 'off',
  budgetGate = null,
  logger = console
} = {}) {
  async function reflectOnce({ episodes = [], existing = [], tendencyLabels = [], speakHabitDimensions = [] } = {}) {
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
          if (reason?.kind === 'error') failure = new Error(String(reason.error?.message ?? '反思失败'));
          return;
        }
        if (event?.type !== 'assistant/message') return;
        usage = event.data?.message?.usage ?? event.data?.usage ?? usage;
        const blocks = event.data?.message?.content;
        if (!Array.isArray(blocks)) return;
        const text = blocks
          .filter(block => block?.type === 'text' && typeof block.text === 'string')
          .map(block => block.text)
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
        sessionTitle.rename(handle.agent?.session, 'DSHAI 反思');
      }
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('反思超时')), timeoutMs);
        timer.unref?.();
      });
      const run = (async () => {
        await handle.agent.followup(buildMessage(`${SYSTEM_PROMPT}\n\n${JSON.stringify({ episodes, existing, tendencyLabels, speakHabitDimensions })}`));
        if (typeof handle.agent.whenIdle === 'function') await handle.agent.whenIdle();
      })();
      await Promise.race([run, timeout]);
      if (failure) throw failure;
      return { result: parseReflectionJson(output), usage };
    } catch (error) {
      logger?.warn?.('[cognition] 反思模型失败', { error: error?.message });
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      off?.();
      try { await handle?.dispose?.(); } catch { /* 会话拆除失败不影响结果 */ }
    }
  }

  async function reflectTurn(input = {}) {
    if (!budgetGate) return (await reflectOnce(input)).result;
    const { result } = await budgetGate.wrap(
      { kind: 'reflect', provider, model, maxOutputTokens },
      () => reflectOnce(input)
    );
    return result;
  }

  return reflectTurn;
}
