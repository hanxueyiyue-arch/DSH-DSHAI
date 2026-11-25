// 宿主配置：只接受显式字段，避免悄悄接受拼写错误。
// 配置分三段（memory / behavior / cognition），S2 只用到其中一小部分。

import { normalizeIdentity } from '../api/validate.js';
import { MEMORY_CAPACITY_DEFAULT } from '../state/schema.js';

const TOP_LEVEL = new Set(['stateRoot', 'home', 'timeZone', 'identity', 'memory', 'behavior', 'recall', 'personality', 'journal', 'cognition', 'ui']);

function fail(reason) {
  throw new Error(`dsh-dshai-cognition 配置错误：${reason}`);
}

export function normalizeConfig(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('配置必须是对象');
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL.has(key)) fail(`未知配置项 ${key}`);
  }

  if (raw.stateRoot !== undefined && (typeof raw.stateRoot !== 'string' || raw.stateRoot.trim() === '')) {
    fail('stateRoot 必须是非空字符串');
  }
  if (raw.home !== undefined && (typeof raw.home !== 'string' || raw.home.trim() === '')) {
    fail('home 必须是非空字符串');
  }
  if (raw.timeZone !== undefined && typeof raw.timeZone !== 'string') fail('timeZone 必须是字符串');
  if (raw.ui !== undefined && typeof raw.ui !== 'boolean') fail('ui 必须是布尔值');

  let identity = null;
  if (raw.identity !== undefined && raw.identity !== null) {
    const checked = normalizeIdentity(raw.identity);
    if (!checked.ok) fail(`identity.${checked.error}`);
    identity = checked.identity;
  }

  const memory = raw.memory === undefined ? {} : raw.memory;
  if (!memory || typeof memory !== 'object' || Array.isArray(memory)) fail('memory 必须是对象');
  const capacity = memory.capacity === undefined ? MEMORY_CAPACITY_DEFAULT : Number(memory.capacity);
  if (!Number.isInteger(capacity) || capacity < 100 || capacity > 10000) {
    fail('memory.capacity 必须是 100–10000 的整数');
  }

  const behavior = raw.behavior === undefined ? {} : raw.behavior;
  if (!behavior || typeof behavior !== 'object' || Array.isArray(behavior)) fail('behavior 必须是对象');

  const recall = raw.recall === undefined ? {} : raw.recall;
  if (!recall || typeof recall !== 'object' || Array.isArray(recall)) fail('recall 必须是对象');
  const recallMode = recall.mode === undefined ? 'legacy' : recall.mode;
  if (recallMode !== 'legacy' && recallMode !== 'p4') fail('recall.mode 只能是 legacy 或 p4');
  const recallAssociation = recall.association === undefined ? false : recall.association;
  if (typeof recallAssociation !== 'boolean') fail('recall.association 必须是布尔值');

  const personality = raw.personality === undefined ? {} : raw.personality;
  if (!personality || typeof personality !== 'object' || Array.isArray(personality)) fail('personality 必须是对象');
  const personalityEnabled = personality.enabled === undefined ? false : personality.enabled;
  if (typeof personalityEnabled !== 'boolean') fail('personality.enabled 必须是布尔值');

  const journal = raw.journal === undefined ? {} : raw.journal;
  if (!journal || typeof journal !== 'object' || Array.isArray(journal)) fail('journal 必须是对象');
  const journalEnabled = journal.enabled === undefined ? false : journal.enabled;
  if (typeof journalEnabled !== 'boolean') fail('journal.enabled 必须是布尔值');
  const journalDebounceMs = journal.debounceMs === undefined ? 8_000 : Number(journal.debounceMs);
  if (!Number.isInteger(journalDebounceMs) || journalDebounceMs < 500 || journalDebounceMs > 120_000) {
    fail('journal.debounceMs 必须是 500–120000 的整数');
  }
  const journalAutoConsolidate = journal.autoConsolidate === undefined ? false : journal.autoConsolidate;
  if (typeof journalAutoConsolidate !== 'boolean') fail('journal.autoConsolidate 必须是布尔值');

  const cognition = raw.cognition === undefined ? {} : raw.cognition;
  if (!cognition || typeof cognition !== 'object' || Array.isArray(cognition)) fail('cognition 必须是对象');
  if (cognition.loop !== undefined && typeof cognition.loop !== 'boolean') {
    fail('cognition.loop 必须是布尔值');
  }

  const rawModel = cognition.model === undefined ? {} : cognition.model;
  if (!rawModel || typeof rawModel !== 'object' || Array.isArray(rawModel)) {
    fail('cognition.model 必须是对象');
  }
  if (rawModel.enabled !== undefined && typeof rawModel.enabled !== 'boolean') {
    fail('cognition.model.enabled 必须是布尔值');
  }
  const modelTimeoutMs =
    rawModel.timeoutMs === undefined ? 15_000 : Number(rawModel.timeoutMs);
  if (!Number.isInteger(modelTimeoutMs) || modelTimeoutMs < 50 || modelTimeoutMs > 120_000) {
    fail('cognition.model.timeoutMs 必须是 50–120000 的整数');
  }
  // 默认不挂载宿主预设：身份以 self.identity 为准；需要宿主语气时由配置显式指定。
  const agentPreset = rawModel.agentPreset === undefined ? 'dshai' : rawModel.agentPreset;
  if (typeof agentPreset !== 'string' || agentPreset.length > 80) {
    fail('cognition.model.agentPreset 必须是不超过 80 字符的字符串');
  }
  const provider = rawModel.provider === undefined ? 'deepseek-account' : rawModel.provider;
  if (typeof provider !== 'string' || provider.length === 0 || provider.length > 80) {
    fail('cognition.model.provider 必须是 1–80 字符的字符串');
  }
  const modelName = rawModel.model === undefined ? 'deepseek-flash' : rawModel.model;
  if (typeof modelName !== 'string' || modelName.length === 0 || modelName.length > 80) {
    fail('cognition.model.model 必须是 1–80 字符的字符串');
  }

  return {
    stateRoot: raw.stateRoot?.trim() || null,
    home: raw.home?.trim() || null,
    // 未显式配置时用系统时区，最后兜底 Asia/Shanghai；不要把空串传给 Intl。
    timeZone: raw.timeZone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
    ui: raw.ui !== false,
    identity,
    memory: { capacity },
    behavior: { ...behavior },
    recall: { mode: recallMode, association: recallAssociation },
    personality: { enabled: personalityEnabled },
    journal: { enabled: journalEnabled, debounceMs: journalDebounceMs, autoConsolidate: journalAutoConsolidate },
    cognition: {
      ...cognition,
      model: {
        enabled: rawModel.enabled === true,
        timeoutMs: modelTimeoutMs,
        agentPreset,
        provider,
        model: modelName
      }
    }
  };
}
