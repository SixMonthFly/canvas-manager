const fs = require('node:fs');
const path = require('node:path');
const { upcomingAssignments } = require('./assignments.cjs');

module.exports.activate = async ctx => {
  const { canvas, storage, desktop } = ctx.services;
  if (desktop.platform !== 'darwin') throw new Error('七天作业桌面卡片目前仅支持 Mac');
  const configPath = path.join(storage.dataDir, 'desktop_assignments.json');
  let config = { pinned: false, showCompleted: false };
  try {
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8')) || {};
    config.pinned = saved.pinned === true;
    config.showCompleted = saved.showCompleted === true;
    if (Number.isFinite(saved.bounds?.x) && Number.isFinite(saved.bounds?.y)) {
      config.bounds = { x: saved.bounds.x, y: saved.bounds.y, width: 360, height: 480 };
    }
  } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  let win = null, opening = null, disposed = false, moveTimer;
  const alive = () => win && !win.isDestroyed();
  function persist(next) {
    fs.mkdirSync(storage.dataDir, { recursive: true });
    const temporary = `${configPath}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(temporary, configPath);
      config = next;
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  function snapshot() {
    const data = canvas.readLocalData();
    const now = Date.now();
    return { items: upcomingAssignments(data, { now, showCompleted: config.showCompleted }),
      now, syncedAt: data.syncedAt || null, hasCourses: !!data.courses?.length,
      pinned: config.pinned, showCompleted: config.showCompleted };
  }
  function refresh() {
    if (alive()) win.webContents.send('desktop-card-changed');
  }
  async function show() {
    if (disposed) throw new Error('插件已关闭');
    if (opening) return opening;
    if (alive()) { win.showInactive(); return true; }
    opening = (async () => {
      const card = await desktop.createCard({ html: path.join(__dirname, 'widget.html'),
        preload: path.join(__dirname, 'preload.cjs'), bounds: config.bounds, pinned: config.pinned,
        onInvoke(method, ...args) {
          if (disposed || !Object.hasOwn(cardMethods, method)) throw new Error('桌面卡片操作无效');
          return cardMethods[method](...args);
        },
        onMove(bounds) {
          clearTimeout(moveTimer);
          moveTimer = setTimeout(() => {
            if (disposed) return;
            try { persist({ ...config, bounds }); } catch (error) { ctx.emit('error', error.message); }
          }, 250);
        },
      });
      if (disposed) { card.destroy(); return false; }
      win = card;
      card.on('closed', () => { if (win === card) win = null; });
      card.showInactive();
      return true;
    })();
    try { return await opening; } finally { opening = null; }
  }
  const cardMethods = {
    snapshot,
    hide() { if (alive()) win.hide(); return true; },
    openApp() { desktop.showMainWindow(); return true; },
    setOption(key, value) {
      if (!['pinned', 'showCompleted'].includes(key) || typeof value !== 'boolean') throw new Error('卡片选项无效');
      persist({ ...config, [key]: value });
      if (key === 'pinned' && alive()) win.setAlwaysOnTop(value);
      refresh(); return snapshot();
    },
    openAssignment(courseId, id) {
      const data = canvas.readLocalData();
      if (!data.courses.some(course => String(course.id) === String(courseId))) throw new Error('课程已不在当前列表');
      const assignment = (data.byCourse[courseId] || []).find(item => String(item.id) === String(id));
      if (!assignment) throw new Error('作业已不在当前列表，请同步后重试');
      canvas.openAssignment(Number(courseId), assignment);
      return true;
    },
  };
  ctx.effect(() => {
    disposed = true; clearTimeout(moveTimer);
    if (alive()) win.destroy();
    win = null;
  });
  ctx.effect(canvas.onDataUpdated(refresh));
  const timer = setInterval(refresh, 60 * 1000);
  ctx.effect(() => clearInterval(timer));
  await show();
  return { methods: { show, snapshot }, dispose() {
    disposed = true;
    // Also destroy synchronously on app shutdown, before Electron closes windows.
    if (alive()) win.destroy();
  } };
};
