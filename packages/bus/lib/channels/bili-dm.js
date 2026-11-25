// 用户私信通道：轮询只读私信 → owner-message；发送默认只落 outbox（dry-run）。
// 真实发送需要 B 站 grant 含 send，本模块默认不开启。
export function createBilibiliDmChannel({
  facade,
  getBilibili,
  getService = () => facade?.boundService?.() ?? null,
  pollMs = 30_000,
  size = 10,
  sendEnabled = false,
  clock = Date.now,
  logger = console,
} = {}) {
  if (!facade) throw new Error('createBilibiliDmChannel 需要 facade');
  if (typeof getBilibili !== 'function') throw new Error('createBilibiliDmChannel 需要 getBilibili');
  const seen = new Set();
  const outbox = [];
  const stats = { polls: 0, received: 0, accepted: 0, ignored: 0, replies: 0, errors: 0, lastError: null };
  let timer = null;
  let cursor = null;
  let busy = false;

  async function deliverToKernel(message, ownerMid) {
    const id = `bili-${message.messageId}`;
    if (seen.has(id)) { stats.ignored += 1; return false; }
    seen.add(id);
    stats.accepted += 1;
    await facade.bus.ingest({
      id,
      type: 'owner-message',
      at: Number(message.timestamp) || clock(),
      actor: { kind: 'owner', authenticated: true, mid: ownerMid },
      payload: {
        text: String(message.text || ''),
        platform: 'bilibili',
        messageId: String(message.messageId || ''),
      },
    });
    const service = getService();
    if (service?.idle) await service.idle();
    return true;
  }

  async function poll() {
    if (busy) return stats;
    busy = true;
    try {
      stats.polls += 1;
      const bili = getBilibili();
      const status = await bili.socialStatus();
      if (!status?.active || !status?.bindingValid || !status?.realReadAvailable) {
        stats.ignored += 0;
        return stats;
      }
      const ownerMid = String(status.ownerMid || '');
      const received = await bili.socialReceive({
        cursor,
        size,
        actor: { kind: 'user', authenticated: true },
        intentId: `dm-poll-${clock()}`,
      });
      cursor = received?.cursor ?? cursor;
      const messages = Array.isArray(received?.messages) ? received.messages : [];
      stats.received += messages.length;
      for (const message of messages) {
        if (String(message.from) !== ownerMid) continue;
        await deliverToKernel(message, ownerMid);
      }
    } catch (error) {
      stats.errors += 1;
      stats.lastError = { code: error?.code || 'dm-channel-failed', message: String(error?.message || error) };
      logger?.warn?.('[bili-dm]', stats.lastError.code, stats.lastError.message);
    } finally {
      busy = false;
    }
    return stats;
  }

  facade.setTransport?.({
    send: async (intent) => {
      if (!sendEnabled) {
        outbox.push({ at: clock(), type: intent.type, text: intent.text, intentId: intent.intentId });
        stats.replies += 1;
        return { ok: true, messageId: `dm-outbox-${outbox.length}`, dryRun: true };
      }
      const bili = getBilibili();
      const result = await bili.socialSend({ intentId: intent.intentId, text: intent.text });
      stats.replies += 1;
      return { ok: true, messageId: result?.messageId ?? null };
    },
  });

  return {
    start() { if (!timer) timer = setInterval(poll, pollMs); return this; },
    stop() { if (timer) { clearInterval(timer); timer = null; } return this; },
    poll,
    status: () => ({ running: Boolean(timer), cursor, seen: seen.size, stats, outbox: outbox.slice(-20) }),
  };
}
