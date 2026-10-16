import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { activeDataDir, canvasOrigin } from '../dist/schoolContext.js';
import { getAssignmentFull } from '../dist/localFeatures.js';
test('MCP follows activated school, ignores a saved pending switch and preserves legacy fallback', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-mcp-schools-'));
  try {
    assert.equal(activeDataDir(root), root);
    fs.writeFileSync(path.join(root, 'school.json'), JSON.stringify({ schoolId: 'nus' }));
    assert.equal(activeDataDir(root), root);
    fs.writeFileSync(path.join(root, 'active-school.json'), JSON.stringify({ schoolId: 'nus' }));
    const data = path.join(root, 'schools', 'nus'); fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, 'school-context.json'), JSON.stringify({ origin: 'https://canvas.nus.edu.sg' }));
    assert.equal(activeDataDir(root), data); assert.equal(canvasOrigin(data), 'https://canvas.nus.edu.sg');
    fs.writeFileSync(path.join(root, 'active-school.json'), JSON.stringify({ schoolId: '../escape' }));
    assert.throws(() => activeDataDir(root));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('MCP assignment links, relative images and attachments use the selected school', () => {
  const result = getAssignmentFull({ canvasOrigin: 'https://canvas.nus.edu.sg', courses: [{ id: 1, code: 'NUS', name: 'Test' }], annBy: {}, byCourse: { 1: [{ id: 2, name: 'Test', published: true, points: null, due_at: null, url: '/courses/1/assignments/2', description: '<img src="/files/3?token=secret"><a href="/courses/1/pages/a">Page</a>', attachments: [{ id: 3, filename: 'x.pdf' }] }] } }, 1, 2);
  assert.equal(result.canvasUrl, 'https://canvas.nus.edu.sg/courses/1/assignments/2');
  assert.equal(result.images[0].url, 'https://canvas.nus.edu.sg/files/3');
  assert.equal(result.attachments[0].canvasUrl, 'https://canvas.nus.edu.sg/courses/1/files/3');
  assert(!JSON.stringify(result).includes('secret'));
  assert(!JSON.stringify(result).includes('hkust-gz'));
});

test('long school directories keep server/client socket paths identical and within Unix limits', async () => {
  const { syncEndpoint } = await import('../dist/syncClient.js');
  const { createRequire } = await import('node:module');
  const { endpointForDataDir, createSyncBridge } = createRequire(import.meta.url)('../../app/sync-bridge.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-long-'));
  const dir = path.join(root, 'long-profile-name'.repeat(7), 'schools', 'nus');
  const bridge = createSyncBridge({ dataDir: dir, onSync: async () => ({ courses: [] }) });
  try {
    assert.equal(syncEndpoint(dir), endpointForDataDir(dir));
    if (process.platform !== 'win32') assert(Buffer.byteLength(syncEndpoint(dir)) < 100);
    await bridge.start();
  } finally { await bridge.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
