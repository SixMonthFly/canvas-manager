// Production main/preload/renderer in an isolated profile; no school network traffic.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
if (!process.versions.electron) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-school-e2e-'));
  try {
    const data = path.join(root, 'data'); fs.mkdirSync(data);
    fs.writeFileSync(path.join(data, 'courses.json'), JSON.stringify([{ id: 7, code: 'LEGACY', name: 'Preserved course' }]));
    for (const phase of ['legacy', 'nus', 'restore']) {
      const r = require('node:child_process').spawnSync(require('electron'), [__filename], {
        env: { ...process.env, CANVAS_SCHOOL_TEST_ROOT: root, CANVAS_SCHOOL_TEST_PHASE: phase }, encoding: 'utf8', timeout: 30000,
      });
      process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || '');
      assert.equal(r.status, 0, r.error?.message || `Failed ${phase}`);
    }
    console.log('PASS: production school settings cancel/save, restart isolation, and legacy restoration');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
} else {
  const { app, BrowserWindow, session } = require('electron');
  const root = process.env.CANVAS_SCHOOL_TEST_ROOT;
  assert(root && root.startsWith(os.tmpdir()) && fs.existsSync(path.join(root, 'data', 'courses.json')));
  app.setPath('userData', root);
  Object.defineProperty(app, 'isPackaged', { value: true });
  app.disableHardwareAcceleration();
  app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, cb) => cb({ cancel: true })));
  let relaunched = false;
  app.relaunch = () => { relaunched = true; };
  app.on('before-quit', () => { if (process.env.CANVAS_SCHOOL_TEST_PHASE !== 'restore') assert(relaunched, 'Save must request relaunch before quitting'); });
  require('../main.js');
  const delay = ms => new Promise(r => setTimeout(r, ms));
  (async () => {
    await app.whenReady();
    let win;
    for (let n = 0; n < 200; n++) {
      win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/renderer/index.html'));
      if (win && await win.webContents.executeJavaScript('!!window.pluginHost && !!document.querySelector("#school-select option")').catch(() => false)) break;
      await delay(30);
    }
    assert(win, 'main window');
    const js = code => win.webContents.executeJavaScript(code);
    await js('pluginHost.whenSettled()');
    const phase = process.env.CANVAS_SCHOOL_TEST_PHASE;
    const config = await js('window.api.schoolConfig()');
    assert.equal(config.active.id, phase === 'nus' ? 'nus' : 'hkust-gz');
    const data = await js('window.api.loadLocal()');
    assert.equal(data.courses.length, phase === 'nus' ? 0 : 1);
    assert.equal(config.schools.length, 5);
    assert((await js('window.api.pluginsList()')).filter(item => item.kind === 'theme').every(item => !item.installed));
    assert.equal(await js('document.body.dataset.theme'), 'base');
    if (phase === 'legacy') {
      await js('openSettings();');
      await js('document.querySelector("#school-select").value="nus"; closeSettings()');
      assert(!fs.existsSync(path.join(root, 'data', 'school.json')), 'Cancel must not persist school draft');
      await js('openSettings()');
      assert.equal(await js('document.querySelector("#school-select").value'), 'hkust-gz');
      await js('document.querySelector("#school-select").value="nus"; saveSettings()');
      assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'data', 'school.json'))).schoolId, 'nus');
      assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'data', 'active-school.json'))).schoolId, 'hkust-gz');
      assert.equal((await js('window.api.loadLocal()')).courses.length, 1);
    } else if (phase === 'nus') {
      assert.equal(await js('CANVAS_ORIGIN'), 'https://canvas.nus.edu.sg');
      assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'data', 'schools', 'nus', 'school-context.json'))).origin, 'https://canvas.nus.edu.sg');
      await js('openSettings()');
      await delay(350);
      assert.equal(await js('document.querySelector("#settings-modal").classList.contains("hidden")'), false);
      const out = path.join(__dirname, '../../output/multi-school'); fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'settings-nus.png'), (await win.webContents.capturePage()).toPNG());
      await js('document.querySelector("#school-select").value="hkust-gz"; saveSettings()');
    }
    console.log(`PASS school phase: ${phase}`);
    if (phase === 'restore') app.quit();
    // Other phases quit via production's automatic restart after saving.
  })().catch(error => { console.error(error); app.exit(1); });
}
