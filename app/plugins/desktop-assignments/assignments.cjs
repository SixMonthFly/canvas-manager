const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

function assignmentStatus(assignment) {
  const sub = assignment.sub;
  if (sub?.state === 'graded') return 'graded';
  if (sub?.state === 'submitted' || sub?.submitted_at) return 'submitted';
  return 'pending';
}

// A rolling 168-hour window. Only current courses contribute; old cached files
// from courses removed by a later sync must not create ghost assignments.
function upcomingAssignments(data, { now = Date.now(), showCompleted = false } = {}) {
  const items = [];
  for (const course of data.courses || []) {
    for (const assignment of data.byCourse?.[course.id] || []) {
      const due = assignment.due_at ? Date.parse(assignment.due_at) : NaN;
      const status = assignmentStatus(assignment);
      if (assignment.published === false || !Number.isFinite(due) || due < now || due > now + SEVEN_DAYS
          || (!showCompleted && status !== 'pending')) continue;
      items.push({ courseId: course.id, id: assignment.id, name: assignment.name || '未命名作业',
        course: course.code || course.name || `课程 ${course.id}`, dueAt: new Date(due).toISOString(), status });
    }
  }
  return items.sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt)
    || String(a.courseId).localeCompare(String(b.courseId)) || String(a.id).localeCompare(String(b.id)));
}
module.exports = { upcomingAssignments, assignmentStatus };
