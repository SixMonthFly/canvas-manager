const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPluginManager } = require('../core/plugin-manager.cjs');
const crypto = require('node:crypto');
const { loadInstalledPlugin } = require('../core/plugin-install-store.cjs');

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-plugin-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const statePath = path.join(directory, 'plugins.json');
  const bundleRoot = path.join(directory, 'bundle');
  const source = path.join(bundleRoot, 'plugins', 'tool');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'main.cjs'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(source, 'renderer.mjs'), 'export function activate() {}\n');
  const files = ['main.cjs', 'renderer.mjs'].map(name => ({ path: name, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(source, name))).digest('hex') }));
  const effects = [];
  const emitted = [];
  let loads = 0;
  let context;
  const catalog = [{ id: 'optional-tool', name: 'Tool', version: '4.0.0', apiVersion: 1,
    defaultEnabled: false, requires: ['courses'], source: 'plugins/tool', main: 'main.cjs', renderer: 'renderer.mjs', files }];
  const args = { catalog, statePath, bundleRoot, services: { courses: { list: () => ['one'] } },
    onEvent: (...event) => emitted.push(event),
    loadPlugin: () => {
      loads++;
      return { activate(ctx) {
        context = ctx;
        ctx.effect(() => effects.push('first'));
        ctx.effect(() => effects.push('second'));
        if (options.failActivation) throw new Error('activation failed');
        return { methods: { list: () => ctx.services.courses.list(), slow: options.slow || (() => 'done') } };
      } };
    }, ...options.args };
  return { statePath, directory, args, manager: createPluginManager(args), effects, emitted,
    get loads() { return loads; }, get context() { return context; } };
}

test('default disabled never loads plugin code or accepts calls, even with legacy AI data', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.directory, 'ai_config.json'), '{"provider":"custom"}');
  await f.manager.initialize();
  assert.equal(f.loads, 0);
  assert.equal(f.manager.list()[0].enabled, false);
  await assert.rejects(f.manager.invoke('optional-tool', 'list'), { code: 'PLUGIN_DISABLED' });
  assert.equal(JSON.parse(fs.readFileSync(f.statePath)).plugins['optional-tool'].enabled, false);
});

test('enable persists, survives restart and disable unwinds in reverse order', async t => {
  const f = fixture(t);
  await f.manager.initialize();
  await f.manager.setEnabled('optional-tool', true);
  assert.deepEqual(await f.manager.invoke('optional-tool', 'list'), ['one']);
  f.context.emit('progress', 1);
  assert.equal(f.emitted.length, 1);
  await f.manager.dispose();
  assert.deepEqual(f.effects, ['second', 'first']);
  assert.equal(JSON.parse(fs.readFileSync(f.statePath)).plugins['optional-tool'].enabled, true,
    'Shutdown preserves the user preference');
  const restarted = createPluginManager(f.args);
  await restarted.initialize();
  assert.equal(restarted.list()[0].enabled, true);
  await restarted.setEnabled('optional-tool', false);
  assert.equal(JSON.parse(fs.readFileSync(f.statePath)).plugins['optional-tool'].enabled, false);
  assert.deepEqual(f.effects, ['second', 'first', 'second', 'first']);
});

test('repeated changes serialize and old contexts cannot publish after reactivation', async t => {
  const f = fixture(t);
  await f.manager.initialize();
  await f.manager.setEnabled('optional-tool', true);
  const old = f.context;
  await Promise.all([f.manager.setEnabled('optional-tool', false), f.manager.setEnabled('optional-tool', true),
    f.manager.setEnabled('optional-tool', true)]);
  assert.equal(f.loads, 2);
  old.emit('progress', 'stale');
  f.context.emit('progress', 'current');
  assert.deepEqual(f.emitted.map(event => event[2]), ['current']);
  await f.manager.dispose();
});

test('disable refuses in-flight calls and leaves the preference unchanged', async t => {
  let finish;
  const f = fixture(t, { slow: () => new Promise(resolve => { finish = resolve; }) });
  await f.manager.initialize();
  await f.manager.setEnabled('optional-tool', true);
  const request = f.manager.invoke('optional-tool', 'slow');
  assert.equal(f.manager.isBusy(), true);
  await assert.rejects(f.manager.setEnabled('optional-tool', false), { code: 'PLUGIN_BUSY' });
  assert.equal(f.manager.list()[0].enabled, true);
  assert.equal(JSON.parse(fs.readFileSync(f.statePath)).plugins['optional-tool'].enabled, true);
  finish('complete');
  assert.equal(await request, 'complete');
  await f.manager.setEnabled('optional-tool', false);
  assert.equal(f.manager.isBusy(), false);
});

test('failed activation cleans partial effects; a rejected change does not poison the queue', async t => {
  const options = { failActivation: true };
  const f = fixture(t, options);
  await f.manager.initialize();
  await assert.rejects(f.manager.setEnabled('optional-tool', true), /activation failed/);
  assert.deepEqual(f.effects, ['second', 'first']);
  assert.equal(f.manager.list()[0].enabled, false);
  assert.equal(JSON.parse(fs.readFileSync(f.statePath)).plugins['optional-tool'].enabled, false);
  // Turning off an already disabled plugin must remain usable after failure.
  await f.manager.setEnabled('optional-tool', false);
});

test('failed persistence leaves an active plugin enabled and rolls back an enable', async t => {
  const f = fixture(t);
  await f.manager.initialize();
  await f.manager.setEnabled('optional-tool', true);
  fs.unlinkSync(f.statePath);
  fs.mkdirSync(f.statePath);
  await assert.rejects(f.manager.setEnabled('optional-tool', false));
  assert.equal(f.manager.list()[0].enabled, true);
  assert.deepEqual(f.effects, []);
  assert.equal(fs.readdirSync(f.directory).some(name => name.endsWith('.tmp')), false);
  await f.manager.dispose();
  const g = fixture(t);
  await g.manager.initialize();
  fs.unlinkSync(g.statePath);
  fs.mkdirSync(g.statePath);
  await assert.rejects(g.manager.setEnabled('optional-tool', true));
  assert.equal(g.manager.list()[0].enabled, false);
  assert.deepEqual(g.effects, ['second', 'first']);
});

test('corrupt preferences fail closed, and unknown ids or methods cannot execute', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.statePath, '{broken');
  await f.manager.initialize();
  assert.equal(f.loads, 0);
  await assert.rejects(f.manager.setEnabled('../foreign', true), { code: 'PLUGIN_UNKNOWN' });
  await assert.rejects(f.manager.setEnabled('optional-tool', 'true'), { code: 'PLUGIN_STATE' });
  assert.equal(f.manager.list()[0].installed, false);
  await assert.rejects(f.manager.setEnabled('optional-tool', true), { code: 'PLUGIN_NOT_INSTALLED' });
  await f.manager.install('optional-tool');
  await f.manager.setEnabled('optional-tool', true);
  await assert.rejects(f.manager.invoke('optional-tool', 'toString'), { code: 'PLUGIN_METHOD' });
  await assert.rejects(f.manager.invoke('optional-tool', 'list', {}), { code: 'PLUGIN_METHOD' });
  await f.manager.dispose();
});

test('a failing cleanup still runs the remaining effects and exposes the actual disabled state', async t => {
  const cleaned = [];
  const f = fixture(t, { args: { loadPlugin: () => ({ activate(ctx) {
    ctx.effect(() => cleaned.push('first'));
    ctx.effect(() => { throw new Error('cleanup failed'); });
    ctx.effect(() => cleaned.push('last'));
    return { methods: { ready: () => true } };
  } }) } });
  await f.manager.initialize();
  await f.manager.setEnabled('optional-tool', true);
  await assert.rejects(f.manager.setEnabled('optional-tool', false), /插件清理失败/);
  assert.deepEqual(cleaned, ['last', 'first']);
  assert.equal(f.manager.list()[0].enabled, false);
  assert.equal(JSON.parse(fs.readFileSync(f.statePath)).plugins['optional-tool'].enabled, false);
  await assert.rejects(f.manager.invoke('optional-tool', 'ready'), { code: 'PLUGIN_DISABLED' });
});

test('startup plugin failures leave core usable; missing services prevent activation', async t => {
  const f = fixture(t, { failActivation: true });
  fs.writeFileSync(f.statePath, JSON.stringify({ schemaVersion: 1, enabled: { 'optional-tool': true } }));
  await f.manager.initialize();
  assert.equal(f.manager.list()[0].enabled, false);
  assert.match(f.manager.list()[0].error, /activation failed/);
  const g = fixture(t, { args: { services: {} } });
  await g.manager.initialize();
  await assert.rejects(g.manager.setEnabled('optional-tool', true), { code: 'PLUGIN_DEPENDENCY' });
  assert.equal(g.loads, 0);
});

test('real AI plugin preserves existing configuration and reports across enable/disable', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-ai-plugin-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = '{"provider":"custom","baseUrl":"https://example.invalid/v1","model":"test","apiKey":"synthetic"}';
  const report = '{"report":"cached report"}';
  fs.writeFileSync(path.join(directory, 'ai_config.json'), config);
  fs.writeFileSync(path.join(directory, 'analysis_1.json'), report);
  let loads = 0;
  const manager = createPluginManager({ catalog: require('../plugins/catalog.json'),
    statePath: path.join(directory, 'plugins.json'),
    services: { canvas: {}, storage: { dataDir: directory, filesDir: path.join(directory, 'files') }, diagnostics: { track() {} }, documents: {} },
    loadPlugin(manifest, installation) { loads++; return loadInstalledPlugin(manifest, installation); } });
  await manager.initialize();
  assert.equal(loads, 0);
  await manager.setEnabled('canvas-ai', true);
  const migrated = await manager.invoke('canvas-ai', 'ai-config-load');
  assert.equal(migrated.profiles.custom.model, 'test');
  assert.equal((await manager.invoke('canvas-ai', 'load-analysis', [1])).report, 'cached report');
  await manager.setEnabled('canvas-ai', false);
  await assert.rejects(manager.invoke('canvas-ai', 'ai-presets'), { code: 'PLUGIN_DISABLED' });
  assert.equal(fs.readFileSync(path.join(directory, 'ai_config.json'), 'utf8'), config);
  assert.equal(fs.readFileSync(path.join(directory, 'analysis_1.json'), 'utf8'), report);
});
