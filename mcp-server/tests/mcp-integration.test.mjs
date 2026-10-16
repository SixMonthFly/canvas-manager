import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const require = createRequire(import.meta.url);
const { createSyncBridge } = require('../../app/sync-bridge.js');

test('real MCP tools read, filter, sync through the app bridge, and report changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'canvas-mcp-integration-'));
  const course = { id: 4021, code: 'WRIT1001 (T01)', name: 'Writing' };
  const assignment = due => ({ id: 26131, name: 'Abstract', published: true, due_at: due, points: 0,
    description: '<p>Read the paper.</p>', url: 'https://hkust-gz.instructure.com/courses/4021/assignments/26131' });
  const write = (due, extra = false) => {
    writeFileSync(join(dir, 'courses.json'), JSON.stringify([course]));
    writeFileSync(join(dir, 'course_4021_assignments.json'), JSON.stringify([
      assignment(due), ...(extra ? [{ ...assignment(due), id: 26132, name: 'Second task' }] : [])]));
    writeFileSync(join(dir, 'course_4021_announcements.json'), '[]');
    writeFileSync(join(dir, 'sync_manifest.json'), JSON.stringify({ syncedAt: extra ? '2026-09-24T10:00:00Z' : '2026-09-24T08:00:00Z', courseCount: 1 }));
  };
  write('2026-09-25T09:00:00Z');
  let bridge;
  const client = new Client({ name: 'canvas-test', version: '1.0.0' });
  try {
    bridge = createSyncBridge({ dataDir: dir, onSync: async () => {
      bridge.publishProgress({ phase: 'courses', completed: 1, total: 1, active: [] });
      write('2026-09-26T09:00:00Z', true);
      return { syncedAt: '2026-09-24T10:00:00Z', courses: [course] };
    } });
    await bridge.start();
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [resolve('dist/index.js')], env: { ...process.env, CANVAS_DATA_DIR: dir, CANVAS_TIME_ZONE: 'Asia/Shanghai' }, stderr: 'pipe' });
    await client.connect(transport);
    const names = (await client.listTools()).tools.map(t => t.name);
    for (const name of ['get_sync_status', 'list_assignments', 'get_assignment_full', 'get_sync_changes', 'sync_courses']) assert(names.includes(name));
    const call = async (name, args = {}) => {
      const r = await client.callTool({ name, arguments: args });
      assert(!r.isError, name);
      return JSON.parse(r.content[0].text);
    };
    assert.equal((await call('get_sync_status')).source, 'completed-sync manifest');
    const filtered = await call('list_assignments', { courseCode: 'WRIT1001', status: 'all', to: '2026-09-25' });
    assert.equal(filtered.total, 1);
    assert.equal(filtered.items[0].points, 0);
    assert.equal((await call('get_assignment_full', { courseId: 4021, assignmentId: 26131 })).assignment.descriptionText, 'Read the paper.');
    assert.equal((await call('get_sync_changes')).baselineAvailable, false);
    const synced = await call('sync_courses');
    assert.equal(synced.courseCount, 1);
    assert(synced.progress.some(p => p.phase === 'courses'));
    assert.equal(synced.changes.length, 2);
    assert.equal(synced.sync.syncedAt, '2026-09-24T10:00:00Z');
    assert.equal((await call('get_sync_changes')).changes.length, 2);
  } finally {
    await client.close().catch(() => {});
    if (bridge) await bridge.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
