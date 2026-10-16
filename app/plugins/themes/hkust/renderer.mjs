export function activate(ctx) {
  ctx.ui.addStylesheet(new URL('./style.css', import.meta.url).href);
  ctx.ui.registerTheme({"id":"hkust","label":"HKUST","layout":"standard","hideEmoji":false});
}
