/**
 * DSHAI 唤醒时段设置（settings.section）。
 * 只调用本插件 /bus/api/*；保存时服务端重新校验 24h 覆盖、重叠、跨午夜。
 */
window.__ModuleLoader__.load({
  id: 'dsh-dshai-bus',
  factory(require) {
    const React = require('react');
    const { useState, useEffect } = React;
    const h = React.createElement;

    const S = {
      wrap: { padding: '16px 4px', maxWidth: '760px', fontSize: '13.5px', lineHeight: 1.6 },
      h1: { fontSize: '16px', fontWeight: 600, margin: 0 },
      sub: { color: 'var(--dsw-alias-text-tertiary, #7a8794)', fontSize: '12.5px', marginTop: '2px' },
      card: { border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.22))', borderRadius: '12px', padding: '14px 16px', marginTop: '14px' },
      row: { display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 0', borderTop: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.16))' },
      input: { width: '86px', padding: '6px 8px', borderRadius: '8px', border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.3))', background: 'transparent', color: 'inherit' },
      btn: (primary) => ({ padding: '6px 12px', borderRadius: '8px', cursor: 'pointer', fontSize: '12.5px', border: primary ? 'none' : '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.3))', background: primary ? 'var(--dsw-alias-brand-primary, #0e7490)' : 'transparent', color: primary ? '#fff' : 'inherit' }),
      muted: { color: 'var(--dsw-alias-text-tertiary, #7a8794)', fontSize: '12px' },
      err: { marginTop: '8px', padding: '7px 10px', borderRadius: '8px', background: 'rgba(180,35,24,.08)', color: '#b42318', fontSize: '12.5px' },
      ok: { marginTop: '8px', padding: '7px 10px', borderRadius: '8px', background: 'rgba(14,116,144,.10)', color: 'var(--dsw-alias-brand-primary, #0e7490)', fontSize: '12.5px' },
    };

    const pad = n => String(n).padStart(2, '0');
    const toMin = text => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim());
      if (!m) return null;
      const hour = Number(m[1]); const minute = Number(m[2]);
      if (hour === 24 && minute === 0) return 1440;
      if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
      return hour * 60 + minute;
    };
    const toText = min => (min >= 1440 ? '24:00' : `${pad(Math.floor(min / 60))}:${pad(min % 60)}`);

    async function api(path, options = {}) {
      const res = await fetch(path, { credentials: 'same-origin', ...options });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      return body;
    }

    function TickSchedule() {
      const [schedule, setSchedule] = useState(null);
      const [draft, setDraft] = useState([]);
      const [csrf, setCsrf] = useState('');
      const [splitAt, setSplitAt] = useState('');
      const [splitOpen, setSplitOpen] = useState(false);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [ok, setOk] = useState('');

      const apply = data => {
        setSchedule(data);
        setDraft((data?.segments || []).map(row => ({ ...row })));
      };

      const load = async () => {
        setError('');
        try {
          const [token, data] = await Promise.all([api('/bus/api/csrf'), api('/bus/api/schedule')]);
          setCsrf(token.token || '');
          apply(data);
        } catch (e) { setError(String(e?.message || e)); }
      };

      useEffect(() => { load(); }, []);

      const save = async (segments = draft) => {
        setBusy(true); setError(''); setOk('');
        try {
          const data = await api('/bus/api/schedule', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
            body: JSON.stringify({ segments }),
          });
          apply(data);
          setOk('已保存');
        } catch (e) { setError(String(e?.message || e)); }
        finally { setBusy(false); }
      };

      const setMinutes = (index, value) => {
        setDraft(list => list.map((row, i) => i === index ? { ...row, tickMs: Math.max(1, Number(value) || 1) * 60_000 } : row));
      };

      const remove = index => {
        if (draft.length <= 1) return;
        const list = draft.map(row => ({ ...row }));
        const [gone] = list.splice(index, 1);
        const neighbor = list[index] || list[index - 1];
        if (neighbor) {
          neighbor.start = toText(Math.min(toMin(neighbor.start), toMin(gone.start)));
          neighbor.end = toText(Math.max(toMin(neighbor.end), toMin(gone.end)));
        }
        setDraft(list);
      };

      const doSplit = () => {
        setError('');
        const point = toMin(splitAt);
        if (point === null || point <= 0 || point >= 1440) {
          setError('拆分时间必须在 00:00–23:59 之间');
          return;
        }
        const index = draft.findIndex(row => point > toMin(row.start) && point < toMin(row.end));
        if (index < 0) { setError('拆分时间必须落在某个时段内部（不能是边界）'); return; }
        const row = draft[index];
        const left = { ...row, end: toText(point) };
        const right = { ...row, start: toText(point) };
        const list = [...draft.slice(0, index), left, right, ...draft.slice(index + 1)];
        if (list.length > 6) { setError('最多 6 段'); return; }
        setDraft(list);
        setSplitOpen(false);
        setSplitAt('');
        save(list);
      };

      const currentText = () => {
        if (!schedule?.current) return '—';
        return `${schedule.current.start}–${schedule.current.end}`;
      };

      return h('div', { style: S.wrap },
        h('div', null,
          h('h1', { style: S.h1 }, '唤醒时段'),
          h('div', { style: S.sub }, '一天最多 6 段，必须完整覆盖 00:00–24:00；每段有自己的唤醒间隔。第一次唤醒在段起点 + 间隔，重启不会补发。')),
        schedule ? h('div', { style: { ...S.card, marginTop: '10px' } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '12px' } },
            h('div', null,
              h('div', { style: { fontWeight: 600 } }, `当前时段：${currentText()}`),
              h('div', { style: S.muted }, `下一次唤醒：${schedule.nextTickAt ? new Date(schedule.nextTickAt).toLocaleString('zh-CN', { hour12: false }) : '本段不唤醒'}`))),
          draft.map((row, i) => h('div', { key: `${row.start}-${row.end}-${i}`, style: S.row },
            h('span', { style: { minWidth: '118px' } }, `${row.start}–${row.end}`),
            h('input', { type: 'number', min: 1, max: 1440, style: S.input, value: Math.round(row.tickMs / 60_000), onInput: e => setMinutes(i, e.target.value) }),
            h('span', { style: S.muted }, '分钟'),
            draft.length > 1 ? h('button', { style: S.btn(false), onClick: () => remove(i) }, '删除') : null)),
          h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '12px' } },
            h('button', { style: S.btn(true), disabled: busy, onClick: () => save() }, '保存全部'),
            h('button', { style: S.btn(false), disabled: busy || draft.length >= 6, onClick: () => setSplitOpen(v => !v) }, '＋ 新增时段'),
            h('span', { style: S.muted }, '新增会按你选的时间拆开现有段')),
          splitOpen ? h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '10px' } },
            h('input', { type: 'time', style: S.input, value: splitAt, onInput: e => setSplitAt(e.target.value) }),
            h('button', { style: S.btn(true), disabled: busy, onClick: doSplit }, '拆分'),
            h('button', { style: S.btn(false), disabled: busy, onClick: () => setSplitOpen(false) }, '取消')) : null,
          error ? h('div', { style: S.err }, error) : null,
          ok ? h('div', { style: S.ok }, ok) : null,
          h('div', { style: { ...S.muted, marginTop: '12px' } }, 'DSHAI 只能改“当前时段”的间隔，不能改时段边界。')) : h('div', { style: S.muted }, '读取中…'));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: 'dshai-bus-tick', order: 9, label: () => '唤醒时段' },
          TickSchedule,
        )), 'dshai bus tick settings');
      },
    };
  },
});
