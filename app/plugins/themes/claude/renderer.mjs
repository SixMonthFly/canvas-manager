export function activate(ctx) {
  ctx.ui.addStylesheet(new URL('./style.css', import.meta.url).href);
  ctx.ui.registerTheme({"id":"claude","label":"Claude","layout":"sidebar","hideEmoji":true});
}
