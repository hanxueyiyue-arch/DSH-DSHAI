/* Bilibili 独立设置页（settings.section）。只调用本插件的本地 API；
 * 不读取其他插件数据；凭证始终留在宿主侧，界面只显示脱敏状态。 */
window.__ModuleLoader__.load({
  id: 'dsh-dshai-bilibili',
  factory: require => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useState } = React;
    const API = '/dsh-dshai/bilibili/api';
    const CSS = `
      .bb{--bb-accent:#0ea5e9;--bb-accent-2:#6366f1;max-width:900px;display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.55}
      .bb *{box-sizing:border-box}
      .bb h2{margin:0;font-size:22px;font-weight:700;letter-spacing:-.01em;line-height:1.25}
      .bb h3{margin:0;font-size:13px;font-weight:600;letter-spacing:.02em;display:flex;align-items:center;gap:8px}
      .bb h3::before{content:"";width:6px;height:6px;border-radius:2px;background:linear-gradient(135deg,var(--bb-accent),var(--bb-accent-2));flex:none}
      .bb .muted{opacity:.78;font-size:13px;line-height:1.7}
      .bb-hero{display:flex;gap:14px;align-items:center;padding:18px;border-radius:16px;background:linear-gradient(135deg,color-mix(in srgb,var(--bb-accent) 13%,transparent),color-mix(in srgb,var(--bb-accent-2) 10%,transparent));border:1px solid color-mix(in srgb,currentColor 8%,transparent)}
      .bb-avatar{width:46px;height:46px;border-radius:15px;display:grid;place-items:center;font-size:24px;background:color-mix(in srgb,var(--dsw-alias-bg-l1,#fff) 72%,transparent);box-shadow:0 2px 6px rgba(0,0,0,.08);flex:none}
      .bb-hero-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
      .bb-sub{margin:0;font-size:13px;opacity:.78;line-height:1.65}
      .bb-toolbar{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
      .bb-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:-4px}
      .bb .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
      .bb .card{border:1px solid color-mix(in srgb,currentColor 9%,transparent);border-radius:14px;padding:16px;min-width:0;background:color-mix(in srgb,currentColor 2.5%,transparent);box-shadow:0 1px 2px rgba(0,0,0,.03);display:flex;flex-direction:column;gap:9px}
      .bb .big{font-size:22px;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1.1}
      .bb .actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
      .bb button{border:1px solid color-mix(in srgb,currentColor 13%,transparent);background:color-mix(in srgb,currentColor 3%,transparent);color:inherit;border-radius:9px;padding:7px 12px;font:inherit;font-size:12px;cursor:pointer;transition:background .15s ease,border-color .15s ease,transform .05s ease;white-space:nowrap}
      .bb button:hover:not(:disabled){background:color-mix(in srgb,currentColor 8%,transparent)}
      .bb button:active:not(:disabled){transform:translateY(1px)}
      .bb button:focus-visible{outline:2px solid color-mix(in srgb,var(--bb-accent) 62%,transparent);outline-offset:2px}
      .bb button:disabled{opacity:.42;cursor:not-allowed}
      .bb button.primary{background:linear-gradient(135deg,var(--bb-accent),var(--bb-accent-2));border-color:transparent;color:#fff;box-shadow:0 2px 8px color-mix(in srgb,var(--bb-accent) 30%,transparent)}
      .bb a.bb-link{display:inline-flex;align-items:center;border:1px solid color-mix(in srgb,currentColor 13%,transparent);background:color-mix(in srgb,currentColor 3%,transparent);color:inherit;border-radius:9px;padding:7px 12px;font-size:12px;text-decoration:none;white-space:nowrap}
      .bb a.bb-link:hover{background:color-mix(in srgb,currentColor 8%,transparent)}
      .bb .error{color:#e05a5a;white-space:pre-wrap;font-size:12px;line-height:1.6}
      .bb .warn{color:#d69c31;font-size:12px;line-height:1.6}
      .bb .item{border-top:1px solid color-mix(in srgb,currentColor 8%,transparent);padding:9px 0;overflow-wrap:anywhere}
      .bb .item:first-of-type{border:0;padding-top:0}
      .bb .policy-note{font-size:12px;line-height:1.6;opacity:.78;border-left:2px solid color-mix(in srgb,var(--bb-accent) 45%,transparent);padding-left:10px;margin-top:4px}
      .bb .policy-group{margin-top:14px}
      .bb .policy-group-title{font-size:12px;font-weight:600;letter-spacing:.02em;opacity:.86;margin:0 0 2px}
      .bb .policy-row{display:flex;gap:14px;align-items:flex-start;justify-content:space-between;border-top:1px solid color-mix(in srgb,currentColor 8%,transparent);padding:11px 0}
      .bb .policy-row:first-of-type{border-top:0;padding-top:4px}
      .bb .policy-main{min-width:0;flex:1}
      .bb .policy-title{font-size:13px;font-weight:600;line-height:1.4}
      .bb .policy-desc{font-size:12px;line-height:1.55;opacity:.72;margin-top:2px}
      .bb .policy-id{font-size:11px;opacity:.52;margin-top:2px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}
      .bb .policy-side{display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0}
      .bb .policy-state{font-size:12px;font-weight:600;padding:2px 9px;border-radius:999px;border:1px solid color-mix(in srgb,currentColor 14%,transparent);white-space:nowrap}
      .bb .policy-state.allow{border-color:color-mix(in srgb,var(--bb-accent) 50%,transparent)}
      .bb .policy-state.deny{border-style:dashed;opacity:.82}
      .bb .policy-actions{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
      .bb .policy-actions button{font-size:11px;padding:5px 9px}
      .bb .policy-actions button.selected{font-weight:700;border-color:color-mix(in srgb,var(--bb-accent) 62%,transparent);background:color-mix(in srgb,var(--bb-accent) 14%,transparent)}
      @media (max-width:640px){.bb .policy-row{flex-direction:column;gap:8px}.bb .policy-side{width:100%;align-items:flex-start}.bb .policy-actions{justify-content:flex-start}}
      .bb .badge{font-size:12px;line-height:1;border:1px solid color-mix(in srgb,currentColor 12%,transparent);border-radius:999px;padding:6px 9px;background:color-mix(in srgb,currentColor 4%,transparent);white-space:nowrap}
      .bb .qr{font-family:ui-monospace,Consolas,monospace;font-size:10px;word-break:break-all;border:1px dashed color-mix(in srgb,currentColor 18%,transparent);border-radius:9px;padding:9px;user-select:all}
      .bb .qrbox{display:inline-block;background:#fff;padding:10px;border:1px solid color-mix(in srgb,currentColor 12%,transparent);border-radius:10px;line-height:0}
      .bb .qrbox svg{display:block;width:220px;height:220px}
      .bb ul{margin:0;padding-left:18px;font-size:12px;line-height:1.75;opacity:.82}
      .bb progress{width:100%;height:7px;border:0;border-radius:999px;overflow:hidden;background:color-mix(in srgb,currentColor 9%,transparent)}
      .bb progress::-webkit-progress-bar{background:color-mix(in srgb,currentColor 9%,transparent);border-radius:999px}
      .bb progress::-webkit-progress-value{background:linear-gradient(90deg,var(--bb-accent),var(--bb-accent-2));border-radius:999px}
      .bb progress::-moz-progress-bar{background:var(--bb-accent);border-radius:999px}
      .bb .bar-row{display:grid;grid-template-columns:64px 1fr auto;gap:9px;align-items:center;font-size:12px;opacity:.86}
      .bb .bb-fold{border:1px solid color-mix(in srgb,currentColor 9%,transparent);border-radius:14px;padding:14px 16px;background:color-mix(in srgb,currentColor 2%,transparent)}
      .bb summary{cursor:pointer;font-size:13px;font-weight:600;list-style:none;display:flex;align-items:center;gap:8px}
      .bb summary::-webkit-details-marker{display:none}
      .bb summary::before{content:"▸";font-size:11px;opacity:.6;transition:transform .15s ease}
      .bb details[open] summary::before{transform:rotate(90deg)}
      .bb .bb-body{display:flex;flex-direction:column;gap:9px;margin-top:10px}
      .bb textarea{width:100%;border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:9px;padding:8px 10px;font:inherit;font-size:12px;background:color-mix(in srgb,currentColor 2%,transparent);color:inherit;resize:vertical;outline:none}
      .bb textarea:focus{border-color:color-mix(in srgb,var(--bb-accent) 55%,transparent);box-shadow:0 0 0 3px color-mix(in srgb,var(--bb-accent) 14%,transparent)}
      .bb input:not([type=checkbox]){width:100%;border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:9px;padding:8px 10px;font:inherit;font-size:12px;background:color-mix(in srgb,currentColor 2%,transparent);color:inherit;outline:none}
      @media (max-width:640px){.bb-hero{align-items:flex-start;flex-wrap:wrap}.bb-toolbar{width:100%;justify-content:flex-start}.bb .bar-row{grid-template-columns:56px 1fr}}
    `;
    const ts = v => (v ? new Date(v).toLocaleString() : '—');
    const splitList = value => String(value || '').split(/[\n,，]/).map(x => x.trim()).filter(Boolean).slice(0, 20);
    const joinList = value => (Array.isArray(value) ? value.join('\n') : '');
    function filtersToForm(filters) {
      const f = filters || {};
      return {
        enabled: f.enabled === true,
        mode: f.mode || null,
        keywordsInclude: joinList(f.keywordsInclude),
        keywordsExclude: joinList(f.keywordsExclude),
        uppersInclude: joinList(f.uppersInclude),
        uppersExclude: joinList(f.uppersExclude),
        categoriesInclude: joinList(f.categoriesInclude),
        categoriesExclude: joinList(f.categoriesExclude),
      };
    }
    /* 设置弹窗的滚动容器由宿主在所有节之间共享：挂载时归零，
     * 避免沿用上一节的 scrollTop 导致标题被裁掉。 */
    function resetScroll(selector) {
      if (typeof document === 'undefined') return;
      const root = document.querySelector(selector);
      let node = root ? root.parentElement : null;
      while (node) {
        const style = getComputedStyle(node);
        if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
          node.scrollTop = 0;
          return;
        }
        node = node.parentElement;
      }
    }
    /* 宿主返回的是二维码矩阵（size/rows），不是 HTML；这里逐格画 SVG，
     * 避免把一次性登录内容当作 HTML 注入。 */
    function QrCode({ qr }) {
      const size = Number(qr?.size) || 0;
      const rows = Array.isArray(qr?.rows) ? qr.rows : [];
      if (!size || rows.length !== size) return null;
      const margin = 2;
      const dim = size + margin * 2;
      const cell = 220 / dim;
      const cells = [];
      for (let y = 0; y < size; y += 1) {
        const row = rows[y];
        if (!Array.isArray(row)) return null;
        for (let x = 0; x < size; x += 1) {
          if (row[x]) {
            cells.push(h('rect', {
              key: `${x}-${y}`, x: (x + margin) * cell, y: (y + margin) * cell,
              width: cell + 0.02, height: cell + 0.02, fill: '#000',
            }));
          }
        }
      }
      return h('svg', { viewBox: '0 0 220 220', width: 220, height: 220, shapeRendering: 'crispEdges', role: 'img', 'aria-label': 'B 站登录二维码' },
        h('rect', { key: 'bg', width: 220, height: 220, fill: '#fff' }), ...cells);
    }
    function Screen() {
      const [data, setData] = useState(null);
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');
      const [busy, setBusy] = useState(false);
      const [csrf, setCsrf] = useState('');
      const [form, setForm] = useState(null);
      const [socialOwner, setSocialOwner] = useState('');
      const [auto, setAuto] = useState(null);
      async function reload() {
        try {
          const r = await fetch(API + '/state', { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
          const j = await r.json();
          if (!r.ok || !j.ok) throw Error(j.error || ('读取失败 ' + r.status));
          setCsrf(typeof j.csrfToken === 'string' ? j.csrfToken : '');
          setData(j.data);
          setForm(current => current || filtersToForm(j.data?.filters));
          setSocialOwner(current => current || String(j.data?.social?.ownerMid || ''));
          setError('');
        } catch (e) {
          setError('读取 Bilibili 状态失败：' + e.message);
        }
      }
      useEffect(() => { reload(); }, []);
      useEffect(() => { resetScroll('.bb'); }, []);
      useEffect(() => {
        let stopped = false;
        fetch('/dsh-dshai/api/state', { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } })
          .then(r => r.json())
          .then(j => { if (!stopped && j?.ok) setAuto(j.data?.automation || null); })
          .catch(() => { if (!stopped) setAuto(null); });
        return () => { stopped = true; };
      }, []);
      async function act(action, fields = {}) {
        if (!csrf) { setError('控制通道尚未就绪，请点上方“刷新”重试。'); return; }
        if (busy) return;
        setBusy(true);
        try {
          const r = await fetch(API + '/control', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'content-type': 'application/json', 'x-dsh-dshai-csrf': csrf },
            body: JSON.stringify({ action, ...fields }),
          });
          const j = await r.json();
          if (!r.ok || !j.ok) throw Error(j.error || '操作失败');
          if (action === 'browse-once' && j.result) {
            setNotice('已执行一次受许可浏览：' + j.result.count + ' 条（' + (j.result.titles || []).join('、') + '）');
          }
          if (j.filters) {
            setForm(filtersToForm(j.filters));
            setNotice('内容限制已保存。');
          }
          if (action === 'filters-clear') setNotice('内容限制已清空。');
          if (action === 'filters-mode') setNotice('已切换为仅排序：include 名单保留但不再限制，exclude 仍然生效。');
          await reload();
        } catch (e) {
          setError('操作失败：' + e.message);
        } finally { setBusy(false); }
      }
      const d = data || {};
      const social = d.social || null;
      const policy = d.policy || null;
      const capabilityItems = Array.isArray(d.capabilities?.items)
        ? d.capabilities.items.filter(item => item.implemented)
        : [];
      const capabilityGroups = [
        { title: '公开内容读取', items: capabilityItems.filter(item => item.category === 'read.public') },
        { title: '用户私信', items: capabilityItems.filter(item => item.category === 'read.private' || item.category === 'write.message') },
      ].filter(group => group.items.length > 0);
      const access = d.access || {};
      const login = d.login || {};
      const acct = access.account || d.account || null;
      const hasCredentials = Boolean(access.hasCredentials ?? d.hasCredentials);
      const granted = access.granted || null;
      const statusText = login.status === 'waiting' ? '等待扫码'
        : login.status === 'scanned' ? '已扫码，请在手机上确认'
        : login.status === 'success' ? '登录成功'
        : login.status === 'expired' ? '二维码已过期'
        : login.status === 'cancelled' ? '已取消'
        : login.status === 'error' ? '登录失败' : '未在登录';
      const perm = granted ? '只读浏览已开放' : '未登录';
      const hasContent = Boolean(granted && (granted.scopes || []).includes('content:popular'));
      const loggedIn = Boolean(hasCredentials || acct);
      const view = form || filtersToForm(d.filters);
      // 旧配置没有 mode 字段：关键词/UP include 仍是硬 allowlist；分区包含现在只排序，不再触发提示。
      const legacyAllowlist = d.filters?.enabled === true && !d.filters?.mode
        && ['keywordsInclude', 'uppersInclude']
          .some(key => (d.filters?.[key] || []).length > 0);
      const saveFilters = () => act('filters-set', {
        filters: {
          enabled: view.enabled,
          mode: view.mode || null,
          keywordsInclude: splitList(view.keywordsInclude),
          keywordsExclude: splitList(view.keywordsExclude),
          uppersInclude: splitList(view.uppersInclude),
          uppersExclude: splitList(view.uppersExclude),
          categoriesInclude: splitList(view.categoriesInclude),
          categoriesExclude: splitList(view.categoriesExclude),
        },
      });
      const filterField = (label, key) => h('label', { className: 'muted', style: { display: 'block', marginTop: '6px' } },
        label,
        h('textarea', {
          value: view[key] || '', rows: 2,
          onChange: e => setForm(current => ({ ...(current || view), [key]: e.target.value })),
          style: { width: '100%', boxSizing: 'border-box', font: 'inherit', resize: 'vertical' },
        }));

      // 二维码等待期间自动轮询；登录成功后立即重拉整页状态，账号与凭证无需手动刷新。
      useEffect(() => {
        if (!csrf || !login.id) return undefined;
        if (login.status !== 'waiting' && login.status !== 'scanned') return undefined;
        let stopped = false;
        let timer = null;
        async function tick() {
          try {
            const r = await fetch(API + '/control', {
              method: 'POST', credentials: 'same-origin',
              headers: { 'content-type': 'application/json', 'x-dsh-dshai-csrf': csrf },
              body: JSON.stringify({ action: 'login-poll', loginId: login.id }),
            });
            const j = await r.json();
            if (stopped) return;
            if (j.ok && j.login) {
              if (j.login.status === 'success') { await reload(); return; }
              setData(current => (current ? { ...current, login: j.login } : current));
            }
          } catch { /* 下一轮继续；不打断手动操作 */ }
          if (!stopped) timer = setTimeout(tick, 2500);
        }
        timer = setTimeout(tick, 2500);
        return () => { stopped = true; if (timer) clearTimeout(timer); };
      }, [csrf, login.id, login.status]);

      const hourPct = d.readHourly ? Math.min(100, Math.round(((d.quota?.hourUsed ?? 0) / d.readHourly) * 100)) : 0;
      const dayPct = d.readDaily ? Math.min(100, Math.round(((d.quota?.used ?? 0) / d.readDaily) * 100)) : 0;

      return h('div', { className: 'bb' },
        h('style', null, CSS),
        h('header', { className: 'bb-hero' },
          h('div', { className: 'bb-avatar' }, '🎬'),
          h('div', { className: 'bb-hero-text' },
            h('h2', null, 'Bilibili · 助手'),
            h('p', { className: 'bb-sub' }, '只读浏览与用户私信。扫码登录即授权本次运行的只读浏览；退出登录会撤销全部 B 站操作权限。')),
          h('div', { className: 'bb-toolbar' }, h('button', { className: 'primary', onClick: reload, disabled: busy }, '刷新'))),
        h('div', { className: 'bb-chips' },
          h('span', { className: 'badge' }, 'V' + (d.version || '0.2.1')),
          h('span', { className: 'badge' }, csrf ? '控制通道：就绪' : '控制通道：未就绪'),
          h('span', { className: 'badge' }, '账号：' + (d.services?.account ? '可用' : '未接入')),
          h('span', { className: 'badge' }, '自主：' + (d.services?.autonomy ? '可用' : '仅手动浏览'))),
        error && h('div', { className: 'error' }, error),
        notice && h('div', { className: 'warn' }, notice),
        d.traffic?.until > Date.now() && h('div', { className: 'warn' },
          `B站请求保护暂停中：${d.traffic.reason || '平台风控'}，${ts(d.traffic.until)} 后自动恢复（连续失败会延长）。`),
        csrf ? null : h('div', { className: 'muted' }, '控制通道未就绪：申请类按钮已禁用。请点上方“刷新”重试；若仍如此，请反馈。'),
        h('section', { className: 'card' },
          h('h3', null, '账号与会话'),
          h('div', { className: 'muted' }, loggedIn
            ? '状态：已登录 · 凭证：仅当前运行期内存（重启失效）'
            : '状态：' + statusText + (login.expiresAt ? ' · 二维码有效至 ' + ts(login.expiresAt) : '') + ' · 凭证：无'),
          h('div', { className: 'muted' }, '账号：' + (acct ? acct.name + '（' + acct.mid + '）' : (hasCredentials ? '凭证已在内存中' : '—'))),
          h('div', { className: 'muted' }, '本次运行权限：' + perm + (granted ? ' · 授权于 ' + ts(granted.approvedAt) : ' · 登录后自动开放')),
          h('div', { className: 'muted' }, loggedIn
            ? '已登录账号可直接只读浏览；点“退出登录”会撤销全部权限并清除凭证。'
            : '扫码即表示同意本次运行内的只读浏览；不申请额外权限。'),
          !loggedIn && login.qr ? h('div', null,
            h('div', { className: 'muted', style: { margin: '8px 0' } }, '请用 B 站 App 扫描二维码：'),
            h('div', { className: 'qrbox' }, h(QrCode, { qr: login.qr }))) : null,
          !loggedIn && !login.qr && (login.status === 'waiting' || login.status === 'scanned') ? h('div', { className: 'muted' },
            '二维码暂时无法生成，请点“取消登录”后重试；若仍失败请反馈。') : null,
          h('div', { className: 'actions', style: { marginTop: '9px' } },
            !loggedIn ? h('button', { className: 'primary', onClick: () => act('login-start'), disabled: busy || !csrf }, '扫码登录') : null,
            !loggedIn && (login.status === 'waiting' || login.status === 'scanned')
              ? h('button', { onClick: () => act('login-poll', { loginId: login.id }), disabled: busy }, '刷新扫码状态') : null,
            !loggedIn && (login.status === 'waiting' || login.status === 'scanned')
              ? h('button', { onClick: () => act('login-cancel', { loginId: login.id }), disabled: busy }, '取消登录') : null,
            loggedIn ? h('button', { onClick: () => act('logout'), disabled: busy }, '退出登录（撤销全部权限）') : null,
            hasContent ? h('button', { onClick: () => act('browse-once'), disabled: busy }, '执行一次受许可浏览') : null),
          h('div', { className: 'muted' }, hasContent
            ? '已随登录自动开放只读浏览。退出登录会立即撤销权限，并中止在途请求。'
            : '登录后自动开放只读浏览；未登录时所有 B 站内容请求都会被拒绝。')),
        h('section', { className: 'card' },
          h('h3', null, '自动浏览'),
          h('div', { className: 'big' }, auto ? (auto.enabled ? '运行中' : '已关闭') : '未读取'),
          h('div', { className: 'muted' }, auto
            ? (auto.enabled
              ? '按作息与配额自主浏览；开启/停止与安全检查在 Autonomy 管理页完成。'
              : '当前关闭；开启后按作息与配额自主浏览。')
            : '暂时读不到 Autonomy 状态；不影响登录与私信。'),
          h('div', { className: 'actions', style: { marginTop: '9px' } },
            h('a', { className: 'bb-link', href: '/dsh-dshai/', target: '_blank', rel: 'noreferrer' },
              auto?.enabled ? '打开自主管理页（停止）' : '打开自主管理页（开启）')),
          h('div', { className: 'muted' },
            '自动浏览的开启/停止、安全检查和人工闸门在 Autonomy 管理页完成；这里只显示状态并提供入口，避免绕过可信面板。')),
        h('section', { className: 'card' },
          h('h3', null, '浏览配额'),
          h('div', { className: 'big' }, (d.quota?.used ?? 0) + ' 次'),
          h('div', { className: 'muted' }, '今日已请求 · 本小时 ' + (d.quota?.hourUsed ?? 0) + '/' + (d.readHourly || '—') + ' · 今日 ' + (d.quota?.used ?? 0) + '/' + (d.readDaily || '—')),
          h('div', { className: 'bar-row' }, h('span', null, '本小时'), h('progress', { max: 100, value: hourPct }), h('span', null, hourPct + '%')),
          h('div', { className: 'bar-row' }, h('span', null, '今日'), h('progress', { max: 100, value: dayPct }), h('span', null, dayPct + '%'))),
        h('section', { className: 'card' },
          h('h3', null, 'B站能力 Policy'),
          h('div', { className: 'muted' }, 'Policy 是长期能力限制；与会话登录、Autonomy 调度分开。首次安装需用户确认一次，之后扫码/退出/重启都不会重新授权。'),
          policy?.status === 'valid'
            ? h('div', { className: 'muted' }, 'Policy 正常 · 已初始化')
            : h('div', { className: 'warn' },
              'Policy 状态：' + (policy?.status || '未加载')
                + (policy?.recoverable ? ' · 可恢复' : '') + '。受保护操作按安全默认拒绝。'),
          policy?.status === 'valid' ? h('div', { className: 'policy-note' },
            'Policy 允许仅代表该能力未被长期限制。实际执行还需要满足登录、用户绑定、社交授权和其他安全条件；dm.send 还必须经过 Autonomy 可信决策与意图验证。') : null,
          policy?.status === 'uninitialized' ? h('div', null,
            h('div', { className: 'muted' }, '首次初始化会写入一份推荐的默认限制：公开读取开放，私有读取/私信/写操作按当前产品目标设置。'),
            h('button', { className: 'primary', onClick: () => act('policy-init'), disabled: busy || !csrf }, '初始化 Policy（一次性）')) : null,
          policy?.status === 'missing' || policy?.status === 'recovery' ? h('div', null,
            h('div', { className: 'warn' }, 'Policy 文件缺失或与初始化标记不一致：受保护操作已默认拒绝，不会自动放宽。'),
            h('div', { className: 'actions' },
              policy?.status === 'recovery'
                ? h('button', { onClick: () => act('policy-recover', { mode: 'adopt' }), disabled: busy || !csrf }, '采用现有 Policy')
                : h('button', { className: 'primary', onClick: () => act('policy-recover', { mode: 'recreate' }), disabled: busy || !csrf }, '按默认重建 Policy'))) : null,
          policy?.status === 'corrupt' ? h('div', null,
            h('div', { className: 'warn' }, 'Policy 已损坏：旧文件会保留诊断副本，不会静默覆盖。'),
            h('button', { onClick: () => act('policy-recover', { mode: 'reset', confirm: 'RESET' }), disabled: busy || !csrf }, '备份旧文件并重置 Policy')) : null,
          policy?.status === 'valid' && capabilityGroups.length
            ? capabilityGroups.map(group => h('div', { key: group.title, className: 'policy-group' },
              h('div', { className: 'policy-group-title' }, group.title),
              group.items.map(item => {
                const allowed = item.effective === 'allow';
                const safeDefault = item.effectiveSource && item.effectiveSource !== 'file';
                return h('div', { key: item.id, className: 'policy-row' },
                  h('div', { className: 'policy-main' },
                    h('div', { className: 'policy-title' }, item.label || item.id),
                    h('div', { className: 'policy-desc' }, item.reason || ''),
                    h('div', { className: 'policy-id' }, item.id)),
                  h('div', { className: 'policy-side' },
                    h('div', { className: 'policy-state ' + (allowed ? 'allow' : 'deny') },
                      allowed ? '允许' : '拒绝', safeDefault ? ' · 安全默认' : ''),
                    h('div', { className: 'policy-actions' },
                      h('button', {
                        className: allowed ? 'selected' : '',
                        onClick: () => act('policy-set', { capabilityId: item.id, state: 'allow' }),
                        disabled: busy || !csrf,
                      }, '设为允许'),
                      h('button', {
                        className: allowed ? '' : 'selected',
                        onClick: () => act('policy-set', { capabilityId: item.id, state: 'deny' }),
                        disabled: busy || !csrf,
                      }, '设为拒绝'))));
              }))) : null,
          policy ? h('details', { className: 'bb-fold' },
            h('summary', null, '高级信息'),
            h('div', { className: 'bb-body' },
              h('div', { className: 'muted' },
                'Policy Hash：' + (policy.policyHash ? String(policy.policyHash).slice(0, 12) : '—')
                  + ' · 生效来源：' + (d.capabilities?.effectiveSource || '—')
                  + (policy.updatedAt ? ' · 更新时间：' + ts(policy.updatedAt) : '')),
              h('div', { className: 'muted' }, 'Policy 是长期限制；不包含当前登录、用户绑定或社交授权状态。'))) : null),
        h('details', { className: 'bb-fold' },
          h('summary', null, '内容限制（标题 / UP 主 / 分区）'),
          h('div', { className: 'bb-body' },
            h('div', { className: 'muted' }, '按标题、UP 主过滤；分区偏好只参与排序，分区排除会直接排除。规则保存在本插件状态中。'),
            h('label', { className: 'muted', style: { display: 'flex', gap: '6px', alignItems: 'center' } },
              h('input', {
                type: 'checkbox', checked: view.enabled,
                onChange: e => setForm(current => ({ ...(current || view), enabled: e.target.checked })),
              }),
              '启用内容限制（未启用时不增加默认兴趣过滤）'),
            legacyAllowlist ? h('div', null,
              h('div', { className: 'muted' },
                '当前仍是旧规则：关键词/UP 主 include 名单作为准入限制，未命中的视频会被直接排除。'),
              h('button', {
                onClick: () => act('filters-mode', { mode: 'deny' }),
                disabled: busy || !csrf, style: { marginTop: '6px' },
              }, '改为仅排序（保留名单，不再限制）')) : null,
            filterField('标题包含（每行一个）', 'keywordsInclude'),
            filterField('标题排除（每行一个）', 'keywordsExclude'),
            filterField('UP 主包含', 'uppersInclude'),
            filterField('UP 主排除', 'uppersExclude'),
            filterField('分区偏好（仅排序，不限制准入；如 科技、生活）', 'categoriesInclude'),
            filterField('分区排除（命中即排除）', 'categoriesExclude'),
            h('div', { className: 'actions' },
              h('button', { className: 'primary', onClick: saveFilters, disabled: busy || !csrf }, '保存限制'),
              h('button', { onClick: () => act('filters-clear'), disabled: busy || !csrf }, '清空限制')),
            h('div', { className: 'muted' }, '启用分区排除且视频缺少分区信息时，该视频视为未通过（fail-closed）；分区偏好缺失只影响排序。'))),
        h('section', { className: 'card' },
          h('h3', null, '用户私信'),
          h('div', { className: 'muted' }, '只支持与绑定的用户 UID 私信。默认允许助手与用户私信交流；本次运行确认后，读取与受控发送同时开放，Autonomy 可在授权期内自主决定是否回复、何时回复、是否主动联系，不需要逐条审批。模型没有通用私信写工具。'),
          social && social.realSendAvailable !== true
            ? h('div', { className: 'warn' }, social.realReadAvailable === true
              ? '真实私信读取技术门禁已开，发送技术门禁仍关闭：可以读取用户消息，但当前不会真实发送。'
              : '真实私信技术门禁未开：当前不会读取或发送任何 B 站私信。')
            : h('div', { className: 'warn' }, '真实私信读取与发送技术门禁均已开：发送仍受用户绑定、每日上限、Budget、幂等与人工核实约束。'),
          social ? h('div', { className: 'muted' },
            `绑定：用户 UID ${social.ownerMid || '—'} · 登录账号 UID ${social.selfMid || '—'} · 通道 ${social.transport}`
              + ` · 读取 ${social.realReadAvailable === true ? '可用' : '关闭'}`
              + ` · 发送 ${social.realSendAvailable === true ? '可用' : '关闭'}`) : null,
          social?.ownerMid && social?.bindingValid === false
            ? h('div', { className: 'warn' }, '登录账号已变更，当前绑定属于旧账号：请重新绑定 ownerMid 后再签发授权。')
            : null,
          h('label', { className: 'muted', style: { display: 'block', marginTop: '6px' } }, '用户 UID（ownerMid）',
            h('input', {
              value: socialOwner, onChange: e => setSocialOwner(e.target.value),
              placeholder: '例如 1234567890', style: { width: '100%' },
            })),
          h('div', { className: 'actions', style: { marginTop: '6px' } },
            h('button', {
              onClick: () => act('social-bind', { ownerMid: socialOwner }),
              disabled: busy || !csrf || !String(socialOwner || '').trim(),
            }, '绑定 UID'),
            social?.active
              ? h('button', { onClick: () => act('social-revoke'), disabled: busy || !csrf }, '关闭并撤销私信交流权限')
              : h('button', {
                className: 'primary',
                onClick: () => act('social-grant'),
                disabled: busy || !csrf || !social?.ownerMid || social?.bindingValid === false
                  || (social?.realReadAvailable !== true && social?.realSendAvailable !== true),
              }, '允许助手与用户私信交流（本次运行）')),
          social?.active
            ? h('div', { className: 'muted' },
              `已允许本次运行内自主交流：授权含${social.grants[0].capabilities?.includes('read') ? '读取' : ''}`
                + `${social.grants[0].capabilities?.includes('send') ? (social.grants[0].capabilities?.includes('read') ? '与发送' : '发送') : '（未含发送，旧只读授权不会自动升级）'}`
                + ` · 发送技术门禁${social.realSendAvailable === true ? '开启' : '关闭'}`
                + ` · 有效至 ${ts(social.grants[0].expiresAt)} · 今日 ${social.grants[0].used}/${social.grants[0].dailySendMax > 0 ? social.grants[0].dailySendMax : '不限'}`)
            : h('div', { className: 'muted' }, '当前未允许。点击上方按钮后，本次运行内有效；重启、换号或退出登录即失效。'),
          h('div', { className: 'muted' },
            `发送状态：已确认 ${social?.counts?.sent || 0} · 未知 ${social?.counts?.unknown || 0} · 失败 ${social?.counts?.failed || 0} · 墓碑 ${social?.tombstones || 0}`),
          social?.tombstoneCapacity?.warning ? h('div', { className: 'warn' },
            `幂等墓碑接近上限（${social.tombstoneCapacity.used}/${social.tombstoneCapacity.max}）：达到上限后会拒绝新发送意图，不会删除旧墓碑。`) : null,
          (social?.unknown || []).length ? h('div', null,
            h('div', { className: 'muted' }, '未知结果（不会自动重发，需人工核实）：'),
            social.unknown.slice(0, 3).map(u => h('div', { className: 'item', key: u.intentId },
              h('div', { className: 'muted' }, `${u.intentId} · 已核实 ${u.verifyAttempts} 次 · ${ts(u.lastCheckedAt)}`),
              h('div', { className: 'actions' },
                h('button', { onClick: () => act('social-resolve', { intentId: u.intentId, status: 'sent' }), disabled: busy || !csrf }, '标记已发送'),
                h('button', { onClick: () => act('social-resolve', { intentId: u.intentId, status: 'failed' }), disabled: busy || !csrf }, '标记未发送'))))) : null),
        h('details', { className: 'bb-fold' },
          h('summary', null, '规则与安全说明'),
          h('ul', null, Object.values(d.rules || {}).map(r => h('li', { key: r }, r)))),
        h('div', { className: 'muted' }, '凭证不会出现在记忆、日记、活动、普通日志或本界面；这里只显示是否已保存。'),
      );
    }
    function apply(ctx) {
      ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: 'dsh-dshai-bilibili', order: 8, label: () => 'Bilibili · 助手' }, Screen
      )), 'bilibili panel');
    }
    exports.apply = apply;
    exports.inject = ['slots'];
    return module.exports;
  },
});
