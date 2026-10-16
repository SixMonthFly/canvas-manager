const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, cb) {
  const listener = (_event, data) => cb(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', {
  uiPreferences: () => ipcRenderer.invoke('ui-preferences'),
  uiPreferencesSave: (patch) => ipcRenderer.invoke('ui-preferences-save', patch),
  schoolConfig: () => ipcRenderer.invoke('school-config'),
  schoolSave: (id) => ipcRenderer.invoke('school-save', id),
  onboardingConnect: (id) => ipcRenderer.invoke('onboarding-connect', id),
  rendererReady: () => ipcRenderer.send('renderer-ready'),
  pluginsList: () => ipcRenderer.invoke('plugins-list'),
  pluginInstall: (id) => ipcRenderer.invoke('plugin-install', id),
  pluginUninstall: (id) => ipcRenderer.invoke('plugin-uninstall', id),
  pluginSetEnabled: (id, enabled) => ipcRenderer.invoke('plugin-set-enabled', id, enabled),
  pluginInvoke: (id, method, ...args) => ipcRenderer.invoke('plugin-invoke', id, method, args),
  onPluginEvent: (cb) => subscribe('plugin-event', cb),
  onPluginsChanged: (cb) => subscribe('plugin-state-changed', cb),
  loadLocal: () => ipcRenderer.invoke('load-local'),
  refresh: () => ipcRenderer.invoke('refresh'),
  syncProgressCurrent: () => ipcRenderer.invoke('sync-progress-current'),
  onSyncProgress: (cb) => ipcRenderer.on('sync-progress', (_e, data) => cb(data)),
  openUrl: (url) => ipcRenderer.invoke('open-url', url),
  downloadFile: (arg) => ipcRenderer.invoke('download-file', arg),
  checkDownloaded: (items) => ipcRenderer.invoke('check-downloaded', items),
  openFile: (arg) => ipcRenderer.invoke('open-file', arg),
  revealFile: (arg) => ipcRenderer.invoke('reveal-file', arg),
  onOpenAssignment: (cb) => ipcRenderer.on('open-assignment', (_e, data) => cb(data)),
  onDataUpdated: (cb) => ipcRenderer.on('data-updated', (_e, data) => cb(data)),
  appVersion: () => ipcRenderer.invoke('app-version'),
  telemetryConfig: () => ipcRenderer.invoke('telemetry-config'),
  telemetrySetEnabled: (enabled) => ipcRenderer.invoke('telemetry-set-enabled', enabled),
  exportTelemetry: () => ipcRenderer.invoke('export-telemetry'),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  runUpdate: (assets) => ipcRenderer.invoke('run-update', assets),
  onUpdateProgress: (cb) => ipcRenderer.on('update-progress', (_e, data) => cb(data)),
});
