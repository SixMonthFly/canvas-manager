export function activate(ctx) {
  const content = document.createElement('div');
  const note = document.createElement('p');
  note.className = 'hint';
  note.textContent = '显示未来七天截止的作业，默认隐藏已提交项。拖动卡片标题可调整位置；关闭主窗口后卡片继续显示，退出应用后关闭。';
  const button = document.createElement('button');
  button.id = 'desktop-assignments-show';
  button.textContent = '显示桌面卡片';
  button.onclick = async () => {
    button.disabled = true;
    try { await ctx.api.invoke('show'); }
    catch (error) { ctx.utils.toast(error.message); }
    finally { button.disabled = false; }
  };
  content.append(note, button);
  ctx.ui.addSettingsSection('七天作业 · Mac 桌面卡片', content);
  ctx.api.on('error', message => ctx.utils.toast('桌面卡片：' + message));
}
