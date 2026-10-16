window.CanvasI18n.ready.then(() => {
  const script = document.createElement('script');
  script.src = 'app.js';
  document.body.append(script);
}).catch(error => {
  console.error(error);
  const toast = document.querySelector('#toast');
  toast.textContent = 'Could not load the interface / 界面加载失败: ' + error.message;
  toast.classList.remove('hidden');
});
