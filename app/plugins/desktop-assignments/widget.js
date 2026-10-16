const $ = selector => document.querySelector(selector);
const dateTime = value => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
function errorMessage(error) { $('#error').hidden = false; $('#error').textContent = error.message || String(error); }
async function invoke(method, ...args) {
  try { $('#error').hidden = true; return await window.card.invoke(method, ...args); }
  catch (error) { errorMessage(error); throw error; }
}
function render(data) {
  $('#count').textContent = data.items.length ? `${data.items.length} 项` : '';
  $('#completed').checked = data.showCompleted;
  $('#pinned').checked = data.pinned;
  $('#range').textContent = '未来 168 小时 · 按截止时间排序';
  $('#synced').textContent = data.syncedAt ? `上次同步 ${dateTime(data.syncedAt)}` : '尚未同步 · 请打开应用同步';
  const list = $('#list'); list.replaceChildren();
  if (!data.items.length) {
    const empty = document.createElement('div'); empty.className = 'empty';
    const heading = document.createElement('strong');
    heading.textContent = data.hasCourses ? (data.showCompleted ? '七天内没有截止作业' : '七天内没有待交作业') : '还没有课程数据';
    const note = document.createElement('span');
    note.textContent = data.hasCourses ? '以最近同步的 Canvas 数据为准' : '打开 Canvas 工具，完成首次同步';
    empty.append(heading, note); list.append(empty);
  }
  for (const item of data.items) {
    const row = document.createElement('button'); row.className = 'assignment';
    row.dataset.assignment = `${item.courseId}:${item.id}`;
    if (item.status !== 'pending') row.classList.add('done');
    const course = document.createElement('span'); course.className = 'course'; course.textContent = item.course;
    const name = document.createElement('span'); name.className = 'name'; name.textContent = item.name;
    const due = document.createElement('span'); due.className = 'due';
    const time = document.createElement('span'); time.textContent = `${dateTime(item.dueAt)} 截止`;
    const remaining = document.createElement('span');
    const hours = Math.max(0, Math.ceil((Date.parse(item.dueAt) - data.now) / 3600000));
    remaining.textContent = item.status === 'graded' ? '已评分' : item.status === 'submitted' ? '已提交'
      : hours < 24 ? (hours <= 1 ? '即将截止' : `剩 ${hours} 小时`) : `剩 ${Math.floor(hours / 24)} 天 ${hours % 24} 时`;
    if (item.status === 'pending' && hours <= 24) remaining.className = 'urgent';
    due.append(time, remaining); row.append(course, name, due);
    row.onclick = () => { void invoke('openAssignment', item.courseId, item.id).catch(() => {}); };
    list.append(row);
  }
}
let sequence = 0;
async function refresh() {
  const request = ++sequence;
  try { const data = await invoke('snapshot'); if (request === sequence) render(data); }
  catch { /* Keep the last successful list and show an error. */ }
}
$('#hide').onclick = () => { void invoke('hide').catch(() => {}); };
$('#open-app').onclick = () => { void invoke('openApp').catch(() => {}); };
for (const [selector, key] of [['#completed', 'showCompleted'], ['#pinned', 'pinned']]) {
  $(selector).onchange = async event => {
    const input = event.target; input.disabled = true;
    try { await invoke('setOption', key, input.checked); await refresh(); }
    catch { input.checked = !input.checked; }
    finally { input.disabled = false; }
  };
}
window.card.onChanged(refresh);
window.addEventListener('focus', refresh);
void refresh();
