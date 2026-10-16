// Generic, revocable desktop-window service for trusted bundled plugins.
function createDesktopService({ BrowserWindow, ipcMain, screen, platform = process.platform, showMainWindow }) {
  const owners = new Map();
  ipcMain.handle('plugin-window-invoke', (event, method, args) => {
    const owner = owners.get(event.sender.id);
    if (!owner || event.senderFrame !== event.sender.mainFrame || !Array.isArray(args)) {
      throw new Error('桌面窗口调用无效');
    }
    return owner(method, ...args);
  });
  return {
    platform,
    showMainWindow,
    async createCard({ html, preload, bounds, pinned = false, onInvoke, onMove }) {
      const area = screen.getDisplayMatching(bounds || screen.getPrimaryDisplay().workArea).workArea;
      const width = 360, height = 480;
      const x = Number.isFinite(bounds?.x) ? bounds.x : area.x + area.width - width - 24;
      const y = Number.isFinite(bounds?.y) ? bounds.y : area.y + 48;
      const win = new BrowserWindow({
        x: Math.round(Math.max(area.x, Math.min(x, area.x + Math.max(0, area.width - width)))),
        y: Math.round(Math.max(area.y, Math.min(y, area.y + Math.max(0, area.height - height)))),
        width, height, frame: false, resizable: false, minimizable: false, maximizable: false,
        fullscreenable: false, skipTaskbar: true, show: false, backgroundColor: '#13243c',
        title: 'Canvas · 七天作业',
        webPreferences: { preload, nodeIntegration: false, contextIsolation: true, sandbox: true },
      });
      owners.set(win.webContents.id, onInvoke);
      const senderId = win.webContents.id;
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', event => event.preventDefault());
      win.on('move', () => onMove?.(win.getBounds()));
      win.on('closed', () => owners.delete(senderId));
      win.setAlwaysOnTop(pinned);
      if (platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false, skipTransformProcessType: true });
      try { await win.loadFile(html); }
      catch (error) { win.destroy(); throw error; }
      return win;
    },
  };
}
module.exports = { createDesktopService };
