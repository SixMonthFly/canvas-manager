const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute the same browser-side script that production passes to Electron.
const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const declaration = source.slice(source.indexOf('const FETCH_ALL_SCRIPT ='), source.indexOf('\nfunction readLocalData'));
const script = vm.runInNewContext(declaration + '\nFETCH_ALL_SCRIPT;');

async function run({ sequential = false, failAssignments = false, denyFiles = false } = {}) {
  let active = 0, peak = 0;
  const calls = [];
  const progress = [];
  const courses = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, name: `Course ${i + 1}`, course_code: `C${i + 1}` }));
  const fetch = async (url) => {
    calls.push(url);
    active++;
    peak = Math.max(peak, active);
    // Varied latency deliberately finishes courses out of order.
    const cid = Number(url.match(/courses\/(\d+)/)?.[1] || 0);
    await new Promise(resolve => setTimeout(resolve, cid === 1 ? 12 : 4));
    active--;
    const failed = failAssignments && cid === 2 && url.includes('/assignments');
    const denied = denyFiles && url.includes('/files');
    let data = courses, next = '';
    if (url.includes('/assignments')) {
      data = [{ id: cid * 10 + (url.includes('page=2') ? 1 : 0), published: true, name: 'Task' }];
      if (!url.includes('page=2')) next = `</api/v1/courses/${cid}/assignments?page=2>; rel="next"`;
    } else if (url.includes('/files')) data = [{ id: cid, filename: 'lecture.pdf' }];
    else if (url.includes('/modules')) data = [{ items: [{ type: 'ExternalUrl', title: 'Reference', external_url: 'https://example.com' }] }];
    else if (url.includes('/discussion_topics')) data = [{ id: cid, title: 'Announcement' }];
    return { ok: !failed && !denied, status: failed ? 500 : denied ? 403 : 200,
      json: async () => data, headers: { get: () => next } };
  };
  const started = performance.now();
  try {
    const scriptConsole = { info: message => {
      if (message.startsWith('__canvas_sync_progress__')) progress.push(JSON.parse(message.slice('__canvas_sync_progress__'.length)));
    } };
    const result = await vm.runInNewContext(sequential ? script.replace('Math.min(3, courses.length)', 'Math.min(1, courses.length)') : script, { fetch, console: scriptConsole });
    return { result: JSON.parse(JSON.stringify(result)), peak, calls, progress, elapsed: performance.now() - started };
  } catch (error) {
    assert.equal(active, 0, 'Requests must finish before reporting failure');
    error.progress = progress;
    throw error;
  }
}

test('bounded concurrency preserves data, course order, and pagination', async () => {
  const serial = await run({ sequential: true });
  const parallel = await run();
  assert.deepEqual(parallel.result, serial.result);
  assert.equal(parallel.peak, 3);
  assert.equal(serial.peak, 1);
  assert.equal(parallel.calls.length, 36);
  assert(parallel.result.every(row => row.assignments.length === 2));
  assert.deepEqual(parallel.progress.map(p => p.completed).filter((n, i, list) => i === 0 || n !== list[i - 1]),
    [0, 1, 2, 3, 4, 5, 6, 7]);
  assert(parallel.progress.every(p => p.active.length <= 3 && p.completed <= p.total));
  assert(parallel.progress.some(p => p.completed > 0 && p.active.includes('C1')),
    'A faster course can finish while the first course remains active');
  assert.deepEqual(parallel.progress.at(-1).active, []);
  console.log(`Simulated network only: serial ${serial.elapsed.toFixed(0)} ms, parallel ${parallel.elapsed.toFixed(0)} ms`);
});

test('assignment failure rejects the entire sync after in-flight work finishes', async () => {
  await assert.rejects(run({ failAssignments: true }), error => {
    assert.match(error.message, /500/);
    assert(error.progress.at(-1).completed < error.progress.at(-1).total);
    return true;
  });
});

test('inaccessible files do not discard assignments or announcements', async () => {
  const { result } = await run({ denyFiles: true });
  assert(result.every(row => row.files.length === 0 && row.assignments.length === 2 && row.announcements.length === 1));
});
