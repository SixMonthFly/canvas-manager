const t = window.CanvasI18n.t;
export function activate(ctx) {
  const content = document.createElement('div');
  const note = document.createElement('p'); note.className = 'hint';
  note.textContent = t('在 Mac 桌面空白处右键 → 编辑小组件，搜索「Canvas」并添加「七天作业」。支持小、中、大尺寸，显示七天内未提交的作业；应用退出后保留最近同步内容。');
  const detail = document.createElement('p'); detail.className = 'hint';
  detail.textContent = t('启用后同步成功会更新小组件数据，实际刷新时间由 macOS 管理。停用或卸载会停止提供作业数据；桌面上的小组件可通过系统菜单移除。');
  const button = document.createElement('button'); button.id = 'native-assignments-refresh'; button.textContent = t('更新小组件数据');
  button.onclick = async () => {
    button.disabled = true;
    try { await ctx.api.invoke('refresh'); ctx.utils.toast(t('小组件数据已更新，等待 macOS 刷新')); }
    catch (error) { ctx.utils.toast(error.message); }
    finally { button.disabled = false; }
  };
  content.append(note, detail, button); ctx.ui.addSettingsSection(t('Mac 系统小组件'), content);
  ctx.api.on('error', message => ctx.utils.toast(t('系统小组件：') + message));
}
