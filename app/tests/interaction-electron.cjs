// Run: app/node_modules/electron/dist/electron.exe app/tests/interaction-electron.cjs
// Uses synthetic course data and never contacts Canvas or AI providers.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const applicationRoot = process.env.CANVAS_TEST_APP_ROOT || path.join(__dirname, '..');
app.setPath('userData', path.join(os.tmpdir(), `canvas-interaction-test-${process.pid}`));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1200, height: 760, show: false,
    webPreferences: { preload: path.join(__dirname, 'interaction-preload.cjs'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const js = code => win.webContents.executeJavaScript(code);
  const rendererErrors = [];
  win.webContents.on('console-message', details => {
    if (details.level === 'error') rendererErrors.push(details.message);
  });
  const waitFor = async code => {
    const end = Date.now() + 4000;
    while (Date.now() < end) {
      if (await js(code)) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out: ${code}`);
  };
  try {
    await win.loadFile(path.join(applicationRoot, 'renderer', 'index.html'));
    await waitFor('document.querySelectorAll(".nav-item").length === 3');
    await js('pluginHost.whenSettled()');
    assert(await js('document.body.dataset.theme === "hkust" && Array.from(document.querySelectorAll("#theme-select option"), option => option.value).join() === "hkust"'),
      'Fresh preferences use HKUST and offer only installed skin plugins');
    assert(await js('document.querySelectorAll("#stage .board").length === 3 && !document.querySelector("#ai-provider") && !document.querySelector("#detail-interpret")'),
      'Fresh install has only core boards and no AI components');
    assert.equal(await js('testPlugins.stats().pluginCalls'), 0, 'Disabled AI never probes a model or loads its settings');
    assert.equal(await js('!!document.querySelector(".sync-icon")'), false);
    assert(await js('document.querySelector("#sync-progress").classList.contains("hidden")'),
      'Reload does not replay an old completion banner');
    assert(await js(`(() => {
      const stage = document.querySelector('#stage');
      return stage.dataset.mode === 'home' && document.querySelectorAll('#home-view .cal-day').length >= 35
        && !!document.querySelector('#home-view .cal-more') && !!document.querySelector('#home-view .cal-item.cc0');
    })()`), 'All courses shows one fixed board: next deadline and a 30-day calendar coloured by course');
    assert(await js(`(() => {
      window.testNav = document.querySelectorAll('.nav-item')[1];
      testNav.click(); testNav.focus();
      return testNav === document.querySelectorAll('.nav-item')[1] && document.activeElement === testNav;
    })()`), 'Course navigation preserves nodes and focus');
    assert(await js(`(() => {
      const stage = document.querySelector('#stage');
      if (stage.dataset.mode !== 'overview' || document.querySelectorAll('#stage .board').length !== 3) return false;
      if (!document.querySelector('.board[data-board="assignments"] .board-surface').inert) return false;
      document.querySelector('.board[data-board="assignments"]').click();
      return stage.dataset.mode === 'focus' && activeSection === 'assignments'
        && !document.querySelector('.board[data-board="assignments"] .board-surface').inert
        && document.querySelector('.board[data-board="files"] .board-surface').inert;
    })()`), 'A course opens as three core preview boards; clicking one brings it to the stage');
    const openingState = await js(`(() => {
      window.testRow = document.querySelectorAll('#assignment-list .row')[15];
      const list = document.querySelector('#assignment-list');
      list.scrollTop = 350;
      window.testScroll = list.scrollTop;
      testRow.click();
      return { sameNode: testRow === document.querySelectorAll('#assignment-list .row')[15], before: testScroll, after: list.scrollTop };
    })()`);
    assert(openingState.sameNode && openingState.before === openingState.after,
      'Opening details preserves list nodes and scroll position: ' + JSON.stringify(openingState));
    assert(await js(`(() => {
      document.querySelector('#detail-close').focus();
      closeDetail();
      return document.activeElement === testRow;
    })()`), 'Closing details returns keyboard focus');
    await js('document.querySelectorAll("#assignment-list .row")[16].click()');
    await new Promise(resolve => setTimeout(resolve, 230));
    assert(await js('!document.querySelector("#detail-panel").classList.contains("hidden") && currentDetail.a.id === 116'),
      'Reopening interrupts the pending close without hiding the new detail');

    assert(await js(`(() => {
      const row = document.querySelectorAll('#assignment-list .row')[16];
      selectSection('announcements');
      return row === document.querySelectorAll('#assignment-list .row')[16] && document.querySelector('#detail-panel').classList.contains('hidden');
    })()`), 'Switching boards keeps the other boards mounted and closes the assignment detail');
    assert(await js(`(() => {
      window.testAnn = document.querySelector('.ann-row');
      const head = testAnn.querySelector('.ann-head');
      head.click();
      window.testBody = testAnn.querySelector('.ann-body');
      testBody.click();
      if (!testAnn.classList.contains('expanded')) return false;
      head.click(); head.click();
      return testAnn === document.querySelector('.ann-row') && testBody === testAnn.querySelector('.ann-body');
    })()`), 'Announcements expand in place and reading their body does not close them');

    await js('selectSection("files")');
    assert(await js('document.querySelector("#files-list").textContent.includes("lecture-1.pdf")'),
      'Files appear before local status lookup completes');
    await js('document.querySelectorAll(".nav-item")[2].click()');
    await waitFor('document.querySelector("#files-list").textContent.includes("打开")');
    await new Promise(resolve => setTimeout(resolve, 400));
    assert(await js('document.querySelector("#files-list").textContent.includes("lecture-2.pdf") && localFiles["WRIT1001/lecture-2.pdf"] === true'),
      'A slower previous course cannot overwrite the latest file status');
    await js('document.querySelector("#settings-btn").click()');
    await waitFor('!!document.querySelector("#plugins-list input[type=checkbox]")');
    await js('document.querySelector("#settings-plugins-tab").click()');
    assert.equal(await js('document.querySelector("#plugins-list input[type=checkbox]").checked'), false,
      'Settings → Plugins exposes AI as an unchecked option');
    assert(await js('document.querySelector("#plugins-list").textContent.includes("已安装") && document.querySelector("#plugins-list").textContent.includes("安装包自带") && document.querySelector("#plugins-list").textContent.includes("v4.0.0")'),
      'Plugin card reports its offline bundle source, installed state and version');
    assert.equal(await js('testPlugins.stats().pluginCalls'), 0, 'Opening ordinary settings does not call AI');
    await js('document.querySelector("#plugins-list input[type=checkbox]").click()');
    await waitFor('document.querySelectorAll("#stage .board").length === 4 && !!document.querySelector("#ai-provider")');
    await waitFor('!!document.querySelector("#detail-interpret")');
    await js('pluginHost.whenSettled()');
    const settingsBounds = await js(`(() => {
      const bounds = selector => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom };
      };
      return { height: innerHeight, theme: document.body.dataset.theme,
        modal: bounds('#settings-modal .modal-body'), title: bounds('#settings-title'), complete: bounds('#settings-close-btn') };
    })()`);
    assert.equal(settingsBounds.theme, 'hkust', 'The viewport regression covers the confirmed default HKUST skin');
    assert(settingsBounds.modal.top >= 0 && settingsBounds.modal.bottom <= settingsBounds.height
      && settingsBounds.title.top >= settingsBounds.modal.top && settingsBounds.complete.bottom <= settingsBounds.modal.bottom,
      'Enabled plugin settings keep the dialog, heading and Done button inside the viewport: ' + JSON.stringify(settingsBounds));
    assert(await js(`(() => {
      const panel = document.querySelector('#settings-plugins-panel');
      panel.scrollTop = panel.scrollHeight;
      const viewport = panel.getBoundingClientRect();
      const save = document.querySelector('#ai-test-btn').getBoundingClientRect();
      const complete = document.querySelector('#settings-close-btn').getBoundingClientRect();
      const reachable = panel.scrollHeight > panel.clientHeight && save.top >= viewport.top && save.bottom <= viewport.bottom
        && document.querySelector('#settings-title').getBoundingClientRect().top >= 0 && complete.bottom <= innerHeight;
      panel.scrollTop = 0;
      return reachable;
    })()`), 'Scrollable settings expose the inner test action while keeping the heading and outer buttons visible');
    assert.equal(await js('!!document.querySelector("#ai-save-btn")'), false, 'AI settings use the single global Save action');
    await js('testPlugins.failNextDisable(); document.querySelector("#plugins-list input[type=checkbox]").click()');
    await waitFor('document.querySelector("#toast").textContent.includes("PLUGIN_BUSY")');
    await js('pluginHost.whenSettled()');
    assert(await js('document.querySelector("#plugins-list input[type=checkbox]").checked && document.querySelectorAll("#stage .board").length === 4'),
      'Failed disabling restores the checkbox and keeps active plugin UI');
    await js('document.querySelector("#settings-close-btn").click(); selectSection("assignments"); document.querySelectorAll("#assignment-list .row")[0].click(); document.querySelector("#detail-interpret").click()');
    await waitFor('document.querySelector("#detail-interpretation").textContent.includes("Synthetic AI response")');
    assert.equal(await js('testPlugins.stats().eventSubscriptions'), 1, 'An enabled plugin owns one progress subscription');
    for (const [button, panel] of [['detail-interpret', 'detail-interpretation'], ['detail-plan-btn', 'detail-plan']]) {
      await js(`testPlugins.holdChats(); document.querySelectorAll('#assignment-list .row')[0].click(); document.querySelector('#${button}').click()`);
      await waitFor('testPlugins.stats().heldChats === 1');
      await js(`document.querySelectorAll('#assignment-list .row')[1].click(); document.querySelector('#${button}').click()`);
      await waitFor('testPlugins.stats().heldChats === 2');
      await js('testPlugins.releaseChat(0)');
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(await js(`document.querySelector('#${button}').disabled`), true,
        'An old detail response cannot unlock a new detail request: ' + button);
      await js('testPlugins.releaseChat(1)');
      await waitFor(`document.querySelector('#${panel}').textContent.includes('Synthetic AI response 1') && !document.querySelector('#${button}').disabled`);
      await js('testPlugins.stopHolding()');
    }
    await js('document.querySelectorAll(".nav-item")[1].click(); selectSection("analysis"); document.querySelectorAll(".nav-item")[2].click()');
    await waitFor('document.querySelector("#analysis-result").textContent.includes("Course 2 report")');
    await new Promise(resolve => setTimeout(resolve, 400));
    assert(await js('document.querySelector("#analysis-result").textContent.includes("Course 2 report")'),
      'A slower analysis response cannot replace another course report');
    assert(await js(`(() => {
      const title = document.querySelector('[data-section="analysis"]');
      title.focus(); title.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowLeft', bubbles:true}));
      return activeSection === 'files' && document.activeElement.dataset.section === 'files';
    })()`), 'Arrow keys switch boards and retain focus');
    assert(await js(`(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}));
      return document.querySelector('#stage').dataset.mode === 'overview' && document.activeElement.dataset.section === 'files';
    })()`), 'Escape returns from the stage to the overview');

    // Actual Settings button actions exercise the installation lifecycle as well as enabling.
    await js('selectSection("assignments"); document.querySelectorAll("#assignment-list .row")[0].click(); testPlugins.holdChats(); document.querySelector("#detail-interpret").click()');
    await waitFor('testPlugins.stats().heldChats === 1 && testPlugins.stats().pendingChats === 1');
    await js('openSettings().then(() => selectSettingsTab("plugins"))');
    await js('document.querySelector("button[data-plugin-uninstall=canvas-ai]").click(); pluginHost.whenSettled()');
    assert(await js('testPlugins.stats().installed && testPlugins.stats().enabled && document.querySelector("#plugins-list input[type=checkbox]").checked && !!document.querySelector("button[data-plugin-uninstall=canvas-ai]") && document.querySelectorAll("#stage .board").length === 4'),
      'Busy uninstall is rejected without changing the installed/enabled state or active UI');
    assert(await js('document.querySelector("#toast").textContent.includes("PLUGIN_BUSY")'), 'Busy uninstall explains why the operation could not finish');
    await js('testPlugins.releaseChat(0); testPlugins.stopHolding()');
    await waitFor('testPlugins.stats().pendingChats === 0 && document.querySelector("#detail-interpretation").textContent.includes("Synthetic AI response 0")');

    await waitFor('document.querySelector("#ai-model").value === "test"');
    await js('document.querySelector("#ai-provider").value="glm"; document.querySelector("#ai-provider").dispatchEvent(new Event("change")); document.querySelector("#ai-key").value="preset-draft-key"; document.querySelector("#ai-key").dispatchEvent(new Event("input")); document.querySelector("[data-effort=fast]").click()');
    assert.notEqual(await js('testPlugins.stats().config.effort'), 'disabled', 'Effort choices remain a draft until global Save');
    await js('document.querySelector("#ai-provider").value="custom"; document.querySelector("#ai-provider").dispatchEvent(new Event("change")); document.querySelector("#ai-baseurl").value="https://synthetic.invalid/v1"; document.querySelector("#ai-model").value="retained-model"; document.querySelector("#ai-key").value="retained-key"; document.querySelector("#ai-test-btn").click()');
    await waitFor('!document.querySelector("#ai-test-btn").disabled && testPlugins.stats().lastTestConfig?.model === "retained-model"');
    assert.equal(await js('testPlugins.stats().config.profiles.custom.model'), 'test', 'Testing and probing draft connection details do not persist them');
    const storedTheme = await js('localStorage.getItem("canvas-theme")');
    await js('pluginHost.install("theme-claude")');
    await js('pluginHost.whenSettled()');
    assert.equal(await js('document.querySelector("#ai-model").value'), 'retained-model', 'Unrelated plugin installation preserves AI drafts');
    assert.equal(await js('!!document.querySelector(".plugin-item[data-plugin-id=theme-claude] input")'), false, 'Skin plugins have no feature enable checkbox');
    await js('selectSettingsTab("general"); document.querySelector("#theme-select").value="claude"; document.querySelector("#theme-select").dispatchEvent(new Event("change")); document.querySelector("#telemetry-toggle").checked=false; document.querySelector("#telemetry-toggle").dispatchEvent(new Event("change"))');
    assert.equal(await js('document.body.dataset.theme'), 'claude', 'Installed skin choices can be previewed');
    assert.equal(await js('localStorage.getItem("canvas-theme")'), storedTheme, 'Preview does not persist appearance');
    assert.equal(await js('testPlugins.stats().telemetryEnabled'), true, 'Diagnostic preference stays a draft');
    await js('testPlugins.failNextSave(); document.querySelector("#settings-save-btn").click()');
    await waitFor('document.querySelector("#toast").textContent.includes("SYNTHETIC_SETTINGS_SAVE_FAILED") && !document.querySelector("#settings-save-btn").disabled');
    assert(await js('!document.querySelector("#settings-modal").classList.contains("hidden") && document.querySelector("#ai-model").value === "retained-model" && document.querySelector("#ai-key").value === "retained-key" && !document.querySelector("#telemetry-toggle").checked'),
      'Failed global Save keeps the modal and fields available for retry');
    assert.equal(await js('localStorage.getItem("canvas-theme")'), storedTheme, 'Failed Save does not commit appearance');
    await js('document.querySelector("#settings-save-btn").click()');
    await waitFor('document.querySelector("#settings-modal").classList.contains("hidden") && !document.querySelector("#settings-save-btn").disabled');
    assert(await js('testPlugins.stats().config.provider === "custom" && testPlugins.stats().config.profiles.custom.model === "retained-model" && testPlugins.stats().config.profiles.custom.apiKey === "retained-key" && testPlugins.stats().config.profiles.custom.baseUrl === "https://synthetic.invalid/v1" && testPlugins.stats().config.effort === "disabled" && testPlugins.stats().config.thinkingModel === "retained-model" && testPlugins.stats().config.thinkingProvider === "custom" && !testPlugins.stats().telemetryEnabled && localStorage.getItem("canvas-theme") === "claude"'),
      'One Save commits provider/key/model/base URL/effort, probe metadata, appearance and diagnostics, including a boolean false result');
    await js('openSettings();');
    await js('selectSettingsTab("general"); document.querySelector("#theme-select").value="hkust"; document.querySelector("#theme-select").dispatchEvent(new Event("change")); document.querySelector("#telemetry-toggle").checked=true; selectSettingsTab("plugins"); document.querySelector("#ai-model").value="cancelled-model"; document.querySelector("#settings-close-btn").click()');
    assert(await js('document.body.dataset.theme === "claude" && localStorage.getItem("canvas-theme") === "claude" && !testPlugins.stats().telemetryEnabled && testPlugins.stats().config.profiles.custom.model === "retained-model"'),
      'Cancel restores committed appearance and leaves model/diagnostic preferences unchanged');
    await js('closeSettings(); selectSection("analysis")');
    await waitFor('document.querySelector("#analysis-result").textContent.includes("Course 2 report")');
    const originalGeneration = await js('testPlugins.stats().generation');
    await js('openSettings().then(() => selectSettingsTab("plugins"))');
    assert(await js(`(() => {
      const button = document.querySelector('button[data-plugin-uninstall="canvas-ai"]');
      button.focus(); button.click(); button.click();
      return document.querySelector('#plugins-list input[type=checkbox]').disabled
        && document.querySelector('button[data-plugin-uninstall="canvas-ai"]').disabled;
    })()`), 'Uninstall immediately locks both controls and ignores a duplicate operation');
    await js('pluginHost.whenSettled()');
    assert.equal(await js('testPlugins.stats().uninstallCalls'), 2, 'Only the busy attempt and one successful uninstall reached the backend');
    assert(await js('!testPlugins.stats().installed && !testPlugins.stats().enabled && document.querySelector("#plugins-list input[type=checkbox]").disabled && !document.querySelector("#plugins-list input[type=checkbox]").checked && !!document.querySelector("button[data-plugin-install=canvas-ai]")'),
      'Successful uninstall exposes offline reinstall and prevents enabling missing files');
    assert(await js('activeSection === "overview" && document.querySelectorAll("#stage .board").length === 3 && !document.querySelector("#analysis-result") && !document.querySelector("#detail-interpret") && !document.querySelector("#ai-provider") && document.querySelectorAll("link[data-plugin=canvas-ai]").length === 0'),
      'Uninstall removes the renderer, its boards/actions/settings/style and returns to overview');
    assert.equal(await js('testPlugins.stats().eventSubscriptions'), 0, 'Uninstall removes plugin subscriptions');
    assert(await js('document.activeElement.dataset.pluginInstall === "canvas-ai"'), 'Focus moves to the available reinstall action');
    assert(await js('testPlugins.stats().config.profiles.custom.model === "retained-model" && testPlugins.stats().reports[2].report === "Course 2 report" && courses.length === 2 && document.querySelectorAll(".nav-item").length === 3'),
      'Uninstall preserves model preferences, generated reports and core course data');
    const enableCalls = await js('testPlugins.stats().enableCalls');
    await js('document.querySelector("#plugins-list input[type=checkbox]").click()');
    assert.equal(await js('testPlugins.stats().enableCalls'), enableCalls, 'An uninstalled plugin cannot be enabled from its checkbox');

    assert(await js(`(() => {
      const button = document.querySelector('button[data-plugin-install="canvas-ai"]');
      button.focus(); button.click(); button.click();
      return document.querySelector('button[data-plugin-install="canvas-ai"]').disabled;
    })()`), 'Offline reinstall locks the card and ignores double clicks');
    await js('pluginHost.whenSettled()');
    assert.equal(await js('testPlugins.stats().installCalls'), 1, 'Only one offline installation reached the backend');
    assert(await js('testPlugins.stats().installed && !testPlugins.stats().enabled && !document.querySelector("#plugins-list input[type=checkbox]").disabled && !document.querySelector("#plugins-list input[type=checkbox]").checked && document.querySelectorAll("#stage .board").length === 3 && !document.querySelector("#ai-model")'),
      'Reinstallation restores installed files but leaves the plugin unchecked and unloaded');
    assert.notEqual(await js('testPlugins.stats().generation'), originalGeneration, 'Reinstallation publishes a new renderer generation');
    assert.equal(await js('testPlugins.stats().eventSubscriptions'), 0, 'Reinstallation alone does not subscribe to plugin events');
    assert(await js('document.activeElement === document.querySelector("#plugins-list input[type=checkbox]")'), 'Focus moves to the enable control after reinstall');
    await js('document.querySelector("#plugins-list input[type=checkbox]").click(); pluginHost.whenSettled()');
    await waitFor('document.querySelector("#ai-model")?.value === "retained-model"');
    assert(await js('document.querySelector("#ai-key").value === "retained-key" && document.querySelector("#ai-baseurl").value === "https://synthetic.invalid/v1"'),
      'Enabling a reinstalled plugin restores the saved model and connection preferences');
    await js('closeSettings(); selectSection("analysis")');
    await waitFor('document.querySelector("#analysis-result").textContent.includes("Course 2 report")');
    await js('selectSection("assignments"); document.querySelectorAll("#assignment-list .row")[0].click(); document.querySelector("#detail-interpret").click()');
    await waitFor('document.querySelector("#detail-interpretation").textContent.includes("Synthetic AI response")');
    assert.equal(await js('testPlugins.stats().eventSubscriptions'), 1, 'Reinstalled plugin owns exactly one event subscription');
    assert.equal(await js('document.querySelectorAll("link[data-plugin=canvas-ai]").length'), 1, 'Reinstalled plugin loads exactly one stylesheet');
    assert.equal(await js('document.querySelectorAll("#detail-interpret").length'), 1, 'Reinstalled plugin adds exactly one interpretation action');

    await js('selectSection("analysis"); openSettings().then(() => selectSettingsTab("plugins"))');
    await js('document.querySelector("#plugins-list input[type=checkbox]").click(); pluginHost.whenSettled()');
    await waitFor('document.querySelectorAll("#stage .board").length === 3 && !document.querySelector("#analysis-result")');
    assert(await js('activeSection === "overview" && !document.querySelector("#detail-interpret") && !document.querySelector("#ai-provider")'),
      'Disabling an installed plugin removes all contributed UI and returns to overview');
    assert.equal(await js('testPlugins.stats().eventSubscriptions'), 0, 'Disabling removes plugin subscriptions');
    for (let cycle = 0; cycle < 2; cycle++) {
      await js('document.querySelector("#plugins-list input[type=checkbox]").click(); pluginHost.whenSettled()');
      await waitFor('document.querySelectorAll("#stage .board").length === 4 && !!document.querySelector("#ai-provider")');
      assert.equal(await js('document.querySelectorAll("#detail-interpret").length'), 1);
      assert.equal(await js('testPlugins.stats().eventSubscriptions'), 1);
      await js('document.querySelector("#plugins-list input[type=checkbox]").click(); pluginHost.whenSettled()');
      await waitFor('document.querySelectorAll("#stage .board").length === 3 && !document.querySelector("#ai-provider")');
      assert.equal(await js('testPlugins.stats().eventSubscriptions'), 0);
    }
    await js('testPlugins.emit({ courseId:2, stage:"done", detail:"late event" })');
    assert.equal(await js('!!document.querySelector("#analysis-result")'), false);
    await js('document.querySelector("button[data-plugin-uninstall=theme-claude]").click(); pluginHost.whenSettled()');
    assert(await js('document.body.dataset.theme === "hkust" && localStorage.getItem("canvas-theme") === "hkust" && !document.querySelector("#theme-select option[value=claude]") && !document.querySelector("link[data-plugin=theme-claude]")'),
      'Removing the current skin unregisters its choice/style and persists a fallback to installed HKUST');
    await js('document.querySelector("button[data-plugin-uninstall=theme-hkust]").click(); pluginHost.whenSettled()');
    assert(await js('document.body.dataset.theme === "base" && pluginHost.themes().length === 0 && Array.from(document.querySelectorAll("#theme-select option"), option => option.value).join() === "base"'),
      'Removing all skins uses a neutral core appearance with no ghost installed choices');
    const callsBeforeSkinInstall = await js('testPlugins.stats().pluginCalls');
    await js('document.querySelector("button[data-plugin-install=theme-hkust]").click(); pluginHost.whenSettled()');
    assert.equal(await js('testPlugins.stats().pluginCalls'), callsBeforeSkinInstall, 'Renderer-only skin installation never invokes a feature backend');
    await js('selectSettingsTab("general"); document.querySelector("#theme-select").value="hkust"; document.querySelector("#theme-select").dispatchEvent(new Event("change")); document.querySelector("#settings-save-btn").click()');
    await waitFor('document.querySelector("#settings-modal").classList.contains("hidden")');
    assert.equal(await js('document.querySelectorAll("link[data-plugin=theme-hkust]").length'), 1, 'Reinstalled skin mounts exactly one stylesheet');
    assert.deepEqual(rendererErrors, [], 'Renderer and dynamic plugin imports have no console errors');
    const output = path.join(__dirname, '..', '..', 'output', 'v4.0.0');
    fs.mkdirSync(output, { recursive: true });
    await js('openSettings().then(() => selectSettingsTab("plugins"))');
    win.showInactive();
    await new Promise(resolve => setTimeout(resolve, 4100));
    fs.writeFileSync(path.join(output, 'plugins-default-disabled.png'), (await win.webContents.capturePage()).toPNG());

    console.log('PASS: HKUST default/installed skin registry and uninstall fallbacks; unified Save, retry and Cancel for AI/effort/probe/appearance/diagnostics; offline plugin lifecycle, retained data, cleanup and core async races.');
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
