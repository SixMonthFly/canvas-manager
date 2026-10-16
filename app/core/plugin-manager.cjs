const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createPluginInstallStore, loadInstalledPlugin, releaseInstalledPlugin, validateManifest } = require('./plugin-install-store.cjs');

const PLUGIN_API_VERSION = 1;
function failure(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

// Only the application's catalog supplies executable entries. Stored preferences
// select entries; they never supply paths or code. This is not a security sandbox.
function createPluginManager({ catalog, loadPlugin = loadInstalledPlugin, services, statePath,
  bundleRoot = path.join(__dirname, '..'), installRoot = path.join(path.dirname(statePath), 'installed-plugins'), onEvent = () => {} }) {
  const entries = new Map();
  let queue = Promise.resolve();
  let initialized = false;
  let closed = false;
  let preferences = {};
  const store = createPluginInstallStore({ bundleRoot, installRoot });
  for (const manifest of catalog) {
    validateManifest(manifest);
    if (!/^[a-z][a-z0-9-]*$/.test(manifest.id) || entries.has(manifest.id)) {
      throw failure('PLUGIN_MANIFEST', '插件 ID 无效或重复');
    }
    if (manifest.apiVersion !== PLUGIN_API_VERSION || !Array.isArray(manifest.requires)) {
      throw failure('PLUGIN_API', `不支持的插件契约：${manifest.id}`);
    }
    entries.set(manifest.id, { manifest, record: { installed: false, enabled: false }, live: null, calls: 0, error: null, transitioning: false });
  }

  function serialize(action) {
    const next = queue.then(action);
    queue = next.catch(() => {});
    return next;
  }
  function entryFor(id) {
    const entry = entries.get(id);
    if (!entry) throw failure('PLUGIN_UNKNOWN', '未找到该内置插件');
    return entry;
  }
  function list() {
    return [...entries.values()].map(({ manifest, record, live, error }) => {
      let renderer = null;
      if (record.installed) {
        try {
          // Themes load in the renderer without backend activation. Verify their
          // bytes here so an invalid installed theme never receives a load URL.
          renderer = (manifest.kind === 'theme' ? store.verify(manifest, record) : store.location(manifest, record)).renderer;
        } catch (failure) { if (manifest.kind === 'theme') error = failure.message; }
      }
      return {
        id: manifest.id, name: manifest.name, description: manifest.description,
        version: record.installed ? record.version : manifest.version, bundledVersion: manifest.version,
        apiVersion: manifest.apiVersion, defaultEnabled: manifest.defaultEnabled === true,
        defaultInstalled: manifest.defaultInstalled !== false,
        kind: manifest.kind || 'feature', themeId: manifest.themeId || null,
        renderer, generation: record.installed ? record.generation : null,
        installed: record.installed === true, available: true, bundled: true, source: 'bundled',
        enabled: !!live?.active, error,
      };
    });
  }
  function busy(entry) {
    return entry.calls > 0 || !!entry.live?.instance?.isBusy?.();
  }
  function readPreferences() {
    try {
      const value = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (value.schemaVersion === 1 && value.enabled && typeof value.enabled === 'object') {
        return { legacy: value.enabled, records: {}, corrupt: false };
      }
      if (value.schemaVersion === 2 && value.plugins && typeof value.plugins === 'object' && !Array.isArray(value.plugins)) {
        for (const [id, record] of Object.entries(value.plugins)) {
          if (!/^[a-z][a-z0-9-]*$/.test(id) || !record || typeof record.installed !== 'boolean' || typeof record.enabled !== 'boolean') throw new Error('Invalid state');
          if (record.installed && (!/^[a-f0-9]{32}$/.test(record.generation) || typeof record.version !== 'string' || record.apiVersion !== PLUGIN_API_VERSION)) throw new Error('Invalid installation');
        }
        return { records: value.plugins, corrupt: false };
      }
      return { records: {}, corrupt: true };
    } catch (error) { return { records: {}, corrupt: error.code !== 'ENOENT' }; }
  }
  function writePreferences(id, record) {
    const next = { ...preferences, [id]: record };
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const temporary = `${statePath}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 2, plugins: next }, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(temporary, statePath);
      preferences = next;
    } finally {
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  function ready() {
    if (closed || !initialized) throw failure('PLUGIN_NOT_READY', '插件服务尚未就绪');
  }
  async function installEntry(entry, preserveEnabled = false) {
    if (busy(entry)) throw failure('PLUGIN_BUSY', '插件仍有任务进行中，请等待完成或先取消任务');
    entry.transitioning = true;
    let staged;
    try {
      staged = store.stage(entry.manifest);
      const next = store.commit(staged);
      if (preserveEnabled) next.enabled = entry.record.enabled === true;
      try { writePreferences(entry.manifest.id, next); }
      catch (error) { store.discard(staged); staged = null; throw error; }
      const previous = entry.record;
      entry.record = next;
      let cleanupError;
      if (entry.live) { try { await unwind(entry, entry.live); } catch (error) { cleanupError = error; } }
      if (previous.installed) store.erase(store.quarantine(entry.manifest, previous));
      entry.error = null;
      if (cleanupError) throw cleanupError;
    } catch (error) {
      if (staged && !staged.committed) store.discard(staged);
      entry.error = error.message;
      throw error;
    } finally { entry.transitioning = false; }
    return list();
  }
  function install(id) { return serialize(() => { ready(); return installEntry(entryFor(id)); }); }
  function uninstall(id) {
    return serialize(async () => {
      ready();
      const entry = entryFor(id);
      if (busy(entry)) throw failure('PLUGIN_BUSY', '插件仍有任务进行中，请等待完成或先取消任务');
      entry.transitioning = true;
      let token;
      try {
        if (entry.record.installed) token = store.quarantine(entry.manifest, entry.record);
        const next = { installed: false, enabled: false };
        try { writePreferences(id, next); } catch (error) { store.restore(token); token = null; throw error; }
        entry.record = next;
        let cleanupError;
        if (entry.live) { try { await unwind(entry, entry.live); } catch (error) { cleanupError = error; } }
        store.erase(token); token = null;
        entry.error = null;
        if (cleanupError) throw cleanupError;
      } catch (error) { entry.error = error.message; throw error; }
      finally { entry.transitioning = false; }
      return list();
    });
  }
  async function unwind(entry, live, reason = 'deactivate') {
    live.active = false;
    if (entry.live === live) entry.live = null;
    const errors = [];
    if (typeof live.instance?.dispose === 'function') {
      try { await live.instance.dispose({ reason }); } catch (error) { errors.push(error); }
    }
    for (const dispose of live.effects.splice(0).reverse()) {
      try { await dispose(); } catch (error) { errors.push(error); }
    }
    if (live.installation) releaseInstalledPlugin(live.installation);
    if (errors.length) throw new AggregateError(errors, '插件清理失败');
  }
  async function activate(entry) {
    const supplied = {};
    for (const key of entry.manifest.requires) {
      if (!Object.hasOwn(services, key)) throw failure('PLUGIN_DEPENDENCY', `缺少服务：${key}`);
      supplied[key] = services[key];
    }
    const live = { active: false, effects: [], instance: null, installation: null };
    try {
      const installation = store.verify(entry.manifest, entry.record);
      live.installation = installation;
      const plugin = await loadPlugin(entry.manifest, installation);
      if (typeof plugin.activate !== 'function') throw failure('PLUGIN_ENTRY', '插件缺少 activate 方法');
      live.instance = await plugin.activate({
        services: Object.freeze(supplied),
        effect(dispose) {
          if (typeof dispose !== 'function') throw failure('PLUGIN_EFFECT', '清理函数无效');
          live.effects.push(dispose);
        },
        emit(event, data) {
          if (live.active && entry.live === live && !closed) onEvent(entry.manifest.id, event, data);
        },
      });
      if (!live.instance || typeof live.instance.methods !== 'object' || live.instance.methods === null) {
        throw failure('PLUGIN_METHODS', '插件必须声明调用方法');
      }
      for (const method of Object.values(live.instance.methods)) {
        if (typeof method !== 'function') throw failure('PLUGIN_METHODS', '插件方法无效');
      }
      live.active = true;
      entry.live = live;
      entry.error = null;
    } catch (error) {
      await unwind(entry, live).catch(() => {});
      throw error;
    }
    return live;
  }
  function initialize() {
    return serialize(async () => {
      if (initialized || closed) return list();
      const saved = readPreferences();
      preferences = saved.corrupt
        ? Object.fromEntries([...entries.keys()].map(id => [id, { installed: false, enabled: false }]))
        : saved.records;
      for (const entry of entries.values()) {
        const id = entry.manifest.id;
        const existing = Object.hasOwn(preferences, id);
        if (existing) entry.record = preferences[id];
        if (saved.corrupt) { entry.error = '插件状态文件损坏，请手动重新安装'; continue; }
        try { store.recover(entry.manifest, entry.record); }
        catch (error) { entry.error = error.message; continue; }
        if (!existing) {
          if (entry.manifest.defaultInstalled === false) {
            try { writePreferences(id, entry.record); } catch (error) { entry.error = error.message; }
            continue;
          }
          try { await installEntry(entry); } catch (error) { entry.error = error.message; continue; }
          const requested = entry.manifest.kind !== 'theme' && (saved.legacy && Object.hasOwn(saved.legacy, id)
            ? saved.legacy[id] === true : entry.manifest.defaultEnabled === true);
          if (requested) {
            entry.record = { ...entry.record, enabled: true };
            try { writePreferences(id, entry.record); } catch (error) { entry.record.enabled = false; entry.error = error.message; }
          }
        }
        if (entry.record.installed) {
          try {
            // A new trusted bundled version replaces only installed runtime
            // copies. User configuration and explicit uninstall choices survive.
            if (entry.record.version !== entry.manifest.version) await installEntry(entry, true);
            // Theme code is applied by the renderer host; it never activates a
            // main-process backend, including legacy enabled preferences.
            if (entry.manifest.kind === 'theme' && entry.record.enabled) {
              writePreferences(id, { ...entry.record, enabled: false });
              entry.record.enabled = false;
            }
            store.verify(entry.manifest, entry.record);
            if (entry.record.enabled && entry.manifest.kind !== 'theme') await activate(entry);
          } catch (error) { entry.error = error.message; }
        }
      }
      initialized = true;
      return list();
    });
  }
  function setEnabled(id, enabled) {
    return serialize(async () => {
      ready();
      if (typeof enabled !== 'boolean') throw failure('PLUGIN_STATE', '启用状态必须是布尔值');
      const entry = entryFor(id);
      if (!entry.record.installed) throw failure('PLUGIN_NOT_INSTALLED', '请先安装该插件');
      if (enabled && entry.manifest.kind === 'theme') throw failure('PLUGIN_THEME', '请在外观设置中选择已安装的皮肤');
      if (!!entry.live?.active === enabled && entry.record.enabled === enabled) return list();
      if (busy(entry)) throw failure('PLUGIN_BUSY', '插件仍有任务进行中，请等待完成或先取消任务');
      entry.transitioning = true;
      try {
        if (enabled) {
          const live = await activate(entry);
          try { writePreferences(id, { ...entry.record, enabled: true }); entry.record.enabled = true; } catch (error) {
            await unwind(entry, live).catch(() => {});
            throw error;
          }
        } else {
          // Persist first: a failed write must leave the working plugin enabled.
          writePreferences(id, { ...entry.record, enabled: false }); entry.record.enabled = false;
          if (entry.live) await unwind(entry, entry.live);
        }
        entry.error = null;
      } catch (error) {
        entry.error = error.message;
        throw error;
      } finally { entry.transitioning = false; }
      return list();
    });
  }
  async function invoke(id, method, args = []) {
    const entry = entryFor(id);
    if (!entry.record.installed) throw failure('PLUGIN_NOT_INSTALLED', '请先安装该插件');
    if (closed || entry.transitioning || !entry.live?.active) {
      throw failure('PLUGIN_DISABLED', '请先在“设置 → 插件”中启用该插件');
    }
    const live = entry.live;
    if (!Array.isArray(args) || !Object.hasOwn(live.instance.methods, method)) {
      throw failure('PLUGIN_METHOD', '插件调用方法或参数无效');
    }
    entry.calls++;
    try { return await live.instance.methods[method](...args); }
    finally { entry.calls--; }
  }
  function dispose() {
    // Stop new calls/events immediately; application shutdown need not wait for
    // background requests before asking each plugin to cancel its work.
    closed = true;
    return serialize(async () => {
      const errors = [];
      for (const entry of [...entries.values()].reverse()) {
        if (entry.live) {
          try { await unwind(entry, entry.live, 'shutdown'); } catch (error) { errors.push(error); }
        }
      }
      if (errors.length) throw new AggregateError(errors, '插件关闭失败');
    });
  }
  return { initialize, list, install, uninstall, setEnabled, invoke, isBusy: () => [...entries.values()].some(busy), dispose };
}

module.exports = { createPluginManager, PLUGIN_API_VERSION };
