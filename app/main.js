const { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, protocol, screen, shell, session, Tray } = require('electron');
const path = require('path');
const fs = require('fs');
const { createSyncBridge } = require('./sync-bridge');
const { createPluginManager } = require('./core/plugin-manager.cjs');
const { createDesktopService } = require('./core/desktop-service.cjs');
const { createNativeWidgetService } = require('./core/native-widget-service.cjs');
const { parseWidgetLink } = require('./core/widget-links.cjs');
const dataEvents = new (require('node:events').EventEmitter)();
const { schools, readSchool, writeSchool, schoolDataDir, schoolPartition, isCanvasUrl } = require('./core/schools.cjs');
const pluginCatalog = require('./plugins/catalog.json');

// canvas-res:// 协议:用 persist:canvas 的登录态代理 Canvas 图片(描述里的插图/公式图都要 Cookie 才能加载)
protocol.registerSchemesAsPrivileged([
  { scheme: 'canvas-res', privileges: { standard: true, secure: true } },
]);

// 打包后程序装在 Program Files 等只读位置,数据改存用户目录;开发模式仍用仓库 data/
const DATA_ROOT = app.isPackaged
  ? path.join(app.getPath('userData'), 'data')
  : path.join(__dirname, '..', 'data');
const uiPreferences = require('./core/ui-preferences.cjs').createUIPreferences(DATA_ROOT, app.getPreferredSystemLanguages()[0]);
const SCHOOL = readSchool(DATA_ROOT);
const DATA_DIR = schoolDataDir(DATA_ROOT, SCHOOL.id);
const FILES_DIR = path.join(DATA_DIR, 'files');
const CANVAS_ORIGIN = SCHOOL.origin;
const SESSION_PARTITION = schoolPartition(SCHOOL.id);

// ---------- 本地诊断日志(纯本地,不上传;设置里可关/可导出) ----------
// 收:匿名安装ID/版本/系统硬件/功能事件流(成功失败+错误码+文件大小/AI服务商与模型)
// 不收:姓名/学号/API Key/课程内容(课程只记数量不记名称)
const TELEMETRY_PATH = path.join(DATA_DIR, 'telemetry.jsonl');
const TELEMETRY_ID_PATH = path.join(DATA_DIR, 'telemetry_id.json');
const TELEMETRY_CONFIG_PATH = path.join(DATA_DIR, 'telemetry_config.json');
const TELEMETRY_MAX_LINES = 5000; // 限额轮转,防止无限增长

function telemetryEnabled() {
  try {
    const c = JSON.parse(fs.readFileSync(TELEMETRY_CONFIG_PATH, 'utf-8'));
    return c.enabled !== false;
  } catch { return true; } // 默认开启
}

function telemetryInstallId() {
  try {
    return JSON.parse(fs.readFileSync(TELEMETRY_ID_PATH, 'utf-8')).id;
  } catch {
    const id = require('crypto').randomUUID().slice(0, 12);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(TELEMETRY_ID_PATH, JSON.stringify({ id, created: new Date().toISOString() }), 'utf-8');
    return id;
  }
}

// 任何失败静默吞掉:诊断日志绝不影响主功能
function track(event, fields = {}) {
  try {
    if (!telemetryEnabled()) return;
    const line = JSON.stringify({ t: new Date().toISOString(), ev: event, ...fields }) + '\n';
    fs.appendFile(TELEMETRY_PATH, line, 'utf-8', () => {});
    // 粗略限额:超过 2 倍上限时截断保留后半
    try {
      const st = fs.statSync(TELEMETRY_PATH);
      if (st.size > 3 * 1024 * 1024) {
        const lines = fs.readFileSync(TELEMETRY_PATH, 'utf-8').split('\n').filter(Boolean);
        fs.writeFileSync(TELEMETRY_PATH, lines.slice(-TELEMETRY_MAX_LINES).join('\n') + '\n', 'utf-8');
      }
    } catch { /* 忽略轮转失败 */ }
  } catch { /* 忽略埋点失败 */ }
}

function telemetryEnv() {
  const os = require('os');
  return {
    installId: telemetryInstallId(),
    version: app.getVersion(),
    platform: process.platform,
    osRelease: os.release(),
    arch: process.arch,
    cpuModel: (os.cpus()[0] || {}).model || '',
    memGB: Math.round(os.totalmem() / 1073741824),
    locale: app.getLocale(),
  };
}

function exportTelemetry() {
  const dir = path.join(DATA_DIR, 'exports');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const out = path.join(dir, `diagnostics-${stamp}.json`);
  let events = [];
  try {
    events = fs.readFileSync(TELEMETRY_PATH, 'utf-8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { /* 无事件 */ }
  const payload = {
    _说明: '本文件由「Canvas 课程管理」本地生成,从未自动上传。仅含匿名诊断数据(见 env 与 events),不含姓名/学号/API Key/课程内容。',
    env: telemetryEnv(),
    telemetryEnabled: telemetryEnabled(),
    eventCount: events.length,
    events,
  };
  fs.writeFileSync(out, JSON.stringify(payload, null, 2), 'utf-8');
  track('telemetry-export', { eventCount: events.length });
  return out;
}


let mainWindow;
let mainRendererReady = false;
let pendingWidgetLink = null;
function deliverWidgetLink() {
  if (!pendingWidgetLink || !mainRendererReady || !mainWindow || mainWindow.isDestroyed()) return;
  const link = pendingWidgetLink; pendingWidgetLink = null;
  if (link.type !== 'assignment') return;
  try {
    const data = readLocalData();
    if (!data.courses.some(course => Number(course.id) === link.cid)) return;
    const a = (data.byCourse[link.cid] || []).find(item => Number(item.id) === link.id);
    if (a) mainWindow.webContents.send('open-assignment', { cid: link.cid, a });
  } catch (error) { console.error('[widget] opening assignment failed:', error.message); }
}
app.on('open-url', (event, value) => {
  event.preventDefault();
  const link = parseWidgetLink(value);
  if (!link) return;
  pendingWidgetLink = link;
  if (app.isReady()) { showMainWindow(); deliverWidgetLink(); }
});
process.on('unhandledRejection', (r) => console.error('[unhandled]', r));

// 单实例:重复启动时唤起已有窗口(两个实例会争抢 persist:canvas 配置目录,导致缓存报错)
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
app.on('second-instance', () => showMainWindow());

// 在 Canvas 页面上下文里抓取课程+作业(含要求)+文件+模块链接
const FETCH_ALL_SCRIPT = `(async () => {
  const active = new Map();
  let completed = 0;
  let total = 0;
  const progress = () => console.info('__canvas_sync_progress__' + JSON.stringify({
    phase: 'courses', completed, total, active: [...active.values()]
  }));
  const paged = async (u) => {
    let items = [];
    while (u) {
      const r = await fetch(u, { credentials: 'include' });
      if (!r.ok) throw new Error(u + ' -> ' + r.status);
      items = items.concat(await r.json());
      const m = (r.headers.get('Link') || '').match(/<([^>]+)>; rel="next"/);
      u = m ? m[1] : null;
    }
    return items;
  };
  const courses = await paged('/api/v1/courses?enrollment_state=active&per_page=100');
  total = courses.length;
  progress();
  // 同时处理最多 3 门课；每门课的请求和分页仍顺序执行，限制服务器压力。
  const out = new Array(courses.length);
  let nextCourse = 0;
  let failure = null;
  const worker = async () => {
    while (!failure && nextCourse < courses.length) {
      const index = nextCourse++;
      const c = courses[index];
      active.set(index, c.course_code || c.name || '课程' + c.id);
      progress();
      try {
        const assignments = (await paged('/api/v1/courses/' + c.id + '/assignments?include[]=submission&per_page=100&order_by=position')).map(a => ({
          id: a.id, name: a.name, due_at: a.due_at, points: a.points_possible,
          published: a.published, url: a.html_url, description: a.description || '',
          attachments: (a.attachments || []).map(x => ({ id: x.id, filename: x.filename, url: x.url, content_type: x.content_type, size: x.size })),
          sub: a.submission ? { state: a.submission.workflow_state, submitted_at: a.submission.submitted_at,
            score: a.submission.score, late: a.submission.late } : null
        }));
        let files = [], links = [];
        try {
          files = (await paged('/api/v1/courses/' + c.id + '/files?per_page=100'))
            .map(f => ({ id: f.id, filename: f.filename, size: f.size, type: f.content_type, url: f.url, created_at: f.created_at }));
        } catch (e) {}
        try {
          const mods = await paged('/api/v1/courses/' + c.id + '/modules?include[]=items&per_page=50');
          for (const m of mods) {
            const items = m.items || [];
            for (const it of items) {
              if (it.type === 'ExternalUrl' && it.external_url) links.push({ title: it.title, url: it.external_url });
              else if (it.type === 'Page' && it.page_url) links.push({ title: it.title, url: '/courses/' + c.id + '/pages/' + it.page_url });
            }
          }
        } catch (e) {}
        let announcements = [];
        try {
          announcements = (await paged('/api/v1/courses/' + c.id + '/discussion_topics?only_announcements=true&per_page=100'))
            .map(t => ({ id: t.id, title: t.title, posted_at: t.posted_at,
              author: t.author && t.author.display_name, url: t.html_url, message: t.message || '' }));
        } catch (e) {}
        out[index] = { course: { id: c.id, name: c.name, code: c.course_code }, assignments, files, links, announcements };
        active.delete(index);
        completed++;
        progress();
      } catch (e) {
        active.delete(index);
        failure = e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, courses.length) }, worker));
  // 等待在途请求收尾后再报错，避免留下后台请求或保存不完整的数据。
  if (failure) throw failure;
  return out;
})()`;

function readLocalData() {
  const coursesPath = path.join(DATA_DIR, 'courses.json');
  const courses = fs.existsSync(coursesPath)
    ? JSON.parse(fs.readFileSync(coursesPath, 'utf-8'))
    : [];
  const byCourse = {};
  const filesBy = {};
  const annBy = {};
  for (const file of fs.readdirSync(DATA_DIR).filter(f => /^course_\d+_(assignments|files|announcements)\.json$/.test(f))) {
    const m = file.match(/course_(\d+)_(assignments|files|announcements)/);
    const cid = parseInt(m[1], 10);
    const content = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf-8'));
    if (m[2] === 'assignments') byCourse[cid] = content;
    else if (m[2] === 'files') filesBy[cid] = content;
    else annBy[cid] = Array.isArray(content) ? content : (content.announcements || []);
  }
  return { courses, byCourse, filesBy, annBy, syncedAt: readSyncedAt() };
}

function readSyncedAt() {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'sync_manifest.json'), 'utf-8'));
    if (typeof manifest.syncedAt === 'string' && Number.isFinite(Date.parse(manifest.syncedAt))) {
      return manifest.syncedAt;
    }
  } catch { /* 旧版数据没有同步记录 */ }
  try {
    return fs.statSync(path.join(DATA_DIR, 'courses.json')).mtime.toISOString();
  } catch {
    return null;
  }
}

function saveData(result) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(DATA_DIR, 'courses.json'),
    JSON.stringify(result.map(r => r.course), null, 2), 'utf-8');
  for (const r of result) {
    fs.writeFileSync(
      path.join(DATA_DIR, `course_${r.course.id}_assignments.json`),
      JSON.stringify(r.assignments, null, 2), 'utf-8');
    fs.writeFileSync(
      path.join(DATA_DIR, `course_${r.course.id}_files.json`),
      JSON.stringify({ files: r.files, links: r.links }, null, 2), 'utf-8');
    fs.writeFileSync(
      path.join(DATA_DIR, `course_${r.course.id}_announcements.json`),
      JSON.stringify(r.announcements || [], null, 2), 'utf-8');
  }
  // 所有课程文件落盘后才更新完成记录，避免读者把半次同步当成新数据。
  const manifestPath = path.join(DATA_DIR, 'sync_manifest.json');
  const tempPath = `${manifestPath}.${require('crypto').randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify({ syncedAt: new Date().toISOString(), courseCount: result.length }) + '\n', 'utf-8');
    fs.renameSync(tempPath, manifestPath);
  } finally {
    try { fs.unlinkSync(tempPath); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

// ---------- 托盘 / 截止提醒 / 自动同步 ----------

let tray = null, trayIcon = null, notificationIcon = null;

function showMainWindow() {
  if (app.isQuiting || !app.isReady()) return;
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function setupTray() {
  try {
    const icons = path.join(__dirname, 'assets', 'icons');
    notificationIcon = nativeImage.createFromPath(path.join(icons, 'app-256.png'));
    if (notificationIcon.isEmpty()) throw new Error('Application icon asset is missing');
    if (process.platform === 'darwin') {
      trayIcon = nativeImage.createFromPath(path.join(icons, 'menuBarTemplate.png'));
      if (trayIcon.isEmpty()) throw new Error('Menu bar template asset is missing');
      trayIcon.setTemplateImage(true);
    } else {
      trayIcon = notificationIcon.resize({ width: 32, height: 32 });
    }
    tray = new Tray(trayIcon);
    updateTrayMenu();
    tray.on('click', () => showMainWindow());
  } catch (e) {
    console.error('[tray] 初始化失败:', e.message);
  }
}

function updateTrayMenu() {
  if (!tray) return;
  const en = uiPreferences.read().language === 'en';
  tray.setToolTip(en ? 'Canvas Manager' : 'Canvas 课程管理');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: en ? 'Show Canvas Manager' : '显示主窗口', click: showMainWindow },
    { label: en ? 'Sync now' : '立即同步', click: () => traySync() },
    { type: 'separator' },
    { label: en ? 'Quit' : '退出', click: () => app.quit() },
  ]));
}

// 截止提醒:24 小时 / 1 小时各弹一次系统通知,已提醒的记录落盘防止重启后重复弹
const NOTIFIED_PATH = path.join(DATA_DIR, 'notified.json');
const notified = new Set((() => {
  try { return JSON.parse(fs.readFileSync(NOTIFIED_PATH, 'utf-8')); } catch { return []; }
})());
const REMINDERS = [
  { key: '24h', lead: 24 * 3600e3, label: '24 小时内' },
  { key: '1h', lead: 3600e3, label: '1 小时内' },
];

function checkReminders() {
  if (!Notification.isSupported()) return;
  let data;
  try { data = readLocalData(); } catch { return; }
  const now = Date.now();
  let changed = false;
  for (const [cidStr, list] of Object.entries(data.byCourse)) {
    const cid = parseInt(cidStr, 10);
    const course = data.courses.find(c => c.id === cid);
    const cname = (course && course.code ? course.code.split(' ')[0] : `课程${cid}`);
    for (const a of list) {
      if (!a.published || !a.due_at) continue;
      const s = a.sub;
      if (s && (s.state === 'graded' || s.state === 'submitted' || s.submitted_at)) continue;
      const left = new Date(a.due_at).getTime() - now;
      if (!(left > 0)) continue;
      for (const r of REMINDERS) {
        if (notified.has(`${a.id}:${r.key}`) || left > r.lead) continue;
        // 更早的档位一并标记:临近截止时不会 24h/1h 连着弹两条
        for (const r2 of REMINDERS) if (r2.lead >= r.lead) notified.add(`${a.id}:${r2.key}`);
        changed = true;
        const n = new Notification({
          title: `⏰ ${cname} · ${uiPreferences.read().language === 'en' ? 'Due within ' + r.key : r.label + '截止'}`,
          body: `${a.name}\n${uiPreferences.read().language === 'en' ? 'Click to view details' : '点击查看详情'}`,
          icon: notificationIcon || undefined,
        });
        n.on('click', () => {
          showMainWindow();
          mainWindow.webContents.send('open-assignment', { cid, a });
        });
        n.show();
      }
    }
  }
  if (changed) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(NOTIFIED_PATH, JSON.stringify([...notified], null, 2), 'utf-8');
  }
}

// 定时自动同步:登录态存在才拉,失败静默(不弹 SSO 打扰用户)
let syncing = false;
let syncRunId = 0;
let syncProgressSequence = 0;
let currentSyncProgress = null;
let syncBridge = null;

function sendSyncProgress(runId, progress) {
  if (runId !== syncRunId) return;
  const previous = currentSyncProgress?.runId === runId ? currentSyncProgress : {};
  currentSyncProgress = { ...previous, ...progress, runId, sequence: ++syncProgressSequence };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sync-progress', currentSyncProgress);
  }
  if (typeof syncBridge !== 'undefined' && syncBridge) syncBridge.publishProgress(currentSyncProgress);
}

async function doSync() {
  if (schoolRestartPending) throw new Error('正在重启以切换学校');
  if (syncing) throw new Error('已有同步在进行,请稍候');
  syncing = true;
  const runId = ++syncRunId;
  const t0 = Date.now();
  sendSyncProgress(runId, { phase: 'connecting' });
  try {
    const result = await fetchViaSession(runId);
    sendSyncProgress(runId, { phase: 'saving', completed: result.length, total: result.length, active: [] });
    saveData(result);
    const data = readLocalData();
    dataEvents.emit('updated', data);
    sendSyncProgress(runId, { phase: 'done', completed: result.length, total: result.length, active: [] });
    track('sync', { ok: true, ms: Date.now() - t0, courseCount: Array.isArray(result) ? result.length : 0 });
    return data;
  } catch (e) {
    sendSyncProgress(runId, { phase: 'error', active: [], detail: String(e.message).slice(0, 180) });
    track('sync', { ok: false, ms: Date.now() - t0, err: String(e.message).slice(0, 120) });
    throw e;
  } finally {
    syncing = false;
  }
}

function broadcast(data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('data-updated', data);
}

syncBridge = createSyncBridge({
  dataDir: DATA_DIR,
  onSync: async () => {
    const data = await doSync();
    broadcast(data);
    return data;
  },
});

async function autoSync() {
  if (syncing || pluginManager.isBusy()) return;
  try {
    const cookies = await session.fromPartition(SESSION_PARTITION).cookies.get({ url: CANVAS_ORIGIN });
    if (!cookies.length) return;
    const data = await doSync();
    broadcast(data);
    console.log('[auto-sync] ok');
  } catch (e) {
    console.log('[auto-sync] failed:', e.message);
  }
}

async function traySync() {
  try {
    broadcast(await doSync());
    if (Notification.isSupported()) new Notification({ title: uiPreferences.read().language === 'en' ? 'Sync complete' : '同步完成', body: uiPreferences.read().language === 'en' ? 'Canvas data updated' : 'Canvas 数据已更新', icon: notificationIcon || undefined }).show();
  } catch (e) {
    if (Notification.isSupported()) new Notification({ title: uiPreferences.read().language === 'en' ? 'Sync failed' : '同步失败', body: String(e.message).slice(0, 160), icon: notificationIcon || undefined }).show();
  }
}

// 在 persist:canvas 分区上开一个隐藏窗口;若未登录则弹出 SSO 窗口等待登录完成。
// 窗口策略:抓取阶段全程隐藏(防止用户误点干扰);只有真正需要输密码时才显示。
async function withSessionWindow(fn, onLoginNeeded = () => {}) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { partition: SESSION_PARTITION, nodeIntegration: false, contextIsolation: true },
  });
  win.setTitle(`登录 ${SCHOOL.name} — 请完成学校认证及多重验证`);
  win.setSize(900, 700);
  try {
    try {
      await win.loadURL(`${CANVAS_ORIGIN}/courses`);
    } catch (loadErr) {
      const m = String((loadErr && loadErr.message) || loadErr);
      // 学校域名(hkust-gz.edu.cn)只在校园网 DNS 里有记录,校外解析不了
      if (/ERR_NAME_NOT_RESOLVED/.test(m)) {
        throw new Error('无法解析学校服务地址，请检查网络；若学校要求校园网或 VPN，请连接后重试');
      }
      if (/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED/.test(m)) {
        throw new Error('网络连接中断或发生了切换,请检查网络后重试');
      }
      if (/ERR_CONNECTION_TIMED_OUT|ERR_CONNECTION_REFUSED/.test(m)) {
        throw new Error('连接学校服务超时:若你在校外,请先连接学校 VPN 再同步');
      }
      // School portals can replace the initial navigation (e.g. NUS SSO).
      // ERR_ABORTED is navigation cancellation, not an authentication failure.
      if (loadErr.code !== 'ERR_ABORTED' && loadErr.errno !== -3) throw loadErr;
    }
    // Give a cached SSO session time to redirect without flashing a login window.
    for (let n = 0; n < 4 && !win.isDestroyed() && !isCanvasUrl(win.webContents.getURL(), CANVAS_ORIGIN); n++) {
      await new Promise(resolve => setTimeout(resolve, 800));
    }
    if (win.isDestroyed()) throw new Error('登录窗口被关闭，请重新点击同步');
    // A same-origin login page is not an authenticated session. Probe the actual API.
    const authenticated = async () => {
      if (win.isDestroyed() || !isCanvasUrl(win.webContents.getURL(), CANVAS_ORIGIN)) return false;
      try {
        return await executeWithTimeout(win, `(async () => {
          try {
            const r = await fetch('/api/v1/users/self/profile', { credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(4000) });
            if (!r.ok || !(r.headers.get('content-type') || '').includes('application/json')) return false;
            return !!(await r.json()).id;
          } catch { return false; }
        })()`, 5000, '检查登录状态');
      } catch { return false; }
    };
    if (!(await authenticated())) {
      onLoginNeeded();
      win.show();
      const deadline = Date.now() + 5 * 60 * 1000;
      while (!(await authenticated())) {
        if (win.isDestroyed()) throw new Error('登录窗口被关闭，请重新点击同步');
        if (Date.now() >= deadline) throw new Error('等待登录超时，请重新同步并完成学校认证');
        await new Promise(resolve => setTimeout(resolve, 800));
      }
      win.hide();
      win.setTitle('正在同步数据，请稍候…');
    }
    return await fn(win);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

// executeJavaScript 包装:超时 + 页面上下文异常的友好报错
function executeWithTimeout(win, script, timeoutMs, what) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what}超时(${Math.round(timeoutMs / 1000)} 秒),可能是网络卡顿或登录态异常,请稍后重试`)), timeoutMs);
    win.webContents.executeJavaScript(script, true)
      .then((r) => { clearTimeout(timer); resolve(r); })
      .catch((e) => {
        clearTimeout(timer);
        const msg = String(e && e.message || e);
        if (/destroyed|navigation|context/.test(msg)) {
          reject(new Error(`${what}被中断(页面发生了跳转),请不要在同步窗口中操作,请重试`));
        } else {
          reject(new Error(`${what}失败:${msg.slice(0, 120)}`));
        }
      });
  });
}

// 校验同步结果:防呆(登录态失效时 API 可能返回空/登录页解析物)
function validateSyncResult(data) {
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('同步结果异常:没有拉到任何课程(登录态可能已失效),请重试;若持续出现,请点击同步并在弹出的窗口中重新登录');
  }
  for (const r of data) {
    if (!r || !r.course || !r.course.id || !Array.isArray(r.assignments)) {
      throw new Error('同步结果异常:课程数据不完整,可能是网络波动或页面受干扰,请重试');
    }
  }
  return data;
}

async function fetchViaSession(runId) {
  return withSessionWindow(async (win) => {
    sendSyncProgress(runId, { phase: 'loading' });
    const onConsole = (_event, levelOrParams, maybeMessage) => {
      const message = typeof levelOrParams === 'object' ? levelOrParams.message : maybeMessage;
      if (typeof message !== 'string' || !message.startsWith('__canvas_sync_progress__')) return;
      try {
        const p = JSON.parse(message.slice('__canvas_sync_progress__'.length));
        if (p.phase !== 'courses' || !Number.isInteger(p.completed) ||
            !Number.isInteger(p.total) || p.completed < 0 || p.completed > p.total ||
            !Array.isArray(p.active) || p.active.length > 3) return;
        sendSyncProgress(runId, {
          phase: 'courses', completed: p.completed, total: p.total,
          active: p.active.map(name => String(name).slice(0, 80)),
        });
      } catch { /* 忽略页面里无效的进度消息 */ }
    };
    win.webContents.on('console-message', onConsole);
    try {
      const data = await executeWithTimeout(win, FETCH_ALL_SCRIPT, 90 * 1000, '抓取 Canvas 数据');
      if (data && data.error) throw new Error('Canvas 接口报错:' + data.error);
      return validateSyncResult(data);
    } finally {
      win.webContents.removeListener('console-message', onConsole);
    }
  }, () => sendSyncProgress(runId, { phase: 'login' }));
}

const nativeWidgets = createNativeWidgetService({
  helperPath: app.isPackaged ? path.join(path.dirname(process.execPath), 'CanvasWidgetBridge')
    : path.join(__dirname, '..', 'output', 'native-widget', 'native', 'CanvasWidgetBridge'),
  snapshotPath: path.join(app.getPath('home'), 'Library', 'Application Support', 'canvas-manager', 'widget-data', 'snapshot.json'),
});

// Optional capabilities use the same host and generic bridge; the core does
// not import an AI implementation or register its individual IPC handlers.
const pluginManager = createPluginManager({
  catalog: pluginCatalog,
  bundleRoot: __dirname,
  installRoot: path.join(DATA_DIR, 'installed-plugins'),
  services: {
    canvas: { downloadFile, sanitizeName, withSessionWindow, executeWithTimeout, readLocalData, origin: CANVAS_ORIGIN,
      onDataUpdated(callback) {
        const listener = data => {
          try { callback(data); } catch (error) { console.error('[plugins] data listener failed:', error.message); }
        };
        dataEvents.on('updated', listener);
        return () => dataEvents.removeListener('updated', listener);
      },
      openAssignment(cid, a) {
        showMainWindow();
        if (!mainWindow || mainWindow.isDestroyed()) return;
        const contents = mainWindow.webContents;
        const send = () => { if (!contents.isDestroyed()) contents.send('open-assignment', { cid, a }); };
        if (contents.isLoadingMainFrame()) contents.once('did-finish-load', send);
        else send();
      },
    },
    desktop: createDesktopService({ BrowserWindow, ipcMain, screen, showMainWindow }),
    nativeWidgets,
    storage: { dataDir: DATA_DIR, filesDir: FILES_DIR },
    diagnostics: { track },
    documents: {
      loadPdfParser: () => require('pdf-parse').PDFParse,
      loadZip: () => require('jszip'),
    },
  },
  statePath: path.join(DATA_DIR, 'plugins.json'),
  onEvent: (pluginId, event, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('plugin-event', { pluginId, event, data });
    }
  },
});

ipcMain.handle('plugins-list', () => pluginManager.list());
async function changePluginInstallation(action, id) {
  try { return await pluginManager[action](id); }
  finally {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('plugin-state-changed', pluginManager.list());
  }
}
ipcMain.handle('plugin-install', (_event, id) => changePluginInstallation('install', id));
ipcMain.handle('plugin-uninstall', (_event, id) => changePluginInstallation('uninstall', id));
ipcMain.handle('plugin-set-enabled', async (_event, id, enabled) => {
  try {
    return await pluginManager.setEnabled(id, enabled);
  } finally {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('plugin-state-changed', pluginManager.list());
    }
  }
});
ipcMain.handle('plugin-invoke', (_event, id, method, args) => pluginManager.invoke(id, method, args));
app.on('before-quit', () => {
  pluginManager.dispose().catch(error => console.error('[plugins] shutdown failed:', error.message));
});

// ---------- 文件下载 ----------

function sanitizeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|\s()]+/g, '_').slice(0, 120);
}

// 下载走浏览器原生流程:persist:canvas 会话里触发 downloadURL,由 will-download 落盘。
// Canvas 对学生隐藏文件直链,这是唯一可靠方式,且需要登录(未登录会弹 SSO)。
let downloadQueue = Promise.resolve();
let pendingDownloads = 0;
let schoolRestartPending = false;

function queueDownload(task) {
  if (schoolRestartPending) return Promise.reject(new Error('正在重启以切换学校'));
  pendingDownloads++;
  const run = downloadQueue.then(task, task).finally(() => { pendingDownloads--; });
  downloadQueue = run.catch(() => {});
  return run;
}

function downloadFile({ courseId, fileId, courseCode, filename }) {
  return queueDownload(async () => {
    const t0 = Date.now();
    console.log(`[download] start ${filename} (course ${courseId}, file ${fileId})`);
    let tracked = false;
    const finish = (ok, extra) => {
      if (tracked) return;
      tracked = true;
      track('download', { ok, ms: Date.now() - t0, bytes: extra && extra.bytes, err: extra && extra.err, ext: path.extname(filename).slice(1).toLowerCase() || '?' });
    };
    const ses = session.fromPartition(SESSION_PARTITION);
    const dir = path.join(FILES_DIR, sanitizeName(courseCode));
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, sanitizeName(filename));

    await withSessionWindow(async (win) => {
      console.log('[download] session ready, triggering downloadURL');
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          ses.removeListener('will-download', onDownload);
          reject(new Error('下载超时'));
        }, 5 * 60 * 1000);
        const onDownload = (_e, item) => {
          console.log(`[download] will-download -> ${item.getFilename()}`);
          // Canvas 对"禁止学生下载"的文件会返回一个 download.htm 页面而不是文件本体
          if (/\.html?$/i.test(item.getFilename())) {
            item.cancel();
            ses.removeListener('will-download', onDownload);
            clearTimeout(timer);
            const preview = `${CANVAS_ORIGIN}/courses/${courseId}/files/${fileId}`;
            shell.openExternal(preview).catch(console.error);
            finish(false, { err: 'restricted-by-teacher' });
            reject(new Error('此文件被老师限制下载,已在浏览器打开在线预览页'));
            return;
          }
          item.setSavePath(target);
          item.on('done', (_e2, state) => {
            console.log(`[download] done state=${state}`);
            ses.removeListener('will-download', onDownload);
            clearTimeout(timer);
            if (state === 'completed') {
              let bytes = 0;
              try { bytes = fs.statSync(target).size; } catch { /* 忽略 */ }
              finish(true, { bytes });
              resolve(target);
            } else {
              finish(false, { err: 'interrupted-' + state });
              reject(new Error('下载中断:' + state));
            }
          });
        };
        ses.on('will-download', onDownload);
        win.webContents.downloadURL(`${CANVAS_ORIGIN}/courses/${courseId}/files/${fileId}/download?download_frd=1`);
      });
    }).catch((e) => {
      finish(false, { err: String(e.message).slice(0, 80) });
      throw e;
    });
    console.log(`[download] saved ${target}`);
    return target;
  });
}


function createWindow() {
  mainRendererReady = false;
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 960,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.on('did-start-loading', () => { mainRendererReady = false; });
  // 渲染进程 console 转发到主进程 stdout,便于排错
  mainWindow.webContents.on('console-message', (_e, levelOrParams, maybeMsg) => {
    const msg = typeof levelOrParams === 'object' ? levelOrParams.message : maybeMsg;
    console.log('[renderer]', msg);
  });
  // F12 开发者工具,Ctrl+R 刷新(方便排错)
  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12') {
      mainWindow.webContents.toggleDevTools();
    } else if (input.control && input.key.toLowerCase() === 'r') {
      mainWindow.webContents.reload();
    }
  });
  // 普通关窗隐藏到托盘;应用退出时由 before-quit 放行关闭
  mainWindow.on('close', (e) => {
    if (!app.isQuiting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

ipcMain.handle('load-local', () => readLocalData());
ipcMain.on('renderer-ready', event => {
  if (mainWindow && event.sender === mainWindow.webContents) {
    mainRendererReady = true; deliverWidgetLink();
  }
});
ipcMain.handle('refresh', () => doSync());
ipcMain.handle('sync-progress-current', () => currentSyncProgress);
ipcMain.handle('debug-dump', (_e, obj) => {
  fs.writeFileSync(path.join(DATA_DIR, 'debug.json'), JSON.stringify(obj, null, 2), 'utf-8');
});
ipcMain.handle('open-url', (_e, url) => {
  let u = String(url || '');
  if (u.startsWith('/')) u = CANVAS_ORIGIN + u; // 模块里的页面链接是相对路径
  if (/^https?:\/\//.test(u)) shell.openExternal(u).catch(console.error);
});
ipcMain.handle('download-file', (_e, arg) => downloadFile(arg));
// 已下载课件的本地路径 / 打开 / 定位
function localFilePath({ courseCode, filename }) {
  return path.join(FILES_DIR, sanitizeName(courseCode), sanitizeName(filename));
}
ipcMain.handle('check-downloaded', (_e, items) => {
  const out = {};
  for (const it of items || []) {
    out[`${it.courseCode}/${it.filename}`] = fs.existsSync(localFilePath(it));
  }
  return out;
});
ipcMain.handle('open-file', (_e, arg) => {
  const p = localFilePath(arg);
  if (!fs.existsSync(p)) throw new Error('文件还没下载');
  const err = shell.openPath(p);
  if (err) throw new Error(err);
  return p;
});
ipcMain.handle('reveal-file', (_e, arg) => {
  const p = localFilePath(arg);
  if (!fs.existsSync(p)) throw new Error('文件还没下载');
  shell.showItemInFolder(p);
  return true;
});

// ---------- 应用内更新(公开仓库,无需令牌) ----------

function cmpVersion(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

ipcMain.handle('app-version', () => app.getVersion());
ipcMain.handle('telemetry-config', () => ({ enabled: telemetryEnabled() }));
ipcMain.handle('telemetry-set-enabled', (_e, enabled) => {
  try {
    fs.mkdirSync(path.dirname(TELEMETRY_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TELEMETRY_CONFIG_PATH, JSON.stringify({ enabled: !!enabled }, null, 2), 'utf-8');
    track('telemetry-toggle', { enabled: !!enabled });
  } catch (e) { console.error('[telemetry] set config failed:', e.message); }
  return telemetryEnabled();
});
ipcMain.handle('export-telemetry', () => {
  const out = exportTelemetry();
  shell.showItemInFolder(out);
  return out;
});
const PUBLIC_DOWNLOADS = 'https://sixmonthfly.github.io/canvas-manager/release.json';
let checkedUpdate = null;
ipcMain.handle('check-update', async () => {
  const response = await fetch(PUBLIC_DOWNLOADS, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('Update information unavailable: HTTP ' + response.status);
  const release = await response.json();
  const platform = process.platform === 'darwin' && process.arch === 'arm64' ? 'mac'
    : process.platform === 'win32' && process.arch === 'x64' ? 'windows' : null;
  const pkg = platform && release.packages?.[platform];
  if (!pkg?.available || !/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('No published build for this platform.');
  const expected = platform === 'mac' ? 'CanvasManager-' + pkg.version + '-mac-arm64.dmg' : 'CanvasManager-Setup-' + pkg.version + '-x64.exe';
  const trustedURL = 'https://github.com/SixMonthFly/canvas-manager/releases/download/v' + pkg.version + '/' + expected;
  if (pkg.filename !== expected || pkg.url !== trustedURL || !/^[a-f0-9]{64}$/.test(pkg.sha256)) throw new Error('Invalid release metadata.');
  checkedUpdate = { ...pkg };
  const en = uiPreferences.read().language === 'en';
  return { current: app.getVersion(), latest: pkg.version, isNewer: cmpVersion(pkg.version, app.getVersion()) > 0,
    notes: en ? 'A newer version is available. Download the full installer from the official GitHub release, quit the app, then install it. Your courses and settings are kept.'
      : '发现新版本。请从 GitHub 正式发布页下载完整安装包，退出应用后安装。课程、设置和登录会话会保留。',
    url: trustedURL, assets: [] };
});
ipcMain.handle('run-update', async () => {
  if (!checkedUpdate || cmpVersion(checkedUpdate.version, app.getVersion()) <= 0) throw new Error('Check for an update first.');
  await shell.openExternal(checkedUpdate.url);
  return { opened: true };
});

ipcMain.handle('ui-preferences', () => uiPreferences.read());
ipcMain.handle('ui-preferences-save', (_event, patch) => {
  if (patch?.language && patch.language !== uiPreferences.read().language && (syncing || pendingDownloads || pluginManager.isBusy())) {
    throw new Error(uiPreferences.read().language === 'en' ? 'Wait for active tasks before changing language.' : '请等待同步、下载或插件任务完成后再切换语言。');
  }
  const result = uiPreferences.save(patch);
  updateTrayMenu();
  return result;
});

ipcMain.handle('school-config', () => ({ schools, active: SCHOOL, selected: readSchool(DATA_ROOT).id }));
function saveSchool(id, continuingOnboarding = false) {
  if (schoolRestartPending) throw new Error('正在重启以切换学校');
  const switching = id !== SCHOOL.id;
  if (switching && (syncing || pendingDownloads || pluginManager.isBusy())) {
    throw new Error('请等待同步、下载或插件任务完成后再切换学校');
  }
  const previous = readSchool(DATA_ROOT);
  const selected = writeSchool(DATA_ROOT, id);
  if (continuingOnboarding) {
    try { uiPreferences.save({ onboardingStatus: 'pending', onboardingStep: 3, onboardingSchool: selected.id }); }
    catch (error) { writeSchool(DATA_ROOT, previous.id); throw error; }
  }
  if (selected.id !== SCHOOL.id) {
    schoolRestartPending = true;
    setTimeout(() => { app.relaunch(); app.quit(); }, 200);
  }
  return { restartRequired: schoolRestartPending };
}
ipcMain.handle('school-save', (_event, id) => saveSchool(id));
ipcMain.handle('onboarding-connect', (_event, id) => saveSchool(id, true));

app.whenReady().then(async () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // MCP follows the running school, never an unapplied settings draft.
  const activePath = path.join(DATA_ROOT, 'active-school.json');
  let previousSchool = 'hkust-gz';
  try { previousSchool = JSON.parse(fs.readFileSync(activePath, 'utf8')).schoolId; } catch { /* first multi-school launch */ }
  if (previousSchool !== SCHOOL.id && nativeWidgets.available()) {
    await nativeWidgets.publish({ schemaVersion: 1, enabled: false, hasCourses: false, syncedAt: null, assignments: [] });
  }
  const contextPath = path.join(DATA_DIR, 'school-context.json');
  fs.writeFileSync(contextPath + '.tmp', JSON.stringify({ schoolId: SCHOOL.id, origin: CANVAS_ORIGIN }));
  fs.renameSync(contextPath + '.tmp', contextPath);
  fs.writeFileSync(activePath + '.tmp', JSON.stringify({ schoolId: SCHOOL.id, origin: CANVAS_ORIGIN }));
  fs.renameSync(activePath + '.tmp', activePath);
  await pluginManager.initialize();
  app.setAppUserModelId('com.hkustgz.canvas-tool');
  track('app-start', telemetryEnv());
  syncBridge.start().catch((error) => console.error('[sync-bridge] startup failed:', error.code || error.message));

  // canvas-res://f/<encodeURIComponent(原始URL)> -> 带 Canvas 登录态取回资源
  protocol.handle('canvas-res', async (req) => {
    try {
      const u = new URL(req.url);
      let target = decodeURIComponent(u.pathname.startsWith('/') ? u.pathname.slice(1) : u.pathname);
      if (target.startsWith('/')) target = CANVAS_ORIGIN + target;
      if (!isCanvasUrl(target, CANVAS_ORIGIN)) return new Response('forbidden', { status: 403 });
      const r = await session.fromPartition(SESSION_PARTITION).fetch(target, { redirect: 'follow' });
      const buf = Buffer.from(await r.arrayBuffer());
      return new Response(buf, {
        status: r.status,
        headers: {
          'content-type': r.headers.get('content-type') || 'application/octet-stream',
          'cache-control': 'public, max-age=3600',
        },
      });
    } catch (e) {
      return new Response('upstream error: ' + e.message, { status: 502 });
    }
  });

  createWindow();
  setupTray();
  setTimeout(checkReminders, 15 * 1000);
  setInterval(checkReminders, 60 * 1000);
  setTimeout(autoSync, 3 * 60 * 1000);
  setInterval(autoSync, 30 * 60 * 1000);
  // macOS 点 Dock 图标也会触发 activate;隐藏窗口仍算存活窗口,需主动显示。
  app.on('activate', () => showMainWindow());
});

// 托盘常驻,普通关窗不退出;所有应用退出入口统一放行窗口关闭
app.on('window-all-closed', () => {});
app.on('before-quit', () => {
  // Command+Q、应用菜单、托盘及 app.quit() 都必须先设置标记。
  app.isQuiting = true;
  syncBridge.close();
});
} // 单实例锁 else 结束
