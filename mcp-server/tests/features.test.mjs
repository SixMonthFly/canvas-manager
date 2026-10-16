import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listAssignments, getAssignmentFull } from '../dist/localFeatures.js';
import { readChanges, setBaseline } from '../dist/changes.js';

const fixture = () => ({
  courses: [
    { id: 1, code: 'WRIT1001 (T01)', name: 'Writing' },
    { id: 2, code: 'PROJ3050 (L02)', name: 'Project' },
    { id: 3, code: 'PROJ3050 Assignment', name: 'Assignment' },
  ],
  byCourse: {
    1: [
      { id: 26131, name: 'Abstract', published: true, due_at: '2026-09-25T09:00:00Z', points: 0,
        description: '<p>Read <a href="https://hkust-gz.instructure.com/file?token=secret">this paragraph</a>.</p><p>See <img src="https://hkust-gz.instructure.com/image?token=secret" alt="study diagram"></p>',
        url: 'https://hkust-gz.instructure.com/courses/1/assignments/26131?token=secret',
        attachments: [{ id: 9, filename: 'paper.pdf', url: 'https://example.com/signed?token=secret', size: 5 }] },
      { id: 26132, name: 'Undated', published: true, due_at: null, description: '', points: null },
      { id: 26133, name: 'Done', published: true, due_at: '2026-09-25T09:00:00Z', description: '', sub: { state: 'submitted' } },
    ],
    2: [{ id: 8, name: 'Other', published: true, due_at: '2026-09-25T09:00:00Z', description: '' }],
  },
  annBy: { 1: [{ id: 10, title: 'Week 4', posted_at: '2026-09-20', message: '<p>Hello</p>', url: 'https://example.com' }] },
});

test('course and local-day filters distinguish ambiguous codes and retain zero points', () => {
  const data = fixture();
  const result = listAssignments(data, { courseCode: 'WRIT1001', status: 'all', from: '2026-09-25', to: '2026-09-25' });
  assert.equal(result.total, 2);
  assert.equal(result.items[0].assignmentId, 26131);
  assert.equal(result.items[0].points, 0);
  assert.equal(result.items[0].dueLocal, '2026-09-25 17:00 (Asia/Shanghai)');
  assert.equal(listAssignments(data, { courseId: 1, status: 'done' }).total, 1);
  assert.equal(listAssignments(data, { courseId: 1, status: 'all', from: '2026-09-25', includeUndated: true }).total, 3);
  assert.throws(() => listAssignments(data, { courseCode: 'PROJ3050' }), /courseId/);
  assert.throws(() => listAssignments(data, { from: '2026-02-31' }), /YYYY-MM-DD/);
});

test('full details preserve structure and attachments but remove URL query credentials', () => {
  const assignment = getAssignmentFull(fixture(), 1, 26131);
  assert.match(assignment.descriptionText, /Read this paragraph\.\nSee/);
  assert.match(assignment.descriptionHtml, /<p>/);
  assert(!JSON.stringify(assignment).includes('secret'));
  assert.equal(assignment.images[0].alt, 'study diagram');
  assert.equal(assignment.attachments[0].filename, 'paper.pdf');
  assert.equal(assignment.canvasUrl, 'https://hkust-gz.instructure.com/courses/1/assignments/26131');
});

test('changes need a baseline and show deadline, content, and announcement updates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'canvas-changes-test-'));
  try {
    const before = fixture();
    assert.equal(readChanges(dir, before, '2026-09-24T00:00:00Z').baselineAvailable, false);
    const after = fixture();
    after.byCourse[1][0].due_at = '2026-09-26T09:00:00Z';
    after.byCourse[1][0].description = '<p>Changed</p>';
    after.annBy[1][0].message = '<p>New message</p>';
    const first = readChanges(dir, after, '2026-09-24T01:00:00Z');
    assert.equal(first.changes.length, 2);
    const changedAssignment = first.changes.find(c => c.kind === 'assignment' && c.id === 26131);
    assert.deepEqual(changedAssignment.fields, ['dueAt', 'content']);
    assert.equal(changedAssignment.dueAfter, '2026-09-26 17:00 (Asia/Shanghai)');
    assert.equal(readChanges(dir, after, '2026-09-24T01:00:00Z').changes.length, 2);
    assert.equal(readChanges(dir, after, '2026-09-24T02:00:00Z').changes.length, 0);
    setBaseline(dir, after, '2026-09-24T02:00:00Z');
    assert.equal(readChanges(dir, after, '2026-09-24T02:00:00Z').changes.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
