// 规则编码：从用户消息里抽出“值得记”的候选记忆（v1 不调模型）。
// 一句里可能同时有偏好和安排，按分句拆成多条；更正按整句处理。
// 产出直接写进 store.memory；调用方负责持久化。

import { addMemory } from './write.js';
import { lexemes } from './memory.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const RELATIVE_DAYS = [
  ['大后天', 3],
  ['后天', 2],
  ['明天', 1],
  ['明晚', 1],
  ['今晚', 0],
  ['今天', 0]
];
const WEEKDAY_INDEX = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 0 };

const KEYWORDS = ['体检', '面试', '考试', '出差', '生日', '约会', '会议', '复诊', '手术', '旅行', '搬家'];
const CORRECTION_CUES = ['不是', '说错', '记错', '搞错', '更正', '其实是'];
const COMMITMENT_CUES = ['答应你', '答应', '说好', '约好', '承诺', '保证', '一定去', '一定会', '我记得'];
const PLAN_CUES = ['准备', '打算', '计划', '想试', '想去', '要去', '会去', '下次想'];
const PAST_CUES = ['已经', '刚去', '刚做', '昨天', '前天', '去过', '吃过', '看过', '做完了'];
const REQUEST_CUES = ['帮我', '替我', '你帮我', '你去', '你查', '你看', '你记得'];
const EMOTION_CUES = ['开心', '高兴', '难过', '焦虑', '紧张', '烦', '害怕', '担心'];
const PREFERENCE_CUES = [
  '我不太想',
  '不太想',
  '我不想',
  '我不太喜欢',
  '不太喜欢',
  '我不喜欢',
  '不喜欢',
  '我讨厌',
  '讨厌',
  '我喜欢',
  '我爱',
  '我想要',
  '我怕'
];

function partsOf(timestamp, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
  const map = {};
  for (const part of formatter.formatToParts(timestamp)) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  const asUTC = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second)
  );
  return { map, offset: asUTC - timestamp };
}

export function localDayStart(timestamp, timeZone = 'Asia/Shanghai', addDays = 0) {
  const { map, offset } = partsOf(timestamp, timeZone);
  return Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day) + addDays) - offset;
}

function localParts(timestamp, timeZone) {
  const { map, offset } = partsOf(timestamp, timeZone);
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    offset
  };
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function dayStartOf(year, month, day, offset) {
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return Date.UTC(year, month - 1, day) - offset;
}

function weekdayOf(dayStart, offset) {
  // 本地日期的星期：用当日 UTC 零点反推，避免再查一次时区。
  return new Date(dayStart + offset).getUTCDay();
}

/**
 * 解析“什么时候”：相对词、星期、月日、光秃秃的“20号”。
 * 只精确到日；返回当天 00:00 与 20:00 的提醒时间。
 */
export function parseScheduleDate(text, now, timeZone = 'Asia/Shanghai') {
  const zone = timeZone || 'Asia/Shanghai';
  const local = localParts(now, zone);
  const todayStart = localDayStart(now, zone, 0);
  const withFollowUp = dayStart => {
    if (dayStart === null || dayStart === undefined) return null;
    return { dayStart, followUpAt: dayStart + 20 * 60 * 60 * 1000, precision: 'day' };
  };

  // 下个月 3 号
  const nextMonth = text.match(/下个月\s*(\d{1,2})\s*[日号]/);
  if (nextMonth) {
    const month = local.month === 12 ? 1 : local.month + 1;
    const year = local.month === 12 ? local.year + 1 : local.year;
    return withFollowUp(dayStartOf(year, month, Number(nextMonth[1]), local.offset));
  }

  // 2027 年 1 月 5 日 / 11 月 20 日
  const fullDate = text.match(/(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/);
  if (fullDate) {
    const month = Number(fullDate[2]);
    const day = Number(fullDate[3]);
    if (month < 1 || month > 12) return null;
    let year = fullDate[1] ? Number(fullDate[1]) : local.year;
    let start = dayStartOf(year, month, day, local.offset);
    if (start === null) return null;
    if (!fullDate[1] && start < todayStart) {
      year += 1;
      start = dayStartOf(year, month, day, local.offset);
    }
    return withFollowUp(start);
  }

  // 20 号（没有月份）：本月；若已过，取下月
  const bareDay = text.match(/(?:^|[^\d月])(\d{1,2})\s*[日号]/);
  if (bareDay) {
    const day = Number(bareDay[1]);
    if (day < 1 || day > 31) return null;
    let year = local.year;
    let month = local.month;
    let start = dayStartOf(year, month, day, local.offset);
    if (start === null) return null;
    if (start < todayStart) {
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
      start = dayStartOf(year, month, day, local.offset);
      if (start === null) return null;
    }
    return withFollowUp(start);
  }

  for (const [word, add] of RELATIVE_DAYS) {
    if (text.includes(word)) {
      const start = localDayStart(now, zone, add);
      return withFollowUp(start);
    }
  }

  // 周三 / 星期三 / 下周三 / 本周三
  const todayWeekday = weekdayOf(todayStart, local.offset);
  const nextWeek = text.match(/(下个星期|下星期|下周)\s*([一二三四五六日天1-7])/);
  if (nextWeek) {
    const target = WEEKDAY_INDEX[nextWeek[2]];
    if (target === undefined) return null;
    const mondayOffset = (todayWeekday + 6) % 7;
    const currentMonday = todayStart - mondayOffset * DAY_MS;
    const targetIndex = target === 0 ? 6 : target - 1;
    return withFollowUp(currentMonday + 7 * DAY_MS + targetIndex * DAY_MS);
  }

  const thisWeek = text.match(/(这周|本周|这星期|本星期)\s*([一二三四五六日天1-7])/);
  if (thisWeek) {
    const target = WEEKDAY_INDEX[thisWeek[2]];
    if (target === undefined) return null;
    const mondayOffset = (todayWeekday + 6) % 7;
    const currentMonday = todayStart - mondayOffset * DAY_MS;
    const targetIndex = target === 0 ? 6 : target - 1;
    return withFollowUp(currentMonday + targetIndex * DAY_MS);
  }

  // 裸周几：取最近的下一次（今天也算）
  const weekday = text.match(/(?:周|星期|礼拜)\s*([一二三四五六日天1-7])/);
  if (weekday) {
    const target = WEEKDAY_INDEX[weekday[1]];
    if (target === undefined) return null;
    const delta = (target - todayWeekday + 7) % 7;
    return withFollowUp(todayStart + delta * DAY_MS);
  }

  return null;
}

function matchKeyword(text) {
  return KEYWORDS.find(keyword => text.includes(keyword)) ?? null;
}

// 问句不是新事实：避免“之前说的体检怎么样了？”又长出一条“体检相关”。
function isQuestion(text) {
  if (/[?？]/.test(text)) return true;
  if (/^(你觉得|你认为|你说|请问|要不要|能不能|可不可以|是不是|是否)/.test(text.trim())) return true;
  if (/(吗|呢|怎么样|怎么|什么|哪[个里种]|多少|如何|是否|有没有|要不要)\s*[。！!]?\s*$/.test(text)) return true;
  return false;
}

function isQuestionClause(clause) {
  return isQuestion(clause);
}

function hasAny(text, cues) {
  return cues.some(cue => text.includes(cue));
}

function sharedBigrams(a, b) {
  const left = lexemes(a);
  return [...lexemes(b)].filter(token => token.length === 2 && left.has(token)).length;
}

function findCorrectionTarget(memories, text) {
  let best = null;
  let bestScore = 1;
  for (const row of memories) {
    if (!row || row.supersededBy || row.archivedAt) continue;
    if (row.kind !== 'fact') continue;
    const score = sharedBigrams(row.content, text);
    if (score > bestScore) {
      best = row;
      bestScore = score;
    }
  }
  return best;
}

function clausesOf(text) {
  return text
    .split(/[，,。；;！!？?、\n]+/)
    .map(clause => clause.trim())
    .filter(clause => clause.length > 0);
}

// P1-B：判断"我叫/叫我 X"是否真的在自我介绍。
// 反例：「我不太喜欢别人叫我老板」——"叫我老板"是别人对她的称呼方式，
// 且整句是否定/嫌恶语境，绝不能记成用户自称"我叫老板"（语义会直接反转）。
const NEGATION_TAIL = /(?:不|别|没|未|无|讨厌|不喜欢|不要|避免)[^。！？；，,]{0,6}$/;
const THIRD_PERSON_TAIL = /(?:别人|大家|他们|她们|有人|旁人)[^。！？；，,]{0,2}$/;

function isNonSelfNaming(text, index) {
  const before = String(text ?? '').slice(0, Math.max(0, index));
  if (NEGATION_TAIL.test(before)) return true;
  if (THIRD_PERSON_TAIL.test(before)) return true;
  return false;
}

export function encodeEvent(event, { state, now = Date.now(), timeZone = 'Asia/Shanghai', capacity = 5000 } = {}) {
  const result = { created: [], corrected: [], skipped: null };
  if (event?.type !== 'owner-message') return result;
  if (event.actor?.kind !== 'owner' || event.actor?.authenticated !== true) return result;

  const text = String(event.payload?.text ?? '').trim();
  if (text === '' || text.length > 500) return result;
  const zone = timeZone || 'Asia/Shanghai';
  const memories = state?.memories ?? [];
  const source = { level: 'owner-message', channel: 'chat', messageId: event.id };

  const clauses = clausesOf(text);
  if (clauses.length > 0 && clauses.every(clause => isQuestionClause(clause))) {
    result.skipped = 'question-not-fact';
    return result;
  }

  // 用户自称：“我叫阿岚 / 叫我阿岚”。名字应比普通事实更重要，但不阻断同句其它线索。
  // 必须先排除否定/第三人称语境，否则"不喜欢别人叫我老板"会被当成用户自称"老板"。
  const ownerNameMatch = text.match(/(?:我叫|叫我)\s*([\u4e00-\u9fa5]{2,4})(?=[，,。！!？?\s]|$)/);
  const ownerName = ownerNameMatch && !isNonSelfNaming(text, ownerNameMatch.index ?? 0)
    ? ownerNameMatch
    : null;
  if (ownerName) {
    const name = ownerName[1];
    const existing = memories.find(
      row =>
        !row.archivedAt &&
        row.kind === 'fact' &&
        (row.tags ?? []).includes('称呼') &&
        String(row.content ?? '').includes(name)
    );
    if (!existing) {
      const created = addMemory(
        state,
        {
          kind: 'fact',
          layer: 'episodic',
          title: '用户称呼',
          content: `用户说“我叫${name}”`,
          tags: ['用户', '称呼'],
          importance: 5,
          source,
          occurredAt: event.at
        },
        { now, capacity, timeZone: zone }
      );
      if (created.ok) result.created.push(created.id);
      else if (created.error === 'memory-capacity-reached') result.skipped = created.error;
    }
  }

  // 更正整句处理：需要跨分句找“旧标题 + 新日期”的关系。
  if (CORRECTION_CUES.some(cue => text.includes(cue))) {
    const target = findCorrectionTarget(memories, text);
    if (target) {
      const created = addMemory(
        state,
        {
          kind: 'fact',
          layer: 'episodic',
          title: `更正：${target.title}`.slice(0, 60),
          content: text,
          tags: [...new Set([...(target.tags ?? []), '更正'])],
          importance: 4,
          source,
          occurredAt: event.at
        },
        { now, capacity, timeZone: zone }
      );
      if (created.ok) {
        const replacedAt = new Date(now).toISOString();
        target.supersededBy = created.id;
        target.supersededAt = replacedAt;
        target.updatedAt = replacedAt;
        result.corrected.push({ oldId: target.id, newId: created.id });
      }
      return result;
    }
  }

  for (const clause of clauses) {
    if (isQuestionClause(clause)) {
      result.skipped = result.skipped ?? 'question-not-fact';
      continue;
    }
    const preference = PREFERENCE_CUES.find(cue => clause.includes(cue));
    if (preference) {
      const created = addMemory(
        state,
        {
          kind: 'fact',
          layer: 'preference',
          title: `偏好：${clause.slice(0, 20)}`,
          content: clause,
          tags: ['偏好'],
          importance: 3,
          source,
          occurredAt: event.at
        },
        { now, capacity, timeZone: zone }
      );
      if (created.ok) result.created.push(created.id);
      else if (created.error === 'memory-capacity-reached') result.skipped = created.error;
      continue;
    }

    const keyword = matchKeyword(clause);
    if (!keyword) {
      if (clause.length < 4) continue;
      const rule = hasAny(clause, COMMITMENT_CUES)
        ? { title: `承诺：${clause.slice(0, 16)}`, tags: ['承诺'], importance: 4, modality: 'commitment' }
        : hasAny(clause, PLAN_CUES)
          ? { title: `计划：${clause.slice(0, 16)}`, tags: ['计划'], importance: 3, modality: 'plan' }
          : hasAny(clause, PAST_CUES)
            ? { title: `事实：${clause.slice(0, 16)}`, tags: ['事实'], importance: 3, modality: 'fact' }
            : hasAny(clause, REQUEST_CUES)
              ? { title: `请求：${clause.slice(0, 16)}`, tags: ['请求'], importance: 3, modality: 'request' }
              : hasAny(clause, EMOTION_CUES)
                ? { title: `情绪：${clause.slice(0, 12)}`, tags: ['情绪'], importance: 2, modality: 'emotion' }
                : null;
      if (!rule) continue;
      const created = addMemory(
        state,
        {
          kind: 'fact',
          layer: 'episodic',
          title: rule.title,
          content: clause,
          tags: rule.tags,
          importance: rule.importance,
          source,
          modality: rule.modality,
          occurredAt: event.at
        },
        { now, capacity, timeZone: zone }
      );
      if (created.ok) result.created.push(created.id);
      else if (created.error === 'memory-capacity-reached') result.skipped = created.error;
      continue;
    }

    const schedule = parseScheduleDate(clause, now, zone);
    if (schedule) {
      const duplicate = memories.find(
        row =>
          !row.supersededBy &&
          !row.archivedAt &&
          row.kind === 'fact' &&
          (row.tags ?? []).includes(keyword) &&
          typeof row.followUpAt === 'number' &&
          Math.abs(row.followUpAt - schedule.followUpAt) < DAY_MS
      );
      if (duplicate) {
        result.skipped = 'duplicate-schedule';
        continue;
      }
      const planned = hasAny(clause, PLAN_CUES) && !hasAny(clause, PAST_CUES);
      const created = addMemory(
        state,
        {
          kind: 'fact',
          layer: 'episodic',
          title: `${keyword}安排`,
          content: clause,
          tags: [keyword, '日程', planned ? '计划' : '事实'],
          importance: 4,
          source,
          modality: planned ? 'plan' : 'fact',
          ...(planned ? { plannedFor: schedule.dayStart } : {}),
          occurredAt: schedule.dayStart,
          precision: 'day',
          validFrom: schedule.dayStart,
          followUpAt: schedule.followUpAt
        },
        { now, capacity, timeZone: zone }
      );
      if (created.ok) result.created.push(created.id);
      else result.skipped = created.error;
      continue;
    }

    if (clause.length < 4) continue;
    const created = addMemory(
      state,
      {
        kind: 'fact',
        layer: 'episodic',
        title: `${keyword}相关`,
        content: clause,
        tags: [keyword],
        importance: 3,
        source,
        occurredAt: event.at
      },
      { now, capacity, timeZone: zone }
    );
    if (created.ok) result.created.push(created.id);
    else result.skipped = created.error;
  }

  return result;
}
