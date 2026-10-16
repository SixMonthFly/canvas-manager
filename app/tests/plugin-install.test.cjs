const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { fileURLToPath } = require('node:url');
const { createPluginManager } = require('../core/plugin-manager.cjs');
const { checkCatalog, writeCatalog } = require('../scripts/plugin-catalog.cjs');

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-install-test-'));
  const bundleRoot = path.join(directory, 'bundle');
  const source = path.join(bundleRoot, 'plugins', 'tool');
  const dataDir = path.join(directory, 'data');
  const installRoot = path.join(dataDir, 'installed-plugins');
  fs.mkdirSync(source, { recursive: true }); fs.mkdirSync(dataDir);
  const operations = { disposed: 0, slow: options.slow || (() => 'done') };
  const manifest = { id: 'optional-tool', name: 'Tool', description: 'Fixture', version: '4.0.0', apiVersion: 1,
    defaultEnabled: false, requires: ['operations'], source: 'plugins/tool', main: 'main.cjs', renderer: 'renderer.mjs', ...options.manifest };
  function payload(version = '4.0.0', value = 'original') {
    manifest.version = version;
    fs.writeFileSync(path.join(source, 'main.cjs'), `module.exports = { activate(ctx) { ctx.effect(() => ctx.services.operations.disposed++); return { methods: { identity: () => '${value}', slow: () => ctx.services.operations.slow() } }; } };\n`);
    fs.writeFileSync(path.join(source, 'renderer.mjs'), 'export function activate() {}\n');
    manifest.files = ['main.cjs', 'renderer.mjs'].map(name => ({ path: name,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(source, name))).digest('hex') }));
  }
  payload();
  const args = { catalog: [manifest], bundleRoot, installRoot, statePath: path.join(dataDir, 'plugins.json'), services: { operations } };
  const managers = [];
  function manager() { const value = createPluginManager(args); managers.push(value); return value; }
  const initial = manager();
  t.after(async () => { for (const value of managers) await value.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, bundleRoot, source, dataDir, installRoot, operations, args, manifest, payload, manager, initial,
    state() { return JSON.parse(fs.readFileSync(args.statePath)); },
    codeRoot(value = initial) { return path.join(installRoot, manifest.id, value.list()[0].generation); } };
}

test('Default installed but disabled copies trusted code and uses a local renderer URL', async t => {
  const f = fixture(t); await f.initial.initialize();
  const listed = f.initial.list()[0];
  assert.equal(listed.installed, true); assert.equal(listed.enabled, false); assert.equal(listed.source, 'bundled');
  assert.equal(listed.bundled, true); assert.equal(listed.available, true);
  assert(fs.existsSync(path.join(f.codeRoot(), 'main.cjs')));
  assert.equal(fileURLToPath(listed.renderer), path.join(f.codeRoot(), 'renderer.mjs'));
  assert.equal(new URL(listed.renderer).searchParams.get('generation'), listed.generation);
  assert.equal(f.state().schemaVersion, 2);
  assert.equal(globalThis.DOMMatrix, undefined, 'Installing a disabled plugin must not activate its PDF setup');
});

test('Legacy enable preferences migrate to installed code without losing enabled state', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.args.statePath, JSON.stringify({ schemaVersion: 1, enabled: { 'optional-tool': true } }));
  await f.initial.initialize();
  assert.equal(f.initial.list()[0].enabled, true);
  assert.equal(await f.initial.invoke('optional-tool', 'identity'), 'original');
  assert.equal(f.state().schemaVersion, 2);
  assert.equal(f.state().plugins['optional-tool'].enabled, true);
});

test('Optional themes stay uninstalled across restarts until explicitly installed', async t => {
  const f = fixture(t, { manifest: { kind: 'theme', themeId: 'fixture-skin', defaultInstalled: false, defaultEnabled: true } });
  await f.initial.initialize();
  const listed = f.initial.list()[0];
  assert.equal(listed.kind, 'theme'); assert.equal(listed.themeId, 'fixture-skin'); assert.equal(listed.defaultInstalled, false);
  assert.equal(listed.installed, false); assert.equal(listed.enabled, false); assert.equal(listed.renderer, null);
  assert.deepEqual(fs.readdirSync(path.join(f.installRoot, f.manifest.id)), []);
  assert.deepEqual(f.state().plugins[f.manifest.id], { installed: false, enabled: false });
  await f.initial.dispose();
  // A new bundle default must not erase an explicit persisted absence.
  f.manifest.defaultInstalled = true;
  const restarted = f.manager(); await restarted.initialize();
  assert.equal(restarted.list()[0].installed, false);
  await restarted.install(f.manifest.id);
  assert.equal(restarted.list()[0].installed, true); assert.equal(restarted.list()[0].enabled, false);
  assert(fs.existsSync(path.join(f.codeRoot(restarted), 'main.cjs')));
  await assert.rejects(restarted.setEnabled(f.manifest.id, true), { code: 'PLUGIN_THEME' });
  assert.equal(f.operations.disposed, 0, 'No theme backend was loaded');
  await restarted.dispose();
  const installedRestart = f.manager(); await installedRestart.initialize();
  assert.equal(installedRestart.list()[0].installed, true); assert.equal(installedRestart.list()[0].enabled, false);
});

test('Default installed themes never activate backend or restore saved enabled preferences', async t => {
  const f = fixture(t, { manifest: { kind: 'theme', themeId: 'fixture-skin', defaultInstalled: true, defaultEnabled: true } });
  await f.initial.initialize();
  assert.equal(f.initial.list()[0].installed, true); assert.equal(f.initial.list()[0].enabled, false);
  const state = f.state(); state.plugins[f.manifest.id].enabled = true;
  fs.writeFileSync(f.args.statePath, JSON.stringify(state));
  await f.initial.dispose();
  const restarted = f.manager(); await restarted.initialize();
  assert.equal(restarted.list()[0].enabled, false); assert.equal(f.state().plugins[f.manifest.id].enabled, false);
  assert.equal(f.operations.disposed, 0);
});

test('A corrupted installed theme stays uninstallable but never supplies a renderer load URL', async t => {
  const f = fixture(t, { manifest: { kind: 'theme', themeId: 'fixture-skin' } });
  await f.initial.initialize(); assert(f.initial.list()[0].renderer);
  fs.appendFileSync(path.join(f.codeRoot(), 'renderer.mjs'), '// altered installed code');
  assert.equal(f.initial.list()[0].installed, true); assert.equal(f.initial.list()[0].renderer, null);
  assert.match(f.initial.list()[0].error, /PLUGIN_INTEGRITY/);
  await f.initial.dispose();
  const restarted = f.manager(); await restarted.initialize();
  assert.equal(restarted.list()[0].renderer, null); assert.equal(restarted.list()[0].enabled, false);
  await restarted.uninstall(f.manifest.id); await restarted.install(f.manifest.id);
  assert(restarted.list()[0].renderer); assert.equal(restarted.list()[0].error, null);
});

test('Uninstall removes active code, preserves data, and persists across restarts and bundle versions', async t => {
  const f = fixture(t);
  for (const name of ['ai_config.json', 'analysis_1.json', 'courses.json']) fs.writeFileSync(path.join(f.dataDir, name), `Fixture ${name}`);
  await f.initial.initialize(); await f.initial.setEnabled('optional-tool', true);
  const oldRoot = f.codeRoot(); const sourceBytes = fs.readFileSync(path.join(f.source, 'main.cjs'));
  await f.initial.uninstall('optional-tool');
  assert.equal(fs.existsSync(oldRoot), false);
  assert.equal(f.initial.list()[0].installed, false); assert.equal(f.initial.list()[0].renderer, null);
  assert(fs.readFileSync(path.join(f.source, 'main.cjs')).equals(sourceBytes));
  await assert.rejects(f.initial.setEnabled('optional-tool', true), { code: 'PLUGIN_NOT_INSTALLED' });
  await assert.rejects(f.initial.invoke('optional-tool', 'identity'), { code: 'PLUGIN_NOT_INSTALLED' });
  await f.initial.dispose(); f.payload('4.1.0', 'new bundled version');
  const restarted = f.manager(); await restarted.initialize();
  assert.equal(restarted.list()[0].installed, false);
  for (const name of ['ai_config.json', 'analysis_1.json', 'courses.json']) assert.equal(fs.readFileSync(path.join(f.dataDir, name), 'utf8'), `Fixture ${name}`);
  await restarted.install('optional-tool');
  assert.equal(restarted.list()[0].enabled, false); assert.equal(restarted.list()[0].version, '4.1.0');
});

test('Reinstall changes generation, reloads backend code, and clears removed module caches', async t => {
  const f = fixture(t); await f.initial.initialize();
  const generations = [];
  for (let pass = 0; pass < 3; pass++) {
    await f.initial.setEnabled('optional-tool', true);
    assert.equal(await f.initial.invoke('optional-tool', 'identity'), 'original');
    const oldRoot = fs.realpathSync(f.codeRoot()); const previousURL = f.initial.list()[0].renderer;
    assert(Object.keys(require.cache).some(name => name.startsWith(oldRoot + path.sep)));
    generations.push(f.initial.list()[0].generation);
    await f.initial.install('optional-tool');
    assert.equal(f.initial.list()[0].enabled, false);
    assert.notEqual(f.initial.list()[0].renderer, previousURL);
    assert.equal(fs.existsSync(oldRoot), false);
    assert.equal(Object.keys(require.cache).some(name => name.startsWith(oldRoot + path.sep)), false);
  }
  assert.equal(new Set([...generations, f.initial.list()[0].generation]).size, 4);
  await f.initial.setEnabled('optional-tool', true); const activeRoot = fs.realpathSync(f.codeRoot());
  await f.initial.uninstall('optional-tool');
  assert.equal(Object.keys(require.cache).some(name => name.startsWith(activeRoot + path.sep)), false);
});

test('Corrupt bundled payload fails before installation and leaves a working installation intact', async t => {
  const f = fixture(t); await f.initial.initialize(); await f.initial.setEnabled('optional-tool', true);
  const oldGeneration = f.initial.list()[0].generation;
  fs.writeFileSync(path.join(f.source, 'main.cjs'), 'untrusted change');
  await assert.rejects(f.initial.install('optional-tool'), { code: 'PLUGIN_INTEGRITY' });
  assert.equal(f.initial.list()[0].generation, oldGeneration); assert.equal(f.initial.list()[0].enabled, true);
  assert.equal(await f.initial.invoke('optional-tool', 'identity'), 'original');
  assert.deepEqual(fs.readdirSync(path.join(f.installRoot, 'optional-tool')), [oldGeneration]);
});

test('Failed state writes roll back install and uninstall filesystem changes', async t => {
  const f = fixture(t); await f.initial.initialize(); await f.initial.setEnabled('optional-tool', true);
  const oldRoot = f.codeRoot(); const generation = f.initial.list()[0].generation;
  fs.unlinkSync(f.args.statePath); fs.mkdirSync(f.args.statePath);
  await assert.rejects(f.initial.install('optional-tool'));
  assert.equal(f.initial.list()[0].enabled, true); assert.equal(f.initial.list()[0].generation, generation);
  assert.deepEqual(fs.readdirSync(path.join(f.installRoot, 'optional-tool')), [generation]);
  await assert.rejects(f.initial.uninstall('optional-tool'));
  assert(fs.existsSync(oldRoot)); assert.equal(f.initial.list()[0].enabled, true);
  assert.equal(await f.initial.invoke('optional-tool', 'identity'), 'original');
  assert.deepEqual(fs.readdirSync(path.join(f.installRoot, 'optional-tool')), [generation]);
});

test('Busy uninstall is refused and concurrent enable/uninstall changes are serialized', async t => {
  let finish; const f = fixture(t, { slow: () => new Promise(resolve => { finish = resolve; }) });
  await f.initial.initialize(); await f.initial.setEnabled('optional-tool', true);
  const pending = f.initial.invoke('optional-tool', 'slow');
  await assert.rejects(f.initial.uninstall('optional-tool'), { code: 'PLUGIN_BUSY' });
  assert.equal(f.initial.list()[0].installed, true); finish('done'); await pending;
  await Promise.all([f.initial.setEnabled('optional-tool', false), f.initial.setEnabled('optional-tool', true), f.initial.uninstall('optional-tool')]);
  assert.equal(f.initial.list()[0].installed, false); assert.equal(f.state().plugins['optional-tool'].installed, false);
});

test('Startup recovers an interrupted uninstall before tombstone commit', async t => {
  const f = fixture(t); await f.initial.initialize(); await f.initial.setEnabled('optional-tool', true);
  const record = f.state().plugins['optional-tool']; const original = f.codeRoot();
  await f.initial.dispose(); fs.renameSync(original, path.join(path.dirname(original), `.remove-${record.generation}`));
  const restarted = f.manager(); await restarted.initialize();
  assert.equal(restarted.list()[0].enabled, true); assert(fs.existsSync(original));
  assert.equal(await restarted.invoke('optional-tool', 'identity'), 'original');
});

test('Startup completes a committed uninstall and deletes orphan staging without reinstalling', async t => {
  const f = fixture(t); await f.initial.initialize(); const record = f.state().plugins['optional-tool']; const original = f.codeRoot();
  await f.initial.dispose(); fs.renameSync(original, path.join(path.dirname(original), `.remove-${record.generation}`));
  fs.mkdirSync(path.join(path.dirname(original), `.stage-${'a'.repeat(32)}`));
  const state = f.state(); state.plugins['optional-tool'] = { installed: false, enabled: false };
  fs.writeFileSync(f.args.statePath, JSON.stringify(state));
  const restarted = f.manager(); await restarted.initialize();
  assert.equal(restarted.list()[0].installed, false); assert.equal(restarted.list()[0].renderer, null);
  assert.deepEqual(fs.readdirSync(path.dirname(original)), []);
});

test('Corrupt persisted state fails closed instead of discarding an unknown uninstall intent', async t => {
  const f = fixture(t); fs.writeFileSync(f.args.statePath, '{broken schema2');
  await f.initial.initialize();
  assert.equal(f.initial.list()[0].installed, false); assert.match(f.initial.list()[0].error, /状态文件损坏/);
  await f.initial.install('optional-tool'); assert.equal(f.initial.list()[0].enabled, false);
  await f.initial.uninstall('optional-tool'); const restarted = f.manager(); await restarted.initialize();
  assert.equal(restarted.list()[0].installed, false);
});

test('A new trusted bundled version upgrades installed code while retaining the enabled preference', async t => {
  const f = fixture(t); await f.initial.initialize(); await f.initial.setEnabled('optional-tool', true); await f.initial.dispose();
  f.payload('4.1.0', 'replacement'); const restarted = f.manager(); await restarted.initialize();
  assert.equal(restarted.list()[0].installed, true); assert.equal(restarted.list()[0].enabled, true);
  assert.equal(restarted.list()[0].error, null);
  assert.equal(restarted.list()[0].version, '4.1.0');
  assert.equal(await restarted.invoke('optional-tool', 'identity'), 'replacement');
});

test('Invalid paths, symlinked payloads, and injected installed files never execute', async t => {
  const f = fixture(t);
  const invalid = { ...f.manifest, files: [{ path: '../outside', sha256: '0'.repeat(64) }] };
  assert.throws(() => createPluginManager({ ...f.args, catalog: [invalid] }), { code: 'PLUGIN_INTEGRITY' });
  await f.initial.initialize();
  fs.writeFileSync(path.join(f.codeRoot(), 'injected.cjs'), 'throw new Error("unsafe")');
  await assert.rejects(f.initial.setEnabled('optional-tool', true), { code: 'PLUGIN_INTEGRITY' });
  await f.initial.uninstall('optional-tool');
  const outside = path.join(f.directory, 'outside.cjs'); fs.writeFileSync(outside, 'outside');
  fs.unlinkSync(path.join(f.source, 'main.cjs')); fs.symlinkSync(outside, path.join(f.source, 'main.cjs'));
  await assert.rejects(f.initial.install('optional-tool'), { code: 'PLUGIN_INTEGRITY' });
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside'); assert.equal(f.initial.list()[0].installed, false);
});

test('Build catalog checks reject source changes until explicitly regenerated', t => {
  const f = fixture(t); const catalogPath = path.join(f.bundleRoot, 'plugins', 'catalog.json');
  fs.writeFileSync(catalogPath, JSON.stringify([f.manifest])); assert.equal(checkCatalog({ appDir: f.bundleRoot }).length, 1);
  fs.appendFileSync(path.join(f.source, 'renderer.mjs'), '// update\n');
  assert.throws(() => checkCatalog({ appDir: f.bundleRoot }), { code: 'PLUGIN_INTEGRITY' });
  writeCatalog({ appDir: f.bundleRoot }); assert.equal(checkCatalog({ appDir: f.bundleRoot }).length, 1);
});

test('Real installed AI extracts a local DOCX using host dependencies before and after reinstall', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-installed-ai-doc-'));
  const appDir = path.join(__dirname, '..'); const filesDir = path.join(directory, 'files');
  const courseDir = path.join(filesDir, 'C1'); fs.mkdirSync(courseDir, { recursive: true });
  const JSZip = require('jszip'); const zip = new JSZip();
  zip.file('word/document.xml', `<document><p>${'Fixture course material '.repeat(30)}</p></document>`);
  fs.writeFileSync(path.join(courseDir, 'Outline.docx'), await zip.generateAsync({ type: 'nodebuffer' }));
  fs.writeFileSync(path.join(directory, 'ai_config.json'), JSON.stringify({ provider: 'custom', profiles: { custom: { baseUrl: 'https://fixture.invalid', model: 'fixture', apiKey: 'test-only' } } }));
  fs.writeFileSync(path.join(directory, 'courses.json'), JSON.stringify([{ id: 1, name: 'Fixture course', code: 'C1 (L01)' }]));
  fs.writeFileSync(path.join(directory, 'course_1_files.json'), JSON.stringify({ files: [{ id: 10, filename: 'Outline.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }] }));
  fs.writeFileSync(path.join(directory, 'course_1_assignments.json'), JSON.stringify([{ name: 'Assignment', published: true, points: 10 }]));
  let zipLoads = 0, pdfLoads = 0; const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const messages = JSON.parse(options.body).messages; const prompt = messages[0].content;
    let content;
    if (prompt.includes('材料筛选')) content = JSON.stringify({ download: ['Outline.docx'], skip: [] });
    else if (prompt.includes('gradingRows')) content = JSON.stringify({ gradingRows: [], gradingNote: 'Extracted DOCX', oneLiner: 'Read material', risk: { level: '低', reason: 'Fixture' }, resources: [], tips: [] });
    else { assert(messages[1].content.includes('Fixture course material')); content = 'Document summary'; }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  const manager = createPluginManager({ catalog: require('../plugins/catalog.json'), bundleRoot: appDir,
    statePath: path.join(directory, 'plugins.json'), services: {
      canvas: { sanitizeName: value => value, downloadFile: async () => { throw new Error('Local file should not download'); }, withSessionWindow: async fn => fn({}), executeWithTimeout: async () => ({ syllabus: '', pages: [] }) },
      storage: { dataDir: directory, filesDir }, diagnostics: { track() {} },
      documents: { loadZip() { zipLoads++; return require('jszip'); }, loadPdfParser() { pdfLoads++; return require('pdf-parse').PDFParse; } },
    } });
  t.after(async () => { globalThis.fetch = originalFetch; await manager.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  await manager.initialize(); assert.equal(zipLoads, 0); assert.equal(pdfLoads, 0);
  await manager.setEnabled('canvas-ai', true);
  assert((await manager.invoke('canvas-ai', 'analyze-course', [1])).report.includes('Extracted DOCX'));
  const savedReport = fs.readFileSync(path.join(directory, 'analysis_1.json'), 'utf8');
  await manager.uninstall('canvas-ai'); await manager.install('canvas-ai'); await manager.setEnabled('canvas-ai', true);
  assert.equal((await manager.invoke('canvas-ai', 'load-analysis', [1])).report, JSON.parse(savedReport).report);
  assert((await manager.invoke('canvas-ai', 'analyze-course', [1])).report.includes('Extracted DOCX'));
  assert.equal(zipLoads, 2); assert.equal(pdfLoads, 0);
});

test('A bundled upgrade respects an explicit uninstall', async t => {
  const f = fixture(t); await f.initial.initialize(); await f.initial.uninstall('optional-tool'); await f.initial.dispose();
  f.payload('4.1.0', 'replacement'); const restarted = f.manager(); await restarted.initialize();
  assert.equal(restarted.list()[0].installed, false);
  assert.equal(restarted.list()[0].enabled, false);
});
