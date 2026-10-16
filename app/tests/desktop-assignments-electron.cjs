// Node orchestrates isolated Electron processes; never loads real user data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const applicationRoot = process.env.CANVAS_TEST_APP_ROOT || path.join(__dirname, '..');
if (!process.versions.electron) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-desktop-e2e-'));
  try {
    for (const phase of ['interaction', 'restart']) {
      const result = require('node:child_process').spawnSync(require('electron'), [__filename], {
        env: { ...process.env, CANVAS_DESKTOP_TEST_DIR: directory, CANVAS_DESKTOP_TEST_PHASE: phase },
        encoding: 'utf8', timeout: 45000,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      assert.ifError(result.error); assert.equal(result.status, 0, `Electron ${phase} failed`);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
} else {
  const { app, BrowserWindow, ipcMain, screen, session } = require('electron');
  const { createPluginManager } = require(path.join(applicationRoot, 'core/plugin-manager.cjs'));
  const { createDesktopService } = require(path.join(applicationRoot, 'core/desktop-service.cjs'));
  const { EventEmitter } = require('node:events');
  const directory = process.env.CANVAS_DESKTOP_TEST_DIR;
  assert(directory?.startsWith(os.tmpdir()), 'Isolated test directory required');
  app.setPath('userData', path.join(directory, 'userData'));
  app.disableHardwareAcceleration();
  const phase = process.env.CANVAS_DESKTOP_TEST_PHASE;
  const dataDir = path.join(directory, 'data');
  let main, opened;
  const courses = [{ id: 1, code: 'COMP5000 (L01)', name: '合成测试课程' }];
  const byCourse = { 1: Array.from({ length: 9 }, (_, i) => ({ id: 101 + i,
    name: i === 0 ? '<img src=x onerror=alert(1)> 编程作业' : `课程作业 ${i + 1}`,
    published: true, due_at: new Date(Date.now() + (i + 1) * 14 * 3600000).toISOString(), description: '<p>合成测试材料</p>',
    sub: i === 8 ? { state: 'submitted' } : null })) };
  let fixtureData = { courses, byCourse, filesBy: { 1: { files: [], links: [] } }, annBy: { 1: [] }, syncedAt: new Date().toISOString() };
  const events = new EventEmitter();
  const manager = createPluginManager({ catalog: require(path.join(applicationRoot, 'plugins/catalog.json')), bundleRoot: applicationRoot,
    statePath: path.join(dataDir, 'plugins.json'), services: {
      canvas: { readLocalData: () => fixtureData,
        onDataUpdated(callback) { events.on('updated', callback); return () => events.off('updated', callback); },
        openAssignment(cid, a) { opened = { cid, a }; main.show(); main.webContents.send('open-assignment', opened); } },
      storage: { dataDir }, desktop: createDesktopService({ BrowserWindow, ipcMain, screen, showMainWindow() { main.show(); } }),
    },
  });
  const schoolFixture = require(path.join(applicationRoot, 'core', 'schools.cjs'));
  ipcMain.handle('ui-preferences', () => ({language:'zh-CN',onboardingStatus:'completed',onboardingStep:2}));
  ipcMain.handle('school-config', () => ({ schools: schoolFixture.schools, active: schoolFixture.getSchool('hkust-gz'), selected: 'hkust-gz' }));
  ipcMain.handle('school-save', (_event, id) => ({ restartRequired: id !== 'hkust-gz' }));
  ipcMain.handle('plugins-list', () => manager.list());
  ipcMain.handle('plugin-invoke', (_event, id, method, args) => manager.invoke(id, method, args));
  const publish = () => main.webContents.send('plugin-state-changed', manager.list());
  for (const [channel, method] of [['plugin-install', 'install'], ['plugin-uninstall', 'uninstall'], ['plugin-set-enabled', 'setEnabled']]) {
    ipcMain.handle(channel, async (_event, ...args) => { try { return await manager[method](...args); } finally { publish(); } });
  }
  for (const [channel, result] of [['load-local', fixtureData], ['sync-progress-current', null], ['app-version', '4.0.0'],
    ['telemetry-config', { enabled: false }], ['check-downloaded', {}], ['check-update', { available: false }]]) {
    ipcMain.handle(channel, () => result);
  }
  ipcMain.handle('telemetry-set-enabled', (_event, enabled) => enabled);
  for (const channel of ['refresh', 'open-url', 'download-file', 'open-file', 'reveal-file', 'export-telemetry', 'run-update']) {
    ipcMain.handle(channel, () => { throw new Error('No network or external file access in this fixture'); });
  }
  const waitUntil = async (predicate, description) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
    throw new Error('Timed out: ' + description);
  };
  const manifest = () => manager.list().find(item => item.id === 'desktop-assignments');
  const card = () => BrowserWindow.getAllWindows().find(win => win !== main);
  const js = code => main.webContents.executeJavaScript(code);
  const cjs = code => card().webContents.executeJavaScript(code);
  app.whenReady().then(async () => {
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: /^https?:/.test(details.url) });
    });
    await manager.initialize();
    assert.equal(manifest().enabled, false); assert.equal(card(), undefined);
    assert.equal(manifest().installed, phase === 'interaction');
    main = new BrowserWindow({ show: false, width: 1200, height: 760, webPreferences: {
      preload: path.join(applicationRoot, 'preload.js'), nodeIntegration: false, contextIsolation: true,
    } });
    await main.loadFile(path.join(applicationRoot, 'renderer', 'index.html'));
    await waitUntil(() => js('window.appVersion === "4.0.0" && pluginHost.list().length > 0'), 'main renderer');
    if (phase === 'restart') {
      await js('pluginHost.install("desktop-assignments")');
      assert.equal(manifest().enabled, false); assert.equal(card(), undefined);
    }
    await js('pluginHost.setEnabled("desktop-assignments", true)');
    await waitUntil(() => cjs(`document.querySelectorAll(".assignment").length === ${phase === 'restart' ? 9 : 8}`), 'initial list with persisted options');
    assert.equal(await cjs('document.querySelectorAll("img").length'), 0);
    assert.equal(await cjs('document.querySelector(".name").textContent'), byCourse[1][0].name);
    assert.equal(await cjs('typeof window.require'), 'undefined');
    if (phase === 'restart') {
      assert.equal(card().isAlwaysOnTop(), true);
      assert.equal(await cjs('document.querySelector("#pinned").checked'), true);
    }
    main.hide(); assert.equal(card().isVisible(), true);
    await cjs('document.querySelector(".assignment").click()');
    await waitUntil(() => !!opened, 'open assignment');
    assert.equal(opened.a.id, 101); assert.equal(main.isVisible(), true);
    await waitUntil(() => js('!document.querySelector("#detail-panel").classList.contains("hidden")'), 'main assignment details');
    if (phase === 'restart') {
      assert.equal(await cjs('document.querySelector("#completed").checked'), true);
      await cjs('document.querySelector("#completed").click()');
      await waitUntil(() => cjs('document.querySelectorAll(".assignment").length === 8'), 'hide completed list');
    }
    await cjs('document.querySelector("#completed").click()');
    await waitUntil(() => cjs('document.querySelectorAll(".assignment").length === 9'), 'completed list');
    if (phase === 'interaction') {
      await cjs('document.querySelector("#pinned").click()');
      await waitUntil(() => card().isAlwaysOnTop(), 'pinning');
      byCourse[1][0].name = '编程作业 · 算法与数据结构';
      events.emit('updated');
      await waitUntil(() => cjs('document.querySelector("#pinned").checked && document.querySelector(".name").textContent === "编程作业 · 算法与数据结构"'), 'preview refresh');
      const output = path.join(__dirname, '..', '..', 'output', 'desktop-assignments');
      fs.mkdirSync(output, { recursive: true });
      const pixels = await card().webContents.capturePage();
      fs.writeFileSync(path.join(output, 'widget-preview.png'), pixels.toPNG());
    }
    fixtureData = { ...fixtureData, byCourse: { 1: [] } };
    events.emit('updated');
    await waitUntil(() => cjs('!!document.querySelector(".empty")'), 'sync refresh and empty state');
    await cjs('document.querySelector("#hide").click()');
    await waitUntil(() => !card().isVisible(), 'hide');
    await js('document.querySelector("#desktop-assignments-show").click()');
    await waitUntil(() => card().isVisible(), 'settings restore');
    await js('pluginHost.setEnabled("desktop-assignments", false)');
    assert.equal(card(), undefined); assert.equal(events.listenerCount('updated'), 0);
    assert.equal(await js('!!document.querySelector("#desktop-assignments-show")'), false);
    await js('pluginHost.uninstall("desktop-assignments")');
    assert.equal(manifest().installed, false);
    await manager.dispose(); main.destroy();
    console.log(`PASS desktop Electron ${phase}: production settings, isolated card, assignment details, pinning, refresh, disable/uninstall.`);
    app.exit(0);
  }).catch(async error => { console.error(error); await manager.dispose().catch(() => {}); app.exit(1); });
}
