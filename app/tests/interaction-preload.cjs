const { contextBridge } = require('electron');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const courses = [
  { id: 1, code: 'CTRL2010 (L01)', name: 'Formal Verification and Control' },
  { id: 2, code: 'WRIT1001 (T01)', name: 'Communicating Research in English' },
];
const byCourse = Object.fromEntries(courses.map(c => [c.id, Array.from({ length: 24 }, (_, i) => ({
  id: c.id * 100 + i, name: `Assignment ${i + 1} — Read, annotate and discuss the research`,
  published: true, due_at: new Date(Date.now() + 3 * 86400000).toISOString(), points: 10,
  description: '<h2>Read and annotate a research paper</h2><p>Review the questions below and prepare your notes for the next class.</p><ul><li>Explain the key idea in your own words.</li><li>Describe one practical example.</li></ul>',
}))]));
const filesBy = Object.fromEntries(courses.map(c => [c.id, { files: [{ id: c.id,
  filename: `lecture-${c.id}.pdf`, size: 123456, type: 'application/pdf' }], links: [] }]));
const annBy = Object.fromEntries(courses.map(c => [c.id, [1, 2].map(i => ({
  id: c.id * 10 + i, title: `Week ${i} reminder and class arrangements`, posted_at: '2026-09-20',
  message: '<p>Please review the reading before class.</p><p>The discussion will focus on your examples.</p>',
}))]));
let installed = true;
let enabled = false;
let generation = 1;
let pluginCalls = 0;
let installCalls = 0;
let uninstallCalls = 0;
let enableCalls = 0;
let pendingChats = 0;
let telemetryEnabled = true;
let telemetrySaves = 0;
let rejectSave = false;
let lastTestConfig = null;
let rejectDisable = false;
let holdChats = false;
let heldChats = [];
const events = new Set();
const changes = new Set();
let aiConfig = { provider: 'custom', profiles: { custom: { model: 'test', apiKey: 'synthetic' } } };
const reports = Object.fromEntries(courses.map(course => [course.id, { report: `Course ${course.id} report`, generatedAt: '2026-09-24' }]));
const themeStates = [
  { id: 'theme-hkust', themeId: 'hkust', directory: 'hkust', name: 'HKUST', installed: true, defaultInstalled: true },
  { id: 'theme-claude', themeId: 'claude', directory: 'claude', name: 'Claude', installed: false, defaultInstalled: false },
  { id: 'theme-chatgpt', themeId: 'chatgpt', directory: 'chatgpt', name: 'ChatGPT', installed: false, defaultInstalled: false },
  { id: 'theme-dark', themeId: 'default', directory: 'dark', name: '深色', installed: false, defaultInstalled: false },
].map(theme => ({ ...theme, generation: 1 }));
const list = () => [{ id: 'canvas-ai', name: 'AI 助手', description: '解读作业、生成方案、整理公告和分析课程。启用后可配置模型服务。',
  version: '4.0.0', bundledVersion: '4.0.0', apiVersion: 1, defaultEnabled: false,
  installed, enabled, bundled: true, source: 'bundled', available: true, generation: installed ? String(generation) : null,
  renderer: installed ? `../plugins/ai/renderer.mjs?generation=${generation}` : null },
  ...themeStates.map(theme => ({ ...theme, name: `${theme.name} 皮肤`, description: '更换应用外观，保留课程数据和功能。',
    kind: 'theme', version: '4.0.0', bundledVersion: '4.0.0', apiVersion: 1, enabled: false,
    source: 'bundled', bundled: true, available: true,
    renderer: theme.installed ? `../plugins/themes/${theme.directory}/renderer.mjs?generation=${theme.generation}` : null }))];
const subscribe = (listeners, cb) => { listeners.add(cb); return () => listeners.delete(cb); };
const publish = () => { const snapshot = list(); for (const cb of changes) cb(snapshot); return snapshot; };
contextBridge.exposeInMainWorld('api', {
  uiPreferences: async () => ({language:'zh-CN',onboardingStatus:'completed',onboardingStep:2}),
  schoolConfig: async () => ({ schools: [{ id: 'hkust-gz', name: '香港科技大学（广州）', region: '内地', origin: 'https://hkust-gz.instructure.com' }, { id: 'nus', name: '新加坡国立大学', region: '新加坡', origin: 'https://canvas.nus.edu.sg' }], active: { id: 'hkust-gz', name: '香港科技大学（广州）', origin: 'https://hkust-gz.instructure.com' }, selected: 'hkust-gz' }),
  schoolSave: async id => ({ restartRequired: id !== 'hkust-gz' }),
  pluginsList: async () => list(),
  pluginSetEnabled: async (id, value) => {
    enableCalls++;
    if (id !== 'canvas-ai') throw new Error('Unknown plugin');
    if (!installed) throw new Error('PLUGIN_NOT_INSTALLED');
    if (!value && rejectDisable) { rejectDisable = false; throw new Error('PLUGIN_BUSY: synthetic pending task'); }
    enabled = value;
    return publish();
  },
  pluginInstall: async id => {
    const theme = themeStates.find(theme => theme.id === id);
    if (theme) { await wait(30); theme.installed = true; theme.generation++; return publish(); }
    installCalls++;
    if (id !== 'canvas-ai') throw new Error('Unknown plugin');
    if (pendingChats) throw new Error('PLUGIN_BUSY: wait for the AI task to finish');
    await wait(60);
    installed = true; enabled = false; generation++;
    return publish();
  },
  pluginUninstall: async id => {
    const theme = themeStates.find(theme => theme.id === id);
    if (theme) { await wait(30); theme.installed = false; return publish(); }
    uninstallCalls++;
    if (id !== 'canvas-ai') throw new Error('Unknown plugin');
    if (pendingChats) throw new Error('PLUGIN_BUSY: wait for the AI task to finish');
    await wait(60);
    installed = false; enabled = false;
    return publish();
  },
  onPluginEvent: cb => subscribe(events, cb),
  onPluginsChanged: cb => subscribe(changes, cb),
  pluginInvoke: async (id, method, ...args) => {
    pluginCalls++;
    if (!installed) throw new Error('PLUGIN_NOT_INSTALLED');
    if (!enabled || id !== 'canvas-ai') throw new Error('PLUGIN_DISABLED');
    if (method === 'ai-presets') return {
      custom: { label: 'Test provider', baseUrl: '', model: '' },
      glm: { label: 'Preset provider', baseUrl: 'https://preset.invalid/v1', model: 'preset-model' },
    };
    if (method === 'ai-config-load') return structuredClone(aiConfig);
    if (method === 'ai-config-save') {
      if (rejectSave) { rejectSave = false; throw new Error('SYNTHETIC_SETTINGS_SAVE_FAILED'); }
      aiConfig = structuredClone(args[0]); return true;
    }
    if (method === 'ai-probe') return { ok: true, levels: ['disabled', 'low', 'high'], model: args[0]?.model };
    if (method === 'ai-chat' || method === 'ai-test') {
      if (method === 'ai-test') lastTestConfig = structuredClone(args[0]);
      pendingChats++;
      try {
        if (method === 'ai-chat' && holdChats) return await new Promise(resolve => { heldChats.push(resolve); });
        await wait(50); return 'Synthetic AI response';
      } finally { pendingChats--; }
    }
    if (method === 'load-analysis') {
      await wait(args[0] === 1 ? 350 : 40);
      return structuredClone(reports[args[0]]);
    }
    if (method === 'cancel-analysis') return true;
    throw new Error('Unknown method: ' + method);
  },
  syncProgressCurrent: async () => ({ sequence: 1, runId: 1, phase: 'done', completed: 2, total: 2 }),
  onSyncProgress() {}, onOpenAssignment() {}, onDataUpdated() {}, onUpdateProgress() {},
  appVersion: async () => '4.0.0',
  telemetryConfig: async () => ({ enabled: telemetryEnabled }),
  telemetrySetEnabled: async value => { telemetrySaves++; telemetryEnabled = value; return telemetryEnabled; },
  openUrl() {},
  loadLocal: async () => ({ courses, byCourse, filesBy, annBy, syncedAt: '2026-09-24T08:00:00Z' }),
  checkDownloaded: async files => {
    await wait(files[0]?.filename === 'lecture-1.pdf' ? 350 : 60);
    return Object.fromEntries(files.map(f => [`${f.courseCode}/${f.filename}`, f.filename === 'lecture-2.pdf']));
  },
});
contextBridge.exposeInMainWorld('testPlugins', {
  stats: () => ({ pluginCalls, installCalls, uninstallCalls, enableCalls, installed, enabled, generation, pendingChats,
    config: structuredClone(aiConfig), reports: structuredClone(reports), telemetryEnabled, telemetrySaves, lastTestConfig,
    eventSubscriptions: events.size, changeSubscriptions: changes.size, heldChats: heldChats.length }),
  failNextDisable: () => { rejectDisable = true; },
  failNextSave: () => { rejectSave = true; },
  holdChats: () => { holdChats = true; heldChats = []; },
  releaseChat: index => { heldChats[index](`Synthetic AI response ${index}`); },
  stopHolding: () => { holdChats = false; },
  emit: data => { for (const cb of events) cb({ pluginId: 'canvas-ai', event: 'analysis-progress', data }); },
});
