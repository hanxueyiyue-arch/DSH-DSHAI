/* Budget 独立设置页（settings.section）。只调用本插件的本地 API；
 * 不读取其他插件数据，不包含任何凭证，不发起外部网络请求。
 *
 * 0.5.1：不依赖 window.prompt / confirm / alert（Electron 渲染器不可靠），
 * 所有确认都在页面内完成；特权动作仍由服务端校验 trust 与 CSRF。 */
window.__ModuleLoader__.load({
  id: 'dsh-dshai-budget',
  factory: require => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useState } = React;
    const API = '/dsh-dshai/budget/api';
    // 存的是 IANA 标识；界面显示中文名（Asia/Shanghai 与北京时间是同一时区，库里没有 Asia/Beijing）。
    const TZ_LABEL = { 'Asia/Shanghai': '北京时间（UTC+8）', 'Asia/Tokyo': '日本时间（UTC+9）', UTC: 'UTC' };
    const CSS = `
      .bg{--bg-accent:#0ea5e9;--bg-accent-2:#6366f1;max-width:960px;display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.55}
      .bg *{box-sizing:border-box}
      .bg h2{margin:0;font-size:22px;font-weight:700;letter-spacing:-.01em;line-height:1.25}
      .bg h3{margin:0;font-size:14px;font-weight:600;letter-spacing:.02em;display:flex;align-items:center;gap:8px}
      .bg h3::before{content:"";width:6px;height:6px;border-radius:2px;background:linear-gradient(135deg,var(--bg-accent),var(--bg-accent-2));flex:none}
      .bg .muted{opacity:.78;font-size:13px;line-height:1.7}
      .bg-hero{display:flex;gap:14px;align-items:center;padding:18px;border-radius:16px;background:linear-gradient(135deg,color-mix(in srgb,var(--bg-accent) 13%,transparent),color-mix(in srgb,var(--bg-accent-2) 10%,transparent));border:1px solid color-mix(in srgb,currentColor 8%,transparent)}
      .bg-avatar{width:46px;height:46px;border-radius:15px;display:grid;place-items:center;font-size:24px;background:color-mix(in srgb,var(--dsw-alias-bg-l1,#fff) 72%,transparent);box-shadow:0 2px 6px rgba(0,0,0,.08);flex:none}
      .bg-hero-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
      .bg-sub{margin:0;font-size:13px;opacity:.78;line-height:1.65}
      .bg-toolbar{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
      .bg-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:-4px}
      .bg .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(138px,1fr));gap:10px}
      .bg .card{border:1px solid color-mix(in srgb,currentColor 9%,transparent);border-radius:14px;padding:16px;min-width:0;background:color-mix(in srgb,currentColor 2.5%,transparent);box-shadow:0 1px 2px rgba(0,0,0,.03);display:flex;flex-direction:column;gap:9px}
      .bg .number{font-size:22px;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1.15;white-space:nowrap}
      .bg .actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
      .bg button{border:1px solid color-mix(in srgb,currentColor 13%,transparent);background:color-mix(in srgb,currentColor 3%,transparent);color:inherit;border-radius:9px;padding:7px 12px;font:inherit;font-size:12px;cursor:pointer;transition:background .15s ease,border-color .15s ease,transform .05s ease;white-space:nowrap}
      .bg button:hover:not(:disabled){background:color-mix(in srgb,currentColor 8%,transparent)}
      .bg button:active:not(:disabled){transform:translateY(1px)}
      .bg button:focus-visible{outline:2px solid color-mix(in srgb,var(--bg-accent) 62%,transparent);outline-offset:2px}
      .bg button:disabled{opacity:.42;cursor:not-allowed}
      .bg .badge{font-size:12px;line-height:1;border:1px solid color-mix(in srgb,currentColor 12%,transparent);border-radius:999px;padding:6px 9px;background:color-mix(in srgb,currentColor 4%,transparent);white-space:nowrap}
      .bg .warn{color:#d69c31;font-size:12px;line-height:1.6}.bg .error{color:#e05a5a;white-space:pre-wrap;font-size:12px;line-height:1.6}
      .bg .ok{color:#3f9d5a;white-space:pre-wrap;font-size:12px;line-height:1.6}
      .bg .item{border-top:1px solid color-mix(in srgb,currentColor 8%,transparent);padding:10px 0;overflow-wrap:anywhere}
      .bg .item:first-of-type{border:0;padding-top:0}
      .bg table{border-collapse:collapse;width:100%;font-size:12px;font-variant-numeric:tabular-nums}
      .bg th,.bg td{border-bottom:1px solid color-mix(in srgb,currentColor 8%,transparent);padding:7px 6px;text-align:right}
      .bg th{font-weight:600;opacity:.68;font-size:11px;letter-spacing:.03em}
      .bg th:first-child,.bg td:first-child{text-align:left}
      .bg label{display:flex;gap:6px;align-items:center;font-size:12px}
      .bg input,.bg select,.bg textarea{border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:9px;padding:7px 9px;color:inherit;background:color-mix(in srgb,currentColor 2%,transparent);max-width:160px;font:inherit;font-size:12px;outline:none}
      .bg input:focus,.bg select:focus,.bg textarea:focus{border-color:color-mix(in srgb,var(--bg-accent) 55%,transparent);box-shadow:0 0 0 3px color-mix(in srgb,var(--bg-accent) 14%,transparent)}
      .bg textarea{max-width:none;width:100%;min-height:54px;resize:vertical}
      .bg .row{display:flex;flex-wrap:wrap;gap:12px;align-items:center}
      .bg .pill{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid color-mix(in srgb,currentColor 12%,transparent);background:color-mix(in srgb,currentColor 4%,transparent);white-space:nowrap}
      .bg .confirm{border:1px dashed color-mix(in srgb,#d69c31 55%,transparent);border-radius:10px;padding:10px;margin-top:8px;font-size:12px;background:color-mix(in srgb,#d69c31 6%,transparent)}
      .bg details{border:1px solid color-mix(in srgb,currentColor 9%,transparent);border-radius:12px;padding:12px 14px;margin-top:8px;background:color-mix(in srgb,currentColor 2%,transparent)}
      .bg summary{cursor:pointer;font-size:12px;opacity:.82;list-style:none;display:flex;align-items:center;gap:7px}
      .bg summary::-webkit-details-marker{display:none}
      .bg summary::before{content:"▸";font-size:10px;opacity:.55;transition:transform .15s ease}
      .bg details[open] summary::before{transform:rotate(90deg)}
      @media (max-width:640px){.bg-hero{align-items:flex-start;flex-wrap:wrap}.bg-toolbar{width:100%;justify-content:flex-start}.bg .number{font-size:20px}}
    `;
    const money = (cost) => {
      if (!cost || typeof cost.micros !== 'number') return '—';
      return (cost.micros / 1e6).toFixed(4) + ' 元';
    };
    const micros = (n) => (Number(n || 0) / 1e6).toFixed(4) + ' 元';
    const rate = (n) => '¥' + Number(n).toFixed(2) + '/M';
    const STATUS_LABEL = {
      pending: '待批准', approved: '已批准', rejected: '已拒绝', revoked: '已撤销', expired: '已过期',
    };
    function ageText(minutes) {
      const m = Math.max(0, Math.floor(Number(minutes) || 0));
      if (m < 60) return m + ' 分钟';
      const hours = Math.floor(m / 60);
      if (hours < 24) return hours + ' 小时 ' + (m % 60) + ' 分';
      return Math.floor(hours / 24) + ' 天 ' + (hours % 24) + ' 小时';
    }
    function Screen() {
      const [data, setData] = useState(null);
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');
      const [busy, setBusy] = useState('');
      const [csrf, setCsrf] = useState('');
      const [form, setForm] = useState({ tokens: '', amount: '', timeZone: 'Asia/Shanghai', savings: false, retainDays: 7 });
      const [guardOpen, setGuardOpen] = useState(false);
      const [guardReason, setGuardReason] = useState('');
      const [usageFor, setUsageFor] = useState('');
      const [usage, setUsage] = useState({ inputTokens: '', cacheReadTokens: '', cacheWriteTokens: '', outputTokens: '' });
      const [confirm, setConfirm] = useState('');
      const [risk, setRisk] = useState({});
      const [topupAmounts, setTopupAmounts] = useState({});
      async function reload() {
        try {
          const r = await fetch(API + '/state', { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
          const j = await r.json();
          if (!r.ok || !j.ok) throw Error(j.error || ('读取失败 ' + r.status));
          setCsrf(typeof j.csrfToken === 'string' ? j.csrfToken : '');
          setData(j.data);
          setError('');
          const cfg = j.data.config;
          if (cfg && cfg.configured) {
            setForm({
              tokens: String(cfg.limits.tokens),
              amount: String(cfg.limits.cost.micros / 1e6),
              timeZone: cfg.timeZone,
              savings: cfg.savings?.enabled === true,
              retainDays: cfg.savings?.retainDays ?? 7,
            });
          }
        } catch (e) { setError('读取预算失败：' + e.message); }
      }
      useEffect(() => { reload(); }, []);
      async function act(action, fields, message) {
        if (busy || !csrf) return false;
        setBusy(action);
        try {
          const r = await fetch(API + '/control', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'content-type': 'application/json', 'x-dsh-dshai-csrf': csrf },
            body: JSON.stringify({ action, ...fields }),
          });
          const j = await r.json();
          if (!r.ok || !j.ok) throw Error(j.error || '操作失败');
          setConfirm('');
          setError('');
          setNotice(message || '操作已完成');
          await reload();
          return true;
        } catch (e) { setNotice(''); setError('操作失败：' + e.message); return false; } finally { setBusy(''); }
      }
      function save() {
        const tokens = Number(form.tokens);
        const amount = Number(form.amount);
        const retainDays = Number(form.retainDays);
        if (!Number.isSafeInteger(tokens) || tokens <= 0) { setError('Token 上限必须是正整数'); return; }
        if (!Number.isFinite(amount) || amount <= 0) { setError('金额上限必须大于 0'); return; }
        if (!Number.isSafeInteger(retainDays) || retainDays < 1 || retainDays > 30) { setError('储蓄保留天数必须是 1–30 的整数'); return; }
        act('configure', {
          limits: { tokens, costMicros: Math.round(amount * 1e6) },
          timeZone: form.timeZone,
          savings: { enabled: form.savings === true, retainDays },
        }, '预算配置已保存');
      }
      const st = data?.status;
      const cfg = data?.config;
      const card = (label, val, suffix) => h('div', { className: 'card', key: label }, h('div', { className: 'number' }, val), h('div', { className: 'muted' }, label + (suffix || '')));
      const savings = st?.savings;
      const uncertain = st?.uncertain || [];
      const exceptions = st?.exceptions || [];
      const topup = st?.topup || { approvedMicros: 0, usedMicros: 0, reservedMicros: 0, availableMicros: 0, pending: [], recent: [] };
      const oldUncertain = uncertain.filter(u => u.ageMinutes >= 1440);
      const freshUncertain = uncertain.filter(u => u.ageMinutes < 1440);
      const section = (title, ...children) => h('section', { className: 'card' }, h('h3', null, title), ...children);

      function uncertainRow(u, historical) {
        const confirming = confirm === 'accept:' + u.runId || confirm === 'zero:' + u.runId || confirm === 'risk:' + u.runId;
        return h('div', { className: 'item', key: u.runId },
          h('b', null, u.runId),
          h('span', { className: 'pill', style: { marginLeft: '8px' } }, u.status),
          historical ? h('span', { className: 'pill', style: { marginLeft: '6px' } }, '历史遗留') : null,
          h('div', { className: 'muted' }, '已等待 ' + ageText(u.ageMinutes) + ' · 预留 ' + u.worstTokens + ' Token / ' + micros(u.worstCostMicros) + (u.actualCostMicros !== null ? ' · 已按 ' + micros(u.actualCostMicros) + ' 入账' : ' · 未入账')),
          h('div', { className: 'actions', style: { marginTop: '6px' } },
            h('button', { disabled: !!busy, onClick: () => { setUsageFor(usageFor === u.runId ? '' : u.runId); setConfirm(''); } }, usageFor === u.runId ? '收起实际用量' : '按实际用量结算'),
            h('button', { disabled: !!busy, onClick: () => setConfirm('accept:' + u.runId) }, '接受最坏入账'),
            h('button', { disabled: !!busy, onClick: () => setConfirm('zero:' + u.runId) }, '确认零消费释放'),
            h('button', { disabled: !!busy, onClick: () => setConfirm('risk:' + u.runId) }, '人工释放（接受风险）')),
          confirming ? h('div', { className: 'confirm' },
            confirm === 'accept:' + u.runId ? h('div', null, '将按最坏预留金额 ' + micros(u.worstCostMicros) + ' 入账并结束该预留。') : null,
            confirm === 'zero:' + u.runId ? h('div', null, '仅在可信确认没有发生任何消费时使用；会释放预留，不产生费用。') : null,
            confirm === 'risk:' + u.runId ? h('div', null,
              h('div', null, '会丢弃这笔未确定费用，之后无法再补账；仅在你能接受风险时继续。'),
              h('label', null, h('input', { type: 'checkbox', checked: risk[u.runId] === true, onChange: e => setRisk({ ...risk, [u.runId]: e.target.checked }) }), '我接受风险，确认释放')) : null,
            h('div', { className: 'actions', style: { marginTop: '6px' } },
              h('button', {
                disabled: !!busy || (confirm === 'risk:' + u.runId && risk[u.runId] !== true),
                onClick: () => {
                  if (confirm === 'accept:' + u.runId) act('reconcile', { runId: u.runId, mode: 'accept' }, '已按最坏情况核销 ' + u.runId);
                  if (confirm === 'zero:' + u.runId) act('reconcile', { runId: u.runId, mode: 'release-zero', reason: '用户确认零消费' }, '已释放 ' + u.runId);
                  if (confirm === 'risk:' + u.runId) act('reconcile', { runId: u.runId, mode: 'release-risk', acceptRisk: true, reason: '用户接受风险' }, '已人工释放 ' + u.runId);
                },
              }, '确认执行'),
              h('button', { disabled: !!busy, onClick: () => setConfirm('') }, '取消'))) : null,
          usageFor === u.runId ? h('div', { className: 'row', style: { marginTop: '6px' } },
            ...['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'].map(k =>
              h('label', { key: k }, k + ' ', h('input', { type: 'number', min: 0, value: usage[k], onChange: e => setUsage({ ...usage, [k]: e.target.value }) }))),
            h('button', {
              disabled: !!busy,
              onClick: () => act('reconcile', {
                runId: u.runId,
                mode: 'settle',
                usage: Object.fromEntries(Object.entries(usage).map(([k, v]) => [k, Number(v) || 0])),
              }, '已按实际用量结算 ' + u.runId),
            }, '提交结算')) : null);
      }

      return h('div', { className: 'bg' },
        h('style', null, CSS),
        h('header', { className: 'bg-hero' },
          h('div', { className: 'bg-avatar' }, '🐟'),
          h('div', { className: 'bg-hero-text' },
            h('h2', null, 'Budget · 助手零花钱'),
            h('p', { className: 'bg-sub' }, '金额是唯一硬限额；Token 只统计并提示。只管理已接入预算链路的自主付费活动，你的开发、部署与测试不计入。')),
          h('div', { className: 'bg-toolbar' }, h('button', { onClick: reload, disabled: !!busy }, '刷新'))),
        h('div', { className: 'bg-chips' }, h('span', { className: 'badge' }, 'V' + (data?.version || '0.5.1')), st?.day ? h('span', { className: 'badge' }, '计费日 ' + st.day) : null),
        error && h('div', { className: 'error' }, error),
        notice && h('div', { className: 'ok' }, notice),
        data?.notice && h('div', { className: 'warn' }, data.notice),
        !st ? h('div', { className: 'muted' }, '正在载入…') :
        h(React.Fragment, null,
          st.configured ? null : h('div', { className: 'warn' }, '尚未配置硬限额：付费自主调用默认禁止。请填写 Token 与金额上限。'),
          h('div', { className: 'cards' },
            card('基础额度剩余', money(st.remaining?.base)),
            card('储蓄可用', money(st.remaining?.savings)),
            card('可用合计', money(st.remaining?.cost))),
          h('div', { className: 'muted' },
            '明细：已用 ' + money(st.used?.cost) + (st.limits ? ' / 上限 ' + money(st.limits.cost) : '') + ' · 临时补额可用 ' + money(st.remaining?.topup)),
          h('div', { className: 'cards' },
            card('Token 已用（提示）', String(st.used?.tokens ?? 0) + (st.limits ? ' / ' + st.limits.tokens : '')),
            card('Token 剩余', String(st.remaining?.tokens ?? 0))),
          section('今日状态',
            h('div', { className: 'muted' }, '计费日：' + (st.day || '未确定（今日尚未产生计费）') + '。'),
            h('div', { className: 'muted' }, '预留：' + (st.reserved?.tokens ?? 0) + ' Token / ' + micros(st.reserved?.cost?.micros) + '；状态：' + (st.blocked?.reason ? '已阻断（' + st.blocked.reason + '）' : '可继续')),
            st.guard?.blocked ? h('div', { className: 'warn', style: { marginTop: '8px' } },
              '保护已触发（' + (st.guard.reason || 'OVERBUDGET') + '），新的付费预留会被拒绝。核查后可由用户解除。',
              h('div', { className: 'actions', style: { marginTop: '6px' } },
                h('button', { disabled: !!busy, onClick: () => { setGuardOpen(!guardOpen); setGuardReason(''); } }, guardOpen ? '收起' : '解除 Guard')),
              guardOpen ? h('div', { className: 'confirm' },
                h('div', { style: { marginBottom: '6px' } }, '解除原因会写入审计；不会核销 uncertain、不会增加额度。'),
                h('textarea', { value: guardReason, maxLength: 200, placeholder: '例如：已人工核查，历史超额由旧版 Token 预留触发，实际金额未超。', onChange: e => setGuardReason(e.target.value) }),
                h('div', { className: 'actions', style: { marginTop: '6px' } },
                  h('button', {
                    disabled: !!busy || guardReason.trim().length < 4,
                    onClick: () => act('clear-guard', { reason: guardReason.trim() }, 'Guard 已解除（已写入审计）'),
                  }, '确认解除'),
                  h('button', { disabled: !!busy, onClick: () => setGuardOpen(false) }, '取消'))) : null) : null,
            (st.warnings || []).map(w => h('div', { className: 'warn', key: w.code }, '提示：' + w.message))),
          section('临时补额（DSHAI 申请 · 用户批准）',
            h('div', { className: 'muted' }, '只在当天有效，按北京时间（UTC+8）计费日到期；批准后才增加可用金额，不修改永久每日额度，也不进入储蓄。消费顺序：基础额度 → 临时补额 → 储蓄。'),
            h('div', { className: 'cards', style: { marginTop: '8px' } },
              card('已批准', micros(topup.approvedMicros)),
              card('已使用', micros(topup.usedMicros)),
              card('预留占用', micros(topup.reservedMicros)),
              card('剩余可用', micros(topup.availableMicros))),
            topup.pending?.length ? h('div', { style: { marginTop: '8px' } }, ...topup.pending.map(t => {
              const key = 'topup:' + t.id;
              const amount = topupAmounts[t.id] ?? String((t.requestedMicros / 1e6).toFixed(4));
              return h('div', { className: 'item', key: t.id },
                h('b', null, t.id), h('span', { className: 'pill', style: { marginLeft: '8px' } }, STATUS_LABEL.pending),
                h('div', { className: 'muted' }, (t.taskId || '无任务') + ' · ' + t.caller + ' · 申请 ' + micros(t.requestedMicros) + ' · 已等待 ' + ageText(t.ageMinutes)),
                h('div', { className: 'muted' }, '理由：' + t.reason),
                confirm === key ? h('div', { className: 'confirm' },
                  h('label', null, '批准金额（元）', h('input', { type: 'number', min: 0.000001, step: 0.01, value: amount, onChange: e => setTopupAmounts({ ...topupAmounts, [t.id]: e.target.value }) })),
                  h('div', { className: 'muted' }, '可以调整本次金额；只影响今天。'),
                  h('div', { className: 'actions', style: { marginTop: '6px' } },
                    h('button', {
                      disabled: !!busy,
                      onClick: () => {
                        const yuan = Number(amount);
                        if (!Number.isFinite(yuan) || yuan <= 0) { setError('批准金额必须大于 0'); return; }
                        act('decide-topup', { id: t.id, decision: 'approve', amountMicros: Math.round(yuan * 1e6) }, '已批准临时补额 ' + t.id);
                      },
                    }, '确认批准'),
                    h('button', { disabled: !!busy, onClick: () => setConfirm('') }, '取消'),
                    h('button', { disabled: !!busy, onClick: () => act('decide-topup', { id: t.id, decision: 'reject' }, '已拒绝 ' + t.id) }, '拒绝'))) :
                h('div', { className: 'actions', style: { marginTop: '6px' } },
                  h('button', { disabled: !!busy, onClick: () => setConfirm(key) }, '批准…'),
                  h('button', { disabled: !!busy, onClick: () => act('decide-topup', { id: t.id, decision: 'reject' }, '已拒绝 ' + t.id) }, '拒绝')));
            })) : h('div', { className: 'muted', style: { marginTop: '8px' } }, '没有待批准的申请。'),
            topup.recent?.length ? h('details', { style: { marginTop: '8px' } },
              h('summary', null, '今日申请记录 · ' + topup.recent.length + ' 条'),
              h('table', null,
                h('thead', null, h('tr', null, h('th', null, '发起'), h('th', null, '状态'), h('th', null, '申请'), h('th', null, '批准'), h('th', null, '已用'), h('th', null, ''))),
                h('tbody', null, ...topup.recent.map(t => h('tr', { key: t.id },
                  h('td', null, (t.taskId || '无任务') + (t.reason ? ' · ' + t.reason.slice(0, 24) : '')),
                  h('td', null, STATUS_LABEL[t.status] || t.status),
                  h('td', null, micros(t.requestedMicros)),
                  h('td', null, micros(t.approvedMicros)),
                  h('td', null, micros(t.usedMicros)),
                  h('td', null, t.status === 'approved' && t.usedMicros < t.approvedMicros
                    ? (confirm === 'revoke:' + t.id
                      ? h('span', null,
                        h('button', { disabled: !!busy, onClick: () => act('revoke-topup', { id: t.id, reason: '用户撤销' }, '已撤销 ' + t.id) }, '确认撤销'),
                        h('button', { disabled: !!busy, onClick: () => setConfirm('') }, '取消'))
                      : h('button', { disabled: !!busy, onClick: () => setConfirm('revoke:' + t.id) }, '撤销'))
                    : null)))))) : null),
          section('储蓄结转',
            h('div', { className: 'muted' }, savings?.enabled
              ? ('已开启：保留 ' + savings.retainDays + ' 天（来源日后第 1–' + savings.retainDays + ' 天可用，第 ' + (savings.retainDays + 1) + ' 天失效）；消费按最早到期优先，每份额度只使用一次。')
              : '未开启：每天未用完的金额额度不会保留到以后。'),
            h('div', { className: 'muted' }, 'DSH 运行过但当天没有消费 → 额度可结转；DSH 全天未运行 → 不产生结转，也不补发。'),
            savings?.lots?.length ? h('table', { style: { marginTop: '8px' } },
              h('thead', null, h('tr', null, h('th', null, '来源日'), h('th', null, '结转'), h('th', null, '剩余'), h('th', null, '预留'), h('th', null, '可用'), h('th', null, '到期日'))),
              h('tbody', null, ...savings.lots.map(l => h('tr', { key: l.id },
                h('td', null, l.earnedDayKey),
                h('td', null, micros(l.amountMicros)),
                h('td', null, micros(l.remainingMicros)),
                h('td', null, micros(l.heldMicros)),
                h('td', null, micros(l.availableMicros)),
                h('td', null, l.expiresOnDayKey))))) : h('div', { className: 'muted' }, '还没有结转批次。')),
          section('未确定的预留（uncertain）',
            h('div', { className: 'muted' }, '这些预留拿不到 Provider 用量：可以按实际用量结算、接受最坏入账、确认零消费后释放，或接受风险人工释放。每个动作都需要在页面内二次确认，并写审计。'),
            freshUncertain.length ? freshUncertain.map(u => uncertainRow(u, false)) : h('div', { className: 'muted' }, '没有 24 小时内的未确定预留。'),
            oldUncertain.length ? h('details', { style: { marginTop: '8px' } },
              h('summary', null, '历史遗留 uncertain · ' + oldUncertain.length + ' 条（超过 24 小时，默认折叠）'),
              ...oldUncertain.map(u => uncertainRow(u, true))) : null),
          section('单次例外',
            h('div', { className: 'muted' }, '仅在 Guard 阻断期间放行一次匹配的付费预留；命中即失效，不解除 Guard。'),
            exceptions.length ? h('table', { style: { marginTop: '8px' } },
              h('thead', null, h('tr', null, h('th', null, '模型'), h('th', null, '上限'), h('th', null, '到期'), h('th', null, ''))),
              h('tbody', null, ...exceptions.map(ex => h('tr', { key: ex.id },
                h('td', null, ex.provider + '/' + ex.model),
                h('td', null, ex.maxWorstTokens + ' Token / ' + micros(ex.maxCostMicros)),
                h('td', null, ex.expiresAt),
                h('td', null, confirm === 'ex:' + ex.id
                  ? h('span', null,
                    h('button', { disabled: !!busy, onClick: () => act('revoke-exception', { id: ex.id }, '已撤销例外 ' + ex.id) }, '确认撤销'),
                    h('button', { disabled: !!busy, onClick: () => setConfirm('') }, '取消'))
                  : h('button', { disabled: !!busy, onClick: () => setConfirm('ex:' + ex.id) }, '撤销')))))) : h('div', { className: 'muted' }, '没有可用例外。')),
          section('峰谷价格（每百万 Token，人民币元）',
            h('div', { className: 'muted' }, '高峰：北京时间周一至周五 09:00–12:00、14:00–18:00；空闲为高峰一半。未知模型/价格会保守处理。'),
            h('table', null,
              h('thead', null, h('tr', null, h('th', null, '模型'), h('th', null, '时段'), h('th', null, '缓存命中'), h('th', null, '未命中'), h('th', null, '输出'))),
              h('tbody', null, ...(data.pricing || []).flatMap(p => ['peak', 'offPeak'].map(w => h('tr', { key: p.model + w },
                h('td', null, p.model + (w === 'peak' ? ' · 高峰' : ' · 低谷')),
                h('td', null, w === 'peak' ? 'peak' : 'off-peak'),
                h('td', null, rate(p[w].cacheRead)), h('td', null, rate(p[w].cacheMiss)), h('td', null, rate(p[w].output)))))))),
          section('预算配置',
            h('div', { className: 'muted' }, cfg?.configured ? ('当前由 ' + (cfg.setBy || 'user') + ' 于 ' + (cfg.setAt || '未知时间') + ' 设置') : '尚未设置'),
            h('div', { className: 'row', style: { marginTop: '10px' } },
              h('label', null, 'Token 上限（提示）', h('input', { type: 'number', min: 1, value: form.tokens, onChange: e => setForm({ ...form, tokens: e.target.value }) })),
              h('label', null, '金额上限（元）', h('input', { type: 'number', min: 0.000001, step: 0.01, value: form.amount, onChange: e => setForm({ ...form, amount: e.target.value }) })),
              h('label', null, '时区 ', h('select', { value: form.timeZone, onChange: e => setForm({ ...form, timeZone: e.target.value }) }, ...['Asia/Shanghai', 'Asia/Tokyo', 'UTC'].map(t => h('option', { key: t, value: t }, TZ_LABEL[t] || t))))),
            h('div', { className: 'row', style: { marginTop: '10px' } },
              h('label', null, h('input', { type: 'checkbox', checked: form.savings, onChange: e => setForm({ ...form, savings: e.target.checked }) }), '启用储蓄结转'),
              h('label', null, '保留天数（1–30）', h('input', { type: 'number', min: 1, max: 30, value: form.retainDays, onChange: e => setForm({ ...form, retainDays: e.target.value }) }))),
            h('div', { className: 'actions', style: { marginTop: '10px' } },
              h('button', { onClick: save, disabled: !!busy || !csrf }, '保存预算配置'),
              h('span', { className: 'muted' }, '只有已验证用户可修改；DSH 不能自行提高限额、批准补额或解除 Guard。'))),
        )
      );
    }
    function apply(ctx) {
      ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: 'dsh-dshai-budget', order: 9, label: () => 'Budget · 助手零花钱' }, Screen
      )), 'budget panel');
    }
    exports.apply = apply;
    exports.inject = ['slots'];
    return module.exports;
  },
});
