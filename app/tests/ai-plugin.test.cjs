const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const appDir = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(appDir, 'plugins', 'ai', 'main.cjs'), 'utf8');
const response = payload => ({ ok: true, status: 200, json: async () => payload });
const answer = content => ({ choices: [{ message: { content } }] });

// Evaluate the real plugin with temporary course data, simulated HTTP, and
// controllable timers. No Canvas session, user configuration, or model service
// is accessed by these tests.
function fixture(t, { fetch, timeoutDelay } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-ai-test-'));
  const effects = [];
  const events = [];
  const timers = new Set();
  const requestedTimeouts = [];
  const config = { provider: 'custom', effort: 'disabled', profiles: { custom: {
    baseUrl: 'https://fixture.invalid/v1', model: 'fixture-model', apiKey: 'test-only',
  } } };
  fs.writeFileSync(path.join(dataDir, 'ai_config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(dataDir, 'courses.json'), JSON.stringify([
    { id: 1, name: 'Fixture 1', code: 'C1 (L01)' },
    { id: 2, name: 'Fixture 2', code: 'C2 (L01)' },
  ]));
  for (const id of [1, 2]) {
    fs.writeFileSync(path.join(dataDir, `course_${id}_files.json`), JSON.stringify({ files: [] }));
    fs.writeFileSync(path.join(dataDir, `course_${id}_assignments.json`), JSON.stringify([
      { name: 'Fixture assignment', published: true, points: 20, due_at: new Date(Date.now() + 86400000).toISOString() },
    ]));
    fs.writeFileSync(path.join(dataDir, `analysis_${id}.json`), JSON.stringify({
      courseId: id, report: `Existing report ${id}`, generatedAt: '2026-09-30T06:00:00.000Z',
    }));
  }
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports, require, Buffer, AbortController,
    fetch: fetch || (async () => { throw new Error('Unexpected model request'); }),
    setTimeout(callback, delay) {
      requestedTimeouts.push(delay);
      let timer;
      timer = setTimeout(() => { timers.delete(timer); callback(); }, timeoutDelay ?? delay);
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
  }, { filename: path.join(appDir, 'plugins', 'ai', 'main.cjs') });
  const plugin = module.exports.activate({
    services: {
      canvas: {
        sanitizeName: value => value,
        downloadFile: async () => { throw new Error('No downloads expected'); },
        withSessionWindow: async fn => fn({}),
        executeWithTimeout: async () => ({ syllabus: 'Fixture syllabus', pages: [] }),
        readLocalData: () => ({}), origin: 'https://fixture.invalid',
      },
      storage: { dataDir, filesDir: path.join(dataDir, 'files') },
      diagnostics: { track() {} },
    },
    effect(dispose) { effects.push(dispose); },
    emit(event, data) { events.push({ event, data }); },
  });
  async function dispose() {
    for (const cleanup of effects.splice(0).reverse()) await cleanup();
  }
  t.after(async () => {
    await dispose();
    for (const timer of timers) clearTimeout(timer);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { plugin, dataDir, config, events, timers, requestedTimeouts, dispose,
    read(name) { return fs.readFileSync(path.join(dataDir, name), 'utf8'); } };
}

function hangingFetch() {
  const requests = [];
  return { requests, fetch: async (url, options) => new Promise((resolve, reject) => {
    const request = { url, signal: options.signal, body: JSON.parse(options.body),
      respond(payload) { resolve(response(payload)); } };
    requests.push(request);
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }) };
}

test('Activation preserves saved configuration and reports; invalid courses release busy state', async t => {
  const f = fixture(t);
  const originalConfig = f.read('ai_config.json');
  const originalReport = f.read('analysis_1.json');
  assert.deepEqual(Object.keys(f.plugin.methods).sort(), [
    'ai-chat', 'ai-config-load', 'ai-config-save', 'ai-presets', 'ai-probe',
    'ai-test', 'analyze-course', 'cancel-analysis', 'load-analysis',
  ].sort());
  assert((await f.plugin.methods['ai-config-load']()).profiles.custom.apiKey === f.config.profiles.custom.apiKey);
  assert.equal((await f.plugin.methods['load-analysis'](1)).report, 'Existing report 1');
  await assert.rejects(f.plugin.methods['analyze-course'](99), /找不到课程/);
  assert.equal(f.plugin.isBusy(), false);
  assert.equal(f.timers.size, 0);
  await f.dispose();
  assert.equal(f.read('ai_config.json'), originalConfig);
  assert.equal(f.read('analysis_1.json'), originalReport);
  assert.throws(() => f.plugin.methods['load-analysis'](1), /停用/);
});

test('All legacy model operations and course report generation work through injected services', async t => {
  const calls = [];
  const f = fixture(t, { fetch: async (url, options) => {
    assert(url.startsWith('https://fixture.invalid/'));
    calls.push(url);
    if (url.endsWith('/models')) return response({ data: [{ id: 'fixture-model', capabilities: ['disabled', 'high'] }] });
    const prompt = JSON.parse(options.body).messages[0].content;
    if (prompt.includes('材料筛选')) return response(answer(JSON.stringify({ download: [], skip: [] })));
    if (prompt.includes('gradingRows')) return response(answer(JSON.stringify({
      gradingRows: [], gradingNote: 'Fixture note', oneLiner: 'Read first',
      risk: { level: '低', reason: 'Fixture' }, resources: [], tips: ['Submit on time'],
    })));
    return response(answer('Fixture answer'));
  } });
  const methods = f.plugin.methods;
  assert.equal(Object.keys(methods['ai-presets']()).length, 3);
  assert.equal(methods['ai-config-save'](f.config), true);
  assert.equal(await methods['ai-test'](f.config.profiles.custom), 'Fixture answer');
  const probe = await methods['ai-probe']();
  assert.equal(probe.ok, true);
  assert.deepEqual(Array.from(probe.levels), ['disabled', 'high']);
  assert.equal(await methods['ai-chat']({ system: 'Summarize', user: 'Fixture task' }), 'Fixture answer');
  const report = await methods['analyze-course'](1);
  assert(report.report.includes('Fixture note'));
  assert(f.events.some(item => item.event === 'analysis-progress' && item.data.stage === 'done'));
  assert((methods['load-analysis'](1)).report.includes('Fixture note'));
  assert.equal(methods['cancel-analysis'](1), true);
  assert.equal(f.plugin.isBusy(), false);
  assert.equal(f.timers.size, 0);
  assert.equal(calls.length, 5);
});

test('Probing a draft returns thinking levels without saving until explicit configuration save', async t => {
  const f = fixture(t, { fetch: async url => {
    assert.equal(url, 'https://draft.fixture.invalid/models');
    return response({ data: [{ id: 'draft-model', thinking: { supported: ['high', 'low', 'disabled'] } }] });
  } });
  const original = f.read('ai_config.json');
  const draft = { baseUrl: 'https://draft.fixture.invalid', model: 'draft-model', apiKey: 'test-only-draft' };
  const probe = await f.plugin.methods['ai-probe'](draft);
  assert.equal(probe.ok, true); assert.equal(probe.model, 'draft-model');
  assert.deepEqual(Array.from(probe.levels), ['disabled', 'low', 'high']);
  assert.equal(f.read('ai_config.json'), original);
  const saved = { ...f.config, effort: 'high', thinkingLevels: Array.from(probe.levels), profiles: { custom: draft } };
  assert.equal(f.plugin.methods['ai-config-save'](saved), true);
  assert.deepEqual(JSON.parse(f.read('ai_config.json')), saved);
  assert.equal(f.plugin.isBusy(), false); assert.equal(f.timers.size, 0);
});

test('Cancelling a course aborts its model request without aborting another course or standalone chat', async t => {
  const simulated = hangingFetch();
  const f = fixture(t, { fetch: simulated.fetch });
  const first = f.plugin.methods['analyze-course'](1);
  const firstRejected = assert.rejects(first, /已取消/);
  const second = f.plugin.methods['analyze-course'](2);
  const secondRejected = assert.rejects(second, /已取消/);
  const standalone = f.plugin.methods['ai-chat']({ system: 'Standalone', user: 'Separate request' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(simulated.requests.length, 3);
  const forCourse = id => simulated.requests.find(request => request.body.messages.some(message => message.content.includes(`Fixture ${id}`)));
  const standaloneRequest = simulated.requests.find(request => request.body.messages[0].content === 'Standalone');
  assert.equal(f.plugin.isBusy(), true);
  f.plugin.methods['cancel-analysis'](1);
  await firstRejected;
  assert.equal(forCourse(1).signal.aborted, true);
  assert.equal(forCourse(2).signal.aborted, false);
  assert.equal(standaloneRequest.signal.aborted, false);
  assert.equal(f.timers.size, 2);
  assert.equal(JSON.parse(f.read('analysis_1.json')).report, 'Existing report 1');
  f.plugin.methods['cancel-analysis'](2);
  await secondRejected;
  standaloneRequest.respond(answer('Standalone result'));
  assert.equal(await standalone, 'Standalone result');
  assert.equal(f.plugin.isBusy(), false);
  assert.equal(f.timers.size, 0);
  assert.equal(JSON.parse(f.read('analysis_2.json')).report, 'Existing report 2');
});

test('Model requests have a finite 120 second timeout and release timers and busy state', async t => {
  const simulated = hangingFetch();
  const f = fixture(t, { fetch: simulated.fetch, timeoutDelay: 10 });
  await assert.rejects(f.plugin.methods['ai-chat']({ system: 'Timeout', user: 'Fixture' }), /请求超时.*120/);
  assert.deepEqual(f.requestedTimeouts, [120000]);
  assert.equal(simulated.requests[0].signal.aborted, true);
  assert.equal(f.plugin.isBusy(), false);
  assert.equal(f.timers.size, 0);
});

test('Cancelling structured report generation prevents a fallback request and permits a new analysis', async t => {
  const requests = [];
  let pauseStructured = true;
  let structuredSignal;
  const f = fixture(t, { fetch: async (url, options) => {
    const prompt = JSON.parse(options.body).messages[0].content;
    requests.push({ url, prompt });
    if (prompt.includes('材料筛选')) return response(answer(JSON.stringify({ download: [], skip: [] })));
    if (prompt.includes('gradingRows')) {
      if (pauseStructured) {
        structuredSignal = options.signal;
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        });
      }
      return response(answer(JSON.stringify({
        gradingRows: [], gradingNote: 'Restarted report', oneLiner: 'Read first',
        risk: { level: '低', reason: 'Fixture' }, resources: [], tips: [],
      })));
    }
    throw new Error('Cancelled analysis must not start a free-format fallback request');
  } });
  const oldReport = f.read('analysis_1.json');
  const pending = f.plugin.methods['analyze-course'](1);
  const rejected = assert.rejects(pending, /已取消/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 2);
  assert(structuredSignal);
  f.plugin.methods['cancel-analysis'](1);
  await rejected;
  assert.equal(structuredSignal.aborted, true);
  assert.equal(requests.length, 2, 'Cancellation must not send the fallback request');
  assert.equal(f.plugin.isBusy(), false);
  assert.equal(f.timers.size, 0);
  assert.equal(f.read('analysis_1.json'), oldReport);
  pauseStructured = false;
  const restarted = await f.plugin.methods['analyze-course'](1);
  assert(restarted.report.includes('Restarted report'));
  assert.equal(requests.length, 4);
  assert.equal(f.plugin.isBusy(), false);
  assert.equal(f.timers.size, 0);
});

test('Disposal cancels pending standalone model calls without modifying saved data', async t => {
  const simulated = hangingFetch();
  const f = fixture(t, { fetch: simulated.fetch });
  const originalConfig = f.read('ai_config.json');
  const originalReport = f.read('analysis_1.json');
  const pending = f.plugin.methods['ai-chat']({ system: 'Dispose', user: 'Fixture' });
  const rejected = assert.rejects(pending, /aborted|停用/);
  assert.equal(f.plugin.isBusy(), true);
  await f.dispose();
  await rejected;
  assert.equal(f.plugin.isBusy(), false);
  assert.equal(f.timers.size, 0);
  assert.equal(f.read('ai_config.json'), originalConfig);
  assert.equal(f.read('analysis_1.json'), originalReport);
});

test('Plugin state IPC publishes actual state even if disabling fails during cleanup', async () => {
  const main = fs.readFileSync(path.join(appDir, 'main.js'), 'utf8');
  const handlerSource = main.slice(main.indexOf("ipcMain.handle('plugin-set-enabled',"), main.indexOf("ipcMain.handle('plugin-invoke',"));
  let handler;
  const sent = [];
  const failed = new Error('Cleanup failed');
  const current = [{ id: 'canvas-ai', enabled: false }];
  vm.runInNewContext(handlerSource, {
    ipcMain: { handle(_name, callback) { handler = callback; } },
    pluginManager: { setEnabled: async () => { throw failed; }, list: () => current },
    mainWindow: { isDestroyed: () => false, webContents: { send: (...args) => sent.push(args) } },
  });
  await assert.rejects(handler(null, 'canvas-ai', false), error => error === failed);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'plugin-state-changed');
  assert.equal(sent[0][1], current);
});

test('Preload forwards plugin arguments and precisely disposes each event subscription', async () => {
  const ipc = new EventEmitter();
  const invokes = [];
  ipc.invoke = (...args) => { invokes.push(args); return Promise.resolve(); };
  let api;
  vm.runInNewContext(fs.readFileSync(path.join(appDir, 'preload.js'), 'utf8'), {
    require: () => ({ ipcRenderer: ipc, contextBridge: { exposeInMainWorld(_name, value) { api = value; } } }),
  });
  const payload = { system: 'Fixture', user: 'Question' };
  await api.pluginInvoke('canvas-ai', 'ai-chat', payload, 17);
  assert.equal(invokes[0][0], 'plugin-invoke');
  assert.equal(invokes[0][1], 'canvas-ai');
  assert.equal(invokes[0][2], 'ai-chat');
  assert.equal(invokes[0][3][0], payload);
  assert.equal(invokes[0][3][1], 17);
  assert.equal(api.aiChat, undefined);
  let first = 0, second = 0;
  const disposeFirst = api.onPluginEvent(() => first++);
  const disposeSecond = api.onPluginEvent(() => second++);
  ipc.emit('plugin-event', {}, {});
  disposeFirst();
  ipc.emit('plugin-event', {}, {});
  assert.equal(first, 1);
  assert.equal(second, 2);
  disposeSecond();
  assert.equal(ipc.listenerCount('plugin-event'), 0);
  const disposeState = api.onPluginsChanged(() => {});
  disposeState();
  assert.equal(ipc.listenerCount('plugin-state-changed'), 0);
});
