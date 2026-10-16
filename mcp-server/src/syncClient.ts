import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { resolve, join } from 'node:path';

export function syncEndpoint(dataDir: string): string {
  if (process.platform !== 'win32') {
    const socket = join(resolve(dataDir), 'sync_bridge.sock');
    if (Buffer.byteLength(socket) < 100) return socket;
    const hash = createHash('sha256').update(resolve(dataDir)).digest('hex').slice(0, 32);
    return join('/tmp', `canvas-sync-${process.getuid!()}-${hash}.sock`);
  }
  const identity = createHash('sha256').update(resolve(dataDir).toLowerCase()).digest('hex').slice(0, 16);
  return `\\\\.\\pipe\\canvas-manager-sync-${identity}`;
}

export interface SyncResult { syncedAt: string; courseCount: number; progress: Array<{ phase: string; completed?: number; total?: number; active?: string[] }> }

export function triggerAppSync(dataDir: string): Promise<SyncResult> {
  let token: string;
  try { token = JSON.parse(readFileSync(join(dataDir, 'sync_bridge_token.json'), 'utf-8')).token; }
  catch { return Promise.reject(new Error('找不到桌面应用同步通道。请先启动对应数据目录的 Canvas 管理工具。')); }
  if (typeof token !== 'string' || !token) return Promise.reject(new Error('桌面应用同步凭据无效。'));
  return new Promise((resolvePromise, rejectPromise) => {
    const progress: SyncResult['progress'] = [];
    const socket = createConnection(syncEndpoint(dataDir));
    let settled = false, buffer = '';
    const finish = (error?: Error, result?: SyncResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.end();
      if (error) rejectPromise(error); else resolvePromise(result!);
    };
    const timer = setTimeout(() => finish(new Error('同步等待超时，请检查桌面应用的登录窗口或网络。')), 7 * 60 * 1000);
    socket.on('connect', () => socket.write(JSON.stringify({ action: 'sync', token, requestId: randomUUID() }) + '\n'));
    socket.on('data', chunk => {
      buffer += chunk.toString('utf-8');
      if (buffer.length > 1024 * 1024) return finish(new Error('同步通道返回数据过大'));
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n');
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        let event: any;
        try { event = JSON.parse(line); } catch { return finish(new Error('同步通道返回无效数据')); }
        if (event.type === 'progress') {
          if (event.data && typeof event.data.phase === 'string') progress.push({
            phase: event.data.phase, completed: event.data.completed,
            total: event.data.total, active: event.data.active,
          });
        } else if (event.type === 'complete') {
          finish(undefined, { syncedAt: String(event.syncedAt), courseCount: Number(event.courseCount), progress });
        } else if (event.type === 'error') finish(new Error(String(event.message || '同步失败')));
      }
    });
    socket.on('error', error => finish(new Error(`无法连接桌面应用：${error.message}`)));
    socket.on('close', () => { if (!settled) finish(new Error('桌面应用在同步完成前关闭了连接')); });
  });
}
