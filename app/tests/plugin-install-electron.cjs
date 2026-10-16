// Run with Node: node app/tests/plugin-install-electron.cjs
// CANVAS_TEST_APP_ROOT may point to the final app.asar. Both Electron phases use
// production preload/renderer and plugin manager, with temporary synthetic data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const applicationRoot = process.env.CANVAS_TEST_APP_ROOT || path.join(__dirname, '..');
const pluginId = 'canvas-ai';
const fixtureConfig = { provider: 'custom', effort: 'disabled', profiles: { custom: {
  baseUrl: 'https://fixture.invalid/v1', model: 'fixture-model', apiKey: 'synthetic-test-only',
} } };
const fixtureReport = { courseId: 1, report: 'Preserved synthetic course report', generatedAt: '2026-09-30T06:00:00.000Z' };
const courses = [{ id: 1, code: 'FIXT1000 (L01)', name: 'Synthetic plugin lifecycle course' }];
const byCourse = { 1: [{ id: 101, name: 'Synthetic assignment', published: true, points: 10,
  due_at: '2026-10-10T12:00:00.000Z', description: '<p>Read the synthetic material and explain the main idea.</p>' }] };
const fixtureData = { courses, byCourse, filesBy: { 1: { files: [], links: [] } }, annBy: { 1: [] }, syncedAt: '2026-09-30T06:00:00.000Z' };

if (!process.versions.electron) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-plugin-install-e2e-'));
  const dataDir = path.join(directory, 'userData', 'data');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(directory, '.isolated-plugin-test'), 'synthetic data only\n');
    for (const [name, value] of [['ai_config.json', fixtureConfig], ['analysis_1.json', fixtureReport], ['courses.json', courses]]) {
      fs.writeFileSync(path.join(dataDir, name), JSON.stringify(value, null, 2) + '\n');
    }
    const electron = process.env.CANVAS_TEST_ELECTRON || require('electron');
    for (const phase of ['install-uninstall', 'restart-reinstall', 'reinstalled-restart']) {
      const result = spawnSync(electron, [__filename], {
        env: { ...process.env, CANVAS_PLUGIN_TEST_DIRECTORY: directory, CANVAS_PLUGIN_TEST_PHASE: phase },
        encoding: 'utf8', timeout: 45000,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      assert.equal(result.error, undefined, `Electron ${phase}: ${result.error?.message}`);
      assert.equal(result.status, 0, `Electron ${phase} failed (signal ${result.signal || 'none'})`);
    }
    console.log('PASS: real plugin installation, restart/reinstall and AI data preservation; explicitly installed HKUST, installed Claude preview/save, physical skin removal, fallback and persisted theme choice.');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
} else {
  const { app, BrowserWindow, ipcMain, session } = require('electron');
  const { createPluginManager } = require(path.join(applicationRoot, 'core', 'plugin-manager.cjs'));
  const catalog = require(path.join(applicationRoot, 'plugins', 'catalog.json'));
  const directory = process.env.CANVAS_PLUGIN_TEST_DIRECTORY;
  assert(directory && fs.existsSync(path.join(directory, '.isolated-plugin-test')), 'Only an isolated orchestrator-created directory may be used');
  const dataDir = path.join(directory, 'userData', 'data');
  const installRoot = path.join(dataDir, 'installed-plugins');
  const phase = process.env.CANVAS_PLUGIN_TEST_PHASE;
  const preservedNames = ['ai_config.json', 'analysis_1.json', 'courses.json'];
  const preserved = Object.fromEntries(preservedNames.map(name => [name, fs.readFileSync(path.join(dataDir, name), 'utf8')]));
  app.setPath('userData', path.join(directory, 'userData'));
  app.disableHardwareAcceleration();
  let win;
  let holdModel = false;
  const heldRequests = [];
  const requestedUrls = [];
  global.fetch = async (url, options) => {
    assert.equal(String(url), 'https://fixture.invalid/v1/chat/completions', 'No real model or Canvas network is permitted');
    requestedUrls.push(String(url));
    const complete = () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Synthetic restored AI interpretation' } }] }) });
    if (!holdModel) return complete();
    return new Promise((resolve, reject) => {
      heldRequests.push(() => resolve(complete()));
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
  };
  const noNetwork = async () => { throw new Error('Canvas access is not permitted in this fixture'); };
  const manager = createPluginManager({
    catalog, bundleRoot: applicationRoot, installRoot, statePath: path.join(dataDir, 'plugins.json'),
    services: {
      canvas: { downloadFile: noNetwork, sanitizeName: value => String(value), withSessionWindow: noNetwork,
        executeWithTimeout: noNetwork, readLocalData: () => fixtureData, origin: 'https://fixture.invalid' },
      storage: { dataDir, filesDir: path.join(dataDir, 'files') },
      diagnostics: { track() {} },
      documents: { loadPdfParser: () => require(path.join(applicationRoot, 'node_modules', 'pdf-parse')).PDFParse,
        loadZip: () => require(path.join(applicationRoot, 'node_modules', 'jszip')) },
    },
    onEvent(plugin, event, data) {
      if (win && !win.isDestroyed()) win.webContents.send('plugin-event', { pluginId: plugin, event, data });
    },
  });
  const publish = () => { if (win && !win.isDestroyed()) win.webContents.send('plugin-state-changed', manager.list()); };
  for (const [channel, method] of [['plugin-set-enabled', 'setEnabled'], ['plugin-install', 'install'], ['plugin-uninstall', 'uninstall']]) {
    ipcMain.handle(channel, async (_event, ...args) => { try { return await manager[method](...args); } finally { publish(); } });
  }
  const schoolFixture = require(path.join(applicationRoot, 'core', 'schools.cjs'));
  ipcMain.handle('school-config', () => ({ schools: schoolFixture.schools, active: schoolFixture.getSchool('hkust-gz'), selected: 'hkust-gz' }));
  ipcMain.handle('school-save', (_event, id) => ({ restartRequired: id !== 'hkust-gz' }));
  const prefs = require(path.join(applicationRoot, 'core/ui-preferences.cjs')).createUIPreferences(dataDir, 'zh-CN');
  prefs.save({onboardingStatus:'completed'});
  ipcMain.handle('ui-preferences', () => prefs.read());
  ipcMain.handle('ui-preferences-save', (_event, patch) => prefs.save(patch));
  ipcMain.handle('plugins-list', () => manager.list());
  ipcMain.handle('plugin-invoke', (_event, id, method, args) => manager.invoke(id, method, args));
  for (const [channel, result] of [
    ['load-local', fixtureData], ['sync-progress-current', null], ['app-version', '4.0.0'],
    ['telemetry-config', { enabled: false }], ['check-downloaded', {}], ['check-update', { available: false }],
  ]) ipcMain.handle(channel, () => result);
  // Production returns a boolean, including false for a successful opt-out.
  ipcMain.handle('telemetry-set-enabled', (_event, enabled) => enabled);
  for (const channel of ['refresh', 'open-url', 'download-file', 'open-file', 'reveal-file', 'export-telemetry', 'run-update']) {
    ipcMain.handle(channel, noNetwork);
  }
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const waitUntil = async (predicate, description) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) { if (await predicate()) return; await delay(25); }
    throw new Error('Timed out: ' + description);
  };
  const js = code => win.webContents.executeJavaScript(code);
  const waitFor = code => waitUntil(() => js(code), code);
  const settled = async () => { await js('pluginHost.whenSettled()'); await waitUntil(() => !manager.isBusy(), 'plugin requests to settle'); };
  const manifest = (id = pluginId) => manager.list().find(item => item.id === id);
  const installedSource = (id = pluginId) => {
    const item = manifest(id);
    assert(item?.installed && item.renderer, 'Installed plugin exposes its real renderer URL');
    const renderer = new URL(item.renderer);
    assert.equal(renderer.protocol, 'file:');
    renderer.search = ''; renderer.hash = '';
    return require('node:url').fileURLToPath(renderer);
  };
  const assertDataPreserved = () => {
    for (const name of preservedNames) assert.equal(fs.readFileSync(path.join(dataDir, name), 'utf8'), preserved[name], name + ' is preserved byte-for-byte');
  };
  const assertNoInstalledSource = (id = pluginId) => {
    assert.equal(manifest(id).installed, false);
    assert.equal(manifest(id).enabled, false);
    assert.equal(manifest(id).renderer, null);
    assert(!fs.existsSync(path.join(installRoot, id)) || fs.readdirSync(path.join(installRoot, id)).length === 0,
      'Uninstall physically removes every installed source generation');
  };
  const settings = async () => {
    await js('openSettings().then(() => selectSettingsTab("plugins"))');
    await settled();
  };
  const click = async selector => {
    await waitFor(`!!document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`);
    await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await settled();
  };
  const enable = async () => {
    await click('#plugins-list input[data-plugin-id="canvas-ai"]');
    await waitFor('document.querySelectorAll("#stage .board").length === 4 && !!document.querySelector("#detail-interpret")');
    assert.equal(manifest().enabled, true);
    assert.equal(await js('document.querySelectorAll("#detail-interpret").length'), 1);
    assert.equal(await js('document.querySelectorAll("link[data-plugin=canvas-ai]").length'), 1);
    await js('document.querySelector("#settings-close-btn").click(); document.querySelectorAll(".nav-item")[1].click(); selectSection("analysis")');
    await waitFor('document.querySelector("#analysis-result").textContent.includes("Preserved synthetic course report")');
    await js('selectSection("assignments"); document.querySelector("#assignment-list .row").click()');
    assert.equal(await js('document.querySelector("#ai-key").value'), fixtureConfig.profiles.custom.apiKey);
  };
  const interpret = async () => {
    await js('document.querySelector("#detail-interpret").click()');
    await waitFor('document.querySelector("#detail-interpretation").textContent.includes("Synthetic restored AI interpretation") && !document.querySelector("#detail-interpret").disabled');
    await settled();
  };
  const screenshot = async name => {
    await settings();
    win.showInactive();
    await delay(4100);
    const destination = path.join(__dirname, '..', '..', 'output', 'v4.0.0', 'plugin-lifecycle');
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, name + '.png'), (await win.webContents.capturePage()).toPNG());
    win.hide();
  };
  const assertHkust = async () => {
    assert.equal(manifest('theme-hkust').installed, true);
    await waitFor('document.body.dataset.theme === "hkust" && document.body.dataset.themeLayout === "standard"');
    await waitFor('getComputedStyle(document.body).getPropertyValue("--header-bg").trim() === "#003366"');
    assert.equal(await js('document.querySelector("#app-title").parentElement.tagName'), 'HEADER');
  };
  const claudeCycle = async () => {
    for (const id of ['theme-claude', 'theme-chatgpt', 'theme-dark']) {
      assertNoInstalledSource(id);
      assert.equal(await js(`!!document.querySelector('link[data-plugin="${id}"]')`), false);
    }
    assert.equal(await js('!!document.querySelector("#theme-select option[value=claude]")'), false,
      'Uninstalled themes are absent from appearance choices');
    await settings();
    await click('#plugins-list button[data-plugin-install="theme-claude"]');
    const source = installedSource('theme-claude');
    fs.writeFileSync(path.join(directory, 'first-claude-source.txt'), source);
    for (const name of ['style.css', 'fonts/SourceSerif4-latin-opsz.woff2', 'fonts/SourceSerif4-OFL.txt']) {
      assert(fs.existsSync(path.join(path.dirname(source), name)), 'Claude installation includes ' + name);
    }
    assert.equal(manifest('theme-claude').enabled, false, 'Installed skin has no enabled backend capability');
    assert.equal(await js('document.body.dataset.theme'), 'hkust', 'Installing a skin does not silently select it');
    await waitFor('!!document.querySelector("#theme-select option[value=claude]")');
    await js('selectSettingsTab("general"); document.querySelector("#theme-select").value="claude"; document.querySelector("#theme-select").dispatchEvent(new Event("change", {bubbles:true}))');
    await waitFor('document.body.dataset.theme === "claude" && document.body.dataset.themeLayout === "sidebar" && document.querySelector("#app-title").parentElement.id === "nav-brand"');
    await waitFor('getComputedStyle(document.body).getPropertyValue("--bg").trim() === "#faf9f5"');
    assert.equal(await js('localStorage.getItem("canvas-theme") === "claude"'), false,
      'Appearance preview is not committed before the unified save');
    await js('document.querySelector("#settings-save-btn").click()');
    await waitFor('document.querySelector("#settings-modal").classList.contains("hidden")');
    assert.equal(await js('localStorage.getItem("canvas-theme")'), 'claude');
    await screenshot('theme-claude');
    await click('#plugins-list button[data-plugin-uninstall="theme-claude"]');
    assertNoInstalledSource('theme-claude'); assert(!fs.existsSync(source));
    await assertHkust();
    assert.equal(await js('!!document.querySelector("#theme-select option[value=claude]") || !!document.querySelector("link[data-plugin=theme-claude]")'), false,
      'Uninstall removes skin choice and stylesheet');
    await waitFor('![...document.fonts].some(font => font.family.includes("Source Serif 4 App"))');
    assert.equal(await js('localStorage.getItem("canvas-theme")'), 'hkust',
      'Uninstalling the committed theme persists its fallback; reinstall cannot revive a stale choice');
    assertDataPreserved();
  };
  app.whenReady().then(async () => {
    const rendererErrors = [];
    try {
      app.dock?.hide();
      session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
      await manager.initialize();
      if (phase === 'install-uninstall') {
        assert(manager.list().filter(item => item.kind === 'theme').every(item => !item.installed), 'Fresh profiles must not install any skins');
        await manager.install('theme-hkust'); // Existing skin lifecycle coverage starts from explicit installation.
      }
      win = new BrowserWindow({ width: 1280, height: 800, show: false,
        webPreferences: { preload: path.join(applicationRoot, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
      win.webContents.on('console-message', details => { if (details.level === 'error') rendererErrors.push(details.message); });
      await win.loadFile(path.join(applicationRoot, 'renderer', 'index.html'));
      await waitFor('document.querySelectorAll(".nav-item").length === 2 && !!window.pluginHost');
      await settled();
      assert.equal(await js('document.querySelectorAll("#stage .board").length'), phase === 'reinstalled-restart' ? 4 : 3);
      assert.equal(requestedUrls.length, 0, 'Application startup never contacts a model');
      await assertHkust();
      if (phase === 'install-uninstall') {
        await claudeCycle();
        // Fresh profiles receive the bundled plugin installed but disabled. Make
        // the explicit installation path run as well instead of only testing init.
        assert.equal(manifest().installed, true, 'A fresh profile installs the bundled plugin source');
        assert.equal(manifest().error, null, 'Fresh bundled installation succeeds without a stored error');
        assert.equal(manifest().enabled, false);
        await settings();
        if (manifest().installed) {
          const oldSource = installedSource();
          await click('#plugins-list button[data-plugin-uninstall="canvas-ai"]');
          assert(!fs.existsSync(oldSource));
        }
        assertNoInstalledSource();
        await click('#plugins-list button[data-plugin-install="canvas-ai"]');
        assert.equal(manifest().enabled, false, 'Installing does not silently enable AI');
        const firstSource = installedSource();
        assert(firstSource.startsWith(installRoot + path.sep), 'Renderer is loaded from the actual independent plugin installation');
        assert(fs.existsSync(firstSource));
        assert(fs.existsSync(path.join(path.dirname(firstSource), 'main.cjs')));
        fs.writeFileSync(path.join(directory, 'first-installed-source.txt'), firstSource);
        await enable();
        await interpret();
        await screenshot('installed');
        // Refuse uninstall while a real manager call is pending; preserve files,
        // enabled state and UI until that model request settles.
        holdModel = true;
        await js('document.querySelector("#settings-close-btn").click(); document.querySelector("#detail-interpret").click()');
        await waitUntil(() => heldRequests.length === 1, 'held model request');
        await js('openSettings().then(() => selectSettingsTab("plugins"))');
        await js('document.querySelector("#plugins-list button[data-plugin-uninstall=canvas-ai]").click()');
        await waitFor('document.querySelector("#toast").textContent.includes("PLUGIN_BUSY")');
        await js('pluginHost.whenSettled()');
        assert.equal(manifest().installed, true); assert.equal(manifest().enabled, true);
        assert(fs.existsSync(firstSource));
        assert.equal(await js('document.querySelectorAll("#stage .board").length'), 4);
        heldRequests.shift()(); holdModel = false;
        await waitFor('!document.querySelector("#detail-interpret").disabled');
        await settled();
        await click('#plugins-list button[data-plugin-uninstall="canvas-ai"]');
        assertNoInstalledSource(); assert(!fs.existsSync(firstSource));
        assert.equal(await js('document.querySelectorAll("#stage .board").length'), 3);
        assert.equal(await js('!!document.querySelector("#detail-interpret") || !!document.querySelector("#ai-provider")'), false);
      } else if (phase === 'restart-reinstall') {
        assertNoInstalledSource('theme-claude');
        assert(!fs.existsSync(fs.readFileSync(path.join(directory, 'first-claude-source.txt'), 'utf8')),
          'A fresh process keeps the removed skin source absent');
        assertNoInstalledSource();
        const firstSource = fs.readFileSync(path.join(directory, 'first-installed-source.txt'), 'utf8');
        assert(!fs.existsSync(firstSource), 'A fresh process does not restore an uninstalled bundled plugin automatically');
        assertDataPreserved();
        await settings();
        await click('#plugins-list button[data-plugin-install="canvas-ai"]');
        assert.equal(manifest().enabled, false);
        const reinstalledSource = installedSource();
        assert(fs.existsSync(reinstalledSource));
        assert.notEqual(reinstalledSource, firstSource, 'Reinstallation uses a fresh source generation and renderer module identity');
        await enable();
        await interpret();
        await settings();
        await click('#plugins-list button[data-plugin-install="theme-claude"]');
        assert(fs.existsSync(installedSource('theme-claude')));
        await waitFor('!!document.querySelector("#theme-select option[value=claude]")');
        await assertHkust();
        await screenshot('reinstalled');
      } else {
        assert.equal(phase, 'reinstalled-restart');
        assert.equal(manifest('theme-claude').installed, true);
        assert.equal(manifest('theme-claude').enabled, false);
        assert(fs.existsSync(installedSource('theme-claude')));
        assert.equal(await js('localStorage.getItem("canvas-theme")'), 'hkust');
        await assertHkust();
      }
      assertDataPreserved();
      assert.deepEqual(rendererErrors, [], 'Production preload, dynamic installed renderer and UI have no console errors');
      await manager.dispose();
      console.log('PASS Electron phase: ' + phase);
      win.destroy(); app.exit(0);
    } catch (error) {
      console.error(error);
      await manager.dispose().catch(() => {});
      win?.destroy(); app.exit(1);
    }
  });
}
