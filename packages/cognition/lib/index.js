// dsh-dshai-cognition 单入口（S2）。
// 目标：能开机、能收信、能查档案；不思考、不发信、不联网、不起定时器。

import { normalizeConfig } from './host/config.js';
import { resolveStateRoot } from './host/root.js';
import { createCognitionService, COGNITION_SERVICE } from './api/service.js';
import { createHostAgentModel } from './decide/host-agent-model.js';
import { createHostExtractTurn } from './decide/host-extract.js';
import { createHostDistillTurn } from './decide/host-distill.js';
import { createHostReflectTurn } from './decide/host-reflect.js';
import { createHostJournalTurn } from './decide/host-journal.js';
import { createBudgetGate } from './decide/budget-gate.js';
import { registerDiaryTools } from './tools/diary-bus.js';
import { registerAlarmTools } from './tools/alarm-bus.js';

export const name = 'dsh-dshai-cognition';
export const version = '0.4.0';
export const COGNITION_SCHEMA = 1;

export { COGNITION_SERVICE };

export function apply(ctx, rawConfig = {}, deps = {}) {
  const config = normalizeConfig(rawConfig);
  const stateRoot = resolveStateRoot({ stateRoot: config.stateRoot, home: config.home });
  const modelConfig = config.cognition.model;
  // 预算闸门：宿主装了 budget 插件才生效；没有时整体透传，行为与之前一致。
  // 注意 getBudget 要能接受 strict 参数：Cordis 的 ctx.get(name) 默认 strict=true，
  // 服务提供者 fiber 非 ACTIVE 时同样返回 undefined —— 那与"没装"无法区分。
  // 传 strict=false 才能看到"已注册但失活"，闸门靠两者的差异判断故障。
  const budgetGate = createBudgetGate({
    getBudget: (strict = true) => (typeof ctx.get === 'function' ? ctx.get('budget', strict) : null),
    logger: console
  });
  let model = modelConfig.enabled ? deps.model : null;
  let extractTurn = typeof deps.extractTurn === 'function' ? deps.extractTurn : null;
  let distillTurn = typeof deps.distillTurn === 'function' ? deps.distillTurn : null;
  let reflectTurn = typeof deps.reflectTurn === 'function' ? deps.reflectTurn : null;
  let journalTurn = typeof deps.journalTurn === 'function' ? deps.journalTurn : null;
  let service = null;
  if (modelConfig.enabled && typeof model !== 'function') {
    if (typeof ctx.get !== 'function') {
      throw new Error(
        'dsh-dshai-cognition 配置错误：cognition.model.enabled=true 但没有提供模型适配器（apply 第三个参数 deps.model，或宿主 ctx.get("agents")）'
      );
    }
    model = createHostAgentModel({
      ctx,
      provider: modelConfig.provider,
      model: modelConfig.model,
      agentPreset: modelConfig.agentPreset,
      timeoutMs: modelConfig.timeoutMs,
      onCall: entry => {
        try { service?.recordModelCall?.(entry); } catch { /* 费用记录失败不影响主流程 */ }
      },
      budgetGate
    });
    if (!extractTurn) {
      extractTurn = createHostExtractTurn({
        ctx,
        provider: modelConfig.provider,
        model: modelConfig.model,
        timeoutMs: Math.max(modelConfig.timeoutMs, 120_000),
        budgetGate
      });
    }
    if (!distillTurn) {
      distillTurn = createHostDistillTurn({
        ctx,
        provider: modelConfig.provider,
        model: modelConfig.model,
        timeoutMs: Math.max(modelConfig.timeoutMs, 120_000),
        budgetGate
      });
    }
    if (!reflectTurn) {
      reflectTurn = createHostReflectTurn({
        ctx,
        provider: modelConfig.provider,
        model: modelConfig.model,
        timeoutMs: Math.max(modelConfig.timeoutMs, 120_000),
        budgetGate
      });
    }
    if (!journalTurn) {
      journalTurn = createHostJournalTurn({
        ctx,
        provider: modelConfig.provider,
        model: modelConfig.model,
        timeoutMs: Math.max(modelConfig.timeoutMs, 120_000),
        budgetGate
      });
    }
  }
  service = createCognitionService({
    stateRoot,
    timeZone: config.timeZone,
    identity: config.identity,
    capacity: config.memory.capacity,
    loop: config.cognition.loop === true,
    recallMode: config.recall.mode,
    association: config.recall.association === true,
    personality: config.personality?.enabled === true,
    journal: config.journal.enabled === true,
    journalDebounceMs: config.journal.debounceMs,
    autoConsolidate: config.journal.autoConsolidate === true,
    model,
    modelTimeoutMs: modelConfig.timeoutMs,
    budgetGate,
    // 闹钟触发时，把总线当前能力目录一起带进 tick。
    capabilityProvider: () => {
      try {
        const bus = typeof ctx.get === 'function' ? ctx.get('cognition-bus') : null;
        return bus && typeof bus.capabilities === 'function' ? bus.capabilities() : undefined;
      } catch { return undefined; }
    },
    ...(extractTurn ? { extractTurn } : {}),
    ...(distillTurn ? { distillTurn } : {}),
    ...(reflectTurn ? { reflectTurn } : {}),
    ...(journalTurn ? { journalTurn } : {}),
    onIntent: (intent) => {
      const sink = ctx.get('cognition-intents');
      if (sink && typeof sink.submit === 'function') return sink.submit(intent);
      return null;
    }
  });

  ctx.provide(COGNITION_SERVICE, service);

  // 把日记工具注册进总线能力目录（她才能在对话里写/读日记）。
  const tryRegisterDiaryTools = () => {
    try {
      const bus = typeof ctx.get === 'function' ? ctx.get('cognition-bus') : null;
      if (!bus || typeof bus.registerTool !== 'function') return false;
      const diary = registerDiaryTools(bus, () => service);
      const alarm = registerAlarmTools(bus, () => service);
      return diary || alarm;
    } catch {
      return false;
    }
  };
  if (!tryRegisterDiaryTools()) {
    const timer = setTimeout(() => { tryRegisterDiaryTools(); }, 3000);
    if (typeof timer.unref === 'function') timer.unref();
  }

  return () => {
    service.dispose().catch(() => undefined);
  };
}
