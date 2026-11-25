/**
 * DSHAI 管理面板的客户端入口。
 *
 * 管理界面直接渲染在宿主「设置」分区里，不跳页面、不弹窗，避免用户
 * 打开后回不到客户端。数据仍来自 Host 端 cognition-ui 插件提供的
 * /cognition/api/*；这里只做展示与表单。
 */
window.__ModuleLoader__.load({
  id: 'dsh-dshai-cognition',
  factory(require) {
    const React = require('react');
    const { useState, useEffect, useRef } = React;
    const h = React.createElement;

    const C = {
      ink: 'var(--dsw-alias-text-primary, #1f2937)',
      muted: 'var(--dsw-alias-text-tertiary, #7a8794)',
      line: 'var(--dsw-alias-border-secondary, rgba(127,127,127,.22))',
      card: 'var(--dsw-alias-bg-elevated, rgba(127,127,127,.045))',
      brand: 'var(--dsw-alias-brand-primary, #0e7490)',
      soft: 'var(--dsw-alias-brand-primary-container, rgba(14,116,144,.10))',
      danger: '#b42318',
    };
    const S = {
      wrap: { padding: '18px 4px', maxWidth: '880px', fontSize: '13.5px', lineHeight: 1.6, color: C.ink },
      head: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px' },
      h1: { fontSize: '17px', fontWeight: 600, margin: 0 },
      sub: { color: C.muted, fontSize: '12.5px', marginTop: '2px' },
      tabs: { display: 'flex', gap: '4px', flexWrap: 'wrap', margin: '16px 0 14px', borderBottom: `1px solid ${C.line}` },
      tab: (on) => ({
        padding: '7px 12px', border: 0, background: 'transparent', cursor: 'pointer',
        color: on ? C.brand : C.muted, fontWeight: on ? 600 : 400, fontSize: '13.5px',
        borderBottom: on ? `2px solid ${C.brand}` : '2px solid transparent', marginBottom: '-1px',
      }),
      card: { border: `1px solid ${C.line}`, borderRadius: '12px', padding: '16px 18px', background: C.card },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px', marginBottom: '12px' },
      stat: { border: `1px solid ${C.line}`, borderRadius: '10px', padding: '10px 12px' },
      num: { fontSize: '19px', fontWeight: 650, letterSpacing: '.3px' },
      lbl: { color: C.muted, fontSize: '12px' },
      meter: { height: '6px', borderRadius: '999px', background: C.soft, overflow: 'hidden', marginTop: '6px' },
      meterFill: (pct) => ({ height: '100%', width: pct + '%', background: C.brand, transition: 'width .3s' }),
      row: { display: 'flex', gap: '12px', alignItems: 'center' },
      field: { marginBottom: '12px' },
      label: { display: 'block', color: C.muted, fontSize: '12px', marginBottom: '4px' },
      input: { width: '100%', boxSizing: 'border-box', padding: '7px 10px', borderRadius: '8px', border: `1px solid ${C.line}`, background: 'transparent', color: C.ink, fontSize: '13.5px' },
      btn: (primary) => ({
        padding: '7px 14px', borderRadius: '8px', cursor: 'pointer', fontSize: '13.5px',
        border: `1px solid ${primary ? 'transparent' : C.line}`,
        background: primary ? C.brand : 'transparent', color: primary ? '#fff' : C.ink,
      }),
      item: { borderTop: `1px solid ${C.line}`, padding: '10px 2px' },
      badge: { display: 'inline-block', padding: '0 6px', borderRadius: '999px', background: C.soft, color: C.brand, fontSize: '11.5px', marginLeft: '6px' },
      muted: { color: C.muted, fontSize: '12.5px' },
      notice: (bad) => ({ margin: '10px 0', padding: '8px 12px', borderRadius: '8px', background: bad ? 'rgba(180,35,24,.08)' : C.soft, color: bad ? C.danger : C.brand, fontSize: '12.5px' }),
      empty: { color: C.muted, padding: '18px 2px', textAlign: 'center' },
    };

    function fmtDate(v) {
      const d = new Date(typeof v === 'number' ? v : Date.parse(v));
      return isNaN(d) ? String(v) : d.toLocaleDateString('zh-CN');
    }

    function fmtTime(v) {
      if (!v) return '—';
      let raw = v;
      // 纯日期字符串 "YYYY-MM-DD" 会被 Date.parse 当成 UTC 零点，在上海就显示成 08:00。
      // 统一按"本地当天 00:00"解析，避免 +8 小时错位。
      if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) raw = raw.trim() + 'T00:00:00';
      const d = new Date(typeof raw === 'number' ? raw : Date.parse(raw));
      return isNaN(d) ? String(v) : d.toLocaleString('zh-CN', { hour12: false });
    }

    // 日记只有"哪一天"这一个权威字段：直接显示日期，不要造一个时刻出来。
    function fmtDay(v) {
      const s = String(v ?? '').trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
      const parsed = Date.parse(s);
      if (!Number.isFinite(parsed)) return s || '—';
      return new Date(parsed).toLocaleDateString('zh-CN');
    }

    // 条目上的写入时间（真实 now，不是"当天 12:00"）。
    function diarySubtitle(row) {
      const parts = [];
      const at = Date.parse(row?.createdAt || row?.updatedAt || '');
      if (Number.isFinite(at)) {
        const d = new Date(at);
        parts.push('写入 ' + fmtClock(d));
      }
      if (Number(row?.chars) > 0) parts.push(row.chars + ' 字');
      if (row?.mood) parts.push(String(row.mood).slice(0, 16));
      return parts.join(' · ') || '—';
    }

    // 只给日记副标题用的"月-日 时:分"（避免和上面按日期格式化的 fmtDate 撞名）
    function fmtClock(d) {
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const hh = String(d.getHours()).padStart(2, '0');
      const mi = String(d.getMinutes()).padStart(2, '0');
      return mm + '-' + dd + ' ' + hh + ':' + mi;
    }

    // 记忆列表只展示最近这么多条；最新的排最前面。
    const MEMORY_SHOW_LIMIT = 30;
    function memoryTime(m) {
      const created = Date.parse(m?.createdAt || '');
      if (Number.isFinite(created)) return created;
      const occurred = Number(m?.occurredAt);
      return Number.isFinite(occurred) ? occurred : 0;
    }

    function DshaiSettings() {
      const [tab, setTab] = useState('overview');
      const [status, setStatus] = useState(null);
      const [identity, setIdentity] = useState(null);
      const [memories, setMemories] = useState(null);
      const [acts, setActs] = useState(null);
      const [query, setQuery] = useState('');
      const [form, setForm] = useState({ name: '', gender: '', profileText: '' });
      const [preview, setPreview] = useState(null);
      const [importData, setImportData] = useState('');
      const [busy, setBusy] = useState(false);
      const [persona, setPersona] = useState(null);
      const [prefs, setPrefs] = useState(null);
      const [prefOpen, setPrefOpen] = useState(false);
      const [diary, setDiary] = useState(null);
      const [chronicle, setChronicle] = useState(null);
      const [reader, setReader] = useState(null);
      const [docQuery, setDocQuery] = useState('');
      const [msg, setMsg] = useState('');
      const [err, setErr] = useState('');
      const tokenRef = useRef('');

      async function call(path, opts = {}) {
        const headers = { ...(opts.headers || {}) };
        if (tokenRef.current) headers['x-csrf-token'] = tokenRef.current;
        if (opts.body !== undefined) headers['content-type'] = 'application/json';
        const res = await fetch(path, { ...opts, headers, credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
        return data;
      }

      async function loadOverview() {
        const data = await call('/cognition/api/overview');
        setStatus(data.status || null);
        setIdentity(data.identity || null);
        setPrefs(data.preferences || null);
        if (data.identity) {
          setForm({
            name: data.identity.name || '',
            gender: data.identity.gender || '',
            profileText: data.identity.profileText || '',
          });
        }
      }

      useEffect(() => {
        let alive = true;
        (async () => {
          try {
            const t = await call('/cognition/api/csrf');
            tokenRef.current = t.token;
            if (alive) await loadOverview();
          } catch (e) { if (alive) setErr(e.message); }
        })();
        return () => { alive = false; };
      }, []);

      async function loadPersona() {
        try { setPersona(await call('/cognition/api/persona')); } catch (e) { setErr(e.message); }
      }
      async function loadDiary() {
        try { const d = await call('/cognition/api/diary'); setDiary(Array.isArray(d) ? d : []); } catch (e) { setErr(e.message); }
      }
      async function loadChronicle() {
        try { const d = await call('/cognition/api/chronicle?limit=30'); setChronicle(Array.isArray(d) ? d : []); } catch (e) { setErr(e.message); }
      }
      async function openDiary(row) {
        try {
          const d = await call('/cognition/api/diary/read?id=' + encodeURIComponent(row.id));
          const raw = d && d.text !== undefined ? d.text : d;
          const textBody = typeof raw === 'string' ? raw : (raw && typeof raw.text === 'string' ? raw.text : '');
          const body = textBody && textBody.trim()
            ? textBody
            : '（读取为空：id=' + String(row.id ?? '') + '，返回=' + JSON.stringify(d).slice(0, 160) + '）';
          setReader({ kind: '日记', title: row.title || row.day || '日记', meta: (row.day || '') + (textBody ? ' · ' + textBody.length + ' 字' : ''), body });
        } catch (e) { setErr(e.message); }
      }
      async function openChronicle(row) {
        try {
          const d = await call('/cognition/api/chronicle/read?id=' + encodeURIComponent(row.id));
          const body = [
            d.current?.text || '',
            d.topics?.length ? '话题：' + d.topics.map(t => t.tag + '×' + t.count).join('、') : '',
            d.basedOn ? '依据：记忆 ' + d.basedOn.memories + ' / 事实 ' + d.basedOn.facts + ' / 行动 ' + d.basedOn.actions : ''
          ].filter(Boolean).join('\n\n');
          setReader({ kind: '编年史', title: '人格编年史', meta: fmtTime(d.at), body });
        } catch (e) { setErr(e.message); }
      }

      async function loadMemories() {
        try {
          const d = await call('/cognition/api/memories?limit=200');
          setMemories(Array.isArray(d) ? d : (d.items || d.memories || []));
        } catch (e) { setErr(e.message); }
      }

      useEffect(() => {
        // 每次切到"记忆"都重新拉：否则新发生的记忆要刷新整页才看得到。
        if (tab === 'memories') loadMemories();
        if (tab === 'activity') {
          call('/cognition/api/activity?limit=60')
            .then((d) => setActs(Array.isArray(d) ? d : (d.items || [])))
            .catch((e) => setErr(e.message));
        }
        if (tab === 'identity') loadPersona();
        if (tab === 'diary') loadDiary();
        if (tab === 'chronicle') loadChronicle();
      }, [tab]);

      // 阅读器打开时按 Esc 返回列表（防止正文太长找不到按钮）。
      useEffect(() => {
        if (!reader) return undefined;
        const onKey = (e) => { if (e.key === 'Escape') setReader(null); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [reader]);

      async function saveIdentity() {
        setBusy(true); setErr(''); setMsg('');
        try {
          const data = await call('/cognition/api/identity', {
            method: 'POST',
            body: JSON.stringify({ name: form.name.trim(), gender: form.gender, profileText: form.profileText }),
          });
          // 后端可能拒绝（人设已锁定）：不能再无条件提示"已保存"
          if (data && data.ok === false) {
            setErr(data.reason === 'persona-locked'
              ? '初始人设已锁定，不能再修改（只能后台改文件）'
              : `身份未保存：${data.reason || '未知原因'}`);
            await loadOverview();
            return;
          }
          setIdentity(data.identity || data);
          await loadOverview();
          if (data && data.locked === false) {
            setMsg('已保存（性别未填，人设尚未锁定）');
          } else {
            setMsg('身份已保存，人设已锁定');
          }
        } catch (e) { setErr(e.message); }
        finally { setBusy(false); }
      }

      async function exportData() {
        setBusy(true); setErr(''); setMsg('');
        try {
          const data = await call('/cognition/api/export', {
            method: 'POST',
            body: JSON.stringify({ includeActivity: true, includeTrace: true }),
          });
          const bytes = atob(data.base64);
          const arr = new Uint8Array(bytes.length);
          for (let i = 0; i < bytes.length; i += 1) arr[i] = bytes.charCodeAt(i);
          const url = URL.createObjectURL(new Blob([arr], { type: 'application/zip' }));
          const a = document.createElement('a');
          a.href = url; a.download = data.filename || 'cognition-backup.zip';
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 4000);
          setMsg('已生成备份：' + (data.filename || 'cognition-backup.zip'));
        } catch (e) { setErr(e.message); }
        setBusy(false);
      }

      function readFile(file) {
        const reader = new FileReader();
        reader.onload = async () => {
          const text = String(reader.result || '');
          const base64 = text.includes(',') ? text.slice(text.indexOf(',') + 1) : text;
          setBusy(true); setErr(''); setMsg('');
          try {
            const p = await call('/cognition/api/import/preview', { method: 'POST', body: JSON.stringify({ base64 }) });
            setImportData(base64);
            setPreview(p);
            setMsg(p.canRestoreEmpty ? '目标为空，可直接恢复' : '目标已有数据，恢复会覆盖（会先自动备份）');
          } catch (e) { setErr(e.message); setPreview(null); setImportData(''); }
          setBusy(false);
        };
        reader.readAsDataURL(file);
      }

      async function runImport() {
        setBusy(true); setErr(''); setMsg('');
        try {
          const mode = preview?.canRestoreEmpty ? 'empty-only' : 'overwrite';
          await call('/cognition/api/import', { method: 'POST', body: JSON.stringify({ base64: importData, mode }) });
          setPreview(null); setImportData('');
          setMemories(null);
          await loadOverview();
          setMsg('恢复完成');
        } catch (e) { setErr(e.message); }
        setBusy(false);
      }

      const counts = status?.counts || {};
      const loop = status?.loop || {};
      // V-A-E：状态只从 status.affect 来，标签由后端 labelOf 统一算好，这里只做展示。
      const affect = status?.affect || {};
      const energyValue = Number(affect.energy);
      const energyPct = Number.isFinite(energyValue) ? Math.max(0, Math.min(100, energyValue)) : 0;
      const energyText = Number.isFinite(energyValue) ? Math.round(energyValue) + ' / 100' : '—';
      const moodLabel = affect.label || affect.mood || '—';
      const CAUSE_TEXT = { system: '系统/工具', owner: '用户', unknown: '不明' };
      const causeText = affect.cause ? '原因：' + (CAUSE_TEXT[affect.cause] || affect.cause) : '';
      const valenceValue = Number(affect.valence);
      const arousalValue = Number(affect.arousal);
      const moodValues = Number.isFinite(valenceValue) && Number.isFinite(arousalValue)
        ? '好坏 ' + valenceValue.toFixed(2) + ' · 激活 ' + arousalValue.toFixed(2) + (affect.version ? '' : '（旧数据）')
        : '—';
      const tired = affect.tired === true || (Number.isFinite(energyValue) && energyValue < 20);
      const tabs = [
        ['overview', '概览'],
        ['identity', '身份'],
        ['memories', '记忆'],
        ['activity', '活动'],
        ['diary', '日记'],
        ['chronicle', '编年史'],
        ['data', '数据'],
      ];

      if (reader) {
        return h('div', {
          style: {
            position: 'fixed', inset: 0, zIndex: 9999,
            background: 'var(--dsw-alias-bg-base, #ffffff)',
            display: 'flex', flexDirection: 'column',
            padding: '16px 20px',
          },
        },
          h('div', {
            style: {
              flexShrink: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              gap: '8px', paddingBottom: '10px', borderBottom: '1px solid ' + C.line,
            },
          },
            h('button', { style: S.btn(false), onClick: () => setReader(null) }, '← 返回列表（Esc）'),
            h('span', { style: S.muted }, reader.kind)),
          h('div', { style: { flex: 1, overflow: 'auto', paddingTop: '12px' } },
            h('h1', { style: S.h1 }, reader.title),
            reader.meta ? h('div', { style: { ...S.muted, marginBottom: '10px' } }, reader.meta) : null,
            h('div', { style: { ...S.card, whiteSpace: 'pre-wrap', lineHeight: 1.9, fontSize: '14px' } },
              reader.body && String(reader.body).trim() ? reader.body : '（这篇没有正文）'),
            h('div', { style: { marginTop: '14px', paddingBottom: '24px' } },
              h('button', { style: S.btn(false), onClick: () => setReader(null) }, '← 返回列表'))));
      }


      return h('div', { style: S.wrap },
        h('div', { style: S.head },
          h('div', null,
            h('h1', { style: S.h1 }, 'DSHAI 设置'),
            h('div', { style: S.sub }, '身份、记忆、活动与备份都在这里；改动只影响认知内核自己的状态根。')),
          h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
            h('button', { style: S.btn(false), disabled: busy, onClick: () => { setErr(''); loadOverview().catch((e) => setErr(e.message)); } }, '刷新'))),

        err ? h('div', { style: S.notice(true) }, err) : null,
        msg ? h('div', { style: S.notice(false) }, msg) : null,

        h('div', { style: S.tabs },
          tabs.map(([key, text]) => h('button', {
            key, style: S.tab(tab === key), onClick: () => setTab(key),
          }, text))),

        tab === 'overview' ? h('div', null,
          h('div', { style: S.grid },
            [['记忆', counts.memories], ['日记', counts.diary], ['已归档', counts.archived], ['习惯', status?.habits?.active]].map(([label, value]) =>
              h('div', { key: label, style: S.stat }, h('div', { style: S.num }, value == null ? '—' : String(value)), h('div', { style: S.lbl }, label)))),
          h('div', { style: { ...S.card, marginBottom: '12px' } },
            h('div', { style: { fontWeight: 600, marginBottom: '10px' } }, '此刻状态'),
            h('div', { style: S.row },
              h('div', { style: { minWidth: '140px', flex: '0 0 auto' } },
                h('div', { style: S.lbl }, '精力'),
                h('div', { style: S.num }, energyText),
                h('div', { style: S.meter }, h('div', { style: S.meterFill(energyPct) }))),
              h('div', null,
                h('div', { style: S.lbl }, '情绪'),
                h('div', { style: { fontSize: '15px', fontWeight: 600 } }, moodLabel),
                causeText ? h('div', { style: S.muted }, causeText) : null,
                h('div', { style: S.muted }, moodValues))),
            tired ? h('div', { style: { ...S.muted, marginTop: '8px' } }, '· 有点累（只影响表达，不限制行动）') : null),
          h('div', { style: S.card },
            h('div', { style: S.row },
              h('div', { style: { width: '42px', height: '42px', borderRadius: '12px', display: 'grid', placeItems: 'center', background: C.soft, color: C.brand, fontWeight: 700 } }, (identity?.name || '鱼').slice(0, 1)),
              h('div', null,
                h('div', { style: { fontWeight: 600, fontSize: '15px' } }, identity?.name || '还没有设置身份'),
                h('div', { style: S.muted }, identity ? `rev ${identity.revision ?? 1} · ${identity.gender || '未填写'}` : '在「身份」里设置名字与自我介绍'))),
            h('div', { style: { ...S.muted, marginTop: '12px' } },
              `循环：${loop.enabled ? '开启' : '关闭'}${loop.model ? ' · 模型决策' : ''} · 状态根：${status?.root || status?.stateRoot || '（未知）'}`))) : null,

        tab === 'identity' ? h('div', null,
          h('div', { style: S.card },
            h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '初设（已锁定）'),
            h('div', { style: S.muted }, persona?.locked ? '锁定于 ' + fmtTime(persona.lockedAt) + '，日常不可改' : '（未锁定）'),
            h('div', { style: { marginTop: '10px' } }, h('div', { style: { fontWeight: 600 } }, persona?.initial?.name || '—')),
            h('div', { style: S.muted }, persona?.initial?.gender || '未填写'),
            h('div', { style: { whiteSpace: 'pre-wrap', marginTop: '8px' } }, persona?.initial?.profileText || '（空）')),
          h('div', { style: { ...S.card, marginTop: '12px' } },
            h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '当前（派生，不落盘）'),
            h('div', { style: { whiteSpace: 'pre-wrap' } }, persona?.derived?.summary || '—'),
            h('div', { style: { ...S.muted, marginTop: '8px' } },
              persona?.derived?.basedOn ? '依据：记忆 ' + persona.derived.basedOn.memories + ' / 事实 ' + persona.derived.basedOn.facts + ' / 行动 ' + persona.derived.basedOn.actions + ' / 理解 ' + persona.derived.basedOn.insights : '')),
          // 偏好与倾向：默认收起，点标题展开/收起。
          // 上面是用户的偏好与约定（含被确认次数、置信度），下面是她自己长出来的倾向。
          h('div', { style: { ...S.card, marginTop: '12px' } },
            h('button', {
              style: { ...S.btn(), width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
              onClick: () => setPrefOpen(!prefOpen),
            },
              h('span', null, '偏好与倾向',
                h('span', { style: S.badge }, ((prefs?.items || []).length + (persona?.tendencies || []).length) + ' 条')),
              h('span', { style: S.muted }, prefOpen ? '点击收起' : '点击展开')),
            prefOpen ? h('div', { style: { marginTop: '12px' } },
              h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '用户的偏好与约定'),
              (prefs?.items || []).length === 0
                ? h('div', { style: S.empty }, '还没有记录到偏好或约定。')
                : (prefs.items || []).map((p, i) => h('div', { key: p.id || i, style: S.item },
                    h('div', { style: { fontWeight: 600 } }, p.title || '（无标题）',
                      h('span', { style: S.badge }, (Number(p.support) || 1) >= 2 ? '确认 ' + p.support + ' 次' : '说过 1 次'),
                      Number.isFinite(p.confidence) ? h('span', { style: S.badge }, '置信 ' + p.confidence.toFixed(2)) : null),
                    p.content ? h('div', { style: { marginTop: '2px', whiteSpace: 'pre-wrap' } }, p.content) : null)),
              h('div', { style: { fontWeight: 600, margin: '14px 0 6px' } }, '当前倾向（她自己长出来的，只读）'),
              (persona?.tendencies || []).length === 0
                ? h('div', { style: S.empty }, '还没有形成稳定倾向。')
                : (persona.tendencies || []).slice().reverse().map((t, i) => h('div', { key: i, style: S.item },
                    h('div', { style: { fontWeight: 600 } }, t.label || '（无标签）',
                      h('span', { style: S.badge }, t.status === 'active' ? '生效' : '待定'),
                      h('span', { style: S.badge }, '支持 ' + (t.support ?? 0)),
                      h('span', { style: S.badge }, '置信 ' + (Number(t.confidence) || 0).toFixed(2))),
                    h('div', { style: { marginTop: '2px' } }, t.statement || '')))) : null),
          h('div', { style: { ...S.card, marginTop: '12px' } },
            h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '变更历史'),
            (persona?.history || []).slice().reverse().map((row, i) => h('div', { key: i, style: S.item },
              h('div', { style: S.muted }, fmtTime(row.at) + ' · ' + (row.source || 'unknown')))))) : null,

        tab === 'memories' ? (() => {
          const filtered = (memories || []).filter((m) => {
            if (!query.trim()) return true;
            const q = query.trim().toLowerCase();
            return [m.title, m.content, ...(m.tags || [])].join('\n').toLowerCase().includes(q);
          });
          // 最新的排最前面，并且只展示最近 MEMORY_SHOW_LIMIT 条。
          const sorted = filtered.slice().sort((a, b) => memoryTime(b) - memoryTime(a));
          const shown = sorted.slice(0, MEMORY_SHOW_LIMIT);
          return h('div', null,
            h('div', { style: { display: 'flex', gap: '8px', marginBottom: '10px' } },
              h('input', { style: { ...S.input, flex: 1 }, placeholder: '搜索标题、内容或标签', value: query, onInput: (e) => setQuery(e.target.value) }),
              h('button', { style: S.btn(), onClick: loadMemories }, '刷新')),
            shown.map((m) =>
              h('div', { key: m.id, style: S.item },
                h('div', { style: { fontWeight: 600 } }, m.title || '(无标题)',
                  h('span', { style: S.badge }, m.kind || 'fact'),
                  m.layer ? h('span', { style: S.badge }, m.layer) : null),
                h('div', { style: { color: C.muted, margin: '2px 0 4px' } }, fmtTime(m.createdAt || m.occurredAt) + (m.tags?.length ? ' · ' + m.tags.join(' / ') : '')),
                h('div', { style: { whiteSpace: 'pre-wrap' } }, String(m.excerpt || m.content || '').slice(0, 260)))),
            shown.length === 0 ? h('div', { style: S.empty }, '还没有记住什么。') : null,
            sorted.length > MEMORY_SHOW_LIMIT
              ? h('div', { style: { ...S.muted, marginTop: '10px' } }, `共 ${sorted.length} 条，仅显示最近 ${MEMORY_SHOW_LIMIT} 条。用上面的搜索查找更早的记忆。`)
              : null);
        })() : null,

        tab === 'activity' ? (() => {
          const rows = (acts || []).filter(Boolean)
            .slice()
            .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))
            .slice(0, MEMORY_SHOW_LIMIT);
          return h('div', null,
            h('div', { style: { display: 'flex', gap: '8px', marginBottom: '10px' } },
              h('input', { style: { ...S.input, flex: 1 }, placeholder: '搜索活动', value: docQuery, onInput: (e) => setDocQuery(e.target.value) }),
              h('button', { style: S.btn(), onClick: () => { setDocQuery(''); call('/cognition/api/activity?limit=60').then((d) => setActs(Array.isArray(d) ? d : (d.items || []))).catch((e) => setErr(e.message)); } }, '刷新')),
            rows
              .filter((a) => {
                if (!docQuery.trim()) return true;
                const q = docQuery.trim().toLowerCase();
                return [a.kind, a.title, a.reason, a.type].join(' ').toLowerCase().includes(q);
              })
              .map((a, i) => h('div', { key: a.id || i, style: S.item },
                h('div', { style: { fontWeight: 550 } }, (a.kind || 'event') + (a.type ? ' · ' + a.type : '')),
                h('div', { style: S.muted }, fmtTime(a.at)),
                a.title || a.reason ? h('div', { style: { marginTop: '2px' } }, String(a.title || a.reason).slice(0, 200)) : null)),
            (acts || []).length === 0 ? h('div', { style: S.empty }, '还没有活动记录。') : null);
        })() : null,

        tab === 'diary' ? (() => {
          const rows = (diary || []).slice().sort((a, b) => (Date.parse(b.day || b.at || 0) || 0) - (Date.parse(a.day || a.at || 0) || 0)).slice(0, MEMORY_SHOW_LIMIT);
          if (!rows.length) return h('div', { style: S.empty }, '还没有日记。（读取接口应返回数组；若你确认写过日记，请把这条提示告诉我）');
          return h('div', null, rows.map((row, i) => h('div', {
            key: row.id || i, style: { ...S.item, cursor: 'pointer' }, onClick: () => openDiary(row),
          },
            h('div', { style: { fontWeight: 600 } }, fmtDay(row.day || row.createdAt) || '(无标题)'),
            h('div', { style: S.muted }, diarySubtitle(row)))));
        })() : null,

        tab === 'chronicle' ? (() => {
          const rows = (chronicle || []).slice().sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0)).slice(0, MEMORY_SHOW_LIMIT);
          if (!rows.length) return h('div', { style: S.empty }, '还没有编年史（每 7 天最多一条，首条在数据根 documents/persona/ 下）。');
          return h('div', null, rows.map((row, i) => h('div', {
            key: row.id || i, style: { ...S.item, cursor: 'pointer' }, onClick: () => openChronicle(row),
          },
            h('div', { style: { fontWeight: 600 } }, fmtDate(row.at)),
            h('div', { style: S.muted, marginTop: '4px' }, String(row.current?.text || '').slice(0, 120)))));
        })() : null,

        tab === 'data' ? h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, '导出备份'),
          h('div', { style: S.muted }, '把状态根里的身份、记忆、日记、活动与 trace 打包成 zip；包含 manifest 与逐文件 SHA256。'),
          h('button', { style: { ...S.btn(true), marginTop: '10px' }, disabled: busy, onClick: exportData }, '导出 zip'),
          h('div', { style: { borderTop: `1px solid ${C.line}`, margin: '16px 0' } }),
          h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, '导入备份'),
          h('div', { style: S.muted }, '先预览清单和冲突；目标非空时覆盖前会自动备份到同级目录。'),
          h('input', {
            type: 'file', accept: '.zip,application/zip', disabled: busy, style: { marginTop: '10px' },
            onChange: (e) => { const f = e.target.files?.[0]; if (f) readFile(f); e.target.value = ''; },
          }),
          preview ? h('div', { style: { marginTop: '12px' } },
            h('div', { style: S.muted }, `清单：${preview.manifest?.files?.length ?? '?'} 个文件 · 冲突 ${preview.conflictCount ?? 0} · ${preview.canRestoreEmpty ? '可直接恢复' : '目标非空'}`),
            h('button', { style: { ...S.btn(true), marginTop: '8px' }, disabled: busy, onClick: runImport },
              preview.canRestoreEmpty ? '恢复到此状态根' : '覆盖恢复（先备份）')) : null) : null,
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: 'dshai', order: 8, label: () => 'DSHAI 设置' },
          DshaiSettings,
        )), 'dshai settings entry');
      },
    };
  },
});
