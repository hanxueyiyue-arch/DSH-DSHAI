const DEFAULT_POLL_MS = 10_000;
const DEFAULT_IDLE_POLL_MS = 60_000;
const MAX_POLL_MS = 5 * 60_000;
const DEFAULT_ACTIVE_WINDOW_MS = 120_000;
const DEFAULT_BACKOFF_MAX_MS = 300_000;

function errorOf(error) {
  return { code: error?.code ?? 'owner-session-error', message: String(error?.message ?? error) };
}

export function createOwnerSession({
  bili,
  facade,
  getService,
  ownerMid,
  pollMs = DEFAULT_POLL_MS,
  // 自适应：最近有来往时用 pollMs（快），空闲时降到 idlePollMs。
  adaptive = true,
  idlePollMs = DEFAULT_IDLE_POLL_MS,
  activeWindowMs = DEFAULT_ACTIVE_WINDOW_MS,
  backoffMaxMs = DEFAULT_BACKOFF_MAX_MS,
  capabilitiesOf = null,
  onDiag = null,
  size = 10,
  sendMode = 'dry-run',
  readIntent = null,
  sendIntent = null,
  latestOnly = true,
  sinceMs = 0,
  clock = Date.now,
  logger = console,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  if (!bili) throw new Error('owner-session 需要 bili 服务');
  if (!facade) throw new Error('owner-session 需要 cognition bus facade');
  if (!getService) throw new Error('owner-session 需要 getService');
  if (!ownerMid || !/^[0-9]{5,20}$/.test(String(ownerMid))) throw new Error('owner-session 需要合法的 ownerMid');

  const clampMs = (value, fallback) => {
    const n = Number(value);
    return Math.max(1000, Math.min(MAX_POLL_MS, Number.isFinite(n) && n > 0 ? n : fallback));
  };
  const fastMs = clampMs(pollMs, DEFAULT_POLL_MS);
  const idleMs = clampMs(idlePollMs, DEFAULT_IDLE_POLL_MS);
  const activeWindow = Math.max(1000, Number(activeWindowMs) || DEFAULT_ACTIVE_WINDOW_MS);
  const backoffCap = Math.max(fastMs, Number(backoffMaxMs) || DEFAULT_BACKOFF_MAX_MS);
  const interval = fastMs;
  const diag = typeof onDiag === 'function' ? onDiag : () => undefined;
  const state = {
    running: false,
    timer: null,
    polls: 0,
    received: 0,
    newReceived: 0,
    accepted: 0,
    rejected: 0,
    rejectedPermanent: 0,
    lastRejected: null,
    ignored: 0,
    duplicates: 0,
    replies: 0,
    errors: [],
    lastPollAt: null,
    lastError: null,
    lastActivityAt: 0,
    backoffLevel: 0,
    lastIntervalMs: null,
    outbox: [],
  };
  const seen = new Set();
  // 被内核明确拒绝的消息不推进进度；短暂拒绝允许重试，连续多次才放弃。
  const rejectedAttempts = new Map();
  const MAX_REJECTED_ATTEMPTS = 3;
  let replySeq = 0;
  let polling = false;

  function status() {
    return {
      running: state.running,
      ownerMid: String(ownerMid),
      pollMs: interval,
      sendMode,
      polls: state.polls,
      received: state.received,
      accepted: state.accepted,
      rejected: state.rejected,
      rejectedPermanent: state.rejectedPermanent,
      lastRejected: state.lastRejected,
      ignored: state.ignored,
      duplicates: state.duplicates,
      replies: state.replies,
      lastPollAt: state.lastPollAt,
      lastError: state.lastError,
      newReceived: Number(state.newReceived || 0),
      historySkipped: Number(state.historySkipped || 0),
      adaptive,
      fastPollMs: fastMs,
      idlePollMs: idleMs,
      activeWindowMs: activeWindow,
      backoffLevel: state.backoffLevel,
      lastIntervalMs: state.lastIntervalMs,
      nextIntervalMs: nextInterval(),
      lastActivityAt: state.lastActivityAt || null,
      errors: state.errors.slice(-5),
      outbox: state.outbox.slice(-20),
    };
  }

  // 下一次轮询的间隔：最近有来往用快档，空闲用慢档；连续失败指数退避。
  function nextInterval() {
    const base = adaptive && clock() - state.lastActivityAt >= activeWindow ? idleMs : fastMs;
    if (state.backoffLevel <= 0) return base;
    return Math.min(backoffCap, base * 2 ** Math.min(state.backoffLevel, 6));
  }

  function markActivity() {
    state.lastActivityAt = clock();
  }

  function idOf(message) {
    for (const key of ['messageId', 'msgKey', 'id', 'key']) {
      const value = message?.[key];
      if (value !== undefined && value !== null && String(value) !== '') return String(value);
    }
    return null;
  }

  function senderOf(message) {
    return String(message?.from ?? message?.senderMid ?? message?.uid ?? message?.mid ?? '');
  }

  function textOf(message) {
    const payload = message?.content ?? message?.text ?? message?.msg ?? '';
    if (typeof payload === 'string') {
      const trimmed = payload.trim();
      if (trimmed.startsWith('{')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === 'object') return String(parsed.content ?? parsed.text ?? '');
        } catch { /* 不是 JSON，按原文处理 */ }
      }
      return payload;
    }
    if (payload && typeof payload === 'object') return String(payload.content ?? payload.text ?? '');
    return '';
  }

  // B 站消息时间是秒级 epoch，内核统一用毫秒。
  function atOf(message, fallback) {
    const raw = message?.at ?? message?.timestamp ?? null;
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
      return raw < 1e12 ? raw * 1000 : raw;
    }
    if (typeof raw === 'string') {
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed)) return parsed;
    }
    return fallback();
  }

  async function accept(messages) {
    let fresh = 0;
    const candidates = [];
    // 历史闸门：早于 sinceMs 的消息一律忽略，避免开机时把旧测试私信当新消息回复。
    const historyCutoff = Number.isFinite(sinceMs) && sinceMs > 0 ? sinceMs : 0;
    for (const message of messages) {
      const id = idOf(message);
      if (!id) { state.ignored += 1; continue; }
      if (senderOf(message) !== String(ownerMid)) { state.ignored += 1; continue; }
      if (seen.has(id)) { state.duplicates += 1; continue; }
      if (historyCutoff > 0 && atOf(message, clock) < historyCutoff) {
        seen.add(id);
        state.ignored += 1;
        state.historySkipped = Number(state.historySkipped || 0) + 1;
        continue;
      }
      const text = textOf(message).trim();
      if (!text) { state.ignored += 1; continue; }
      candidates.push({ id, text, message });
    }
    if (latestOnly && candidates.length > 1) {
      candidates.sort((a, b) => atOf(a.message, clock) - atOf(b.message, clock));
      const keep = candidates[candidates.length - 1];
      for (const dropped of candidates) {
        if (dropped === keep) continue;
        seen.add(dropped.id);
        state.ignored += 1;
      }
      candidates.length = 0;
      candidates.push(keep);
    }
    for (const { id, text, message } of candidates) {
      try {
        // 把当前工具目录随消息一起交给内核：能力由总线决定，内核不再硬编码。
        let capabilities;
        if (typeof capabilitiesOf === 'function') {
          try { const list = capabilitiesOf(); if (Array.isArray(list)) capabilities = list; } catch { /* 取不到就不带 */ }
        }
        const ingested = await facade.bus.ingest({
          id: `bili-${id}`,
          type: 'owner-message',
          at: atOf(message, clock),
          actor: { kind: 'owner', authenticated: true, mid: String(ownerMid) },
          payload: { text, ...(capabilities ? { capabilities } : {}) },
        });
        if (ingested && ingested.accepted === false) {
          state.rejected += 1;
          const attempts = (rejectedAttempts.get(id) ?? 0) + 1;
          rejectedAttempts.set(id, attempts);
          state.lastRejected = { at: clock(), id, error: ingested.error ?? 'ingest-rejected', attempts };
          // 队列满/暂存失败属于可恢复：不记 seen，下一轮重试。
          // 连续多次仍被拒，才当作永久失败，避免每一轮都重投同一条。
          if (attempts >= MAX_REJECTED_ATTEMPTS) {
            seen.add(id);
            rejectedAttempts.delete(id);
            state.rejectedPermanent += 1;
          }
          continue;
        }
        rejectedAttempts.delete(id);
        if (ingested?.duplicate === true) {
          seen.add(id);
          state.duplicates += 1;
          continue;
        }
      } catch (error) {
        const failure = errorOf(error);
        state.lastError = failure;
        state.errors.push({ at: clock(), ...failure });
        state.errors = state.errors.slice(-20);
        continue;
      }
      seen.add(id);
      state.accepted += 1;
      fresh += 1;
    }
    if (fresh > 0) {
      const service = getService();
      if (service) await service.idle();
    }
    return fresh;
  }

  // P3：每轮都读"最新一页"是**有意设计**（B 站 cursor 是 begin_seqno，往回翻历史，
  // 不适合做增量拉取）。真正的问题只是：同一页会被反复返回，导致 received 统计虚高。
  // 这里额外记录 newReceived（去重后的新消息数），received 仍保留原始条数。
  const toMessages = receive => (Array.isArray(receive) ? receive : (receive?.messages ?? receive?.items ?? []));

  async function pollOnce() {
    if (polling) return { skipped: 'busy' };
    polling = true;
    try {
      const extra = typeof readIntent === 'function' ? (readIntent() ?? {}) : {};
      const receive = await bili.socialReceive({ actor: { kind: 'user', authenticated: true }, size, ...extra });
      const messages = toMessages(receive);
      const fresh = messages.filter(message => {
        const id = idOf(message);
        return id && !seen.has(id);
      });
      state.polls += 1;
      state.received += messages.length;
      state.newReceived = Number(state.newReceived || 0) + fresh.length;
      state.lastPollAt = clock();
      if (fresh.length > 0) markActivity();
      await accept(messages);
      state.lastError = null;
      // 成功一次就清掉退避，回到正常节奏。
      if (state.backoffLevel > 0) {
        diag({ step: 'poll-recovered', backoffLevel: state.backoffLevel });
        state.backoffLevel = 0;
      }
      return { received: messages.length, fresh: fresh.length };
    } catch (error) {
      state.lastError = errorOf(error);
      state.errors.push({ at: clock(), ...state.lastError });
      state.errors = state.errors.slice(-20);
      // 连续失败指数退避，避免把风控越打越紧。
      state.backoffLevel = Math.min(6, state.backoffLevel + 1);
      const wait = nextInterval();
      diag({
        step: 'poll-error',
        code: state.lastError.code,
        message: state.lastError.message.slice(0, 200),
        backoffLevel: state.backoffLevel,
        nextWaitMs: wait
      });
      logger?.warn?.('[owner-session] 轮询失败', state.lastError.message);
      return { error: state.lastError };
    } finally {
      polling = false;
    }
  }

  async function transport(intent) {
    if (intent?.type === 'send') {
      const text = String(intent.text ?? '');
      if (!text) return { ok: false, error: { code: 'send-text-empty', message: '发送文本为空' } };
      if (sendMode !== 'real') {
        replySeq += 1;
        const messageId = `dry-${replySeq}`;
        state.replies += 1;
        markActivity();
        state.outbox.push({ at: clock(), text, replyTo: intent.replyTo ?? null, messageId });
        state.outbox = state.outbox.slice(-50);
        return { ok: true, messageId, dryRun: true };
      }
      try {
        const sendExtra = typeof sendIntent === 'function' ? (sendIntent({ text, replyTo: intent.replyTo ?? null }) ?? {}) : {};
        const result = await bili.socialSend({ actor: { kind: 'user', authenticated: true }, text, ...sendExtra });
        if (result?.ok === false) return { ok: false, error: result.error ?? { code: 'send-failed', message: 'B 站发送失败' } };
        state.replies += 1;
        markActivity();
        state.outbox.push({ at: clock(), text, replyTo: intent.replyTo ?? null, messageId: result?.messageId ?? null });
        state.outbox = state.outbox.slice(-50);
        return { ok: true, messageId: result?.messageId ?? null };
      } catch (error) {
        return { ok: false, error: errorOf(error) };
      }
    }
    return { ok: false, error: { code: 'owner-session-intent-unsupported', message: `不支持意图：${intent?.type}` } };
  }

  // 用递归 setTimeout 而不是 setInterval：每轮都按"当前状态"决定下一次间隔，
  // 这样空闲可以降频、失败可以退避。setInterval 固定不变，做不到。
  function scheduleNext() {
    if (!state.running) return;
    const wait = nextInterval();
    state.lastIntervalMs = wait;
    state.timer = setTimeoutFn(async () => {
      if (!state.running) return;
      await pollOnce();
      scheduleNext();
    }, wait);
    state.timer?.unref?.();
  }

  function start() {
    if (state.running) return status();
    state.running = true;
    diag({
      step: 'poll-start',
      adaptive,
      fastPollMs: fastMs,
      idlePollMs: idleMs,
      activeWindowMs: activeWindow,
      backoffMaxMs: backoffCap
    });
    void pollOnce().then(() => scheduleNext());
    return status();
  }

  function stop() {
    state.running = false;
    if (state.timer) { clearTimeoutFn(state.timer); state.timer = null; }
    return status();
  }

  return { start, stop, pollOnce, transport, status };
}
