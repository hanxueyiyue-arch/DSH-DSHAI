// 自包含的管理界面：不依赖外部 CDN、字体或构建步骤。
export function renderCognitionUi({ csrfToken = '', presets = [] } = {}) {
  const presetName = presets.length > 0 ? presets[0] : '助手';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(presetName)} · 认知内核</title>
<style>
  :root{
    --ink:#122430; --ink-2:#2d4554; --muted:#69808f; --line:#dfeaf0;
    --bg:#f2f7fa; --card:#ffffff; --teal:#0e7490; --teal-soft:#e2f2f8;
    --amber:#b07a18; --amber-soft:#fbf1dc; --rose:#b0443f; --rose-soft:#fbe9e7;
    --shadow:0 1px 2px rgba(18,36,48,.05),0 12px 28px -18px rgba(18,36,48,.35);
    --radius:16px;
  }
  *{box-sizing:border-box}
  html,body{height:100%}
  body{margin:0;background:var(--bg);color:var(--ink);
    font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;}
  .shell{display:grid;grid-template-columns:232px 1fr;min-height:100vh}
  aside{position:sticky;top:0;height:100vh;padding:26px 18px 20px;border-right:1px solid var(--line);
    background:linear-gradient(180deg,#fbfdff,#eef5f9);display:flex;flex-direction:column;gap:22px}
  .brand{display:flex;align-items:center;gap:11px;padding:0 8px}
  .brand .dot{width:36px;height:36px;border-radius:12px;display:grid;place-items:center;
    background:radial-gradient(circle at 30% 25%,#33b2d0,#0a6a8a);color:#fff;font-weight:700;font-size:15px;
    box-shadow:inset 0 0 0 1px rgba(255,255,255,.22)}
  .brand b{display:block;font-size:15px;letter-spacing:.2px}
  .brand span{display:block;font-size:11.5px;color:var(--muted);letter-spacing:.4px}
  nav{display:flex;flex-direction:column;gap:4px}
  nav button{all:unset;display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:11px;
    color:var(--ink-2);cursor:pointer;font-size:13.5px}
  nav button svg{width:17px;height:17px;stroke:currentColor;fill:none;stroke-width:1.7}
  nav button:hover{background:#eaf3f7}
  nav button.on{background:var(--teal-soft);color:var(--teal);font-weight:600}
  .side-note{margin-top:auto;font-size:11.5px;color:var(--muted);padding:12px;border:1px dashed var(--line);border-radius:12px}
  main{padding:30px 34px 44px;max-width:1180px}
  header.top{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:24px}
  h1{margin:0;font-size:23px;letter-spacing:-.2px}
  .sub{color:var(--muted);font-size:12.5px;margin-top:4px}
  .actions{display:flex;gap:8px;align-items:center}
  .btn{all:unset;display:inline-flex;align-items:center;gap:7px;padding:9px 15px;border-radius:10px;
    background:var(--ink);color:#fff;font-size:13px;cursor:pointer}
  .btn:hover{opacity:.9}
  .btn.ghost{background:#fff;color:var(--ink-2);border:1px solid var(--line)}
  .btn.teal{background:var(--teal)}
  .btn.danger{background:var(--rose)}
  .btn[disabled]{opacity:.45;cursor:not-allowed}
  .grid{display:grid;gap:16px}
  .cols-4{grid-template-columns:repeat(4,minmax(0,1fr))}
  .cols-3{grid-template-columns:repeat(3,minmax(0,1fr))}
  .cols-2{grid-template-columns:repeat(2,minmax(0,1fr))}
  .card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:20px;box-shadow:var(--shadow)}
  .card h2{margin:0 0 12px;font-size:14px;letter-spacing:.2px}
  .card .hint{font-size:12px;color:var(--muted);margin-bottom:14px}
  .stat .num{font-size:28px;font-weight:650;letter-spacing:-.5px;font-variant-numeric:tabular-nums}
  .stat .lbl{font-size:12px;color:var(--muted);margin-top:2px}
  .stat .badge{margin-top:10px}
  .badge{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:999px;font-size:11.5px;
    background:#ecf4f8;color:var(--ink-2)}
  .badge.teal{background:var(--teal-soft);color:var(--teal)}
  .badge.amber{background:var(--amber-soft);color:var(--amber)}
  .badge.rose{background:var(--rose-soft);color:var(--rose)}
  .kv{display:grid;grid-template-columns:96px 1fr;gap:10px 14px;font-size:13px}
  .kv dt{color:var(--muted)}
  .kv dd{margin:0;color:var(--ink)}
  .meter{height:6px;border-radius:999px;background:#eef2ec;overflow:hidden;margin-top:6px}
  .meter i{display:block;height:100%;width:0;background:#4aa96c;transition:width .3s}
  .avatar{width:56px;height:56px;border-radius:18px;display:grid;place-items:center;font-size:22px;font-weight:700;
    color:#fff;background:linear-gradient(135deg,#159bc0,#0a5f80);box-shadow:inset 0 0 0 1px rgba(255,255,255,.2)}
  .idhead{display:flex;align-items:center;gap:14px}
  .idhead .name{font-size:18px;font-weight:650}
  .idhead .meta{font-size:12px;color:var(--muted);margin-top:2px}
  label.field{display:block;margin-bottom:14px}
  label.field b{display:block;font-size:12.5px;font-weight:600;margin-bottom:6px;color:var(--ink-2)}
  input[type=text],input[type=search],select,textarea{width:100%;padding:10px 12px;border:1px solid var(--line);
    border-radius:10px;background:#fbfcfa;font:inherit;color:var(--ink);outline:none}
  input:focus,select:focus,textarea:focus{border-color:#93c6d6;box-shadow:0 0 0 3px rgba(14,116,144,.08)}
  textarea{min-height:110px;resize:vertical}
  .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  .list{display:flex;flex-direction:column;gap:10px}
  .item{border:1px solid var(--line);border-radius:12px;padding:13px 14px;background:#fcfdfe}
  .item .title{font-weight:600;font-size:13.5px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .item .body{font-size:12.8px;color:var(--ink-2);margin-top:6px;white-space:pre-wrap}
  .item .foot{font-size:11.5px;color:var(--muted);margin-top:8px;display:flex;gap:10px;flex-wrap:wrap}
  .stage{border-left:3px solid var(--teal-soft);padding:2px 0 2px 12px;margin:10px 0}
  .stage b{font-size:12.5px}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.8px;color:var(--ink-2)}
  .empty{padding:36px;text-align:center;color:var(--muted);font-size:13px}
  table{width:100%;border-collapse:collapse;font-size:12.5px}
  th,td{text-align:left;padding:9px 8px;border-bottom:1px solid var(--line);vertical-align:top}
  th{color:var(--muted);font-weight:600;font-size:11.5px}
  .toast{position:fixed;right:22px;bottom:22px;display:flex;flex-direction:column;gap:8px;z-index:20}
  .toast div{background:var(--ink);color:#fff;padding:10px 14px;border-radius:10px;font-size:12.5px;box-shadow:var(--shadow);max-width:420px}
  .toast div.err{background:var(--rose)}
  .pane{display:none}
  .pane.on{display:block;animation:fade .18s ease}
  @keyframes fade{from{opacity:.4;transform:translateY(3px)}to{opacity:1;transform:none}}
  .drop{border:1px dashed #a9c6d4;border-radius:14px;padding:26px;text-align:center;color:var(--muted);background:#fbfdfe}
  .drop.drag{border-color:var(--teal);background:var(--teal-soft)}
  .seg{display:inline-flex;background:#eaf3f7;border-radius:9px;padding:3px}
  .seg button{all:unset;padding:6px 12px;border-radius:7px;font-size:12px;cursor:pointer;color:var(--ink-2)}
  .seg button.on{background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.08);font-weight:600}
  .banner{padding:12px 14px;border-radius:12px;background:var(--amber-soft);color:#6b4a0e;font-size:12.5px;margin-bottom:16px}
  @media (max-width:900px){
    .shell{grid-template-columns:1fr}
    aside{position:static;height:auto;flex-direction:row;align-items:center;gap:10px;padding:14px;overflow:auto}
    .side-note{display:none}
    nav{flex-direction:row}
    main{padding:20px}
    .cols-4,.cols-3,.cols-2{grid-template-columns:1fr}
  }
</style>
</head>
<body data-csrf="${escapeHtml(csrfToken)}">
<div class="shell">
  <aside>
    <div class="brand">
      <div class="dot">鱼</div>
      <div><b>${escapeHtml(presetName)}</b><span>认知内核 · 管理界面</span></div>
    </div>
    <nav id="nav">
      <button data-pane="overview" class="on"><svg viewBox="0 0 24 24"><path d="M4 13h6V4H4v9Zm10 7h6v-9h-6v9ZM4 20h6v-4H4v4Zm10-11h6V4h-6v5Z"/></svg>概览</button>
      <button data-pane="identity"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.2"/><path d="M5.5 20c.6-3.2 3.2-5 6.5-5s5.9 1.8 6.5 5"/></svg>身份</button>
      <button data-pane="memories"><svg viewBox="0 0 24 24"><path d="M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2V4Z"/><path d="M8 8h7M8 12h7M8 16h4"/></svg>记忆</button>
      <button data-pane="activity"><svg viewBox="0 0 24 24"><path d="M4 18V6m0 8h5l3-7 3 11h5"/></svg>活动与循环</button>
      <button data-pane="data"><svg viewBox="0 0 24 24"><ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/></svg>数据</button>
    </nav>
    <div class="side-note">她不是系统设置。这里的每一种改动，都会成为她下一次醒来时的一部分。</div>
  </aside>
  <main>
    <header class="top">
      <div>
        <h1 id="title">概览</h1>
        <div class="sub" id="subtitle">认知内核运行状态</div>
      </div>
      <div class="actions">
        <button class="btn ghost" id="back" title="关闭管理页并回到客户端">返回</button>
        <button class="btn ghost" id="refresh">刷新</button>
      </div>
    </header>

    <section class="pane on" id="pane-overview">
      <div class="grid cols-4" style="margin-bottom:16px">
        <div class="card stat"><div class="num" id="s-mem">–</div><div class="lbl">记忆</div></div>
        <div class="card stat"><div class="num" id="s-diary">–</div><div class="lbl">日记</div></div>
        <div class="card stat"><div class="num" id="s-arch">–</div><div class="lbl">已归档</div></div>
        <div class="card stat"><div class="num" id="s-habits">–</div><div class="lbl">习惯（活跃）</div></div>
      </div>
      <div class="grid cols-2">
        <div class="card">
          <h2>她是谁</h2>
          <div class="idhead">
            <div class="avatar" id="ov-avatar">鱼</div>
            <div><div class="name" id="ov-name">–</div><div class="meta" id="ov-meta">还没有设置身份</div></div>
          </div>
          <div style="margin-top:16px" class="kv">
            <dt>循环</dt><dd id="ov-loop">–</dd>
            <dt>队列</dt><dd id="ov-queue">–</dd>
            <dt>最近事件</dt><dd id="ov-last">–</dd>
          </div>
        </div>
        <div class="card">
          <h2>此刻状态</h2>
          <div class="hint">这些数字是行为状态，不是设置项。</div>
          <div class="kv">
            <dt>精力</dt>
            <dd>
              <span id="ov-energy">–</span><span class="meta" id="ov-tired"></span>
              <div class="meter"><i id="ov-energy-bar"></i></div>
            </dd>
            <dt>情绪</dt><dd><span id="ov-mood">–</span> <span class="meta" id="ov-mood-cause"></span></dd>
            <dt>情绪数值</dt><dd id="ov-mood-values">–</dd>
            <dt>主动性阈值</dt><dd id="ov-threshold">–</dd>
            <dt>冷区习惯</dt><dd id="ov-dormant">–</dd>
          </div>
        </div>
      </div>
    </section>

    <section class="pane" id="pane-identity">
      <div class="grid cols-2">
        <div class="card">
          <h2>她对自己的认识</h2>
          <div class="hint">这里是自我的唯一可编辑来源。聊天时会读它；改动会生成新的修订号。</div>
          <label class="field"><b>名字</b><input id="id-name" type="text" maxlength="40" placeholder="助手" /></label>
          <label class="field"><b>性别</b>
            <select id="id-gender"><option value="">未设置</option><option value="女">女</option><option value="男">男</option><option value="其他">其他</option></select>
          </label>
          <label class="field"><b>自我描述（会进入她的语气与自我认知）</b><textarea id="id-profile" maxlength="500" placeholder="你是「助手」，住在 DeepSeek Harness 里，语气温和、略带好奇。"></textarea></label>
          <div class="row"><button class="btn teal" id="id-save">保存身份</button><span class="badge" id="id-rev">–</span></div>
        </div>
        <div class="card">
          <h2>当前生效</h2>
          <div class="hint">只读预览，来自 self.json。</div>
          <div class="kv">
            <dt>名字</dt><dd id="id-cur-name">–</dd>
            <dt>性别</dt><dd id="id-cur-gender">–</dd>
            <dt>修订</dt><dd id="id-cur-rev">–</dd>
            <dt>更新时间</dt><dd id="id-cur-updated">–</dd>
          </div>
          <div style="margin-top:16px;padding:14px;border-radius:12px;background:#f7faf7;border:1px solid var(--line)">
            <div style="font-size:12px;color:var(--muted);margin-bottom:6px">自我描述</div>
            <div id="id-cur-profile" style="font-size:13px;white-space:pre-wrap">–</div>
          </div>
        </div>
      </div>
      <div class="card" style="margin-top:14px">
        <details id="pref-details">
          <summary style="cursor:pointer;list-style:none;display:flex;align-items:center;justify-content:space-between;gap:10px">
            <span style="font-size:14px;font-weight:600">偏好与倾向 <span class="badge" id="pref-count">–</span></span>
            <span class="meta" id="pref-toggle">点击展开</span>
          </summary>
          <div class="hint" style="margin-top:10px">上面是用户的偏好与约定（含被确认次数、置信度），下面是她当前生效的倾向。默认收起，点标题展开或收起。</div>
          <div style="margin-top:14px">
            <div style="font-size:12px;color:var(--muted);margin-bottom:8px">用户的偏好与约定</div>
            <div class="list" id="pref-list"></div>
          </div>
          <div style="margin-top:18px">
            <div style="font-size:12px;color:var(--muted);margin-bottom:8px">她当前的倾向</div>
            <div class="list" id="tendency-list"></div>
          </div>
        </details>
      </div>
    </section>

    <section class="pane" id="pane-memories">
      <div class="card" id="prop-card" style="display:none">
        <h2>待确认的整理</h2>
        <div class="hint">同主题聚合或近似重复。系统只给建议，不会自动改记忆。</div>
        <div class="list" id="prop-list"></div>
      </div>
      <div class="card">
        <div class="row" style="justify-content:space-between;margin-bottom:14px">
          <div class="row">
            <input id="mem-q" type="search" placeholder="搜索标题、内容或标签…" style="width:280px" />
            <select id="mem-kind" style="width:130px"><option value="">全部类型</option><option>fact</option><option>observation</option><option>action</option><option>inference</option><option>uncertain</option></select>
            <select id="mem-layer" style="width:150px"><option value="">全部层</option><option>episodic</option><option>semantic</option><option>preference</option><option>autobiographical</option></select>
          </div>
          <label class="row" style="font-size:12px;color:var(--muted)"><input id="mem-arch" type="checkbox" /> 含归档</label>
        </div>
        <div class="list" id="mem-list"></div>
      </div>
    </section>

    <section class="pane" id="pane-activity">
      <div class="grid cols-2">
        <div class="card">
          <h2>最近活动</h2>
          <div class="hint">她做过什么。只用于审计，不参与回忆。</div>
          <div class="list" id="act-list"></div>
        </div>
        <div class="card">
          <h2>循环诊断</h2>
          <div class="hint">按事件 id 查看一次循环断在哪一段。</div>
          <div class="row" style="margin-bottom:12px"><input id="tr-event" type="text" placeholder="事件 id（可空 = 最近）" /><button class="btn ghost" id="tr-load">查看</button></div>
          <div id="tr-list"></div>
        </div>
      </div>
    </section>

    <section class="pane" id="pane-data">
      <div class="banner">备份是完整的认知根：身份、记忆、日记、经历、活动与 trace。导入前会先预览并校验；目标非空时默认拒绝。</div>
      <div class="card" style="margin-bottom:14px">
        <h2>心跳定时器</h2>
        <div class="hint">兜底唤醒间隔。她自己设的闹钟优先；这个只是防止她忘记设闹钟时一直睡过去。改完下一轮心跳就按新间隔走，不需要重启。</div>
        <div class="row" style="margin-top:10px;gap:8px;align-items:center">
          <input id="hb-minutes" type="number" min="1" max="1440" step="1" style="width:110px" />
          <span class="hint">分钟</span>
          <button class="btn teal" id="hb-save">保存</button>
          <span id="hb-state" class="hint"></span>
        </div>
      </div>
      <div class="grid cols-2">
        <div class="card">
          <h2>导出</h2>
          <div class="hint">生成 ZIP，包含 manifest 与逐文件 SHA256。</div>
          <label class="row" style="font-size:12.5px;margin-bottom:8px"><input type="checkbox" id="ex-act" /> 包含活动流水（activity）</label>
          <label class="row" style="font-size:12.5px;margin-bottom:14px"><input type="checkbox" id="ex-trace" /> 包含循环 trace</label>
          <button class="btn teal" id="do-export">生成备份</button>
          <div id="ex-result" style="margin-top:14px"></div>
        </div>
        <div class="card">
          <h2>导入</h2>
          <div class="hint">先选择 ZIP 预览，再决定是否写入。</div>
          <div class="drop" id="drop">把备份 ZIP 拖到这里，或点击选择<input type="file" id="file" accept=".zip" hidden /></div>
          <div id="im-report" style="margin-top:14px"></div>
        </div>
      </div>
    </section>
  </main>
</div>
<div class="toast" id="toast"></div>
<script>
const CSRF = document.body.dataset.csrf || '';
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtTime = (v) => { if (!v) return '—'; const d = new Date(typeof v === 'number' ? v : Date.parse(v)); return isNaN(d) ? esc(v) : d.toLocaleString('zh-CN', {hour12:false}); };
const fmtNum = (v) => (v === null || v === undefined) ? '—' : Number(v).toLocaleString('zh-CN');
function toast(text, err) { const div = document.createElement('div'); div.textContent = text; if (err) div.className = 'err'; $('#toast').append(div); setTimeout(() => div.remove(), 4200); }
async function api(path, opts = {}) {
  const headers = { 'x-csrf-token': CSRF, ...(opts.headers || {}) };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}
// 记忆列表最多展示多少条（最新的排在前面）。
const MEMORY_SHOW_LIMIT = 30;
const PANE_TITLE = {overview:['概览','认知内核运行状态'],identity:['身份','她对自己的认识'],memories:['记忆','她记得什么'],activity:['活动与循环','她做过什么，以及一次循环断在哪'],data:['数据','备份与迁移']};
let current = 'overview';
document.querySelectorAll('#nav button').forEach(btn => btn.addEventListener('click', () => switchPane(btn.dataset.pane)));
function goBack() {
  // 作为独立窗口打开时，优先关掉自己；同窗口打开时退回上一页；
  // 直接打开（没有历史）则回到宿主首页。
  if (window.opener && !window.opener.closed) {
    try { window.close(); } catch (_) { /* 宿主可能禁止关闭 */ }
    if (window.closed) return;
  }
  if (window.history.length > 1) { window.history.back(); return; }
  window.location.assign('/');
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') goBack(); });
const backBtn = document.getElementById('back');
if (backBtn) backBtn.addEventListener('click', goBack);
function switchPane(pane) {
  current = pane;
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.pane === pane));
  document.querySelectorAll('.pane').forEach(p => p.classList.toggle('on', p.id === 'pane-' + pane));
  $('#title').textContent = PANE_TITLE[pane][0]; $('#subtitle').textContent = PANE_TITLE[pane][1];
  loadPane(pane);
}
let cache = { status: null, identity: null, memories: [] };
async function loadPane(pane) {
  try {
    if (pane === 'overview') await loadOverview();
    if (pane === 'identity') await loadIdentity();
    if (pane === 'memories') await loadMemories();
    if (pane === 'activity') { await loadActivity(); await loadTrace(); }
    if (pane === 'data') await loadHeartbeat();
  } catch (e) { toast(e.message, true); }
}
async function loadOverview() {
  const data = await api('/cognition/api/overview');
  cache.status = data.status; cache.identity = data.identity;
  const s = data.status || {};
  const c = s.counts || {};
  $('#s-mem').textContent = fmtNum(c.memories); $('#s-diary').textContent = fmtNum(c.diary);
  $('#s-arch').textContent = fmtNum(c.archived); $('#s-habits').textContent = fmtNum(s.habits && s.habits.active);
  const ident = data.identity || {};
  $('#ov-name').textContent = ident.name || '还没有名字';
  $('#ov-meta').textContent = ident.name ? '身份已设置' + (ident.gender ? ' · ' + ident.gender : '') : '她还没有被命名';
  $('#ov-avatar').textContent = (ident.name || '鱼').slice(0, 1);
  $('#ov-loop').textContent = s.loop && s.loop.enabled ? ('运行中 · 待处理 ' + (s.loop.pending ?? 0)) : '未启用';
  $('#ov-queue').textContent = s.queue ? ('排队 ' + s.queue.pending + ' · 已处理 ' + s.queue.processed + ' · 失败 ' + s.queue.failures) : '—';
  $('#ov-last').textContent = fmtTime(s.lastEventAt);
  const a = s.affect || {};
  const energy = Number(a.energy);
  $('#ov-energy').textContent = Number.isFinite(energy) ? Math.round(energy) + ' / 100' : '—';
  const bar = $('#ov-energy-bar');
  if (bar) bar.style.width = (Number.isFinite(energy) ? Math.max(0, Math.min(100, energy)) : 0) + '%';
  const tiredEl = $('#ov-tired');
  if (tiredEl) tiredEl.textContent = Number.isFinite(energy) && energy < 20 ? ' · 有点累' : '';
  $('#ov-mood').textContent = a.label || a.mood || '—';
  const CAUSE_TEXT = { system: '系统/工具', owner: '用户', unknown: '不明' };
  const causeEl = $('#ov-mood-cause');
  if (causeEl) causeEl.textContent = a.cause ? '· 原因：' + (CAUSE_TEXT[a.cause] || a.cause) : '';
  const valuesEl = $('#ov-mood-values');
  if (valuesEl) {
    const v = Number(a.valence);
    const ar = Number(a.arousal);
    valuesEl.textContent = Number.isFinite(v) && Number.isFinite(ar)
      ? '好坏 ' + v.toFixed(2) + ' · 激活 ' + ar.toFixed(2) + (Number(a.version) ? '' : '（旧数据）')
      : '—';
  }
  $('#ov-dormant').textContent = fmtNum(s.habits && s.habits.dormant);
}
let idDirty = false;
async function loadIdentity() {
  const data = await api('/cognition/api/overview');
  const ident = data.identity || {};
  $('#id-cur-name').textContent = ident.name || '—';
  $('#id-cur-gender').textContent = ident.gender || '—';
  $('#id-cur-rev').textContent = ident.revision ?? '—';
  $('#id-cur-updated').textContent = fmtTime(ident.updatedAt);
  $('#id-cur-profile').textContent = ident.profileText || '—';
  $('#id-rev').textContent = 'revision ' + (ident.revision ?? 0);
  $('#id-name').value = ident.name || ''; $('#id-gender').value = ident.gender || ''; $('#id-profile').value = ident.profileText || '';

  paintPreferences(data.preferences);
  paintTendencies(data.tendencies);
}

// 偏好与倾向：默认折叠，展开才看。数据来自 /cognition/api/overview 的 preferences / tendencies。
function esc(text) {
  return String(text ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}
function paintPreferences(pref) {
  const host = $('#pref-list');
  if (!host) return;
  const items = Array.isArray(pref?.items) ? pref.items : [];
  $('#pref-count').textContent = (pref?.total ?? items.length) + ' 条';
  if (items.length === 0) { host.innerHTML = '<div class="meta">还没有记录到偏好或约定。</div>'; return; }
  host.innerHTML = items.map(row => {
    const support = Number(row.support) || 1;
    const conf = Number.isFinite(row.confidence) ? row.confidence.toFixed(2) : '—';
    const tail = support >= 2 ? '确认 ' + support + ' 次 · 置信 ' + conf : '置信 ' + conf;
    return '<div class="item"><div class="item-head"><b>' + esc(row.title) + '</b><span class="meta">' + esc(tail) + '</span></div>'
      + (row.content ? '<div class="item-body">' + esc(row.content) + '</div>' : '') + '</div>';
  }).join('');
}
function paintTendencies(ten) {
  const host = $('#tendency-list');
  if (!host) return;
  const traits = Array.isArray(ten?.traits) ? ten.traits : [];
  const habits = Array.isArray(ten?.speakHabits) ? ten.speakHabits : [];
  const rows = [...traits.map(row => ({ ...row, tag: '倾向' })), ...habits.map(row => ({ ...row, tag: '说话' }))];
  if (rows.length === 0) { host.innerHTML = '<div class="meta">还没有形成稳定的倾向。</div>'; return; }
  host.innerHTML = rows.map(row => {
    const conf = Number.isFinite(row.confidence) ? row.confidence.toFixed(2) : '—';
    const support = Number(row.support) > 0 ? ' · 证据 ' + row.support : '';
    return '<div class="item"><div class="item-head"><b>' + esc(row.label || row.id) + '</b><span class="meta">' + esc(row.tag + ' · 置信 ' + conf + support) + '</span></div>'
      + (row.statement ? '<div class="item-body">' + esc(row.statement) + '</div>' : '') + '</div>';
  }).join('');
}
document.addEventListener('toggle', event => {
  if (event.target?.id !== 'pref-details') return;
  const label = $('#pref-toggle');
  if (label) label.textContent = event.target.open ? '点击收起' : '点击展开';
}, true);
$('#id-save').addEventListener('click', async () => {
  const name = $('#id-name').value.trim();
  if (!name) return toast('名字不能为空', true);
  try {
    await api('/cognition/api/identity', { method: 'POST', body: JSON.stringify({ name, gender: $('#id-gender').value, profileText: $('#id-profile').value.trim() }) });
    toast('身份已保存'); await loadIdentity(); await loadOverview();
  } catch (e) { toast(e.message, true); }
});
let memTimer = null;
['#mem-q','#mem-kind','#mem-layer','#mem-arch'].forEach(sel => $(sel).addEventListener('input', () => { clearTimeout(memTimer); memTimer = setTimeout(loadMemories, 220); }));
// 心跳定时器：读写由 cognition-bus 提供，她设的闹钟优先，这里只是兜底。
async function loadHeartbeat() {
  const input = $('#hb-minutes'), state = $('#hb-state');
  if (!input) return;
  try {
    const hb = await api('/cognition/api/heartbeat');
    if (Number.isFinite(hb.tickMs)) input.value = Math.round(hb.tickMs / 60000);
    if (state) state.textContent = hb.schedulerEnabled ? '' : '（心跳未启用）';
  } catch (e) {
    if (state) state.textContent = '读取失败：' + e.message;
  }
}
const hbSave = $('#hb-save');
if (hbSave) hbSave.addEventListener('click', async () => {
  const state = $('#hb-state');
  try {
    const minutes = Number($('#hb-minutes').value);
    const res = await api('/cognition/api/heartbeat', { method: 'POST', body: JSON.stringify({ minutes }) });
    if (state) state.textContent = '已保存：' + Math.round(res.tickMs / 60000) + ' 分钟';
  } catch (e) {
    if (state) state.textContent = '保存失败：' + e.message;
  }
});

async function loadMemories() {
  const q = $('#mem-q').value.trim().toLowerCase();
  const params = new URLSearchParams({ limit: '200' });
  const kind = $('#mem-kind').value, layer = $('#mem-layer').value;
  if (kind) params.set('kind', kind); if (layer) params.set('layer', layer);
  if ($('#mem-arch').checked) params.set('includeArchived', '1');
  const rows = await api('/cognition/api/memories?' + params.toString());
  try {
    const proposals = await api('/cognition/api/proposals');
    const card = $('#prop-card'), host = $('#prop-list');
    if (proposals.length) {
      card.style.display = '';
      host.innerHTML = proposals.map(p => '<div class="item"><div class="title">' + esc(p.title || '整理建议') + ' <span class="badge amber">' + esc(p.action || 'merge') + '</span></div>' +
        '<div class="body">' + esc(p.reason || p.content || '') + '</div>' +
        '<div class="row" style="margin-top:8px"><button class="btn ghost" data-act="apply" data-id="' + esc(p.id) + '">采纳</button><button class="btn ghost" data-act="dismiss" data-id="' + esc(p.id) + '">忽略</button></div></div>').join('');
    } else {
      card.style.display = 'none';
    }
  } catch (e) { /* 提案不是核心路径，失败不打断记忆列表 */ }
  const filtered = q ? rows.filter(r => (r.title + '\\n' + r.content + '\\n' + (r.tags || []).join(' ')).toLowerCase().includes(q)) : rows;
  const host = $('#mem-list');
  if (!filtered.length) { host.innerHTML = '<div class="empty">没有匹配的记忆。</div>'; return; }
  // 最新的排在最上面；界面只展示最近 N 条，避免列表无限变长。
  const timeOfRow = r => {
    const created = Date.parse(r.createdAt || '');
    if (Number.isFinite(created)) return created;
    const occurred = Number(r.occurredAt);
    return Number.isFinite(occurred) ? occurred : 0;
  };
  const sorted = filtered.slice().sort((a, b) => timeOfRow(b) - timeOfRow(a));
  const shown = sorted.slice(0, MEMORY_SHOW_LIMIT);
  host.innerHTML = shown.map(r => {
    const badges = [kindBadge(r.kind), r.layer ? '<span class="badge">' + esc(r.layer) + '</span>' : '', r.importance ? '<span class="badge amber">重要度 ' + esc(r.importance) + '</span>' : '', r.archivedAt ? '<span class="badge">已归档</span>' : '', r.supersededBy ? '<span class="badge rose">已被更正</span>' : ''].filter(Boolean).join(' ');
    return '<div class="item"><div class="title">' + esc(r.title || '(无标题)') + ' ' + badges + '</div>' +
      (r.content ? '<div class="body">' + esc(String(r.content).slice(0, 320)) + '</div>' : '') +
      '<div class="foot"><span>' + fmtTime(r.createdAt || r.occurredAt) + '</span>' + (r.tags || []).map(t => '<span>#' + esc(t) + '</span>').join('') + (r.source && r.source.channel ? '<span>来源 ' + esc(r.source.channel) + '</span>' : '') + '</div></div>';
  }).join('');
  if (sorted.length > MEMORY_SHOW_LIMIT) {
    host.innerHTML += '<div class="hint">共 ' + fmtNum(sorted.length) + ' 条，仅显示最近 ' + MEMORY_SHOW_LIMIT + ' 条。用上面的筛选或搜索查找更早的记忆。</div>';
  }
}
$('#prop-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  try {
    await api('/cognition/api/proposals/' + btn.dataset.act, { method: 'POST', body: JSON.stringify({ id: btn.dataset.id }) });
    toast(btn.dataset.act === 'apply' ? '已采纳，原条目已标记为被替代' : '已忽略');
    await loadMemories();
  } catch (err) { toast(err.message, true); }
});
function kindBadge(kind) {
  const map = { fact:['teal','事实'], observation:['','观察'], action:['amber','行动'], inference:['','推断'], uncertain:['rose','不确定'] };
  const m = map[kind] || ['','' + esc(kind)];
  return '<span class="badge ' + m[0] + '">' + m[1] + '</span>';
}
async function loadActivity() {
  const rows = await api('/cognition/api/activity?limit=80');
  const host = $('#act-list');
  if (!rows.length) { host.innerHTML = '<div class="empty">还没有活动记录。</div>'; return; }
  host.innerHTML = rows.slice().reverse().map(r => '<div class="item"><div class="title"><span class="mono">' + esc(r.kind || 'event') + '</span>' + (r.type ? ' <span class="badge">' + esc(r.type) + '</span>' : '') + (r.outcome ? ' <span class="badge">' + esc(r.outcome) + '</span>' : '') + '</div>' + (r.title || r.reason ? '<div class="body">' + esc(r.title || r.reason) + '</div>' : '') + '<div class="foot"><span>' + fmtTime(r.at) + '</span>' + (r.eventId ? '<span class="mono">' + esc(r.eventId) + '</span>' : '') + '</div></div>').join('');
}
$('#tr-load').addEventListener('click', loadTrace);
async function loadTrace() {
  const eventId = $('#tr-event').value.trim();
  const rows = await api('/cognition/api/trace?limit=6' + (eventId ? '&eventId=' + encodeURIComponent(eventId) : ''));
  const host = $('#tr-list');
  if (!rows.length) { host.innerHTML = '<div class="empty">没有匹配的循环记录。</div>'; return; }
  host.innerHTML = rows.slice().reverse().map(t => {
    const stages = t.stages || {};
    const parts = Object.entries(stages).map(([name, val]) => '<div class="stage"><b>' + esc(name) + '</b><div class="mono">' + esc(JSON.stringify(val)) + '</div></div>').join('');
    return '<div class="item"><div class="title">' + esc(t.eventId || t.traceId || '循环') + ' <span class="badge">' + esc(t.type || '') + '</span></div><div class="foot"><span>' + fmtTime(t.at) + '</span></div>' + parts + '</div>';
  }).join('');
}
$('#do-export').addEventListener('click', async () => {
  try {
    const data = await api('/cognition/api/export', { method: 'POST', body: JSON.stringify({ includeActivity: $('#ex-act').checked, includeTrace: $('#ex-trace').checked }) });
    $('#ex-result').innerHTML = '<div class="badge teal">' + esc(data.filename) + ' · ' + fmtNum(data.bytes) + ' 字节</div><div class="hint" style="margin-top:8px">记忆 ' + fmtNum(data.manifest.counts.memories) + ' · 日记 ' + fmtNum(data.manifest.counts.diary) + ' · 文件 ' + data.manifest.files.length + '</div>';
    const bin = atob(data.base64); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'application/zip' }); const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = data.filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 3000);
    toast('备份已生成并下载');
  } catch (e) { toast(e.message, true); }
});
let pendingZip = null;
const drop = $('#drop'), fileInput = $('#file');
drop.addEventListener('click', () => fileInput.click());
['dragenter','dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('drag'); }));
['dragleave','drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('drag'); }));
drop.addEventListener('drop', e => { const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) readZip(f); });
fileInput.addEventListener('change', () => { const f = fileInput.files && fileInput.files[0]; if (f) readZip(f); });
async function readZip(file) {
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = ''; const chunk = 0x8000; for (let i = 0; i < buf.length; i += chunk) bin += String.fromCharCode.apply(null, buf.subarray(i, i + chunk));
    pendingZip = btoa(bin);
    const report = await api('/cognition/api/import/preview', { method: 'POST', body: JSON.stringify({ base64: pendingZip }) });
    renderImportReport(report);
  } catch (e) { toast(e.message, true); }
}
function renderImportReport(r) {
  const host = $('#im-report');
  if (!r || r.ok === false) { host.innerHTML = '<div class="banner" style="background:var(--rose-soft);color:var(--rose)">无法导入：' + esc((r && r.problems || []).join('；') || '未知问题') + '</div>'; return; }
  const m = r.manifest || {};
  host.innerHTML = '<div class="card" style="box-shadow:none;background:#fbfcfa"><div class="kv"><dt>备份时间</dt><dd>' + fmtTime(m.createdAt) + '</dd>' +
    '<dt>目标</dt><dd>' + (r.canRestoreEmpty ? '空根（可直接恢复）' : '已有数据（需覆盖）') + '</dd>' +
    '<dt>记忆</dt><dd>' + fmtNum(m.counts && m.counts.memories) + ' · 日记 ' + fmtNum(m.counts && m.counts.diary) + '</dd>' +
    '<dt>冲突</dt><dd>' + fmtNum(r.conflictCount) + '</dd></div>' +
    '<div class="row" style="margin-top:14px"><button class="btn danger" id="do-import">确认导入</button><span class="hint">写入前会自动把当前根备份到旁边。</span></div></div>';
  $('#do-import').addEventListener('click', async () => {
    if (!confirm('确认把这份备份写入当前状态根？')) return;
    try {
      const mode = r.canRestoreEmpty ? 'empty-only' : 'overwrite';
      await api('/cognition/api/import', { method: 'POST', body: JSON.stringify({ base64: pendingZip, mode }) });
      toast('导入完成'); await loadOverview();
    } catch (e) { toast(e.message, true); }
  });
}
$('#refresh').addEventListener('click', () => loadPane(current));
loadOverview();
</script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
