const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const TOKEN_FILE = 'sync_bridge_token.json';
const SOCKET_FILE = 'sync_bridge.sock';
const MAX_REQUEST_BYTES = 8192;

function endpointForDataDir(dataDir, platform = process.platform) {
  const resolved = path.resolve(dataDir);
  if (platform === 'win32') {
    const identity = resolved.toLowerCase();
    const hash = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 16);
    return `\\\\.\\pipe\\canvas-manager-sync-${hash}`;
  }
  const socket = path.join(resolved, SOCKET_FILE);
  if (Buffer.byteLength(socket) < 100) return socket;
  const hash = crypto.createHash('sha256').update(resolved).digest('hex').slice(0, 32);
  return path.join('/tmp', `canvas-sync-${process.getuid()}-${hash}.sock`);
}

function loadOrCreateToken(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const tokenPath = path.join(dataDir, TOKEN_FILE);
  try {
    const fd = fs.openSync(tokenPath, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ token: crypto.randomBytes(32).toString('hex') }) + '\n');
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  if (process.platform !== 'win32') fs.chmodSync(tokenPath, 0o600);
  const parsed = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  if (typeof parsed.token !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.token)) {
    throw new Error('Invalid local sync token file');
  }
  return { tokenPath, token: parsed.token };
}

function tokensMatch(actual, expected) {
  if (typeof actual !== 'string' || !/^[a-f0-9]{64}$/.test(actual) || actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

async function clearStaleUnixSocket(socketPath) {
  if (!fs.existsSync(socketPath)) return;
  await new Promise((resolve, reject) => {
    const probe = net.createConnection(socketPath);
    probe.once('connect', () => {
      probe.destroy();
      reject(new Error('Local sync socket is already in use'));
    });
    probe.once('error', (error) => {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve();
      else reject(error);
    });
  });
  try { fs.unlinkSync(socketPath); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function createSyncBridge({ dataDir, onSync }) {
  if (typeof onSync !== 'function') throw new TypeError('onSync must be a function');
  const socketPath = endpointForDataDir(dataDir);
  const tokenPath = path.join(path.resolve(dataDir), TOKEN_FILE);
  const subscribers = new Set();
  const sockets = new Set();
  let server = null;
  let token = null;

  function send(socket, payload) {
    if (!socket.destroyed && socket.writable) socket.write(JSON.stringify(payload) + '\n');
  }

  function publishProgress(progress) {
    for (const socket of subscribers) send(socket, { type: 'progress', data: progress });
  }

  function handleConnection(socket) {
    sockets.add(socket);
    socket.setEncoding('utf8');
    socket.setTimeout(10000, () => socket.destroy());
    let input = '';
    let receivedRequest = false;
    socket.on('close', () => {
      subscribers.delete(socket);
      sockets.delete(socket);
    });
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      if (receivedRequest) return;
      input += chunk;
      if (Buffer.byteLength(input, 'utf8') > MAX_REQUEST_BYTES) {
        receivedRequest = true;
        send(socket, { type: 'error', message: 'Request is too large' });
        socket.end();
        return;
      }
      const lineEnd = input.indexOf('\n');
      if (lineEnd < 0) return;
      receivedRequest = true;
      socket.setTimeout(0);
      let request;
      try { request = JSON.parse(input.slice(0, lineEnd)); } catch {
        send(socket, { type: 'error', message: 'Invalid request' });
        socket.end();
        return;
      }
      if (!request || request.action !== 'sync' || !tokensMatch(request.token, token)
          || typeof request.requestId !== 'string' || !request.requestId || request.requestId.length > 128) {
        send(socket, { type: 'error', message: 'Unauthorized or invalid request' });
        socket.end();
        return;
      }
      subscribers.add(socket);
      Promise.resolve().then(onSync).then((data) => {
        send(socket, {
          type: 'complete',
          syncedAt: data && data.syncedAt ? data.syncedAt : null,
          courseCount: data && Array.isArray(data.courses) ? data.courses.length : 0,
        });
      }, (error) => {
        send(socket, { type: 'error', message: String(error && error.message || error).slice(0, 300) });
      }).finally(() => {
        subscribers.delete(socket);
        socket.end();
      });
    });
  }

  async function start() {
    if (server) return { socketPath, tokenPath };
    token = loadOrCreateToken(path.resolve(dataDir)).token;
    if (process.platform !== 'win32') await clearStaleUnixSocket(socketPath);
    const candidate = net.createServer(handleConnection);
    try {
      await new Promise((resolve, reject) => {
        candidate.once('error', reject);
        candidate.listen(socketPath, () => {
          candidate.off('error', reject);
          resolve();
        });
      });
      server = candidate;
      if (process.platform !== 'win32') fs.chmodSync(socketPath, 0o600);
      return { socketPath, tokenPath };
    } catch (error) {
      try { candidate.close(); } catch { /* listen may not have started */ }
      throw error;
    }
  }

  function close() {
    for (const socket of sockets) socket.destroy();
    if (!server) return Promise.resolve();
    const runningServer = server;
    server = null;
    return new Promise((resolve) => {
      runningServer.close(() => {
        if (process.platform !== 'win32') {
          try { fs.unlinkSync(socketPath); } catch { /* stale socket is handled on next start */ }
        }
        resolve();
      });
    });
  }

  return { socketPath, tokenPath, start, close, publishProgress };
}

module.exports = { createSyncBridge, endpointForDataDir };
