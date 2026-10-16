// Run with Electron, passing main.js and optionally "hidden" or "tray".
// Uses production event handlers with an isolated window; no course data or network.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(process.argv[2], 'utf8');
const scenario = process.argv[3] || 'visible';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-quit-test-'));
app.setPath('userData', profile);
app.disableHardwareAcceleration();
let bridgeClosed = 0;
let closed = false;
let timer;
app.whenReady().then(() => {
  const mainWindow = new BrowserWindow({ show: false });
  const context = { app, mainWindow, syncBridge: { close() { bridgeClosed++; } } };
  const start = source.indexOf("  mainWindow.on('close',");
  assert(start >= 0);
  const end = source.indexOf('\n}', start);
  vm.runInNewContext(source.slice(start, end), context);
  const lifecycle = source.indexOf("app.on('window-all-closed',");
  assert(lifecycle >= 0);
  vm.runInNewContext(source.slice(lifecycle, source.lastIndexOf('\n}')), context);
  mainWindow.close();
  assert.equal(mainWindow.isDestroyed(), false, 'Normal close keeps the app running');
  assert.equal(mainWindow.isVisible(), false, 'Normal close hides the window');
  assert.equal(bridgeClosed, 0, 'Normal close keeps the sync bridge running');
  if (scenario !== 'hidden') mainWindow.show();
  mainWindow.on('closed', () => { closed = true; });
  timer = setTimeout(() => {
    console.error('FAIL: quit was blocked; window survived:', !mainWindow.isDestroyed());
    app.exit(1);
  }, 2000);
  app.on('will-quit', () => {
    assert(closed, 'Quit destroys the window');
    assert.equal(bridgeClosed, 1, 'Quit closes the sync bridge');
    clearTimeout(timer);
    console.log(`PASS: normal close stays resident; ${scenario} quit terminates`);
  });
  if (scenario === 'tray') {
    const match = source.match(/\{ label: '退出', click: (.*?) \},/);
    assert(match);
    vm.runInNewContext(`(${match[1]})()`, context);
  } else {
    app.quit();
  }
}).catch(error => { console.error(error); app.exit(1); });
