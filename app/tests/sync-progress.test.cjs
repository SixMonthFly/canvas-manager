const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const sendSource = source.slice(source.indexOf('function sendSyncProgress('), source.indexOf('\nasync function doSync'));

test('progress snapshot keeps counts on failure and ignores a previous run', () => {
  const received = [];
  const context = vm.createContext({
    mainWindow: { isDestroyed: () => false, webContents: { send: (_event, data) => received.push(data) } },
  });
  vm.runInContext(`let syncRunId = 1; let syncProgressSequence = 0; let currentSyncProgress = null; ${sendSource}`, context);
  vm.runInContext("sendSyncProgress(1, {phase:'courses', completed:2, total:7, active:['C1']})", context);
  vm.runInContext("sendSyncProgress(1, {phase:'error', active:[], detail:'failed'})", context);
  vm.runInContext("sendSyncProgress(0, {phase:'done'})", context);
  assert.equal(received.length, 2);
  assert.deepEqual({ phase: received[1].phase, completed: received[1].completed,
    total: received[1].total, active: Array.from(received[1].active) },
    { phase: 'error', completed: 2, total: 7, active: [] });
  vm.runInContext('syncRunId = 2; sendSyncProgress(2, {phase:"connecting"})', context);
  assert.equal(received[2].completed, undefined);
  assert.equal(received[2].sequence, 3);
});
