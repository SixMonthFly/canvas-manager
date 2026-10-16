import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { triggerAppSync, syncEndpoint } from '../dist/syncClient.js';
const require = createRequire(import.meta.url);
const { createSyncBridge } = require('../../app/sync-bridge.js');

test('MCP client exchanges authenticated progress and completion with the app bridge', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'canvas-sync-client-test-'));
  let bridge;
  try {
    bridge = createSyncBridge({ dataDir, onSync: async () => {
      bridge.publishProgress({ phase: 'courses', completed: 1, total: 2, active: ['WRIT1001'] });
      return { syncedAt: '2026-09-24T08:00:00.000Z', courses: [{ id: 1 }, { id: 2 }] };
    } });
    await bridge.start();
    assert.equal(syncEndpoint(dataDir), bridge.socketPath);
    const result = await triggerAppSync(dataDir);
    assert.equal(result.courseCount, 2);
    assert.equal(result.progress[0].phase, 'courses');
  } finally {
    if (bridge) await bridge.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
