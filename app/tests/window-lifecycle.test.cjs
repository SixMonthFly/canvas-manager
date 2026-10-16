const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise production handlers without booting the user's application,
// creating its data directory, or connecting to Canvas.
const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const showSource = source.slice(source.indexOf('function showMainWindow()'), source.indexOf('\nfunction setupTray()'));
const createSource = source.slice(source.indexOf('function createWindow()'), source.indexOf("\nipcMain.handle('load-local'"));
const activateSource = source.split('\n').find(line => line.includes("app.on('activate',"));
const quitSource = source.slice(source.indexOf("app.on('window-all-closed',"), source.lastIndexOf('\n}'));
assert(activateSource, 'Production activate handler must be present');

function fixture() {
  const windows = [];
  let bridgeClosed = 0;
  class Window extends EventEmitter {
    constructor(options = {}) {
      super();
      this.visible = options.show !== false;
      this.destroyed = false;
      this.minimized = false;
      this.focusCount = 0;
      this.restoreCount = 0;
      this.webContents = new EventEmitter();
      windows.push(this);
    }
    static getAllWindows() { return windows.filter(window => !window.destroyed); }
    loadFile(file) { this.file = file; }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return this.minimized; }
    isVisible() { return this.visible; }
    show() { assert(!this.destroyed); this.visible = true; }
    hide() { this.visible = false; }
    focus() { this.focusCount++; }
    minimize() { this.minimized = true; this.visible = false; }
    restore() { this.restoreCount++; this.minimized = false; this.visible = true; }
    destroy() { this.destroyed = true; this.visible = false; this.emit('closed'); }
    close() {
      let prevented = false;
      this.emit('close', { preventDefault() { prevented = true; } });
      if (!prevented) this.destroy();
    }
  }
  const app = new EventEmitter();
  app.ready = true;
  app.isReady = () => app.ready;
  app.quit = () => {
    app.emit('before-quit');
    for (const window of Window.getAllWindows()) window.close();
  };
  const context = vm.createContext({ app, BrowserWindow: Window, path,
    __dirname: path.join(__dirname, '..'), console, mainWindow: null,
    syncBridge: { close() { bridgeClosed++; } } });
  vm.runInContext(`${showSource}\n${createSource}\n${activateSource}\n${quitSource}`, context);
  return { app, Window, windows, context, get bridgeClosed() { return bridgeClosed; },
    create() { vm.runInContext('createWindow()', context); return context.mainWindow; } };
}

test('Dock activation restores the same window after every normal close', () => {
  const f = fixture();
  const main = f.create();
  for (let pass = 0; pass < 3; pass++) {
    main.close();
    assert.equal(main.isDestroyed(), false);
    assert.equal(main.isVisible(), false);
    f.app.emit('activate');
    assert.equal(main.isVisible(), true);
    assert.equal(f.context.mainWindow, main);
    assert.equal(f.windows.length, 1);
  }
  assert.equal(main.focusCount, 3);
  assert.equal(f.bridgeClosed, 0, 'Closing the window keeps background sync available');
});

test('Dock activation restores minimized windows and does not duplicate visible windows', () => {
  const f = fixture();
  const main = f.create();
  main.minimize();
  f.app.emit('activate');
  assert.equal(main.isMinimized(), false);
  assert.equal(main.isVisible(), true);
  assert.equal(main.restoreCount, 1);
  f.app.emit('activate');
  assert.equal(f.windows.length, 1);
  assert.equal(main.focusCount, 2);
});

test('A missing main window is recreated even while a login window exists', () => {
  const f = fixture();
  const main = f.create();
  const auxiliary = new f.Window({ show: false });
  main.destroy();
  assert.equal(f.context.mainWindow, null);
  f.app.emit('activate');
  assert.notEqual(f.context.mainWindow, main);
  assert.notEqual(f.context.mainWindow, auxiliary);
  assert.equal(f.context.mainWindow.isVisible(), true);
  assert.equal(f.context.mainWindow.file, path.join(__dirname, '..', 'renderer', 'index.html'));
  assert.equal(f.windows.length, 3);
  f.app.emit('activate');
  assert.equal(f.windows.length, 3);
});

test('Shared show action recreates a destroyed reference and waits for app readiness', () => {
  const f = fixture();
  f.app.ready = false;
  vm.runInContext('showMainWindow()', f.context);
  assert.equal(f.windows.length, 0);
  f.app.ready = true;
  vm.runInContext('showMainWindow()', f.context);
  const main = f.context.mainWindow;
  main.destroyed = true;
  vm.runInContext('showMainWindow()', f.context);
  assert.notEqual(f.context.mainWindow, main);
  assert.equal(f.windows.length, 2);
});

for (const scenario of ['visible', 'hidden', 'tray']) {
  test(`${scenario} quit destroys the window and activation cannot reopen it`, () => {
    const f = fixture();
    const main = f.create();
    if (scenario === 'hidden') main.close();
    if (scenario === 'tray') {
      const match = source.match(/\{ label: en \? 'Quit' : '退出', click: (.*?) \},/);
      assert(match);
      vm.runInContext(`(${match[1]})()`, f.context);
    } else f.app.quit();
    assert.equal(main.isDestroyed(), true);
    assert.equal(f.context.mainWindow, null);
    assert.equal(f.bridgeClosed, 1);
    f.app.emit('activate');
    assert.equal(f.windows.length, 1);
  });
}
