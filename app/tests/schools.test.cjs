const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { schools, readSchool, writeSchool, schoolDataDir, schoolPartition, isCanvasUrl } = require('../core/schools.cjs');
test('school persistence preserves legacy data and isolates all campuses', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-schools-'));
  try {
    fs.writeFileSync(path.join(root, 'courses.json'), '[{"id":1}]');
    assert.equal(readSchool(root).id, 'hkust-gz');
    assert.equal(schoolDataDir(root, 'hkust-gz'), root);
    assert.equal(schoolPartition('hkust-gz'), 'persist:canvas');
    assert.equal(new Set(schools.map(s => schoolDataDir(root, s.id))).size, schools.length);
    assert.equal(new Set(schools.map(s => schoolPartition(s.id))).size, schools.length);
    for (const s of schools) { writeSchool(root, s.id); assert.equal(readSchool(root).id, s.id); }
    assert.throws(() => writeSchool(root, '../../escape'));
    assert.equal(fs.readFileSync(path.join(root, 'courses.json'), 'utf8'), '[{"id":1}]');
    fs.writeFileSync(path.join(root, 'school.json'), '{invalid'); assert.throws(() => readSchool(root));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('origin checks reject lookalikes, credentials and insecure protocols', () => {
  for (const { origin } of schools) {
    assert(isCanvasUrl(origin + '/courses', origin));
    for (const url of [origin + '.evil.test/courses', origin.replace('https:', 'http:'), origin.replace('https://', 'https://user@'), '//evil.test']) assert.equal(isCanvasUrl(url, origin), false);
  }
});
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const sessionFunction = source.slice(source.indexOf('async function withSessionWindow('), source.indexOf('// executeJavaScript 包装'));
for (const school of schools) test(`${school.id}: same-origin login needs API success; cleanup always runs`, async () => {
  let shown = false, destroyed = false, probes = 0;
  class Window {
    constructor(options) { assert.equal(options.webPreferences.partition, schoolPartition(school.id)); this.webContents = { getURL: () => school.origin + '/login/canvas' }; }
    setTitle() {} setSize() {} async loadURL() {} isDestroyed() { return destroyed; }
    show() { shown = true; } hide() {} destroy() { destroyed = true; }
  }
  const fn = vm.runInNewContext(sessionFunction + '\nwithSessionWindow', {
    BrowserWindow: Window, SCHOOL: school, CANVAS_ORIGIN: school.origin, SESSION_PARTITION: schoolPartition(school.id),
    isCanvasUrl, executeWithTimeout: async () => ++probes > 1, Date, setTimeout,
  });
  assert.equal(await fn(async () => 'ok'), 'ok');
  assert(shown && destroyed); assert.equal(probes, 2);
});
test('asset rewrite follows selected origin without proxying other schools', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const start = renderer.indexOf('function rewriteCanvasAssets(');
  const end = renderer.indexOf('\nfunction ', start + 10);
  const rewrite = vm.runInNewContext(renderer.slice(start, end) + '\nrewriteCanvasAssets', { URL, encodeURIComponent, CANVAS_ORIGIN: 'https://canvas.nus.edu.sg' });
  assert(rewrite('<img src="/files/1">').includes('canvas-res://'));
  for (const host of ['hkust-gz.instructure.com', 'canvas.nus.edu.sg.evil.test']) {
    const html = `<img src="https://${host}/files/1">`; assert.equal(rewrite(html), html);
  }
});

test('first NUS navigation cancellation proceeds to login in the same sync attempt', async () => {
  let destroyed = false, shown = false, probes = 0;
  class Window {
    constructor() { this.webContents = { getURL: () => shown ? 'https://canvas.nus.edu.sg/courses' : 'https://www.nus.edu.sg/canvas/login/' }; }
    setTitle() {} setSize() {} async loadURL() { throw Object.assign(new Error("ERR_ABORTED (-3) loading 'https://www.nus.edu.sg/canvas/login/'"), { code: 'ERR_ABORTED', errno: -3 }); }
    isDestroyed() { return destroyed; } show() { shown = true; } hide() {} destroy() { destroyed = true; }
  }
  const fn = vm.runInNewContext(sessionFunction + '\nwithSessionWindow', {
    BrowserWindow: Window, SCHOOL: schools.find(s => s.id === 'nus'), CANVAS_ORIGIN: 'https://canvas.nus.edu.sg', SESSION_PARTITION: 'persist:canvas-nus',
    isCanvasUrl, executeWithTimeout: async () => { probes++; return true; }, Date, setTimeout: callback => callback(),
  });
  assert.equal(await fn(async () => 'synced'), 'synced');
  assert(shown && destroyed); assert.equal(probes, 1, 'Only probe the Canvas origin after login redirect');
});

test('non-aborted navigation failures still reject and clean up the login window', async () => {
  let destroyed = false;
  class Window {
    setTitle() {} setSize() {} async loadURL() { throw Object.assign(new Error('ERR_CONNECTION_REFUSED'), { code: 'ERR_CONNECTION_REFUSED' }); }
    isDestroyed() { return destroyed; } destroy() { destroyed = true; }
  }
  const fn = vm.runInNewContext(sessionFunction + '\nwithSessionWindow', { BrowserWindow: Window, SCHOOL: schools[0], CANVAS_ORIGIN: schools[0].origin, SESSION_PARTITION: 'persist:canvas' });
  await assert.rejects(fn(async () => assert.fail('must not sync')), /连接学校服务超时/);
  assert(destroyed);
});

test('saving a changed school relaunches once; busy work prevents changing persisted selection', () => {
  const fragment = source.slice(source.indexOf('function saveSchool('), source.indexOf('\napp.whenReady().then(async () => {', source.indexOf('function saveSchool(')));
  const events = []; let handler, timer;
  const context = vm.createContext({ ipcMain: { handle: (name, fn) => { if(name==='school-save') handler = fn; } }, SCHOOL: schools[0], DATA_ROOT: '/fixture',
    schoolRestartPending: false, syncing: true, pendingDownloads: 0, pluginManager: { isBusy: () => false },
    readSchool: () => schools[0], writeSchool: (_root, id) => { events.push(id); return { id }; }, setTimeout: fn => { timer = fn; },
    app: { relaunch: () => events.push('relaunch'), quit: () => events.push('quit') } });
  vm.runInContext(fragment, context);
  assert.throws(() => handler(null, 'nus'), /等待/); assert.deepEqual(events, []);
  context.syncing = false;
  assert.equal(handler(null, 'hkust-gz').restartRequired, false); assert.equal(timer, undefined);
  assert.equal(handler(null, 'nus').restartRequired, true); timer();
  assert.deepEqual(events, ['hkust-gz', 'nus', 'relaunch', 'quit']);
  assert.throws(() => handler(null, 'nus'), /正在重启/);
});

test('entering the app persists pending practical guidance before restart and rolls back a failed save', () => {
  const fragment = source.slice(source.indexOf('function saveSchool('), source.indexOf('\napp.whenReady().then(async () => {', source.indexOf('function saveSchool(')));
  let handler, selected='hkust-gz', completed=false, timer, reject=true;
  const context=vm.createContext({ipcMain:{handle:(name,fn)=>{if(name==='onboarding-connect')handler=fn;}},SCHOOL:schools[0],DATA_ROOT:'/fixture',schoolRestartPending:false,syncing:true,pendingDownloads:0,pluginManager:{isBusy:()=>false},
    readSchool:()=>({id:selected}),writeSchool:(_root,id)=>{selected=id;return{id};},uiPreferences:{save:patch=>{if(reject)throw Error('disk unavailable');completed=patch.onboardingStatus==='pending' && patch.onboardingStep===3;}},
    setTimeout:fn=>{assert(completed,'Pending practical step must be durable before scheduling restart');timer=fn;},app:{relaunch(){},quit(){}}});
  vm.runInContext(fragment,context);
  assert.throws(()=>handler(null,'nus'),/等待/);assert.equal(selected,'hkust-gz');assert.equal(completed,false);
  context.syncing=false;
  assert.throws(()=>handler(null,'nus'),/disk unavailable/);assert.equal(selected,'hkust-gz');assert.equal(timer,undefined);
  reject=false;assert.equal(handler(null,'nus').restartRequired,true);assert.equal(selected,'nus');assert.equal(completed,true);assert.equal(typeof timer,'function');
});
