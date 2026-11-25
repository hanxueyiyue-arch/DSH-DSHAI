// P8 日记写作适配器：把当天证据交给宿主 agent，取回 JSON；与 reflect/extract 相同的会话约束。
import { randomUUID } from 'node:crypto';

const HARNESS_MARK = 'cognition-journal';

const SYSTEM_PROMPT = [
  '你是「助手」的日记写作器。输入是某一天的证据：真实经历（experiences）、当日记忆（memories）、已提交反思（insights）、当前倾向（traits）、上一篇当日正文（previous）。',
  '只输出一个 JSON 对象：{"write":true,"body":"...","append":"...","facts":["..."],"subjective":["..."],"mood":"..."}',
  '规则：',
  '1. 第一次写今天用 body（第一人称，篇幅不限，单篇 ≤20KB）；如果 previous 已有正文，用 append 接着写一段（1–3 句，追加到今天末尾），不要重写已有内容。没有值得记录的新经历时输出 {"write":false}。',
  '2. facts 只能填 experiences 或 memories 中真实出现的 id；不能填 insights 或 traits 的 id。',
  '3. 用户说过的话是用户的事实，不能写成你自己的偏好；用户喜欢跑步不等于你喜欢跑步。',
  '4. 你自己做过的事，只有 experiences 中有对应行动/执行回执时才可写成已经发生。',
  '5. 感受、猜测、犹豫放 subjective，不要写成外部事实。',
  '6. 不要用旧日记推断新事实；不要重复套话，不要编造时间、地点、承诺或行动。',
  '7. previous 是当日已有正文。它存在时优先用 append 接着写；只有确实要整体重写时才用 body，并确保新 body 覆盖旧内容。不要原样抄回。',
  '8. 关于"我用了工具/我查了一下/我看了一下/工具没带回来结果"这类叙述：只有 experiences 里存在 type="tool-result" 且 intentType="invoke" 的记录时才允许写。intentType="send" 只是**发送回执**，证明的是"我说了话"，不能据此写成"我去查了/去看了/工具没结果"。没有 invoke 记录时，日记里不要出现任何工具或探查动作的描写。',
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
  if (!raw) return null;
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1));
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // ignore
    }
  }
  return null;
}

export function createHostJournalTurn({
  ctx,
  provider = 'deepseek-account',
  model = 'deepseek-flash',
  maxOutputTokens = 700,
  timeoutMs = 120_000,
  reasoningEffort = 'off',
  budgetGate = null,
  logger = console
} = {}) {
  async function journalOnce({ day, experiences = [], memories = [], insights = [], traits = [], previous = null } = {}) {
    const agents = ctx?.get?.('agents');
    if (!agents || typeof agents.create !== 'function') {
      throw new Error('宿主 agent 服务不可用');
    }
    const sessionId = `${HARNESS_MARK}-${randomUUID()}`;
    let output = '';
    let failure = null;
    let usage = null;
    const startedAt = Date.now();
    const off = typeof ctx.on === 'function'
      ? ctx.on('session/event', (session, event) => {
        if (session?.id !== sessionId) return;
        if (event?.type === 'turn/end') {
          const reason = event.data?.reason;
          if (reason?.kind === 'error') failure = new Error(String(reason.error?.message ?? '日记生成失败'));
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
        if (text) output = text.slice(-6000);
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
        sessionTitle.rename(handle.agent?.session, 'DSHAI 日记');
      }
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('日记生成超时')), timeoutMs);
        timer.unref?.();
      });
      const input = {
        day,
        experiences: experiences.map(item => ({ id: item.id, type: item.type, at: item.at, ...(item.intentType ? { intentType: item.intentType } : {}), text: item.text ?? '' })),
        memories: memories.map(item => ({ id: item.id, kind: item.kind, title: item.title, content: item.content })),
        insights: insights.map(item => ({ id: item.id, title: item.title, content: item.content })),
        traits: traits.map(item => ({ id: item.id, label: item.label, statement: item.statement })),
        previous: previous ? String(previous).slice(0, 4000) : null
      };
      const run = (async () => {
        await handle.agent.followup(buildMessage(`${SYSTEM_PROMPT}\n\n${JSON.stringify(input)}`));
        if (typeof handle.agent.whenIdle === 'function') await handle.agent.whenIdle();
      })();
      await Promise.race([run, timeout]);
      if (failure) throw failure;
      const parsed = parseJson(output);
      if (!parsed) throw Object.assign(new Error('日记输出不是 JSON'), { code: 'JOURNAL_BAD_JSON' });
      return {
        result: {
          write: parsed.write !== false,
          body: typeof parsed.body === 'string' ? parsed.body : '',
          append: typeof parsed.append === 'string' ? parsed.append : '',
          facts: Array.isArray(parsed.facts) ? parsed.facts.slice(0, 60) : [],
          subjective: Array.isArray(parsed.subjective) ? parsed.subjective.slice(0, 12) : [],
          mood: typeof parsed.mood === 'string' ? parsed.mood.slice(0, 40) : '',
          model
        },
        usage
      };
    } finally {
      if (timer) clearTimeout(timer);
      off?.();
      try {
        ctx?.get?.('cognition')?.recordModelCall?.({
          provider,
          model,
          agentPreset: 'journal',
          ok: !failure,
          startedAt,
          ms: Date.now() - startedAt,
          usage,
          ...(failure ? { error: String(failure.message ?? failure) } : {})
        });
      } catch { /* 费用记录失败不影响日记 */ }
      try { await handle?.dispose?.(); } catch { /* 会话拆除失败不影响结果 */ }
    }
  }

  async function journalTurn(input = {}) {
    if (!budgetGate) return (await journalOnce(input)).result;
    const { result } = await budgetGate.wrap(
      { kind: 'journal', provider, model, maxOutputTokens },
      () => journalOnce(input)
    );
    return result;
  }

  return journalTurn;
}
