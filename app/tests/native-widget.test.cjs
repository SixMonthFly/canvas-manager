const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { snapshotOf } = require('../plugins/native-assignments/main.cjs');
const { createNativeWidgetService } = require('../core/native-widget-service.cjs');
const { parseWidgetLink } = require('../core/widget-links.cjs');
const { createPluginManager } = require('../core/plugin-manager.cjs');

test('native snapshot contains only published pending assignments in current courses and no private fields', () => {
  const base = { id: 1, name: '作业', due_at: '2026-10-20T04:00:00Z', description: 'private description', url: 'private URL',
    sub: { state: 'unsubmitted' }, attachments: ['private attachment'] };
  const data = { courses: [{ id: 1, code: 'COMP1000' }], syncedAt: '2026-10-02T00:00:00Z', byCourse: {
    1: [base, { ...base, id: 2, sub: { state: 'graded' } }, { ...base, id: 3, sub: { submitted_at: 'yesterday' } },
      { ...base, id: 4, published: false }, { ...base, id: 5, due_at: 'invalid' }],
    9: [{ ...base, id: 6 }],
  } };
  const snapshot = snapshotOf(data);
  assert.equal(snapshot.assignments.length, 1); assert.equal(snapshot.assignments[0].id, 1);
  assert.deepEqual(Object.keys(snapshot.assignments[0]).sort(), ['course', 'courseId', 'dueAt', 'id', 'name']);
  assert(!JSON.stringify(snapshot).includes('private'));
  assert.deepEqual(snapshotOf({}).assignments, []);
});
test('widget links reject unsupported schemes, injected paths, queries and unsafe identifiers', () => {
  assert.deepEqual(parseWidgetLink('canvas-manager://assignment/12/34'), { type: 'assignment', cid: 12, id: 34 });
  assert.deepEqual(parseWidgetLink('canvas-manager://open'), { type: 'open' });
  for (const input of ['https://assignment/12/34', 'canvas-manager://assignment/0/1', 'canvas-manager://assignment/1/9007199254740993',
    'canvas-manager://assignment/1/2?path=/etc/passwd', 'canvas-manager://user@assignment/1/2', 'canvas-manager://assignment/../1/2',
    'canvas-manager://file/etc/passwd', 'bad']) assert.equal(parseWidgetLink(input), null);
});
test('native publishing is serialized, atomic, size limited and refuses absent runtime', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-native-widget-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const helperPath = path.join(dir, 'helper'); fs.writeFileSync(helperPath, 'fixture');
  const snapshotPath = path.join(dir, 'snapshot.json');
  const versions = [];
  const service = createNativeWidgetService({ platform: 'darwin', helperPath, snapshotPath,
    runHelper: async () => versions.push(JSON.parse(fs.readFileSync(snapshotPath)).schemaVersion) });
  assert.equal(service.available(), true);
  await Promise.all([service.publish({ schemaVersion: 1 }), service.publish({ schemaVersion: 2 })]);
  assert.deepEqual(versions, [1, 2]); assert.equal(fs.existsSync(snapshotPath + '.tmp'), false);
  assert.equal(fs.statSync(snapshotPath).mode & 0o777, 0o600);
  await assert.rejects(service.publish({ data: 'x'.repeat(5 * 1024 * 1024) }), /大小限制/);
  assert.equal(JSON.parse(fs.readFileSync(snapshotPath)).schemaVersion, 2);
  fs.unlinkSync(helperPath); await assert.rejects(service.publish({}), /完整客户端/);
});
test('native plugin publishes on sync, preserves cached content on quit and clears on disable/uninstall', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-native-lifecycle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = new EventEmitter(), published = [];
  const args = { catalog: require('../plugins/catalog.json').filter(item => item.id === 'native-assignments'),
    bundleRoot: path.join(__dirname, '..'), statePath: path.join(dir, 'plugins.json'), services: {
      canvas: { readLocalData: () => ({ courses: [{ id: 1 }], byCourse: {} }),
        onDataUpdated(callback) { events.on('updated', callback); return () => events.off('updated', callback); } },
      nativeWidgets: { available: () => true, publish: async data => { published.push(data); } },
    } };
  let manager = createPluginManager(args); t.after(() => manager.dispose());
  await manager.initialize(); assert.equal(published.length, 0);
  await manager.setEnabled('native-assignments', true); assert.equal(published.at(-1).enabled, true);
  events.emit('updated'); assert.equal(published.length, 2);
  await manager.dispose(); assert.equal(published.at(-1).enabled, true); assert.equal(events.listenerCount('updated'), 0);
  manager = createPluginManager(args); await manager.initialize();
  await manager.setEnabled('native-assignments', false); assert.equal(published.at(-1).enabled, false);
  await manager.setEnabled('native-assignments', true); await manager.uninstall('native-assignments');
  assert.equal(published.at(-1).enabled, false); assert.equal(events.listenerCount('updated'), 0);
});
