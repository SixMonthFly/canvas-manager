import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.CANVAS_TIME_ZONE = 'Asia/Shanghai';
const { calendarDay, formatDeadline } = await import('../dist/time.js');

test('UTC deadlines display local time with an explicit zone', () => {
  assert.equal(formatDeadline('2026-09-25T09:00:00Z'), '2026-09-25 17:00 (Asia/Shanghai)');
});
test('today uses the local calendar day at the date boundary', () => {
  assert.equal(calendarDay(new Date('2026-09-24T16:30:00Z')), '2026-09-25');
  assert.equal(calendarDay(new Date('2026-09-24T15:59:59Z')), '2026-09-24');
});
test('assignments without a deadline remain undated', () => {
  assert.equal(formatDeadline(null), '无');
});
