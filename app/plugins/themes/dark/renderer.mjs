export function activate(ctx) {
  ctx.ui.addStylesheet(new URL('./style.css', import.meta.url).href);
  ctx.ui.registerTheme({"id":"default","label":"深色","layout":"standard","hideEmoji":false});
}
