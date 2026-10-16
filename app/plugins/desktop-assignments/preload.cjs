const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('card', {
  invoke: (method, ...args) => ipcRenderer.invoke('plugin-window-invoke', method, args),
  onChanged(callback) {
    const listener = () => callback();
    ipcRenderer.on('desktop-card-changed', listener);
    return () => ipcRenderer.removeListener('desktop-card-changed', listener);
  },
});
