// 真实宿主模型适配器：只在宿主显式开启 cognition.model 时使用。
// 走宿主 agents 服务（与行为控制里的决策调用同一路径），不联网、不读环境变量。
// 约束：隐藏全部工具、固定会话标题、单次会话用完即弃。
// 默认**没有**调用次数配额；只保留可选的费用闸（maxCalls=0 即关闭）、
// 连续失败熔断与逐次费用记录，防止异常循环，不限制正常实验。

import { randomUUID } from 'node:crypto';
import { createHostModel } from './host-model.js';

const HARNESS_MARK = 'cognition-decision';

function buildMessage(prompt) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(prompt ?? '') }],
    source: { kind: 'user', harness: HARNESS_MARK }
  };
}

export function createHostAgentModel({
  ctx,
  provider = 'deepseek-account',
  model = 'deepseek-flash',
  agentPreset = '',
  maxOutputTokens = 800,
  timeoutMs = 120_000,
  reasoningEffort = 'off',
  maxCalls = 0,
  maxCallsWindowMs = 24 * 60 * 60 * 1000,
  failureThreshold = 5,
  cooldownMs = 60_000,
  onCall = null,
  budgetGate = null,
  now = () => Date.now(),
  logger = console
} = {}) {
  const callTimes = [];
  let consecutiveFailures = 0;
  let cooldownUntil = 0;

  async function invokeOnce({ system, prompt, agentPreset: preset, maxOutputTokens: maxOut }) {
    const agents = ctx?.get?.('agents');
    if (!agents || typeof agents.create !== 'function') {
      throw new Error('宿主 agent 服务不可用');
    }
    const startedAt = now();
    if (cooldownUntil > startedAt) {
      throw new Error('宿主模型连续失败，处于冷却期');
    }
    if (maxCalls > 0) {
      const cutoff = startedAt - maxCallsWindowMs;
      while (callTimes.length && callTimes[0] <= cutoff) callTimes.shift();
      if (callTimes.length >= maxCalls) {
        throw new Error(
          `宿主模型调用次数超过上限 ${maxCalls}/${Math.round(maxCallsWindowMs / 60000)} 分钟（可选费用闸）`
        );
      }
      callTimes.push(startedAt);
    }

    const sessionId = `${HARNESS_MARK}-${randomUUID()}`;
    let output = '';
    let failure = null;
    let usage = null;
    let ok = false;
    let failureError = null;
    const off = typeof ctx.on === 'function'
      ? ctx.on('session/event', (session, event) => {
        if (session?.id !== sessionId) return;
        if (event?.type === 'turn/end') {
          const reason = event.data?.reason;
          if (reason?.kind === 'error') {
            failure = new Error(String(reason.error?.message ?? '模型决策失败'));
          }
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
      const effectivePreset = preset === undefined ? agentPreset : preset;
      // agents.create 不会自动挂载预设：必须显式 setup，否则 meta.agentPreset
      // 只是记录，模型的 system prompt 里不会出现该预设的 persona。
      //
      // 但预设是可选依赖：全新环境只装了 cognition、没装配套预设包时，
      // agentPresets.mount 会因为这个名字不存在而抛错。那不该让"模型调用失败"——
      // 降级成"没有 persona 的裸 Agent"继续跑，只记一条警告。
      const presets = ctx?.get?.('agentPresets');
      const setup = effectivePreset && presets && typeof presets.mount === 'function'
        ? async (agentCtx) => {
          try {
            await presets.mount(agentCtx, effectivePreset);
          } catch (error) {
            logger?.warn?.('[cognition] agentPreset 挂载失败，按无预设继续', {
              preset: effectivePreset,
              error: error?.message
            });
          }
        }
        : undefined;
      handle = await agents.create({
        sessionId,
        ...(effectivePreset ? { meta: { agentPreset: effectivePreset } } : {}),
        ...(setup ? { setup } : {}),
        agentOptions: {
          provider,
          model,
          ...(reasoningEffort ? { reasoningEffort } : {}),
          ...(maxOut || maxOutputTokens ? { maxTokens: maxOut || maxOutputTokens } : {})
        }
      });

      const sessionTitle = ctx?.get?.('sessionTitle');
      if (sessionTitle && typeof sessionTitle.rename === 'function') {
        sessionTitle.rename(handle.agent?.session, 'DSHAI 认知决策');
      }

      const scoped = handle.agent?.ctx;
      if (scoped?.tools && typeof scoped.tools.restrict === 'function') {
        scoped.tools.restrict({ allow: [] });
      }

      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('模型决策超时')), timeoutMs);
        timer.unref?.();
      });
      const run = (async () => {
        await handle.agent.followup(buildMessage(`${system ?? ''}\n\n${prompt}`));
        if (typeof handle.agent.whenIdle === 'function') await handle.agent.whenIdle();
      })();
      await Promise.race([run, timeout]);
      if (failure) throw failure;
      ok = true;
      consecutiveFailures = 0;
      return { result: output, usage };
    } catch (error) {
      failureError = error;
      consecutiveFailures += 1;
      if (failureThreshold > 0 && consecutiveFailures >= failureThreshold) {
        cooldownUntil = now() + cooldownMs;
        logger?.warn?.('[cognition] 宿主模型连续失败，进入冷却', {
          failures: consecutiveFailures,
          cooldownMs
        });
      }
      logger?.warn?.('[cognition] 宿主模型调用失败', { error: error?.message });
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      off?.();
      try { await handle?.dispose?.(); } catch { /* 会话拆除失败不影响结果 */ }
      try {
        onCall?.({
          provider,
          model,
          agentPreset: preset === undefined ? agentPreset : preset,
          ok,
          startedAt,
          ms: now() - startedAt,
          usage,
          ...(ok ? {} : { error: String(failureError?.message ?? failure?.message ?? 'unknown') })
        });
      } catch { /* 费用记录失败不影响主流程 */ }
    }
  }

  async function invoke(payload) {
    if (!budgetGate) return (await invokeOnce(payload)).result;
    const { result } = await budgetGate.wrap(
      {
        kind: 'decide',
        provider,
        model,
        maxOutputTokens: payload?.maxOutputTokens ?? maxOutputTokens
      },
      () => invokeOnce(payload)
    );
    return result;
  }

  return createHostModel({
    invoke,
    // 空串表示“不挂载任何预设”；不要回落到 dsh-dshai-chat，
    // 否则隔离/生产里没有该预设时会直接报 Unknown agent preset。
    agentPreset,
    maxOutputTokens,
    logger
  });
}
