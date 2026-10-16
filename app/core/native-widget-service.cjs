const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

function createNativeWidgetService({ helperPath, snapshotPath, platform = process.platform, runHelper } = {}) {
  let queue = Promise.resolve();
  const reload = runHelper || (() => new Promise((resolve, reject) => {
    execFile(helperPath, [], { timeout: 10000 }, error => error ? reject(error) : resolve());
  }));
  return {
    platform,
    available: () => platform === 'darwin' && fs.existsSync(helperPath),
    publish(snapshot) {
      if (platform !== 'darwin' || !fs.existsSync(helperPath)) return Promise.reject(new Error('请安装带原生小组件的 Mac 完整客户端'));
      const next = queue.catch(() => {}).then(async () => {
        const data = JSON.stringify(snapshot) + '\n';
        if (Buffer.byteLength(data) > 5 * 1024 * 1024) throw new Error('小组件数据超出大小限制');
        fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
        const temporary = `${snapshotPath}.tmp`;
        try { fs.writeFileSync(temporary, data, { mode: 0o600 }); fs.renameSync(temporary, snapshotPath); }
        finally { fs.rmSync(temporary, { force: true }); }
        await reload();
        return { published: true };
      });
      queue = next;
      return next;
    },
  };
}
module.exports = { createNativeWidgetService };
