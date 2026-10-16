export function activate(ctx) {
  ctx.ui.addStylesheet(new URL('./style.css', import.meta.url).href);
  ctx.ui.registerTheme({"id":"chatgpt","label":"ChatGPT","layout":"standard","hideEmoji":false});
}
