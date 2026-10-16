function parseWidgetLink(value) {
  try {
    if (typeof value !== 'string' || !/^canvas-manager:\/\/(?:open\/?|assignment\/[1-9]\d*\/[1-9]\d*\/?)$/.test(value)) return null;
    const url = new URL(value);
    if (url.protocol !== 'canvas-manager:' || url.username || url.password || url.port || url.search || url.hash) return null;
    if (url.hostname === 'open' && ['', '/'].includes(url.pathname)) return { type: 'open' };
    const match = url.hostname === 'assignment' && url.pathname.match(/^\/(\d+)\/(\d+)\/?$/);
    if (!match) return null;
    const cid = Number(match[1]), id = Number(match[2]);
    if (!Number.isSafeInteger(cid) || !Number.isSafeInteger(id) || cid <= 0 || id <= 0) return null;
    return { type: 'assignment', cid, id };
  } catch { return null; }
}
module.exports = { parseWidgetLink };
