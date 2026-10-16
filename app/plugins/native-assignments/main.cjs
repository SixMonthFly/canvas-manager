function snapshotOf(data) {
  const assignments = [];
  for (const course of data.courses || []) {
    for (const item of data.byCourse?.[course.id] || []) {
      const sub = item.sub;
      if (item.published === false || sub?.state === 'graded' || sub?.state === 'submitted' || sub?.submitted_at
          || !item.due_at || !Number.isFinite(Date.parse(item.due_at))
          || !Number.isSafeInteger(Number(course.id)) || Number(course.id) <= 0
          || !Number.isSafeInteger(Number(item.id)) || Number(item.id) <= 0) continue;
      assignments.push({ courseId: Number(course.id), id: Number(item.id), name: String(item.name || '未命名作业'),
        course: String(course.code || course.name || `课程 ${course.id}`), dueAt: new Date(item.due_at).toISOString() });
    }
  }
  // Export deadlines beyond seven days as well: the system filters the rolling
  // window even while the containing app is closed. No descriptions or secrets.
  return { schemaVersion: 1, enabled: true, hasCourses: !!data.courses?.length,
    syncedAt: data.syncedAt || null, assignments };
}
module.exports.snapshotOf = snapshotOf;
module.exports.activate = async ctx => {
  const { canvas, nativeWidgets } = ctx.services;
  if (!nativeWidgets.available()) throw new Error('请安装带原生小组件的 Mac 完整客户端');
  let disposed = false;
  const refresh = () => nativeWidgets.publish(snapshotOf(canvas.readLocalData()));
  ctx.effect(canvas.onDataUpdated(() => {
    if (!disposed) refresh().catch(error => { if (!disposed) ctx.emit('error', error.message); });
  }));
  ctx.effect(() => { disposed = true; });
  await refresh();
  return { methods: { refresh }, async dispose({ reason } = {}) {
    disposed = true;
    // Quitting leaves the last snapshot available to WidgetKit. Explicit
    // disable/uninstall replaces it with an empty, disabled snapshot.
    if (reason !== 'shutdown') await nativeWidgets.publish({ schemaVersion: 1, enabled: false, hasCourses: false, syncedAt: null, assignments: [] });
  } };
};
