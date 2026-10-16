const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createSyncBridge, endpointForDataDir } = require('../sync-bridge');

function exchange(endpoint, request) {
  return new Promise((resolve, reject) => {
    const messages = [];
    let buffer = '';
    const socket = net.createConnection(endpoint);
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        messages.push(JSON.parse(buffer.slice(0, newline)));
        buffer = buffer.slice(newline + 1);
      }
    });
    socket.once('error', reject);
    socket.once('end', () => resolve(messages));
  });
}

test('endpoint is a data-directory-scoped local pipe or socket', () => {
  const one = endpointForDataDir(path.join(os.tmpdir(), 'Canvas-A'), 'win32');
  const two = endpointForDataDir(path.join(os.tmpdir(), 'canvas-a'), 'win32');
  assert.equal(one, two);
  assert.match(one, /^\\\\\.\\pipe\\canvas-manager-sync-[a-f0-9]{16}$/);
  assert.equal(endpointForDataDir('/tmp/canvas-a', 'linux'), path.resolve('/tmp/canvas-a', 'sync_bridge.sock'));
});

test('local socket authenticates, streams progress, and completes after sync', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-bridge-test-'));
  let calls = 0;
  let bridge;
  bridge = createSyncBridge({
    dataDir,
    onSync: async () => {
      calls++;
      bridge.publishProgress({ phase: 'connecting', runId: 1, sequence: 1 });
      await new Promise(resolve => setTimeout(resolve, 5));
      bridge.publishProgress({ phase: 'done', runId: 1, sequence: 2 });
      return { syncedAt: '2026-09-24T08:00:00.000Z', courses: [{ id: 1 }, { id: 2 }] };
    },
  });
  t.after(async () => {
    await bridge.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const { socketPath, tokenPath } = await bridge.start();
  assert.equal(socketPath, endpointForDataDir(dataDir));
  const { token } = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  assert.match(token, /^[a-f0-9]{64}$/);

  const denied = await exchange(socketPath, { action: 'sync', token: '0'.repeat(64), requestId: 'bad' });
  assert.equal(denied[0].type, 'error');
  assert.equal(calls, 0);

  const received = await exchange(socketPath, { action: 'sync', token, requestId: 'good' });
  assert.deepEqual(received.map(message => message.type), ['progress', 'progress', 'complete']);
  assert.equal(received[0].data.phase, 'connecting');
  assert.equal(received[1].data.phase, 'done');
  assert.equal(received[2].courseCount, 2);
  assert.equal(received[2].syncedAt, '2026-09-24T08:00:00.000Z');
  assert.equal(calls, 1);
  assert.equal(JSON.parse(fs.readFileSync(tokenPath, 'utf8')).token, token);
});

test('sync manifest is written after course files and read as completed timestamp', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-manifest-test-'));
  try {
    const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const readSource = source.slice(source.indexOf('function readSyncedAt()'), source.indexOf('\nfunction saveData('));
    const saveSource = source.slice(source.indexOf('function saveData('), source.indexOf('\n// ---------- 托盘'));
    const writes = [];
    const trackedFs = { ...fs, writeFileSync: (...args) => {
      writes.push(path.basename(args[0]));
      return fs.writeFileSync(...args);
    } };
    const context = vm.createContext({ DATA_DIR: dataDir, fs: trackedFs, path, require, Date });
    vm.runInContext(`${readSource}\n${saveSource}`, context);
    vm.runInContext(`saveData([{course:{id:1,name:'Test'},assignments:[],files:[],links:[],announcements:[]}])`, context);
    assert.match(writes.at(-1), /^sync_manifest\.json\.[a-f0-9]+\.tmp$/);
    const manifest = JSON.parse(fs.readFileSync(path.join(dataDir, 'sync_manifest.json'), 'utf8'));
    assert.equal(manifest.courseCount, 1);
    assert.equal(vm.runInContext('readSyncedAt()', context), manifest.syncedAt);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
