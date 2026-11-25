import { createHash } from 'node:crypto';

// P7 可演化倾向：与受保护的 self.json 身份分开存放。
// 只有“关于助手自己”的独立证据能形成倾向；用户偏好属于用户画像，不进入这里。
// 倾向按「主题@方面」表达；支持与反证分开计数，修订历史保留完整快照。

export const TRAIT_LIMIT = 24;
// 近义阈值：同一件事换个说法不该长成两条。低于这个分数才视为新主题。
export const TRAIT_SIMILARITY = 0.72;
export const TRAIT_ACTIVE_LIMIT = 5;
export const TRAIT_MIN_CONFIDENCE = 0.55;
export const TRAIT_MIN_SUPPORT = 2;
const HISTORY_LIMIT = 128;

const TOPIC_STOP = new Set([
  '喜欢', '讨厌', '发送', '舒服', '开心', '不错', '很好', '谢谢', '时候', '今天', '最近',
  '一般', '用户', '建议', '觉得', '可以', '自己', '一下', '有点', '还是', '就是'
]);

const GENERIC_CHARS = new Set(
  '我你他她它的了是在有和就都也还又很挺太这那哪个什么怎样吗呢吧啊呀哦嗯把被给对从向与及或但如果因为所以然后而且不过虽然已经正在每天最近下次有点一点用户喜欢觉得想要可以自己一下'.split('')
);

const ACTIVITIES = [
  ['咖啡', /(咖啡|手冲|浅烘|深烘|豆子|拿铁|浓缩)/],
  ['跑步', /(跑步|夜跑|晨跑|慢跑|跑了|跑一跑|跑个|跑三公里)/],
  ['体检', /(体检|查体|医院|医生|复查)/],
  ['工作', /(工作|上班|加班|项目|会议|代码)/],
  ['睡眠', /(睡眠|睡觉|熬夜|早睡|失眠|作息)/],
  ['旅行', /(旅行|旅游|出游|出行|周末去)/]
];

const NEGATED = /(不喜欢|不爱|不想|不再|讨厌|受不了|反感|别再|不愿意|没兴趣|不感兴趣)/;
const POSITIVE = /(喜欢|爱|享受|愿意|习惯|挺好|很好|不错|有用|靠谱|开心|推荐)/;
const SELF_ACTION = /(我建议|我推荐|我选|我更想|我倾向|我通常会|我会先|我会先听|我先听)/;

function hash(text) {
  return createHash('sha1').update(String(text)).digest('hex').slice(0, 16);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function topicsFromClause(clause, { limit = 4 } = {}) {
  const out = [];
  const seen = new Set();
  for (const run of String(clause ?? '').split(/[^\u4e00-\u9fff]+/)) {
    if (run.length < 2) continue;
    for (let i = run.length - 2; i >= 0; i -= 1) {
      const gram = run.slice(i, i + 2);
      if ([...gram].some(char => GENERIC_CHARS.has(char))) continue;
      if (TOPIC_STOP.has(gram) || seen.has(gram)) break;
      seen.add(gram);
      out.push(gram);
      break;
    }
    if (out.length >= limit) break;
  }
  return out;
}

function activityOf(text) {
  for (const [topic, pattern] of ACTIVITIES) {
    if (pattern.test(text)) return topic;
  }
  return null;
}

function facetOf(text, topic) {
  const value = String(text ?? '');
  if (topic === '跑步') {
    if (/(夜跑|晚上跑|夜里跑|晚上.*跑|夜里.*跑)/.test(value)) return '夜跑';
    if (/(晨跑|早起跑|早上跑|清晨.*跑|早起.*跑|早上.*跑)/.test(value)) return '早起';
    if (/(周末.*跑|跑.*周末)/.test(value)) return '周末';
    return '通用';
  }
  if (topic === '咖啡') {
    if (/手冲/.test(value)) return '手冲';
    if (/浅烘/.test(value)) return '浅烘';
    if (/深烘/.test(value)) return '深烘';
    if (/浓度|苦|酸/.test(value)) return '风味';
    return '通用';
  }
  if (topic === '睡眠') {
    if (/(熬夜|晚睡|夜里)/.test(value)) return '夜间';
    if (/(早起|早睡|早上)/.test(value)) return '早晨';
    return '通用';
  }
  if (/(晚上|夜里|夜间)/.test(value)) return '夜间';
  if (/(早起|早上|清晨|早晨)/.test(value)) return '早晨';
  if (/周末/.test(value)) return '周末';
  return '通用';
}

function labelOf(topic, facet) {
  return facet && facet !== '通用' ? `${topic}@${facet}` : topic;
}

/**
 * 解析一句评价：主题、方面、极性。
 * 否定优先于肯定，避免“不喜欢”被“喜欢”子串命中。
 */
export function parseEvaluations(text, { polarity = null } = {}) {
  const value = String(text ?? '');
  const clauses = value.split(/[，。！？；、,.!?;\n]+/).map(clause => clause.trim()).filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const clause of clauses) {
    const topic = activityOf(clause) ?? topicsFromClause(clause, { limit: 1 })[0];
    if (!topic) continue;
    const sign = polarity ?? (NEGATED.test(clause) ? 'negative' : POSITIVE.test(clause) ? 'positive' : 'unknown');
    if (sign === 'unknown') continue;
    const facet = facetOf(clause, topic);
    const label = labelOf(topic, facet);
    if (seen.has(`${label}:${sign}`)) continue;
    seen.add(`${label}:${sign}`);
    out.push({ topic, facet, label, polarity: sign, clause });
  }
  return out;
}

export function parseEvaluation(text, { polarity = null } = {}) {
  const all = parseEvaluations(text, { polarity });
  return all.find(row => row.facet !== '通用') ?? all[0] ?? null;
}

export function blankPersonality() {
  return { items: [], revision: 0, updatedAt: null };
}

function normalizeEvidenceList(value) {
  const list = Array.isArray(value) ? value : [];
  const out = [];
  const seen = new Set();
  for (const row of list) {
    const id = typeof row === 'string' ? row : row?.key ?? row?.memoryId;
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue;
    seen.add(id);
    out.push({
      key: id,
      at: Number(row?.at) || 0,
      memoryId: typeof row?.memoryId === 'string' ? row.memoryId : null,
      messageId: typeof row?.messageId === 'string' ? row.messageId : null,
      source: typeof row?.source === 'string' ? row.source : null
    });
  }
  return out.slice(-64);
}

function normalizeSnapshot(row) {
  return {
    at: Number(row?.at) || 0,
    revision: Number(row?.revision) || 0,
    action: typeof row?.action === 'string' ? row.action : null,
    statement: String(row?.statement ?? '').slice(0, 240),
    confidence: clamp(Number(row?.confidence) || 0, 0, 0.95),
    status: ['active', 'uncertain', 'disabled'].includes(row?.status) ? row.status : 'active',
    support: normalizeEvidenceList(row?.support),
    counter: normalizeEvidenceList(row?.counter),
    restoredFrom: Number.isFinite(Number(row?.restoredFrom)) ? Number(row.restoredFrom) : null,
    revoked: row?.revoked === true
  };
}

export function normalizePersonality(value) {
  const data = value && typeof value === 'object' ? value : blankPersonality();
  const items = Array.isArray(data.items) ? data.items : [];
  return {
    items: items
      .filter(item => item && typeof item.id === 'string')
      .map(item => {
        const status = item.status === 'reverted' ? 'disabled' : ['active', 'uncertain', 'disabled'].includes(item.status) ? item.status : 'active';
        const history = Array.isArray(item.history) ? item.history.filter(row => row && typeof row === 'object').map(normalizeSnapshot).slice(-HISTORY_LIMIT) : [];
        return {
          id: item.id,
          kind: String(item.kind ?? 'attitude'),
          topic: String(item.topic ?? item.label ?? '').split('@')[0].slice(0, 24),
          facet: String(item.facet ?? item.label ?? '').split('@')[1] ?? '通用',
          label: String(item.label ?? '').slice(0, 64),
          statement: String(item.statement ?? '').slice(0, 240),
          confidence: clamp(Number(item.confidence) || 0, 0, 0.95),
          status,
          support: normalizeEvidenceList(item.support),
          counter: normalizeEvidenceList(item.counter),
          explanations: normalizeEvidenceList(item.explanations),
          history,
          historyDropped: Math.max(0, Number(item.historyDropped) || 0),
          revision: Number(item.revision) || 1,
          createdAt: Number(item.createdAt) || 0,
          updatedAt: Number(item.updatedAt) || 0,
          disabledAt: Number(item.disabledAt) || null,
          revertedAt: Number(item.revertedAt) || null
        };
      }),
    // 注意：这里不再 slice(-TRAIT_LIMIT)。读盘时静默截断正是“最早的倾向被吃掉”的来源；
    // 超额条目由 partitionTraits 按价值挤出并沉底（不删除），调用方负责落盘。
    revision: Number(data.revision) || 0,
    updatedAt: Number(data.updatedAt) || 0
  };
}

function snapshotOf(item, { action = null, now = 0, restoredFrom = null } = {}) {
  return {
    at: now,
    revision: item.revision,
    action,
    statement: item.statement,
    confidence: item.confidence,
    status: item.status,
    support: item.support.map(row => ({ ...row })),
    counter: item.counter.map(row => ({ ...row })),
    restoredFrom
  };
}

function pushHistory(item, snapshot) {
  item.history.push(snapshot);
  if (item.history.length > HISTORY_LIMIT) {
    const dropped = item.history.length - HISTORY_LIMIT;
    item.historyDropped = (item.historyDropped || 0) + dropped;
    item.history = item.history.slice(-HISTORY_LIMIT);
  }
}

function evidenceKey(memory) {
  const source = memory?.source ?? {};
  if (typeof source.messageId === 'string' && source.messageId) return { key: `msg:${source.messageId}`, messageId: source.messageId, source: 'message' };
  if (typeof source.experienceId === 'string' && source.experienceId) return { key: `exp:${source.experienceId}`, messageId: null, source: 'experience' };
  if (typeof source.eventId === 'string' && source.eventId) return { key: `evt:${source.eventId}`, messageId: null, source: 'event' };
  // 没有稳定来源的旧记录：保守地合并成一段，不能按 memory 条数累计。
  return { key: 'legacy:unverified', messageId: null, source: 'legacy' };
}

function selfEvidence(memory) {
  if (!memory || ['archive', 'superseded'].includes(memory?.status)) return null;
  const source = memory.source ?? {};
  // 用户自己的偏好/事实属于用户画像，不能直接变成助手人格。
  if (source.level === 'owner-message' || source.actor === 'owner') return null;
  if (memory.kind === 'insight') return null;
  if (memory.kind === 'feedback' && source.level === 'owner-feedback') {
    if (!['explicit-positive', 'explicit-negative'].includes(source.feedbackType)) return null;
    const parsed = parseEvaluation(memory.content ?? memory.title, {
      polarity: source.feedbackType === 'explicit-positive' ? 'positive' : 'negative'
    });
    if (!parsed) return null;
    return { ...parsed, text: memory.content ?? memory.title, memory, ...evidenceKey(memory) };
  }
  // 助手自己的实际选择/表达：只接受明确带出自述的行为记忆，且必须能解析出主题。
  if (memory.kind === 'action' && SELF_ACTION.test(`${memory.title ?? ''} ${memory.content ?? ''}`)) {
    const parsed = parseEvaluation(`${memory.title ?? ''} ${memory.content ?? ''}`);
    if (!parsed) return null;
    return { ...parsed, text: memory.content ?? memory.title, memory, ...evidenceKey(memory) };
  }
  return null;
}

function mergeEvidence(list, row, key) {
  if (list.some(item => item.key === key)) return false;
  list.push(row);
  return true;
}

export function deriveTraits({ memories = [], personality, now = Date.now() } = {}) {
  const current = normalizePersonality(personality);
  const groups = new Map();
  for (const memory of memories) {
    const evidence = selfEvidence(memory);
    if (!evidence) continue;
    if (!groups.has(evidence.label)) groups.set(evidence.label, []);
    groups.get(evidence.label).push(evidence);
  }

  const items = current.items.map(item => ({
    ...item,
    support: [...item.support],
    counter: [...item.counter],
    history: [...item.history]
  }));
  const changes = [];

  for (const [label, rows] of groups) {
    const existing = items.find(item => item.label === label);
    const supports = new Map();
    const counters = new Map();
    for (const row of rows) {
      const entry = {
        key: row.key,
        at: Number(row.memory?.occurredAt) || now,
        memoryId: row.memory?.id ?? null,
        messageId: row.messageId ?? null,
        source: row.source
      };
      if (row.polarity === 'positive') supports.set(entry.key, entry);
      else if (row.polarity === 'negative') counters.set(entry.key, entry);
    }

    const baseAt = existing ? Math.max(existing.disabledAt ?? 0, existing.revertedAt ?? 0) : 0;
    const freshKeys = [...supports.keys()].filter(key => {
      const entry = supports.get(key);
      return entry.at > baseAt && !existing?.support.some(row => row.key === key);
    });
    const freshCounterKeys = [...counters.keys()].filter(key => {
      const entry = counters.get(key);
      return entry.at > baseAt && !existing?.counter.some(row => row.key === key);
    });

    if (!existing) {
      if (supports.size < TRAIT_MIN_SUPPORT) continue;
      const support = [...supports.values()];
      const counter = [...counters.values()];
      const confidence = confidenceOf(support.length, counter.length);
      const topic = rows[0].topic;
      const facet = rows[0].facet;
      const item = {
        id: `trait-${hash(`${label}:${support.map(row => row.key).sort().join(',')}`)}`,
        kind: kindOf(rows.map(row => row.text).join(' ')),
        topic,
        facet,
        label,
        statement: `我在「${label}」上表现出持续倾向。`,
        confidence,
        status: counter.length > 0 && support.length - counter.length <= 0 ? 'uncertain' : 'active',
        support,
        counter,
        explanations: [],
        history: [],
        historyDropped: 0,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        disabledAt: null,
        revertedAt: null
      };
      pushHistory(item, snapshotOf(item, { action: 'created', now }));
      items.push(item);
      changes.push({ id: item.id, action: 'created', label, confidence, status: item.status });
      continue;
    }

    // 停用/回退后，只有之后的新独立经历才能让它重新成长。
    if ((existing.disabledAt || existing.revertedAt) && freshKeys.length < TRAIT_MIN_SUPPORT) {
      // 仍允许记录新反证，但不激活倾向。
      if (freshCounterKeys.length === 0) continue;
    }

    let changed = false;
    for (const key of supports.keys()) {
      if (mergeEvidence(existing.support, supports.get(key), key)) changed = true;
      const before = existing.counter.length;
      existing.counter = existing.counter.filter(row => row.key !== key);
      if (existing.counter.length !== before) changed = true;
    }
    for (const key of counters.keys()) {
      if (mergeEvidence(existing.counter, counters.get(key), key)) changed = true;
      const before = existing.support.length;
      existing.support = existing.support.filter(row => row.key !== key);
      if (existing.support.length !== before) changed = true;
    }
    if (!changed) continue;

    const supportCount = existing.support.length;
    const counterCount = existing.counter.length;
    const confidence = confidenceOf(supportCount, counterCount);
    const nextStatus =
      existing.disabledAt && freshKeys.length >= TRAIT_MIN_SUPPORT
        ? 'active'
        : counterCount > 0 && supportCount - counterCount <= 0
          ? 'uncertain'
          : supportCount >= TRAIT_MIN_SUPPORT
            ? 'active'
            : 'uncertain';
    const statement = `我在「${label}」上表现出持续倾向。`;
    const changedStatus = existing.status !== nextStatus;
    if (existing.confidence === confidence && !changedStatus && existing.statement === statement) continue;

    existing.statement = statement;
    existing.confidence = confidence;
    existing.status = nextStatus;
    if (nextStatus === 'active' && existing.disabledAt && freshKeys.length >= TRAIT_MIN_SUPPORT) {
      existing.disabledAt = null;
      existing.revertedAt = null;
    }
    existing.revision += 1;
    existing.updatedAt = now;
    pushHistory(existing, snapshotOf(existing, { action: 'revised', now }));
    changes.push({ id: existing.id, action: 'revised', label, confidence, status: nextStatus });
  }

  const { kept, evicted } = partitionTraits(items, TRAIT_LIMIT);
  return {
    personality: {
      items: kept,
      revision: current.revision + (changes.length ? 1 : 0),
      updatedAt: changes.length ? now : current.updatedAt
    },
    changes,
    evicted
  };
}

function confidenceOf(supportCount, counterCount) {
  const net = supportCount - counterCount;
  const raw = 0.5 + 0.12 * Math.min(4, supportCount) - 0.18 * Math.min(3, counterCount) + 0.03 * Math.max(0, Math.min(3, net));
  return clamp(raw, 0.2, 0.95);
}

// ---------- 近义标签：同一件事换个说法，不该长成两条 ----------

const LABEL_PUNCT = /[\s，。、；：！？·…—–\-"'“”‘’（）()【】\[\]《》<>~～,.;:!?]/g;

export function normalizeLabel(label) {
  return String(label ?? '').replace(LABEL_PUNCT, '').toLowerCase();
}

function labelBigrams(text) {
  const out = [];
  for (let i = 0; i + 1 < text.length; i += 1) out.push(text.slice(i, i + 2));
  return out;
}

// 归一化相等 = 1；否则看三种证据里最强的一种：
//   1) 短标签完整出现在长标签里（短标签 ≥6 字）：0.95
//   2) 共同前缀占到短标签的 70% 以上（短标签 ≥8 字）：0.9
//   3) 二元组 Jaccard
// 短标签（<8 字）不参与前缀规则——「日记要自己写」和「日记要自己读」不能被并成一条。
export function labelSimilarity(a, b) {
  const x = normalizeLabel(a);
  const y = normalizeLabel(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length >= 6 && long.includes(short)) return 0.95;

  let prefix = 0;
  while (prefix < short.length && short[prefix] === long[prefix]) prefix += 1;
  const prefixRatio = prefix / short.length;
  if (short.length >= 8 && prefixRatio >= 0.7) return 0.9;

  const left = new Set(labelBigrams(x));
  const right = new Set(labelBigrams(y));
  if (left.size === 0 || right.size === 0) return 0;
  let inter = 0;
  for (const gram of left) if (right.has(gram)) inter += 1;
  return inter / (left.size + right.size - inter);
}

export function findSimilarTrait(items, label, { threshold = TRAIT_SIMILARITY, includeDisabled = false } = {}) {
  let best = null;
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item.label !== 'string') continue;
    if (!includeDisabled && item.status === 'disabled') continue;
    const score = labelSimilarity(item.label, label);
    if (score >= threshold && (!best || score > best.score)) best = { item, score };
  }
  return best;
}

// ---------- 价值排序与挤出（不删除） ----------

const STATUS_WEIGHT = { active: 2, uncertain: 1, disabled: 0 };

function compareTraits(a, b) {
  const rows = [
    (STATUS_WEIGHT[b?.status] ?? 0) - (STATUS_WEIGHT[a?.status] ?? 0),
    (Number(b?.confidence) || 0) - (Number(a?.confidence) || 0),
    (Number(b?.updatedAt) || 0) - (Number(a?.updatedAt) || 0)
  ];
  return rows.find(value => value !== 0) ?? 0;
}

// 活跃池上限：按 status > confidence > updatedAt 保留前 limit 条，
// 其余原样返回给调用方沉底（永不静默删除）。
export function partitionTraits(items, limit = TRAIT_LIMIT) {
  const list = Array.isArray(items) ? items : [];
  if (list.length <= limit) return { kept: list, evicted: [] };
  const sorted = [...list].sort(compareTraits);
  return { kept: sorted.slice(0, limit), evicted: sorted.slice(limit) };
}

// 把近义条目并成一条：支持/反证取并集，置信度取高，保留更早创建的那条的身份。
// 停用条目不参与合并——避免把“我说过这不是我”的结论悄悄复活。
export function mergeSimilarTraits(items, { threshold = TRAIT_SIMILARITY, limit = TRAIT_LIMIT } = {}) {
  const list = Array.isArray(items) ? items : [];
  const kept = [];
  const merges = [];
  for (const item of list) {
    const hit = kept.find(row => row.status !== 'disabled' && item.status !== 'disabled'
      && labelSimilarity(row.label, item.label) >= threshold);
    if (!hit) { kept.push(item); continue; }

    const [base, extra] = (Number(hit.createdAt) || 0) <= (Number(item.createdAt) || 0) ? [hit, item] : [item, hit];
    const supportKeys = new Set(base.support.map(row => row.key));
    const support = [...base.support];
    for (const row of extra.support) {
      if (supportKeys.has(row.key)) continue;
      support.push(row);
      supportKeys.add(row.key);
    }
    const counterKeys = new Set(base.counter.map(row => row.key));
    const counter = [...base.counter];
    for (const row of extra.counter) {
      if (counterKeys.has(row.key)) continue;
      counter.push(row);
      counterKeys.add(row.key);
    }
    // 同一条证据不能既支持又反证
    const trimmedSupport = support.filter(row => !counter.some(c => c.key === row.key)).slice(-24);
    const merged = {
      ...base,
      confidence: clamp(Math.max(base.confidence, extra.confidence), 0, 0.95),
      status: base.status === 'active' || extra.status === 'active' ? 'active' : 'uncertain',
      support: trimmedSupport,
      counter: counter.slice(-24),
      revision: Math.max(base.revision, extra.revision) + 1,
      updatedAt: Math.max(Number(base.updatedAt) || 0, Number(extra.updatedAt) || 0)
    };
    pushHistory(merged, snapshotOf(merged, {
      action: `merged:${String(extra.label).slice(0, 40)}`,
      now: merged.updatedAt,
      restoredFrom: null
    }));
    kept[kept.indexOf(hit)] = merged;
    merges.push({
      keptId: base.id,
      mergedId: extra.id,
      keptLabel: base.label,
      mergedLabel: extra.label,
      score: Number(labelSimilarity(base.label, extra.label).toFixed(3))
    });
  }
  const { kept: withinLimit, evicted } = partitionTraits(kept, limit);
  return { items: withinLimit, evicted, merges };
}

function kindOf(text) {
  if (/(建议|倾听|先听|沟通|表达|语气|回复)/.test(text)) return 'communication-style';
  if (/(跑步|咖啡|体检|工作|睡眠|旅行)/.test(text)) return 'interest';
  return 'attitude';
}

/**
 * 反思产出的"倾向描述"写入口。
 * 只记录"我倾向于……"这种自我认识，不接受建议/指令式表述（由调用方 prompt 约束）。
 * 生效条件：同一标签 ≥TRAIT_MIN_SUPPORT 条支持，或单次置信度 ≥0.8。
 *
 * polarity = 'support'（默认）：追加支持证据，强化这条倾向。
 * polarity = 'counter'：追加反证，弱化它——同一条证据会从支持里挪到反证里，
 * 置信度按 confidenceOf(support, counter) 重算（与 deriveTraits 同口径），
 * 反证压过支持时降为 uncertain。倾向是有强有弱的量，不是并列清单。
 */
export function applyReflectionTendency(personality, candidate, { now = Date.now(), polarity = 'support' } = {}) {
  const data = normalizePersonality(personality);
  const label = String(candidate?.label ?? '').trim().slice(0, 40);
  const statement = String(candidate?.statement ?? '').trim().slice(0, 200);
  // 反证只需要标签（它不改变表述）；支持才需要完整表述。
  if (!label) return { personality: data, changed: false, reason: 'empty' };
  if (polarity !== 'counter' && !statement) return { personality: data, changed: false, reason: 'empty' };
  // 只收描述型；指令式表述一律拒绝。
  // 「不准」只在句子开头或标点/空白之后才算祈使——否则会把「拿不准」「保不准」这类
  // 描述自己的话误判成指令（真实数据里就踩到过）。
  const PRESCRIPTIVE = /应该|必须|应当|以后要|务必|严禁|不许|不要再|禁止/;
  const IMPERATIVE_BUQI = /(^|[，。；：！？、\s])不准/;
  if (statement && (PRESCRIPTIVE.test(statement) || IMPERATIVE_BUQI.test(statement))) {
    return { personality: data, changed: false, reason: 'prescriptive' };
  }
  const confidence = clamp(Number(candidate?.confidence) || 0.5, 0, 0.95);
  const evidence = Array.isArray(candidate?.evidence)
    ? candidate.evidence.filter(id => typeof id === 'string').slice(0, 8)
    : [];
  const supportRow = { key: `refl:${hash(label + '|' + statement)}`, at: now, memoryId: evidence[0] ?? null, messageId: null, source: 'reflection' };
  const items = data.items.slice();
  // 先找完全同名；没有再找近义。近义命中的话，证据并进那一条，不再长出新条目。
  const exact = items.find(item => item.label === label);
  const similar = exact ? null : findSimilarTrait(items, label, { includeDisabled: true });
  const existing = exact ?? similar?.item ?? null;
  // 一个人说“这不是我”之后又被同类证据撞上：只有够分量的新证据才允许重新长回来。
  if (existing && existing.status === 'disabled' && evidence.length < TRAIT_MIN_SUPPORT) {
    return { personality: data, changed: false, reason: 'similar-disabled' };
  }
  const mergedInto = exact || !similar
    ? null
    : { id: similar.item.id, label: similar.item.label, score: Number(similar.score.toFixed(3)) };
  const rowLabel = existing?.label ?? label;

  const activate = (supportCount, conf) => (supportCount >= TRAIT_MIN_SUPPORT || conf >= 0.8 ? 'active' : 'uncertain');

  // 反证入口：只作用于已有倾向（没有支持的倾向不该凭空存在，所以不新建）。
  if (polarity === 'counter') {
    if (!existing) return { personality: data, changed: false, reason: 'no-target' };
    const counterRows = evidence
      .filter(id => id && !existing.counter.some(row => row.memoryId === id))
      .slice(0, 3)
      .map(id => ({ key: `refl:${rowLabel}:${id}`, at: now, memoryId: id, messageId: null, source: 'reflection' }));
    if (counterRows.length === 0) return { personality: data, changed: false, reason: 'duplicate' };
    // 同一条证据不能既支持又反证：反证优先，从支持里挪走。
    const movedIds = new Set(counterRows.map(row => row.memoryId).filter(Boolean));
    const support = existing.support.filter(row => !(row.memoryId && movedIds.has(row.memoryId)));
    const counter = [...existing.counter, ...counterRows].slice(-24);
    const nextConfidence = confidenceOf(support.length, counter.length);
    const status =
      counter.length > 0 && support.length - counter.length <= 0
        ? 'uncertain'
        : support.length >= TRAIT_MIN_SUPPORT
          ? 'active'
          : 'uncertain';
    const revision = existing.revision + 1;
    const updated = {
      ...existing,
      confidence: nextConfidence,
      status,
      support,
      counter,
      revision,
      updatedAt: now,
      history: [...existing.history, { at: now, revision, action: 'contradicted', statement: existing.statement, confidence: nextConfidence, status, support, counter }].slice(-HISTORY_LIMIT)
    };
    items[items.indexOf(existing)] = updated;
    return { personality: { ...data, items }, changed: true, item: updated, mergedInto };
  }

  if (existing) {
    const freshRows = evidence
      .filter(id => id && !existing.support.some(row => row.memoryId === id))
      .slice(0, 3)
      .map(id => ({ key: `refl:${rowLabel}:${id}`, at: now, memoryId: id, messageId: null, source: 'reflection' }));
    if (freshRows.length === 0 && (mergedInto || existing.statement === statement)) {
      return { personality: data, changed: false, reason: 'duplicate', mergedInto };
    }
    const support = [...existing.support, ...freshRows].slice(-24);
    const nextConfidence = clamp(Math.max(existing.confidence, confidence) + 0.05, 0, 0.95);
    const status = activate(support.length, nextConfidence);
    const revision = existing.revision + 1;
    // 近义命中时保留她原来的表述，只把证据并进来——不替她改写自己说过的话。
    const nextStatement = mergedInto ? existing.statement : statement;
    const updated = {
      ...existing,
      statement: nextStatement,
      confidence: nextConfidence,
      status,
      support,
      revision,
      updatedAt: now,
      history: [...existing.history, {
        at: now,
        revision,
        action: mergedInto ? `merged:${label}`.slice(0, 60) : 'reflected',
        statement: nextStatement,
        confidence: nextConfidence,
        status,
        support,
        counter: existing.counter
      }].slice(-HISTORY_LIMIT)
    };
    items[items.indexOf(existing)] = updated;
    return { personality: { ...data, items }, changed: true, item: updated, mergedInto };
  }

  const supportRows = (evidence.length ? evidence : [null]).slice(0, 3).map(id => ({
    key: `refl:${label}:${id ?? 'self'}`,
    at: now,
    memoryId: id,
    messageId: null,
    source: 'reflection'
  }));
  const status = activate(supportRows.length, confidence);
  const created = {
    id: `trait-${hash(label + '|' + statement)}`,
    kind: 'tendency',
    topic: label.slice(0, 24),
    facet: '通用',
    label,
    statement,
    confidence,
    status,
    support: supportRows,
    counter: [],
    explanations: [],
    history: [{ at: now, revision: 1, action: 'created', statement, confidence, status, support: supportRows, counter: [] }],
    revision: 1,
    createdAt: now,
    updatedAt: now
  };
  items.push(created);
  // 超活跃池上限时按价值挤出（status > confidence > updatedAt），由调用方沉底落盘，不删除。
  const { kept, evicted } = partitionTraits(items, TRAIT_LIMIT);
  return { personality: { ...data, items: kept }, changed: true, item: created, evicted };
}

// 和当前话题的相关度：命中越具体分越高；没有话题时返回 0（退回按置信排序）。
function topicRelevance(item, topics) {
  if (!Array.isArray(topics) || topics.length === 0) return 0;
  const hay = `${item.topic ?? ''} ${item.label ?? ''} ${item.statement ?? ''}`.toLowerCase();
  let score = 0;
  for (const topic of topics) {
    const key = String(topic ?? '').trim().toLowerCase();
    if (key.length < 2) continue;
    if (hay.includes(key)) { score = Math.max(score, key.length); continue; }
    // 中文没空格：退一步看二元组，至少两字连续命中才算相关
    for (let i = 0; i + 2 <= key.length; i += 1) {
      if (hay.includes(key.slice(i, i + 2))) { score = Math.max(score, 2); break; }
    }
  }
  return score;
}

export function activeTraits(personality, { limit = TRAIT_ACTIVE_LIMIT, minConfidence = TRAIT_MIN_CONFIDENCE, topics = [] } = {}) {
  const data = normalizePersonality(personality);
  return data.items
    .filter(item => item.status === 'active' && item.confidence >= minConfidence)
    .map(item => ({ item, relevance: topicRelevance(item, topics) }))
    .sort((a, b) =>
      b.relevance - a.relevance
      || b.item.confidence - a.item.confidence
      || (Number(b.item.updatedAt) || 0) - (Number(a.item.updatedAt) || 0))
    .slice(0, limit)
    .map(({ item }) => ({ id: item.id, label: item.label, statement: item.statement, confidence: item.confidence }));
}

export function revertTrait(personality, id, { now = Date.now(), toRevision = null } = {}) {
  const data = normalizePersonality(personality);
  const item = data.items.find(row => row.id === id);
  if (!item) return { personality: data, reverted: null, reason: 'not-found' };
  const candidates = item.history.filter(row => !row.revoked && row.revision < item.revision);
  const target = toRevision === null ? candidates.at(-1) : candidates.find(row => row.revision === Number(toRevision));
  if (!target) return { personality: data, reverted: null, reason: 'no-previous-revision' };

  for (const row of item.history) {
    if (row.revision > target.revision) row.revoked = true;
  }
  item.statement = target.statement;
  item.confidence = target.confidence;
  item.status = target.status === 'disabled' ? 'active' : target.status;
  item.support = target.support.map(row => ({ ...row }));
  item.counter = target.counter.map(row => ({ ...row }));
  item.revertedAt = now;
  item.disabledAt = null;
  item.revision += 1;
  item.updatedAt = now;
  pushHistory(item, snapshotOf(item, { action: 'revert', now, restoredFrom: target.revision }));
  return {
    personality: { ...data, revision: data.revision + 1, updatedAt: now },
    reverted: item.id,
    toRevision: target.revision
  };
}

export function disableTrait(personality, id, { now = Date.now(), reason = 'manual' } = {}) {
  const data = normalizePersonality(personality);
  const item = data.items.find(row => row.id === id);
  if (!item) return { personality: data, disabled: null, reason: 'not-found' };
  item.status = 'disabled';
  item.disabledAt = now;
  item.revertedAt = null;
  item.revision += 1;
  item.updatedAt = now;
  pushHistory(item, snapshotOf(item, { action: `disable:${String(reason).slice(0, 40)}`, now }));
  return { personality: { ...data, revision: data.revision + 1, updatedAt: now }, disabled: item.id };
}

