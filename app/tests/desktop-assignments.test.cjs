const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { upcomingAssignments } = require('../plugins/desktop-assignments/assignments.cjs');
const { createPluginManager } = require('../core/plugin-manager.cjs');
const { createDesktopService } = require('../core/desktop-service.cjs');
const now = Date.parse('2026-10-02T03:00:00Z');
const assignment = (id, delta, extra = {}) => ({ id, name: `作业 ${id}`, due_at: new Date(now + delta).toISOString(), ...extra });
const data = { courses: [{ id: 1, code: 'TEST1000' }], byCourse: {
  1: [assignment(1, 0), assignment(2, 7 * 86400000), assignment(3, 7 * 86400000 + 1), assignment(4, -1),
    assignment(5, 1000, { sub: { state: 'submitted' } }), assignment(6, 1000, { sub: { state: 'graded' } }),
    assignment(7, 1000, { sub: { state: 'unsubmitted', submitted_at: '2026-10-01' } }),
    assignment(8, 1000, { published: false }), assignment(9, 1000, { due_at: null }),
    assignment(10, 1000, { due_at: 'invalid' }), assignment(11, 1000, { sub: { state: 'unsubmitted' } })],
  99: [assignment(12, 1000)],
} };
test('rolling seven-day boundaries, current courses and pending status', () => {
  assert.deepEqual(upcomingAssignments(data, { now }).map(item => item.id), [1, 11, 2]);
  assert.deepEqual(upcomingAssignments(data, { now, showCompleted: true }).map(item => item.id), [1, 11, 5, 6, 7, 2]);
  assert.equal(upcomingAssignments(data, { now: now + 1 }).some(item => item.id === 1), false);
  assert.deepEqual(upcomingAssignments({}, { now }), []);
});
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-desktop-plugin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = new EventEmitter();
  const cards = [], opened = [];
  let platform = 'darwin', fail = false;
  const services = {
    canvas: { readLocalData: () => ({ ...data, syncedAt: '2026-10-02T00:00:00Z' }),
      onDataUpdated(callback) { events.on('updated', callback); return () => events.off('updated', callback); },
      openAssignment: (...args) => opened.push(args) },
    storage: { dataDir: dir },
    desktop: { get platform() { return platform; }, showMainWindow() {},
      async createCard(options) {
        if (fail) throw new Error('fixture window failure');
        const card = new EventEmitter();
        Object.assign(card, { options, destroyed: false, visible: false, pinned: options.pinned, messages: [],
          isDestroyed() { return this.destroyed; }, destroy() { this.destroyed = true; this.emit('closed'); },
          hide() { this.visible = false; }, showInactive() { this.visible = true; },
          setAlwaysOnTop(value) { this.pinned = value; }, webContents: { send: (...args) => card.messages.push(args) } });
        cards.push(card); return card;
      },
    },
  };
  const args = { catalog: [require('./fixtures/retired-desktop-plugin.json')],
    bundleRoot: path.join(__dirname, '..'), statePath: path.join(dir, 'plugins.json'), services };
  return { dir, events, cards, opened, args, setPlatform(value) { platform = value; }, setFail(value) { fail = value; } };
}
test('installation, card ownership, refresh, preference retention and restart', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, 'courses.json'), 'preserved fixture course data');
  let manager = createPluginManager(f.args);
  t.after(() => manager.dispose());
  await manager.initialize();
  assert.equal(manager.list()[0].enabled, false); assert.equal(f.cards.length, 0);
  await manager.setEnabled('desktop-assignments', true);
  const card = f.cards[0]; assert.equal(card.visible, true);
  const invoke = card.options.onInvoke;
  assert.equal(invoke('snapshot').syncedAt, '2026-10-02T00:00:00Z');
  invoke('setOption', 'pinned', true); assert.equal(card.pinned, true);
  invoke('setOption', 'showCompleted', true);
  assert.throws(() => invoke('setOption', 'bad', true));
  invoke('openAssignment', 1, 1); assert.equal(f.opened[0][0], 1);
  assert.throws(() => invoke('openAssignment', 99, 12));
  invoke('hide'); assert.equal(card.visible, false);
  await manager.invoke('desktop-assignments', 'show'); assert.equal(card.visible, true);
  assert.equal(f.cards.length, 1);
  f.events.emit('updated'); assert(card.messages.length > 0);
  assert.equal(f.events.listenerCount('updated'), 1);
  await manager.setEnabled('desktop-assignments', false);
  assert.equal(card.destroyed, true); assert.equal(f.events.listenerCount('updated'), 0);
  assert.throws(() => invoke('snapshot'));
  await manager.setEnabled('desktop-assignments', true);
  assert.equal(f.cards[1].pinned, true);
  await manager.dispose();
  manager = createPluginManager(f.args); await manager.initialize();
  assert.equal(manager.list()[0].enabled, true); assert.equal(f.cards[2].pinned, true);
  await manager.uninstall('desktop-assignments');
  assert.equal(f.cards[2].destroyed, true); assert.equal(f.events.listenerCount('updated'), 0);
  await manager.dispose();
  manager = createPluginManager(f.args); await manager.initialize();
  assert.equal(manager.list()[0].installed, false);
  await manager.install('desktop-assignments'); assert.equal(manager.list()[0].enabled, false);
  assert.equal(fs.readFileSync(path.join(f.dir, 'courses.json'), 'utf8'), 'preserved fixture course data');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'desktop_assignments.json'))).showCompleted, true);
});
test('unsupported platform and failed window activation do not leave registrations', async t => {
  const f = fixture(t); const manager = createPluginManager(f.args); t.after(() => manager.dispose());
  await manager.initialize(); f.setPlatform('win32');
  await assert.rejects(manager.setEnabled('desktop-assignments', true), /仅支持 Mac/);
  assert.equal(f.events.listenerCount('updated'), 0);
  f.setPlatform('darwin'); f.setFail(true);
  await assert.rejects(manager.setEnabled('desktop-assignments', true), /fixture window failure/);
  assert.equal(f.events.listenerCount('updated'), 0); assert.equal(manager.list()[0].enabled, false);
});
test('desktop window service clamps old positions and only accepts its own main frame', async () => {
  let handler, win, blocked;
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; win = this;
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, { id: 3, mainFrame: {}, setWindowOpenHandler(callback) { blocked = callback; } });
    }
    async loadFile() {} setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {}
    destroy() { this.emit('closed'); }
  }
  const service = createDesktopService({ BrowserWindow: Window, ipcMain: { handle(channel, cb) { handler = cb; } },
    screen: { getDisplayMatching() { return { workArea: { x: 0, y: 0, width: 1000, height: 800 } }; } }, platform: 'darwin' });
  await service.createCard({ bounds: { x: -500, y: 2000 }, onInvoke: method => method });
  assert.equal(win.options.x, 0); assert.equal(win.options.y, 320);
  assert.equal(win.options.webPreferences.sandbox, true); assert.equal(blocked().action, 'deny');
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  assert.equal(handler(event, 'snapshot', []), 'snapshot');
  assert.throws(() => handler({ ...event, senderFrame: {} }, 'snapshot', []));
  win.destroy(); assert.throws(() => handler(event, 'snapshot', []));
});
