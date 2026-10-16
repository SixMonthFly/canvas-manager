const L = window.CanvasI18n;
let courses = [];        // [{id, code, name}]
let byCourse = {};       // id -> [assignment]
let filesBy = {};        // id -> {files: [], links: []}
let annBy = {};          // id -> [announcement]
let selectedCourse = 'all';
let activeSection = 'home'; // home(全部课程看板) | overview(课程看板总览) | assignments | announcements | files
const BOARDS = ['assignments', 'announcements', 'files'];
let expandedAnn = null;  // 当前展开的公告 id
let localFiles = {};     // "课程代码/文件名" -> 是否已下载到本地
let activeFilter = 'pending';
let currentDetail = null; // {cid, a}
let downloading = {};    // file id -> 'ing' | 'done'

const $ = (sel) => document.querySelector(sel);

// ---------- 工具 ----------

function codeOf(id) {
  const c = courses.find(c => c.id === id);
  return c ? c.code.split(' ')[0] : L.html`课程${id}`;
}

function navLabelOf(course) {
  if (!course) return L.t('当前课程');
  const code = codeOf(course.id);
  return courses.filter(c => codeOf(c.id) === code).length > 1 ? course.code : code;
}

// 课程色:按课程在列表里的顺序分配 8 种色之一,侧边栏圆点、月历色块、首页倒计时统一用它
const COURSE_COLORS = 8;
function colorOf(cid) {
  const i = courses.findIndex(c => c.id === cid);
  return `cc${(i < 0 ? 0 : i) % COURSE_COLORS}`;
}

function parseTime(iso) {
  return iso ? new Date(iso) : null;
}

function fmtDue(iso) {
  const d = parseTime(iso);
  if (!d) return L.t('无截止');
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtCountdown(due) {
  const ms = due - new Date();
  if (ms <= 0) return L.t('已到截止');
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  if (days >= 1) return L.html`剩 ${days} 天 ${hours} 时`;
  if (hours >= 1) return L.html`剩 ${hours} 时 ${mins} 分`;
  return L.html`${mins} 分钟后截止`;
}

function fmtSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function esc(s) {
  const d = document.createElement('span');
  d.textContent = s ?? '';
  return d.innerHTML;
}

// 更新说明等通用文本按 markdown 渲染,失败时退回纯文本
function renderMarkdown(md) {
  if (md && window.marked) {
    try {
      return safeHtml(window.marked.parse(md));
    } catch (e) { /* fallthrough */ }
  }
  return esc(md || '');
}

function safeHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/ on\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/ on\w+\s*=\s*'[^']*'/gi, '')
    .replace(/javascript:/gi, '#');
}

function html2text(html) {
  const div = document.createElement('div');
  div.innerHTML = safeHtml(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ');
  return div.textContent.replace(/\n{3,}/g, '\n\n').trim();
}

// Canvas 域内的图片(插图/公式图)需要登录态,改写到主进程的 canvas-res:// 代理加载
let CANVAS_ORIGIN = '';
let schoolConfig;
let themeStorageKey = 'canvas-theme';

function rewriteCanvasAssets(html) {
  const cvt = (u) => {
    const target = u.trim();
    let abs;
    try {
      const url = new URL(target, CANVAS_ORIGIN);
      if (!target || url.origin !== CANVAS_ORIGIN || url.username || url.password) return null;
      abs = url.href;
    } catch { return null; }
    return `canvas-res://f/${encodeURIComponent(abs)}`;
  };
  return html
    // src / 懒加载的 data-src 统一改写成 src
    .replace(/\b(src|data-src)\s*=\s*"([^"]+)"/gi, (m, _attr, u) => {
      const t = cvt(u);
      return t ? `src="${t}"` : m;
    })
    .replace(/\bsrcset\s*=\s*"([^"]+)"/gi, (m, list) => {
      const parts = list.split(',').map((p) => {
        const seg = p.trim().split(/\s+/);
        const t = cvt(seg[0]);
        return t ? [t, ...seg.slice(1)].join(' ') : p.trim();
      });
      return `srcset="${parts.join(', ')}"`;
    });
}

function statusOf(a) {
  const s = a.sub;
  if (s && s.state === 'graded') return 'graded';
  if (s && (s.state === 'submitted' || s.submitted_at)) return 'submitted';
  return 'pending';
}

function classify(a) {
  if (statusOf(a) !== 'pending') return 'done';
  const due = parseTime(a.due_at);
  if (!due) return 'pending';
  return due < new Date() ? 'overdue' : 'pending';
}

const BADGE = {
  pending: ['pending', L.t('未提交')],
  overdue: ['overdue', L.t('过期未交')],
  submitted: ['submitted', L.t('已提交')],
  graded: ['graded', L.t('已评分')],
};

function toast(msg, duration = 4000) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.add('hidden'), duration);
}

let lastSyncProgressSequence = 0;
let lastSyncProgressPercent = 0;
let syncProgressHideTimer = null;

function renderSyncProgress(p) {
  if (!p || p.sequence <= lastSyncProgressSequence) return;
  if (p.runId !== renderSyncProgress.runId) lastSyncProgressPercent = 0;
  renderSyncProgress.runId = p.runId;
  lastSyncProgressSequence = p.sequence;
  clearTimeout(syncProgressHideTimer);

  const box = $('#sync-progress');
  const title = $('#sync-progress-title');
  const count = $('#sync-progress-count');
  const detail = $('#sync-progress-detail');
  const track = $('#sync-progress-track');
  const fill = $('#sync-progress-fill');
  const completed = Number(p.completed) || 0;
  const total = Number(p.total) || 0;
  const active = Array.isArray(p.active) ? p.active : [];
  const terminal = p.phase === 'done' || p.phase === 'error';

  box.classList.remove('hidden');
  $('#refresh-btn').disabled = !terminal;
  $('#refresh-btn .sync-label').textContent = terminal ? L.t('同步') : L.t('同步中…');
  count.textContent = total ? L.html`${completed}/${total} 门课程` : '';
  if (p.phase === 'connecting') {
    title.textContent = L.t('正在连接 Canvas…');
    detail.textContent = L.t('检查学校登录状态');
  } else if (p.phase === 'login') {
    title.textContent = L.t('等待学校登录');
    detail.textContent = L.t('请在弹出的窗口完成登录');
  } else if (p.phase === 'loading') {
    title.textContent = L.t('正在读取课程列表…');
    detail.textContent = L.t('登录完成，正在获取课程');
  } else if (p.phase === 'courses') {
    title.textContent = active.length
      ? L.html`正在同步 ${active.slice(0, 2).join('、')}${active.length > 2 ? L.html` 等 ${active.length} 门课程` : ''}`
      : completed === total ? L.t('课程数据已获取') : L.t('正在安排课程同步…');
    detail.textContent = L.t('作业、课件和公告将一起更新');
  } else if (p.phase === 'saving') {
    title.textContent = L.t('正在保存课程数据…');
    detail.textContent = L.t('课程内容已获取，即将完成');
  } else if (p.phase === 'done') {
    title.textContent = L.t('课程同步完成');
    detail.textContent = L.t('课程数据已更新');
  } else if (p.phase === 'error') {
    title.textContent = L.t('课程同步失败');
    detail.textContent = p.detail || L.t('请稍后重试');
  } else return;

  const percent = p.phase === 'done' ? 100
    : p.phase === 'saving' ? 95
    : p.phase === 'courses' && total ? Math.round(completed / total * 90)
    : p.phase === 'error' ? lastSyncProgressPercent : null;
  fill.classList.toggle('indeterminate', percent === null);
  if (percent === null) {
    track.removeAttribute('aria-valuenow');
    fill.style.width = '';
  } else {
    lastSyncProgressPercent = percent;
    fill.style.width = `${percent}%`;
    track.setAttribute('aria-valuenow', String(percent));
  }
  track.setAttribute('aria-valuetext', `${title.textContent}，${count.textContent}`);
  if (terminal) syncProgressHideTimer = setTimeout(() => box.classList.add('hidden'), p.phase === 'done' ? 4000 : 8000);
}

// ---------- 导航 ----------

function pendingOf(courseKey) {
  const list = courseKey === 'all'
    ? Object.values(byCourse).flat()
    : (byCourse[courseKey] || []);
  return list.filter(a => a.published && classify(a) === 'pending').length;
}

function renderNav() {
  const nav = $('#nav-items');
  const signature = JSON.stringify(courses.map(c => [c.id, c.code, c.name]));
  const entries = [['all', L.t('全部课程')], ...courses.map(c => [c.id, navLabelOf(c)])];
  if (nav.dataset.signature !== signature) {
    nav.replaceChildren();
    nav.dataset.signature = signature;
    const mk = (key, label) => {
      const div = document.createElement('div');
      div.className = 'nav-item';
      div.dataset.course = key;
      div.tabIndex = 0;
      div.setAttribute('role', 'button');
      div.innerHTML = `<span class="nav-label-text">${key === 'all' ? '' : `<i class="cdot ${colorOf(key)}" aria-hidden="true"></i>`}${esc(label)}</span><span class="count"></span>`;
      const activate = () => {
        if (selectedCourse === key) return;
        closeDetail({ immediate: true, restoreFocus: false });
        selectedCourse = key;
        render();
      };
      div.onclick = activate;
      div.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } };
      nav.appendChild(div);
    };
    for (const [key, label] of entries) mk(key, label);
  }
  entries.forEach(([key, label], index) => {
    const div = nav.children[index];
    const n = pendingOf(key);
    div.classList.toggle('active', selectedCourse === key);
    div.setAttribute('aria-pressed', String(selectedCourse === key));
    const count = div.querySelector('.count');
    count.textContent = n;
    count.classList.toggle('zero', n === 0);
    div.title = key === 'all' ? L.t('全部课程 · 数字为未到期和无截止日期的待办数') :
      L.html`${courses.find(c => c.id === key)?.name || label} · ${n} 项待办`;
  });
}

// ---------- 作业列表 ----------

function visibleAssignments() {
  let items = [];
  if (selectedCourse === 'all') {
    for (const [cid, list] of Object.entries(byCourse)) {
      for (const a of list) items.push({ cid: +cid, a });
    }
  } else {
    (byCourse[selectedCourse] || []).forEach(a => items.push({ cid: selectedCourse, a }));
  }
  items = items.filter(({ a }) => a.published);
  if (activeFilter !== 'all') items = items.filter(({ a }) => classify(a) === activeFilter);
  items.sort((x, y) => (x.a.due_at || '9999') < (y.a.due_at || '9999') ? -1 : 1);
  return items;
}

function renderList() {
  const box = $('#assignment-list');
  const items = visibleAssignments();
  box.innerHTML = '';
  if (!items.length) {
    const labels = { pending: L.t('暂无待办作业'), overdue: L.t('没有过期未交的作业'), done: L.t('暂无已完成作业'), all: L.t('暂无作业数据') };
    box.innerHTML = L.html`<div class="empty"><strong>${labels[activeFilter]}</strong><p>当前范围：${esc(selectedCourse === 'all' ? L.t('全部课程') : navLabelOf(courses.find(c => c.id === selectedCourse)))}</p>` +
      (activeFilter !== 'all' ? L.t('<button class="empty-show-all">查看全部作业</button>') : L.t('<p>可点击「同步」更新 Canvas 数据。</p>')) + '</div>';
    box.querySelector('.empty-show-all')?.addEventListener('click', () => $('#sub-filters [data-filter="all"]').click());
    return;
  }
  const showCourse = selectedCourse === 'all';
  for (const { cid, a } of items) {
    const cls = classify(a);
    const [bc, bt] = BADGE[statusOf(a) === 'pending' && cls === 'overdue' ? 'overdue' : statusOf(a)];
    const due = parseTime(a.due_at);
    let dueHtml = esc(fmtDue(a.due_at));
    if (cls === 'pending' && due) dueHtml += `<span class="cd" style="color:var(--warn)">${esc(fmtCountdown(due))}</span>`;
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.assignment = `${cid}:${a.id}`;
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', `${a.name}, ${fmtDue(a.due_at)}, ${bt}`);
    row.title = `${a.name} · ${codeOf(cid)} · ${fmtDue(a.due_at)}`;
    row.innerHTML =
      `<span class="due">${dueHtml}</span>` +
      `<span class="badge ${bc}">${bt}</span>` +
      `<span class="name">${showCourse ? `<span class="course-tag">${esc(codeOf(cid))}</span>` : ''}${esc(a.name)}</span>` +
      `<span class="points">${a.points != null ? a.points + (L.language === 'en' ? ' pts' : '分') : ''}</span>`;
    const activate = () => openDetail(cid, a);
    row.onclick = activate;
    row.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } };
    box.appendChild(row);
  }
  updateAssignmentSelection();
}

function updateAssignmentSelection() {
  const key = currentDetail ? `${currentDetail.cid}:${currentDetail.a.id}` : null;
  document.querySelectorAll('#assignment-list .row').forEach(row => {
    const selected = row.dataset.assignment === key;
    row.classList.toggle('selected', selected);
    row.setAttribute('aria-expanded', String(selected));
    row.setAttribute('aria-controls', 'detail-panel');
  });
}

// ---------- 作业详情面板 ----------

let detailMotion = null;
let detailMotionVersion = 0;
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function openDetail(cid, a) {
  if (currentDetail?.cid === cid && currentDetail.a.id === a.id) return;
  currentDetail = { cid, a };
  $('#detail-title').textContent = a.name;
  const s = a.sub;
  let statusText = { pending: L.t('未提交'), submitted: L.t('已提交'), graded: L.t('已评分') }[statusOf(a)];
  if (statusOf(a) === 'graded' && s) statusText += ` ${s.score}/${a.points ?? '?'}`;
  const due = parseTime(a.due_at);
  $('#detail-meta').textContent = L.html`${codeOf(cid)} · 截止 ${fmtDue(a.due_at)}` +
    (due && due > new Date() && statusOf(a) === 'pending' ? `(${fmtCountdown(due)})` : '') + ` · ${statusText}`;
  const atts = a.attachments || [];
  const attHtml = atts.length
    ? L.t('<div class="att-block"><div class="att-title">📎 作业附件</div>') +
      atts.map((x, i) =>
        `<div class="att-row"><span class="fname">${esc(x.filename)}</span>` +
        L.html`<span class="meta">${fmtSize(x.size)}</span><button data-att="${i}">⬇ 下载</button></div>`).join('') +
      '</div>'
    : '';
  $('#detail-desc').innerHTML = attHtml +
    (a.description
      ? `<div class="paper">${rewriteCanvasAssets(safeHtml(a.description))}</div>`
      : L.t('<i class="note-muted">(这项作业没有填写说明)</i>'));
  notifyPluginHooks(pluginDetailHooks, currentDetail);
  const panel = $('#detail-panel');
  const opening = panel.classList.contains('hidden') || panel.dataset.state === 'closing';
  ++detailMotionVersion;
  detailMotion?.cancel();
  panel.inert = false;
  panel.dataset.state = 'open';
  panel.classList.remove('hidden');
  $('#detail-desc').scrollTop = 0;
  if (opening && !reducedMotion()) {
    detailMotion = panel.animate([
      { opacity: .5, transform: 'translateX(18px)' },
      { opacity: 1, transform: 'translateX(0)' },
    ], { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
  // 响应式下详情面板是覆盖层,点遮罩可关闭
  panel.onclick = (e) => { if (e.target === panel) closeDetail(); };
  updateAssignmentSelection();
}

function closeDetail({ immediate = false, restoreFocus = true } = {}) {
  const key = currentDetail ? `${currentDetail.cid}:${currentDetail.a.id}` : null;
  currentDetail = null;
  notifyPluginHooks(pluginDetailHooks, null);
  const panel = $('#detail-panel');
  const hadFocus = panel.contains(document.activeElement);
  const version = ++detailMotionVersion;
  detailMotion?.cancel();
  panel.inert = true;
  panel.dataset.state = 'closing';
  panel.onclick = null;
  updateAssignmentSelection();
  const finish = () => {
    if (version !== detailMotionVersion) return;
    panel.classList.add('hidden');
    panel.dataset.state = 'closed';
  };
  if (restoreFocus && hadFocus && key) {
    [...document.querySelectorAll('#assignment-list .row')]
      .find(row => row.dataset.assignment === key)?.focus({ preventScroll: true });
  }
  if (immediate || panel.classList.contains('hidden') || reducedMotion()) {
    finish();
  } else {
    detailMotion = panel.animate([
      { opacity: 1, transform: 'translateX(0)' },
      { opacity: 0, transform: 'translateX(12px)' },
    ], { duration: 120, easing: 'ease-in', fill: 'forwards' });
    detailMotion.finished.then(finish, () => {});
  }
}

// 作业附件下载:成功落到 data/files/课程代码/,失败则退回浏览器打开 Canvas 直链
async function downloadAttachment(btn, att) {
  if (!att || !currentDetail) return;
  const { cid } = currentDetail;
  btn.disabled = true;
  btn.textContent = L.t('下载中…');
  try {
    await window.api.downloadFile({ courseId: cid, fileId: att.id, courseCode: codeOf(cid), filename: att.filename });
    btn.textContent = L.t('✓ 已下载');
    toast(L.html`已下载:${att.filename}`);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = L.t('⬇ 下载');
    toast(L.html`下载受限,尝试在浏览器打开:${e.message}`);
    if (att.url) window.api.openUrl(att.url);
  }
}

// ---------- 全部课程看板 ----------
// 只做两件事:提示下一项截止;把未来 30 天的截止铺成按周对齐的月历,作业按课程着色

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function bigCountdown(due) {
  const ms = due - new Date();
  const pad = n => String(n).padStart(2, '0');
  if (ms <= 0) return L.t('已到点');
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  if (days >= 1) return L.html`${days} 天 ${pad(hours)} 时`;
  if (hours >= 1) return `${pad(hours)}:${pad(mins)}`;
  return L.html`${mins} 分钟`;
}

function greeting(d = new Date()) {
  const h = d.getHours();
  if (h < 5) return L.t('夜深了');
  if (h < 11) return L.t('早上好');
  if (h < 13) return L.t('中午好');
  if (h < 18) return L.t('下午好');
  return L.t('晚上好');
}

// 带单位的倒计时,避免 "19:59" 被误读成钟点
function longCountdown(due) {
  const ms = due - new Date();
  if (ms <= 0) return L.t('已到点');
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  if (days >= 1) return L.html`${days} 天 ${hours} 小时`;
  if (hours >= 1) return L.html`${hours} 小时 ${mins} 分`;
  return L.html`${mins} 分钟`;
}

const CAL_DAYS = 30;

function renderHome() {
  const box = $('#home-view');
  const now = new Date();
  const today = startOfDay(now);
  const pad = n => String(n).padStart(2, '0');
  const md = d => `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const dayMs = 86400000;
  const dayIndex = d => Math.round((startOfDay(d) - today) / dayMs);

  // 下一项:未提交且截止在未来的最早一项
  const upcoming = [];
  for (const [cidStr, list] of Object.entries(byCourse)) {
    for (const a of list) {
      if (!a.published || classify(a) !== 'pending') continue;
      const d = parseTime(a.due_at);
      if (d && d > now) upcoming.push({ cid: +cidStr, a });
    }
  }
  upcoming.sort((x, y) => (x.a.due_at < y.a.due_at ? -1 : 1));
  const next = upcoming[0];

  const hero = next
    ? L.html`<div class="hn" data-cid="${next.cid}" data-aid="${next.a.id}">
        <div class="hn-label">下一项截止</div>
        <div class="hn-count">${esc(bigCountdown(parseTime(next.a.due_at)))}</div>
        <div class="hn-count-long only-claude">还有 <b>${esc(longCountdown(parseTime(next.a.due_at)))}</b></div>
        <div class="hn-title">${esc(next.a.name)}<span class="hn-course ${colorOf(next.cid)}">${esc(codeOf(next.cid))}</span>` +
        L.html`<span class="hn-due">${esc(fmtDue(next.a.due_at))} 截止</span></div>
      </div>`
    : L.html`<div class="hn hn-clear">
        <div class="hn-label">下一项截止</div>
        <div class="hn-count">${courses.length ? L.t('暂无截止安排') : L.t('尚未同步课程')}</div>
        <div class="hn-title">${courses.length ? L.t('未来没有待交的作业。没有截止日期或已过期的作业，在对应课程的「作业」看板里查看。') : L.t('点「同步」，登录 Canvas 后这里会显示课程与作业。')}</div>
      </div>`;

  // 月历:从本周一开始按周对齐,行数刚好盖住今天起的 30 天
  const lead = (today.getDay() + 6) % 7;               // 今天是本周第几天(周一 = 0)
  const rows = Math.ceil((lead + CAL_DAYS) / 7);
  const start = new Date(today);
  start.setDate(start.getDate() - lead);
  const end = new Date(today);
  end.setDate(end.getDate() + CAL_DAYS - 1);

  const cells = Array.from({ length: rows * 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return { date: d, offset: i - lead, items: [] };
  });
  let inRange = 0;
  for (const [cidStr, list] of Object.entries(byCourse)) {
    for (const a of list) {
      if (!a.published) continue;
      const d = parseTime(a.due_at);
      if (!d) continue;
      const off = dayIndex(d);
      if (off < -lead || off >= CAL_DAYS) continue;
      cells[off + lead].items.push({ cid: +cidStr, a, d });
      if (off >= 0) inRange++;
    }
  }

  const MAX_ITEMS = rows > 5 ? 2 : 3;
  const weekday = [L.t('一'), L.t('二'), L.t('三'), L.t('四'), L.t('五'), L.t('六'), L.t('日')];
  const grid = cells.map(({ date, offset, items }, i) => {
    items.sort((x, y) => x.d - y.d);
    const cls = ['cal-day'];
    if (offset < 0) cls.push('past');
    if (offset === 0) cls.push('today');
    if (offset >= CAL_DAYS) cls.push('out');
    if (i % 7 >= 5) cls.push('weekend');
    const monthStart = date.getDate() === 1 || i === 0;
    const label = offset === 0 ? L.html`<b>今天</b> ${date.getDate()}`
      : monthStart ? (L.language === 'en' ? date.toLocaleDateString('en', {month:'short',day:'numeric'}) : `${date.getMonth() + 1}月${date.getDate()}日`) : String(date.getDate());
    const shown = items.length > MAX_ITEMS ? items.slice(0, MAX_ITEMS - 1) : items;
    const its = shown.map(({ cid, a, d }) => {
      const st = classify(a);
      const state = st === 'done' ? ' done' : st === 'overdue' ? ' late' : '';
      const tip = L.html`${codeOf(cid)}  ${a.name}\n${md(d)} ${pad(d.getHours())}:${pad(d.getMinutes())} 截止` +
        (st === 'done' ? L.t('(已完成)') : st === 'overdue' ? L.t('(已过期未交)') : '');
      return `<div class="cal-item ${colorOf(cid)}${state}" data-cid="${cid}" data-aid="${a.id}" title="${esc(tip)}">${esc(a.name)}</div>`;
    }).join('');
    const more = items.length > shown.length
      ? L.html`<div class="cal-more" title="${esc(items.slice(shown.length).map(x => `${codeOf(x.cid)}  ${x.a.name}`).join('\n'))}">还有 ${items.length - shown.length} 项</div>` : '';
    return `<div class="${cls.join(' ')}"><div class="cal-date">${label}</div>${its}${more}</div>`;
  }).join('');

  box.innerHTML =
    `<h2 class="hn-greet only-claude">${greeting()}</h2>` +
    hero +
    `<div class="cal">` +
      L.html`<div class="cal-head"><h2 class="cal-title">未来 30 天</h2>` +
      L.html`<span class="cal-range">${md(today)} 至 ${md(end)}</span>` +
      `<span class="sec-count">${inRange ? L.html`${inRange} 项截止` : L.t('没有截止')}</span></div>` +
      `<div class="cal-grid" style="--rows:${rows}">` +
        weekday.map((w, i) => L.html`<div class="cal-wd${i >= 5 ? ' weekend' : ''}">${L.language === 'en' ? '' : '周'}${w}</div>`).join('') +
        grid +
      `</div>` +
    `</div>`;

  box.querySelectorAll('[data-aid]').forEach(el => {
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    const activate = () => {
      const cid = +el.dataset.cid;
      const a = (byCourse[cid] || []).find(x => x.id === +el.dataset.aid);
      if (a) gotoAssignment(cid, a);
    };
    el.onclick = activate;
    el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } };
  });
}

// ---------- 看板舞台(台前调度) ----------
// 切换看板时只改 #stage 的 data-mode 和 .is-focus,节点不重建;
// 位置变化用 FLIP 补一段 200ms 的过渡:先记下旧位置,改布局后从旧位置滑到新位置。
function flipBoards(mutate) {
  const boards = [...document.querySelectorAll('#stage .board')];
  const before = new Map(boards.map(b => [b, b.getBoundingClientRect()]));
  mutate();
  if (reducedMotion()) return;
  for (const b of boards) {
    const from = before.get(b);
    const to = b.getBoundingClientRect();
    if (!from.width || !to.width) continue;
    const dx = from.left - to.left, dy = from.top - to.top;
    const sx = from.width / to.width, sy = from.height / to.height;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < .01 && Math.abs(sy - 1) < .01) continue;
    b.getAnimations().forEach(an => an.cancel());
    b.animate([
      { transformOrigin: '0 0', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
      { transformOrigin: '0 0', transform: 'none' },
    ], { duration: 200, easing: 'cubic-bezier(.2, .8, .2, 1)' });
  }
}

// sec: overview | assignments | announcements | files 或插件注册的看板(全部课程下只有 home)
function selectSection(sec) {
  if (selectedCourse === 'all') sec = 'home';
  else if (sec === 'home') sec = 'overview';
  else if (sec !== 'overview' && !BOARDS.includes(sec)) sec = 'overview';
  if (activeSection === sec) return;
  flipBoards(() => { activeSection = sec; layoutStage(); });
}

// 让某项作业在列表里可见:当前筛选不包含它时切到它所属的筛选
function revealInFilter(a) {
  const cls = classify(a);
  if (activeFilter === 'all' || activeFilter === cls) return;
  activeFilter = cls;
  document.querySelectorAll('.chip').forEach(c => {
    c.classList.toggle('active', c.dataset.filter === cls);
    c.setAttribute('aria-pressed', String(c.dataset.filter === cls));
  });
}

function gotoAssignment(cid, a) {
  if (selectedCourse !== cid) closeDetail({ immediate: true, restoreFocus: false });
  selectedCourse = cid;
  revealInFilter(a);
  if (activeSection === 'assignments') render();
  else { activeSection = 'assignments'; render(); }
  openDetail(cid, a);
  document.querySelector(`#assignment-list .row[data-assignment="${cid}:${a.id}"]`)?.scrollIntoView({ block: 'nearest' });
}


// ---------- 公告视图 ----------

function visibleAnnouncements() {
  const cids = selectedCourse === 'all' ? courses.map(c => c.id) : [selectedCourse];
  const items = [];
  for (const cid of cids) {
    for (const ann of annBy[cid] || []) items.push({ cid, ann });
  }
  items.sort((x, y) => (x.ann.posted_at || '') < (y.ann.posted_at || '') ? 1 : -1);
  return items;
}

function renderAnnouncements() {
  const showCourse = selectedCourse === 'all';
  const items = visibleAnnouncements();
  const list = $('#ann-list');
  list.innerHTML = '';
  if (!items.length) {
    list.innerHTML = selectedCourse === 'all'
      ? L.t('<div class="empty">没有公告数据,点「同步」拉取</div>')
      : L.html`<div class="empty">${esc(codeOf(selectedCourse))} 这门课暂无公告(想看全部请选「全部课程」)</div>`;
    return;
  }
  const now = new Date();
  for (const { cid, ann } of items) {
    const posted = parseTime(ann.posted_at);
    const isNew = posted && (now - posted) < 7 * 86400000;
    const row = document.createElement('div');
    row.className = 'ann-row';
    const pad = n => String(n).padStart(2, '0');
    const dateText = posted
      ? `${posted.getFullYear()}-${pad(posted.getMonth() + 1)}-${pad(posted.getDate())}`
      : L.t('未知时间');
    row.innerHTML =
      `<button class="ann-head" type="button" aria-expanded="false" aria-controls="ann-${cid}-${ann.id}">` +
      `<span class="due">${dateText}</span>` +
      (isNew ? L.t('<span class="badge pending">新</span>') : '') +
      `<span class="name">${showCourse ? `<span class="course-tag">${esc(codeOf(cid))}</span>` : ''}${esc(ann.title)}</span>` +
      `<span class="ann-chevron" aria-hidden="true">›</span></button>`;
    const head = row.querySelector('.ann-head');
    head.setAttribute('aria-label', `${ann.title}, ${dateText}`);
    const content = document.createElement('div');
    content.className = 'ann-content';
    content.id = `ann-${cid}-${ann.id}`;
    const inner = document.createElement('div');
    inner.className = 'ann-content-inner';
    content.appendChild(inner);
    row.appendChild(content);
    const ensureContent = () => {
      if (inner.childElementCount) return;
      const body = document.createElement('div');
      body.className = 'ann-body';
      body.innerHTML = ann.message
        ? `<div class="paper">${rewriteCanvasAssets(safeHtml(ann.message))}</div>`
        : L.t('<i class="note-muted">(公告没有正文)</i>');
      const actions = document.createElement('div');
      actions.className = 'ann-actions';
      const openBtn = document.createElement('button');
      openBtn.textContent = L.t('🌐 原页');
      openBtn.onclick = (e) => { e.stopPropagation(); window.api.openUrl(ann.url); };
      actions.append(openBtn);
      appendPluginAnnouncementActions(actions, { cid, ann, bodyElement: body });
      inner.append(body, actions);
    };
    row.setExpanded = (open) => {
      if (open) ensureContent();
      // 读取初始折叠高度，首次展开也能从 0 平滑过渡。
      if (row.isConnected) content.getBoundingClientRect();
      row.classList.toggle('expanded', open);
      head.setAttribute('aria-expanded', String(open));
      content.setAttribute('aria-hidden', String(!open));
      content.inert = !open;
    };
    head.onclick = () => {
      const open = !row.classList.contains('expanded');
      for (const other of list.querySelectorAll('.ann-row.expanded')) {
        if (other !== row) other.setExpanded(false);
      }
      expandedAnn = open ? ann.id : null;
      row.setExpanded(open);
    };
    row.setExpanded(expandedAnn === ann.id);
    list.appendChild(row);
  }
}

// ---------- 课件视图 ----------

function visibleFiles() {
  const cids = selectedCourse === 'all' ? courses.map(c => c.id) : [selectedCourse];
  const files = [], links = [];
  for (const cid of cids) {
    const d = filesBy[cid];
    if (!d) continue;
    for (const f of d.files || []) files.push({ cid, f });
    for (const l of d.links || []) links.push({ cid, l });
  }
  files.sort((x, y) => (x.f.created_at || '') < (y.f.created_at || '') ? 1 : -1);
  links.sort((a, b) => a.cid - b.cid);
  return { files, links };
}

let localFilesRequest = 0;
let localFilesChecking = false;

async function refreshLocalFiles() {
  const request = ++localFilesRequest;
  const course = selectedCourse;
  const { files } = visibleFiles();
  localFilesChecking = true;
  renderFiles();
  let found = {};
  try {
    if (files.length) found = await window.api.checkDownloaded(
      files.map(({ cid, f }) => ({ courseCode: codeOf(cid), filename: f.filename })));
  } catch (e) { /* 保留已有的下载状态，稍后可重试 */ }
  if (request !== localFilesRequest || course !== selectedCourse) return;
  localFiles = { ...localFiles, ...found };
  localFilesChecking = false;
  renderFiles();
}

function renderFiles() {
  const showCourse = selectedCourse === 'all';
  const { files, links } = visibleFiles();
  const list = $('#files-list');
  const scrollTop = list.scrollTop;
  list.innerHTML = '';
  $('#files-hint').textContent = L.html`${files.length} 个文件 · 保存到 data/files/`;
  if (!files.length && !links.length) {
    list.innerHTML = L.t('<div class="empty">没有课件数据,点「同步」拉取</div>');
    return;
  }
  if (files.length) {
    const h = document.createElement('div');
    h.className = 'file-sec-title';
    h.textContent = L.t('📄 文件(PPT/PDF 等,未下载点行下载,已下载可打开)');
    list.appendChild(h);
  }
  for (const { cid, f } of files) {
    const key = `${codeOf(cid)}/${f.filename}`;
    const has = localFiles[key];
    const checking = localFilesChecking && !(key in localFiles);
    const st = downloading[f.id];
    const row = document.createElement('div');
    row.className = 'file-row';
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', `${f.filename}, ${fmtSize(f.size)}, ${has ? L.t('已下载') : L.t('未下载')}`);
    let actions;
    if (checking) actions = L.t('<button disabled>检查中…</button>');
    else if (st === 'ing') actions = L.t('<button disabled>下载中…</button>');
    else if (has) actions = L.t('<button data-act="open">📂 打开</button><button data-act="reveal">📁 所在文件夹</button>');
    else actions = L.t('<button>⬇ 下载</button>');
    row.innerHTML =
      `<span class="fname">${showCourse ? `<span class="course-tag">${esc(codeOf(cid))}</span>` : ''}${esc(f.filename)}</span>` +
      `<span class="meta">${esc((f.type || '').split('/').pop())}</span>` +
      `<span class="meta">${fmtSize(f.size)}</span>` +
      `<span class="file-actions">${actions}</span>`;
    const activate = () => { if (!checking && !localFiles[key] && downloading[f.id] !== 'ing') downloadOne(cid, f); };
    row.onclick = activate;
    row.onkeydown = (e) => { if (e.target === row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); activate(); } };
    row.querySelectorAll('button').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const arg = { courseCode: codeOf(cid), filename: f.filename };
        if (btn.dataset.act === 'open') {
          try { await window.api.openFile(arg); } catch (err) { toast(L.t('打开失败:') + err.message); }
        } else if (btn.dataset.act === 'reveal') {
          try { await window.api.revealFile(arg); } catch (err) { toast(err.message); }
        } else if (!downloading[f.id]) {
          downloadOne(cid, f);
        }
      };
    });
    list.appendChild(row);
  }
  if (links.length) {
    const h = document.createElement('div');
    h.className = 'file-sec-title';
    h.textContent = L.t('🔗 老师放的外部链接 / 页面(点击打开)');
    list.appendChild(h);
  }
  for (const { cid, l } of links) {
    const row = document.createElement('div');
    row.className = 'file-row link-row';
    row.tabIndex = 0;
    row.setAttribute('role', 'link');
    row.setAttribute('aria-label', l.title || l.url);
    row.innerHTML =
      `<span class="fname">${showCourse ? `<span class="course-tag">${esc(codeOf(cid))}</span>` : ''}${esc(l.title || l.url)}</span>` +
      L.html`<span class="meta">链接</span><span class="meta"></span><button>↗ 打开</button>`;
    const activate = () => window.api.openUrl(l.url);
    row.onclick = activate;
    row.onkeydown = (e) => { if (e.target === row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); activate(); } };
    list.appendChild(row);
  }
  list.scrollTop = scrollTop;
}

async function downloadOne(cid, f) {
  downloading[f.id] = 'ing';
  renderFiles();
  try {
    await window.api.downloadFile({ courseId: cid, fileId: f.id, courseCode: codeOf(cid), filename: f.filename });
    downloading[f.id] = 'done';
    localFiles[`${codeOf(cid)}/${f.filename}`] = true;
    toast(L.html`已下载:${f.filename}`);
  } catch (e) {
    delete downloading[f.id];
    toast(L.html`下载失败:${f.filename} - ${e.message}`);
  }
  renderFiles();
}

async function downloadAll() {
  const btn = $('#download-all-btn');
  const { files } = visibleFiles();
  if (!files.length) { toast(L.t('没有可下载的文件')); return; }
  btn.disabled = true;
  let ok = 0;
  for (let i = 0; i < files.length; i++) {
    btn.textContent = L.html`⬇ 下载中 ${i + 1}/${files.length}`;
    const { cid, f } = files[i];
    if (downloading[f.id] !== 'done') {
      downloading[f.id] = 'ing';
      renderFiles();
      try {
        await window.api.downloadFile({ courseId: cid, fileId: f.id, courseCode: codeOf(cid), filename: f.filename });
        downloading[f.id] = 'done';
        localFiles[`${codeOf(cid)}/${f.filename}`] = true;
        ok++;
      } catch (e) {
        delete downloading[f.id];
        toast(L.html`下载失败:${f.filename} - ${e.message}`);
      }
      renderFiles();
    }
  }
  btn.disabled = false;
  btn.textContent = L.t('⬇ 全部下载');
  toast(L.html`全部下载完成:成功 ${ok}/${files.length}`);
}

// ---------- 设置 ----------

// ---------- 通用插件 UI host ----------
// 插件只注册扩展点；关闭时移除其 UI、订阅和样式，课程数据仍由核心管理。
const pluginRenderHooks = new Set();
const pluginDetailHooks = new Set();
const pluginSettingsHooks = new Set();
const pluginSettingsSaveHooks = new Set();
const pluginAnnouncementActions = new Map();
const themeRegistry = new Map();
const BASE_THEME = Object.freeze({ id: 'base', label: L.t('基础外观'), layout: 'standard', hideEmoji: false });
let committedTheme = 'hkust';
let themeDraft = 'hkust';
let committedTelemetry = true;
let settingsOpen = false;
let settingsSaving = false;
let settingsOpenPromise = Promise.resolve();
const activePlugins = new Map();
const pluginErrors = new Map();
const pluginMutations = new Map();
const pluginOperations = new Set();
let pluginManifests = [];
let pluginTransition = Promise.resolve();
window.pluginRefreshPromise = pluginTransition;

function notifyPluginCallback(callback, ...args) {
  try {
    Promise.resolve(callback(...args)).catch(error => toast(L.t('插件操作失败：') + error.message));
  } catch (error) { toast(L.t('插件操作失败：') + error.message); }
}

function notifyPluginHooks(hooks, ...args) {
  for (const callback of [...hooks]) notifyPluginCallback(callback, ...args);
}

function bindBoardInteraction(board) {
  const title = board.querySelector('.board-title');
  board.onclick = () => {
    if (!board.classList.contains('is-focus')) selectSection(board.dataset.board);
  };
  title.onkeydown = event => {
    const titles = [...document.querySelectorAll('#stage .board-title')];
    const index = titles.indexOf(title);
    let next;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = titles[(index + 1) % titles.length];
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = titles[(index - 1 + titles.length) % titles.length];
    else if (event.key === 'Home') next = titles[0];
    else if (event.key === 'End') next = titles.at(-1);
    if (next) {
      event.preventDefault();
      if (activeSection !== 'overview') selectSection(next.dataset.section);
      next.focus({ preventScroll: true });
    }
  };
}

function appendPluginAnnouncementActions(actions, context) {
  for (const [key, action] of pluginAnnouncementActions) {
    const button = document.createElement('button');
    button.className = action.className || '';
    button.textContent = action.label;
    button.dataset.pluginAction = key;
    button.onclick = event => {
      event.stopPropagation();
      notifyPluginCallback(action.onClick, { ...context, button, event });
    };
    actions.append(button);
  }
}

function createPluginContext(manifest) {
  let alive = true;
  const cleanups = [];
  const track = cleanup => {
    if (typeof cleanup === 'function') cleanups.push(cleanup);
    return cleanup;
  };
  const trackElement = element => { track(() => element.remove()); return element; };
  const subscribe = (hooks, callback) => {
    const guarded = (...args) => { if (alive) return callback(...args); };
    hooks.add(guarded);
    return track(() => hooks.delete(guarded));
  };
  const context = {
    plugin: Object.freeze({ ...manifest }),
    isActive: () => alive,
    api: {
      invoke: (method, ...args) => alive
        ? window.api.pluginInvoke(manifest.id, method, ...args)
        : Promise.reject(new Error(L.t('插件已关闭'))),
      openUrl: url => { if (alive) return window.api.openUrl(url); },
      on: (event, callback) => track(window.api.onPluginEvent(message => {
        if (alive && message.pluginId === manifest.id && message.event === event) {
          notifyPluginCallback(callback, message.data);
        }
      })),
    },
    data: { snapshot: () => ({ courses, byCourse, filesBy, annBy, selectedCourse, activeSection, currentDetail }) },
    utils: { esc, safeHtml, html2text, renderMarkdown, toast, codeOf, parseTime, fmtDue, fmtCountdown, rewriteCanvasAssets },
    lifecycle: {
      onRender: callback => subscribe(pluginRenderHooks, callback),
      onDetail: callback => subscribe(pluginDetailHooks, callback),
      onSettingsOpen: callback => subscribe(pluginSettingsHooks, callback),
      onSettingsSave: callback => subscribe(pluginSettingsSaveHooks, callback),
    },
    ui: {
      trackElement,
      addStylesheet(href) {
        const link = trackElement(document.createElement('link'));
        link.rel = 'stylesheet'; link.href = href; link.dataset.plugin = manifest.id;
        document.head.append(link);
        return link;
      },
      registerTheme({ id, label, layout = 'standard', hideEmoji = false }) {
        if (!/^[a-z][a-z0-9-]*$/.test(id) || id === 'base' || themeRegistry.has(id)) throw new Error(L.t('皮肤标识无效或重复'));
        if (!['standard', 'sidebar'].includes(layout)) throw new Error(L.t('皮肤布局无效'));
        themeRegistry.set(id, { id, label, layout, hideEmoji, pluginId: manifest.id });
        return track(() => themeRegistry.delete(id));
      },
      registerBoard({ id, title, content }) {
        if (!/^[a-z][a-z0-9-]*$/.test(id) || BOARDS.includes(id)) throw new Error(L.t('看板标识无效或重复'));
        const board = document.createElement('section');
        board.className = 'board'; board.dataset.board = id; board.dataset.plugin = manifest.id;
        board.setAttribute('aria-labelledby', `board-title-${id}`);
        board.innerHTML = `<div class="board-head"><button class="board-title" id="board-title-${id}" data-section="${id}"></button><span class="board-meta" id="board-meta-${id}"></span></div><div class="board-frame"><div class="board-surface"></div></div>`;
        board.querySelector('.board-title').textContent = title;
        board.querySelector('.board-surface').append(content);
        $('#stage').append(board); BOARDS.push(id); bindBoardInteraction(board);
        track(() => { board.remove(); BOARDS.splice(BOARDS.indexOf(id), 1); });
        return { element: board, surface: board.querySelector('.board-surface'), meta: board.querySelector('.board-meta') };
      },
      addDetailAction({ id, label, className = '', onClick }) {
        const button = trackElement(document.createElement('button'));
        button.id = id; button.className = className; button.textContent = label; button.dataset.plugin = manifest.id;
        button.onclick = event => notifyPluginCallback(onClick, { detail: currentDetail, event, button });
        $('.detail-actions').append(button);
        return button;
      },
      addDetailPanel({ id, className = '' }) {
        const panel = trackElement(document.createElement('div'));
        panel.id = id; panel.className = className; panel.dataset.plugin = manifest.id;
        $('#detail-panel').append(panel);
        return panel;
      },
      registerAnnouncementAction(action) {
        const key = `${manifest.id}:${action.id}`;
        pluginAnnouncementActions.set(key, action);
        return track(() => pluginAnnouncementActions.delete(key));
      },
      addSettingsSection(title, content) {
        const section = trackElement(document.createElement('section'));
        section.className = 'plugin-settings-section'; section.dataset.plugin = manifest.id;
        const heading = document.createElement('h3'); heading.textContent = title;
        section.append(heading, content); $('#plugin-settings-content').append(section);
        return section;
      },
    },
  };
  return { context, deactivate: () => { alive = false; }, dispose: () => {
    alive = false;
    for (const cleanup of cleanups.reverse()) {
      try { cleanup(); } catch (error) { console.error('Plugin cleanup failed', error); }
    }
  } };
}

function pluginFocusTarget() {
  const active = document.activeElement;
  return active?.closest('#plugins-list') ? { id: active.dataset.pluginId, operation: active.dataset.pluginOperation } : null;
}

function restorePluginFocus(target) {
  if (!target?.id) return;
  const controls = [...document.querySelectorAll('#plugins-list input, #plugins-list button')]
    .filter(control => control.dataset.pluginId === target.id && !control.disabled);
  const preferred = controls.find(control => control.dataset.pluginOperation === target.operation);
  (preferred || controls[0])?.focus({ preventScroll: true });
}

function renderPluginList() {
  const focused = pluginFocusTarget();
  const list = $('#plugins-list'); list.replaceChildren();
  if (!pluginManifests.length) {
    const empty = document.createElement('p'); empty.className = 'hint'; empty.textContent = L.t('暂无可用插件。'); list.append(empty);
  }
  for (const manifest of pluginManifests) {
    const installed = manifest.installed === true;
    const isTheme = manifest.kind === 'theme';
    const mutation = pluginMutations.get(manifest.id);
    const card = document.createElement('div'); card.className = 'plugin-item'; card.dataset.pluginId = manifest.id;
    card.setAttribute('aria-busy', String(!!mutation));
    const heading = document.createElement('div'); heading.className = 'plugin-item-head';
    const copy = document.createElement('span'); copy.className = 'plugin-copy';
    const name = document.createElement('strong'); name.textContent = L.t(manifest.name);
    const description = document.createElement('small'); description.textContent = L.t(manifest.description);
    copy.append(name, description);
    const status = document.createElement('span'); status.className = 'plugin-install-status';
    status.dataset.installed = String(installed); status.textContent = installed ? L.t('已安装') : L.t('未安装');
    heading.append(copy, status);
    const metadata = document.createElement('div'); metadata.className = 'plugin-metadata';
    const source = document.createElement('span'); source.textContent = manifest.source === 'bundled' ? L.t('安装包自带') : L.t('本地插件');
    const version = document.createElement('span'); version.textContent = `v${manifest.version || manifest.bundledVersion || '-'}`;
    const kind = document.createElement('span'); kind.textContent = isTheme ? L.t('皮肤') : L.t('功能');
    metadata.append(source, version, kind);
    const controls = document.createElement('div'); controls.className = 'plugin-controls';
    if (isTheme) {
      const caption = document.createElement('span'); caption.className = 'hint';
      caption.textContent = installed ? L.t('在「常规 → 外观」中选择') : L.t('安装后可选择此外观');
      controls.append(caption);
    } else {
      const label = document.createElement('label'); label.className = 'plugin-toggle';
      const input = document.createElement('input'); input.type = 'checkbox';
      input.dataset.pluginId = manifest.id; input.dataset.pluginOperation = 'enable';
      input.checked = installed && !!manifest.enabled; input.disabled = !installed || !!mutation || settingsSaving;
      input.setAttribute('aria-label', L.html`启用 ${manifest.name}`);
      const caption = document.createElement('span'); caption.textContent = L.t('启用插件');
      label.append(input, caption); controls.append(label);
      input.onchange = () => { void setPluginEnabled(manifest.id, input.checked); };
    }
    const packageAction = document.createElement('button'); packageAction.className = 'plugin-package-action';
    packageAction.dataset.pluginId = manifest.id;
    packageAction.dataset.pluginOperation = installed ? 'uninstall' : 'install';
    if (installed) packageAction.dataset.pluginUninstall = manifest.id;
    else packageAction.dataset.pluginInstall = manifest.id;
    packageAction.disabled = !!mutation || settingsSaving || (!installed && manifest.available === false);
    packageAction.textContent = mutation === 'uninstall' ? L.t('正在卸载…') : mutation === 'install' ? L.t('正在安装…')
      : installed ? L.t('卸载') : L.t('从安装包重新安装');
    packageAction.setAttribute('aria-label', `${installed ? L.t('卸载') : L.t('从安装包重新安装')} ${manifest.name}`);
    packageAction.onclick = () => { void (installed ? uninstallPlugin(manifest.id) : installPlugin(manifest.id)); };
    controls.append(packageAction);
    card.append(heading, metadata, controls);
    const failure = pluginErrors.get(manifest.id) || manifest.error;
    if (failure) {
      const error = document.createElement('small'); error.className = 'plugin-error';
      error.textContent = typeof failure === 'string' ? failure : failure.message || L.t('插件加载失败'); card.append(error);
    }
    list.append(card);
  }
  restorePluginFocus(focused);
}

function pluginRendererIdentity(manifest) {
  return JSON.stringify([manifest.renderer, manifest.generation, manifest.version]);
}

async function reconcilePlugins(list) {
  pluginManifests = list.map(manifest => ({ ...manifest }));
  const enabled = new Map(list.filter(manifest => manifest.installed && manifest.renderer
    && (manifest.kind === 'theme' || manifest.enabled)).map(manifest => [manifest.id, manifest]));
  for (const [id, plugin] of activePlugins) {
    if (enabled.has(id) && plugin.identity === pluginRendererIdentity(enabled.get(id))) continue;
    plugin.scope.deactivate();
    try { await plugin.disposer?.(); } finally { plugin.scope.dispose(); activePlugins.delete(id); }
    if (plugin.kind !== 'theme') activeSection = selectedCourse === 'all' ? 'home' : 'overview';
  }
  for (const manifest of list) {
    if (!enabled.has(manifest.id) || activePlugins.has(manifest.id)) continue;
    const scope = createPluginContext(manifest);
    try {
      if (manifest.apiVersion !== 1) throw new Error(L.t('插件与当前应用版本不兼容'));
      const source = new URL(manifest.renderer, window.location.href);
      if (source.protocol !== 'file:') throw new Error(L.t('只能加载随应用附带的本地插件'));
      if (manifest.generation != null) source.searchParams.set('generation', String(manifest.generation));
      const module = await import(source.href);
      if (typeof module.activate !== 'function') throw new Error(L.t('插件缺少 activate 入口'));
      const disposer = await module.activate(scope.context);
      activePlugins.set(manifest.id, { scope, disposer: typeof disposer === 'function' ? disposer : null,
        identity: pluginRendererIdentity(manifest), kind: manifest.kind || 'feature' });
      pluginErrors.delete(manifest.id);
    } catch (error) {
      scope.dispose(); pluginErrors.set(manifest.id, L.t('加载失败：') + error.message);
      toast(L.html`${manifest.name} 加载失败：${error.message}`);
    }
  }
  for (const manifest of list) {
    if (!manifest.installed || (manifest.kind !== 'theme' && !manifest.enabled)) pluginErrors.delete(manifest.id);
  }
  const previousTheme = committedTheme;
  committedTheme = resolveTheme(committedTheme);
  if (previousTheme !== committedTheme) {
    try { localStorage.setItem(themeStorageKey, committedTheme); } catch (error) { toast(L.t('外观恢复后未能保存：') + error.message); }
  }
  themeDraft = resolveTheme(settingsOpen ? themeDraft : committedTheme);
  applyTheme(themeDraft);
  renderPluginList(); render();
}

function refreshPlugins(list) {
  const next = pluginTransition.catch(() => {}).then(async () => {
    const manifests = list || await window.api.pluginsList();
    await reconcilePlugins(manifests);
  });
  pluginTransition = next;
  window.pluginRefreshPromise = next;
  return next;
}

function runPluginOperation(id, kind, perform) {
  if (pluginMutations.has(id)) return Promise.resolve();
  const focused = pluginFocusTarget();
  pluginMutations.set(id, kind); renderPluginList();
  const operation = (async () => {
    try { await refreshPlugins(await perform()); }
    catch (error) {
      toast(L.t('插件操作失败：') + error.message);
      await refreshPlugins().catch(() => {});
    } finally {
      pluginMutations.delete(id); renderPluginList();
      if (focused?.id === id) restorePluginFocus(focused);
    }
  })();
  pluginOperations.add(operation);
  operation.finally(() => pluginOperations.delete(operation));
  window.pluginRefreshPromise = operation;
  return operation;
}

function setPluginEnabled(id, enabled) {
  return runPluginOperation(id, 'enable', () => window.api.pluginSetEnabled(id, enabled));
}

function installPlugin(id) {
  return runPluginOperation(id, 'install', () => window.api.pluginInstall(id));
}

function uninstallPlugin(id) {
  return runPluginOperation(id, 'uninstall', () => window.api.pluginUninstall(id));
}

window.pluginHost = Object.freeze({
  refresh: refreshPlugins,
  setEnabled: setPluginEnabled,
  install: installPlugin,
  uninstall: uninstallPlugin,
  list: () => pluginManifests.map(manifest => ({ ...manifest })),
  themes: () => [...themeRegistry.values()].map(theme => ({ ...theme })),
  async whenSettled() {
    while (pluginOperations.size) await Promise.allSettled([...pluginOperations]);
    let pending;
    do { pending = pluginTransition; await pending; } while (pending !== pluginTransition);
  },
});

async function openSettings() {
  if (settingsSaving) return;
  if (settingsOpen) return settingsOpenPromise;
  settingsOpen = true;
  settingsOpenPromise = (async () => {
    await window.pluginHost.whenSettled();
    schoolConfig = await window.api.schoolConfig();
    $('#school-select').value = schoolConfig.selected;
    $('#language-select').value = L.language;
    const tel = await window.api.telemetryConfig().catch(() => ({ enabled: true }));
    committedTelemetry = tel.enabled !== false;
    $('#telemetry-toggle').checked = committedTelemetry;
    themeDraft = resolveTheme(committedTheme); applyTheme(themeDraft);
    for (const callback of [...pluginSettingsHooks]) await callback();
    if (!settingsOpen) return;
    const modal = $('#settings-modal');
    modal.classList.remove('hidden');
    modal.querySelector('button, select, input')?.focus();
    modal.onclick = event => { if (event.target === modal) closeSettings(); };
  })().catch(error => { settingsOpen = false; toast(L.t('设置未能打开：') + error.message); });
  return settingsOpenPromise;
}

function closeSettings() {
  if (settingsSaving) return;
  settingsOpen = false;
  themeDraft = resolveTheme(committedTheme); applyTheme(themeDraft);
  $('#telemetry-toggle').checked = committedTelemetry;
  const modal = $('#settings-modal');
  modal.classList.add('hidden'); modal.onclick = null;
  $('#settings-btn').focus({ preventScroll: true });
}

async function saveSettings() {
  if (settingsSaving) return;
  settingsSaving = true;
  const modal = $('#settings-modal');
  const save = $('#settings-save-btn');
  const cancel = $('#settings-close-btn');
  save.disabled = true; cancel.disabled = true; save.textContent = L.t('保存中…');
  let previousControls = [];
  try {
    await settingsOpenPromise;
    await window.pluginHost.whenSettled();
    previousControls = [...modal.querySelectorAll('button, input, select')].map(control => [control, control.disabled]);
    for (const [control] of previousControls) control.disabled = true;
    const nextTheme = resolveTheme(themeDraft);
    const nextTelemetry = $('#telemetry-toggle').checked;
    for (const callback of [...pluginSettingsSaveHooks]) await callback();
    const result = await window.api.telemetrySetEnabled(nextTelemetry);
    const enabled = typeof result === 'boolean' ? result : result?.enabled;
    if (enabled !== nextTelemetry) throw new Error(L.t('诊断选项未能保存'));
    localStorage.setItem(themeStorageKey, nextTheme);
    committedTheme = nextTheme; committedTelemetry = nextTelemetry;
    const nextLanguage = $('#language-select').value;
    await window.api.uiPreferencesSave?.({ language: nextLanguage });
    const schoolResult = await window.api.schoolSave($('#school-select').value);
    settingsOpen = false;
    modal.classList.add('hidden'); modal.onclick = null;
    applyTheme(committedTheme);
    toast(schoolResult.restartRequired ? L.t('设置已保存，正在重启以切换学校') : L.t('设置已保存'), 8000);
    $('#settings-btn').focus({ preventScroll: true });
    if (nextLanguage !== L.language && !schoolResult.restartRequired) location.reload();
  } catch (error) {
    toast(L.t('保存失败：') + error.message);
  } finally {
    for (const [control, disabled] of previousControls) { if (control.isConnected) control.disabled = disabled; }
    settingsSaving = false;
    save.disabled = false; cancel.disabled = false; save.textContent = L.t('保存');
    renderPluginList();
  }
}

function selectSettingsTab(name) {
  for (const button of document.querySelectorAll('[data-settings-tab]')) {
    const active = button.dataset.settingsTab === name;
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  }
  for (const panel of document.querySelectorAll('[data-settings-panel]')) {
    panel.classList.toggle('hidden', panel.dataset.settingsPanel !== name);
  }
}

// ---------- 应用内更新(入口常驻左下角) ----------
let pendingUpdate = null; // {latest, notes, assets, url}

function hideUpdatePanels() {
  $('#update-progress-box').classList.add('hidden');
  $('#update-new-box').classList.add('hidden');
  $('#update-panel').classList.add('hidden');
}

async function checkUpdate(silent = false) {
  const btn = $('#update-check-btn');
  btn.disabled = true;
  btn.textContent = L.t('检查中…');
  hideUpdatePanels();
  try {
    const info = await window.api.checkUpdate();
    $('#update-status').textContent = `📦 v${window.appVersion || info.current || '-'}${info.isNewer ? ' 🔴' : ''}`;
    $('#update-status').classList.toggle('has-update', !!info.isNewer);
    btn.textContent = L.t('🚀 检查更新');
    if (!info.isNewer) {
      if (!silent) toast(L.html`当前安装版本 ${info.current}，更新渠道暂无更高版本`);
      return;
    }
    pendingUpdate = info;
    const notes = $('#update-notes');
    notes.innerHTML = window.marked
      ? safeHtml(window.marked.parse(info.notes))
      : esc(info.notes);
    $('#update-new-box').classList.remove('hidden');
    $('#update-panel').classList.remove('hidden');
  } catch (e) {
    toast(L.t('检查更新失败:') + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = L.t('🚀 检查更新');
  }
}

async function runUpdateNow() {
  if (!pendingUpdate) return;
  $('#update-new-box').classList.add('hidden');
  $('#update-panel').classList.remove('hidden');
  $('#update-progress-box').classList.remove('hidden');
  $('#update-stage').textContent = L.t('准备下载…');
  $('#update-fill').style.width = '0%';
  try {
    await window.api.runUpdate(pendingUpdate.assets);
    hideUpdatePanels();
    toast(L.t('已在浏览器打开下载。下载完成后，退出应用并安装更新。'), 9000);
  } catch (e) {
    $('#update-stage').textContent = L.t('更新失败');
    $('#update-detail').textContent = e.message;
    $('#update-fill').style.width = '0%';
    toast(L.t('更新失败:') + e.message, 8000);
  }
}

// ---------- 主题皮肤 ----------

function resolveTheme(theme) {
  if (theme === 'base' || themeRegistry.has(theme)) return theme;
  return themeRegistry.has('hkust') ? 'hkust' : 'base';
}

function applyTheme(theme) {
  const chosen = resolveTheme(theme);
  const descriptor = themeRegistry.get(chosen) || BASE_THEME;
  document.body.dataset.theme = chosen;
  document.body.dataset.themeLayout = descriptor.layout;
  document.body.dataset.hideEmoji = String(descriptor.hideEmoji);
  const select = $('#theme-select'); select.replaceChildren();
  const themes = [...themeRegistry.values()];
  if (chosen === 'base') themes.unshift(BASE_THEME);
  for (const entry of themes) {
    const option = document.createElement('option'); option.value = entry.id; option.textContent = L.t(entry.label); select.append(option);
  }
  select.value = chosen;
  arrangeChrome(descriptor.layout);
  syncOptionEmoji(descriptor.hideEmoji);
}

// 侧栏布局将标题、同步和设置移到侧栏；标准布局按原顺序放回顶栏。
// 移动的是同一批节点,事件绑定不受影响。
function arrangeChrome(layout) {
  const title = $('#app-title'), synced = $('#synced-at');
  const settings = $('#settings-btn'), refresh = $('#refresh-btn'), progress = $('#sync-progress');
  if (layout === 'sidebar') {
    $('#nav-brand').append(title);
    $('#nav-sync').append(refresh, synced, progress);
    $('#update-footer').append(settings);
  } else {
    $('header').append(title, synced, settings, refresh);
    $('header').after(progress);
  }
}

// ---------- emoji 标记 ----------
// 界面文案里的 emoji 统一包成 <span class="emo">,由已选皮肤决定显示与否。
// 用 MutationObserver 兜住所有动态写入的文案;Canvas 原文(.paper)和输入控件不动。
const EMOJI_RE = /\p{Extended_Pictographic}️?(?:‍\p{Extended_Pictographic}️?)*\s*/gu;
const EMOJI_SKIP = '.paper, .emo, script, style, textarea, option, input';

function wrapEmojiIn(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    const parent = node.parentElement;
    const text = node.nodeValue;
    if (!parent || parent.closest(EMOJI_SKIP) || !text) return;
    EMOJI_RE.lastIndex = 0;
    if (!EMOJI_RE.test(text)) return;
    EMOJI_RE.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(EMOJI_RE)) {
      if (m.index > last) frag.append(text.slice(last, m.index));
      const span = document.createElement('span');
      span.className = 'emo';
      span.textContent = m[0];
      frag.append(span);
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.append(text.slice(last));
    node.replaceWith(frag);
  } else if (node.nodeType === Node.ELEMENT_NODE && !node.matches(EMOJI_SKIP)) {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode);
    texts.forEach(wrapEmojiIn);
  }
}

function watchEmoji() {
  wrapEmojiIn(document.body);
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'characterData') wrapEmojiIn(m.target);
      else m.addedNodes.forEach(wrapEmojiIn);
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
}

// <option> 不能放 span,隐藏 emoji 时改文字,其余时候还原。
function syncOptionEmoji(hide) {
  document.querySelectorAll('option').forEach((o) => {
    if (o.dataset.raw == null) o.dataset.raw = o.textContent;
    o.textContent = hide ? o.dataset.raw.replace(EMOJI_RE, '') : o.dataset.raw;
  });
}

// ---------- 渲染入口 ----------

function renderBoardMeta() {
  if (selectedCourse === 'all') return;
  const list = (byCourse[selectedCourse] || []).filter(a => a.published);
  const pending = list.filter(a => classify(a) === 'pending').length;
  const overdue = list.filter(a => classify(a) === 'overdue').length;
  $('#board-meta-assignments').textContent =
    [pending ? L.html`${pending} 项待办` : L.t('没有待办'), overdue ? L.html`${overdue} 项过期` : ''].filter(Boolean).join('，');
  const anns = annBy[selectedCourse] || [];
  const fresh = anns.filter(x => parseTime(x.posted_at) > Date.now() - 7 * 86400000).length;
  $('#board-meta-announcements').textContent = anns.length ? L.html`${anns.length} 条${fresh ? L.html`，${fresh} 条新` : ''}` : L.t('暂无');
  const fl = filesBy[selectedCourse] || {};
  const nFiles = (fl.files || []).length, nLinks = (fl.links || []).length;
  $('#board-meta-files').textContent = nFiles || nLinks
    ? [nFiles ? L.html`${nFiles} 个文件` : '', nLinks ? L.html`${nLinks} 个链接` : ''].filter(Boolean).join('，') : L.t('暂无');
}

// 只摆放看板(模式、台前是哪块、可交互性),不重画内容;切看板时只调这个,列表节点和滚动位置保持不动
function layoutStage() {
  const isAll = selectedCourse === 'all';
  // 全部课程只有一块固定看板;具体课程在"总览"和"某块看板在台前"之间切换
  if (isAll) activeSection = 'home';
  else if (activeSection === 'home') activeSection = 'overview';
  const focus = BOARDS.includes(activeSection) ? activeSection : null;
  const stage = $('#stage');
  stage.dataset.mode = isAll ? 'home' : focus ? 'focus' : 'overview';
  stage.dataset.boardCount = String(BOARDS.length);
  stage.style.setProperty('--preview-count', String(Math.max(1, BOARDS.length - 1)));
  $('#stage-overview-btn').title = L.html`回到 ${BOARDS.length} 块看板总览 (Esc)`;
  $('#home-view').classList.toggle('hidden', !isAll);
  document.querySelectorAll('#stage .board').forEach(board => {
    const name = board.dataset.board;
    const onStage = name === focus;
    board.classList.toggle('is-focus', onStage);
    // 不在台前的看板只是预览:内容不可交互,整块可点
    board.querySelector('.board-surface').inert = !onStage;
    const title = board.querySelector('.board-title');
    title.setAttribute('aria-expanded', String(onStage));
    title.tabIndex = focus ? (onStage ? 0 : -1) : 0;
  });
  if (focus !== 'assignments' && !$('#detail-panel').classList.contains('hidden')) {
    closeDetail({ immediate: true, restoreFocus: false });
  }
}

function render() {
  renderNav();
  layoutStage();
  if (selectedCourse === 'all') {
    renderHome();
    notifyPluginHooks(pluginRenderHooks);
    return;
  }
  renderBoardMeta();
  renderList();
  renderAnnouncements();
  refreshLocalFiles();
  notifyPluginHooks(pluginRenderHooks);
}

async function init() {
  schoolConfig = await window.api.schoolConfig();
  CANVAS_ORIGIN = schoolConfig.active.origin;
  themeStorageKey = schoolConfig.active.id === 'hkust-gz' ? 'canvas-theme' : `canvas-theme-${schoolConfig.active.id}`;
  for (const school of schoolConfig.schools) {
    const option = document.createElement('option');
    option.value = school.id; option.textContent = `${L.t(school.name)} · ${L.t(school.region)}`;
    $('#school-select').append(option);
  }
  $('#school-select').value = schoolConfig.selected;
  $('#school-current').textContent = L.html`当前学校：${L.t(schoolConfig.active.name)}`;
  document.title = L.html`Canvas 课程管理 · ${L.t(schoolConfig.active.name)}`;
  watchEmoji();

  window.api.onSyncProgress(renderSyncProgress);
  window.api.syncProgressCurrent().then(p => {
    // 重开窗口只恢复进行中的任务，不重放早已完成的提示让页面上下跳动。
    if (p && p.phase !== 'done' && p.phase !== 'error') renderSyncProgress(p);
  }).catch(() => {});

  try { committedTheme = localStorage.getItem(themeStorageKey) || 'hkust'; } catch (e) { /* 忽略 */ }
  themeDraft = committedTheme;
  applyTheme(themeDraft);
  $('#theme-select').onchange = () => { themeDraft = $('#theme-select').value; applyTheme(themeDraft); };


  document.querySelectorAll('#stage .board').forEach(bindBoardInteraction);
  $('#stage-overview-btn').onclick = () => selectSection('overview');
  document.querySelectorAll('.chip').forEach(chip => {
    chip.setAttribute('role', 'button');
    chip.setAttribute('aria-pressed', chip.classList.contains('active') ? 'true' : 'false');
    const activate = () => {
      if (activeFilter === chip.dataset.filter) return;
      closeDetail({ immediate: true, restoreFocus: false });
      document.querySelector('.chip.active').classList.remove('active');
      chip.classList.add('active');
      document.querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', c === chip ? 'true' : 'false'));
      activeFilter = chip.dataset.filter;
      renderList();
    };
    chip.onclick = activate;
    chip.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } };
  });

  $('#refresh-btn').onclick = async () => {
    const btn = $('#refresh-btn');
    const label = btn.querySelector('.sync-label');
    btn.disabled = true;
    label.textContent = L.t('同步中…');
    const startedAt = Date.now();
    toast(L.t('正在同步 Canvas…若弹出登录窗口请完成登录;其余时间不会出现任何窗口,请勿担心'));
    try {
      const data = await window.api.refresh();
      ({ courses, byCourse, filesBy, annBy } = normalize(data));
      renderSyncedAt(data.syncedAt);
      render();
      toast(L.html`同步完成 · 用时 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒`);
    } catch (e) {
      toast(L.t('同步失败:') + e.message, 8000);
    } finally {
      btn.disabled = false;
      label.textContent = L.t('同步');
    }
  };

  $('#detail-close').onclick = closeDetail;
  $('#detail-open').onclick = () => currentDetail && currentDetail.a.url && window.api.openUrl(currentDetail.a.url);

  // 点击通知跳转到对应作业;自动同步后刷新界面
  window.api.onOpenAssignment(({ cid, a }) => gotoAssignment(cid, a));
  window.api.onDataUpdated((data) => {
    ({ courses, byCourse, filesBy, annBy } = normalize(data));
    renderSyncedAt(data.syncedAt);
    render();
    toast(L.t('Canvas 数据已自动更新'));
  });

  $('#download-all-btn').onclick = downloadAll;
  $('#settings-btn').onclick = openSettings;
  $('#language-select').value = L.language;
  $('#onboarding-replay').onclick = () => { closeSettings(); window.CanvasOnboarding.open(schoolConfig, 0); };
  window.appVersion = await window.api.appVersion();
  $('#update-status').textContent = `📦 v${window.appVersion || '-'}`;
  $('#update-check-btn').onclick = () => checkUpdate(false);
  $('#update-now-btn').onclick = runUpdateNow;
  $('#update-later-btn').onclick = hideUpdatePanels;
  $('#update-panel-close').onclick = hideUpdatePanels;
  $('#telemetry-export-btn').onclick = async () => {
    try {
      const out = await window.api.exportTelemetry();
      toast(L.t('已导出并打开所在文件夹:') + out.split(/[\\/]/).pop());
    } catch (e) {
      toast(L.t('导出失败:') + e.message);
    }
  };
  window.api.onUpdateProgress((p) => {
    $('#update-panel').classList.remove('hidden');
    const box = $('#update-progress-box');
    box.classList.remove('hidden');
    $('#update-stage').textContent = p.stage === 'download' ? L.t('⬇ 下载新版本') : p.stage === 'verify' ? L.t('🔒 校验完整性') : p.stage === 'done' ? L.t('✅ 即将启动安装') : p.stage;
    $('#update-detail').textContent = p.detail || '';
    $('#update-fill').style.width = (p.pct || 0) + '%';
  });
  $('#settings-close-btn').onclick = closeSettings;
  $('#settings-save-btn').onclick = saveSettings;
  for (const button of document.querySelectorAll('[data-settings-tab]')) {
    button.onclick = () => selectSettingsTab(button.dataset.settingsTab);
    button.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const next = button.dataset.settingsTab === 'general' ? 'plugins' : 'general';
      selectSettingsTab(next); document.querySelector(`[data-settings-tab="${next}"]`).focus();
    };
  }

  // 键盘:Esc 关闭弹窗与详情面板
  document.addEventListener('keydown', (e) => {
    const modal = $('#settings-modal');
    if (e.key === 'Tab' && !modal.classList.contains('hidden')) {
      const controls = [...modal.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]')]
        .filter(control => !control.closest('.hidden') && control.tabIndex >= 0);
      const first = controls[0], last = controls.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
    if (e.key === 'Escape') {
      const panel = $('#detail-panel');
      if (!modal.classList.contains('hidden')) {
        closeSettings();
        e.preventDefault();
      } else if (!panel.classList.contains('hidden')) {
        closeDetail();
        e.preventDefault();
      } else if (BOARDS.includes(activeSection) && !e.target.closest?.('input, select, textarea')) {
        const from = activeSection;
        selectSection('overview');
        document.querySelector(`.board-title[data-section="${from}"]`)?.focus({ preventScroll: true });
        e.preventDefault();
      }
    }
  });

  $('#detail-desc').addEventListener('click', (e) => {
    const attBtn = e.target.closest('button[data-att]');
    if (attBtn && currentDetail) {
      downloadAttachment(attBtn, (currentDetail.a.attachments || [])[+attBtn.dataset.att]);
      return;
    }
    const a = e.target.closest('a');
    if (a && a.getAttribute('href') !== '#') {
      e.preventDefault();
      if (/^https?:\/\//.test(a.href)) window.api.openUrl(a.href);
    }
  });

  $('#ann-list').addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (a && a.getAttribute('href') !== '#') {
      e.preventDefault();
      if (/^https?:\/\//.test(a.href)) window.api.openUrl(a.href);
    }
  });

  const data = await window.api.loadLocal();
  ({ courses, byCourse, filesBy, annBy } = normalize(data));
  renderSyncedAt(data.syncedAt);
  render();
  if (!courses.length) toast(L.t('本地无数据,点击「同步」登录 Canvas 拉取'));

  window.api.onPluginsChanged?.(list => { void refreshPlugins(Array.isArray(list) ? list : undefined); });
  await refreshPlugins();
  window.api.rendererReady?.();
  if (!['completed', 'skipped'].includes(L.preferences.onboardingStatus)) window.CanvasOnboarding.open(schoolConfig, L.preferences.onboardingStep);
}

function normalize(data) {
  return {
    courses: data.courses || [],
    byCourse: data.byCourse || {},
    filesBy: data.filesBy || {},
    annBy: data.annBy || {},
  };
}

function renderSyncedAt(iso) {
  const el = $('#synced-at');
  if (!iso) { el.textContent = ''; return; }
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  el.textContent = L.html`同步于 ${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

init();
