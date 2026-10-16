// CDP 驱动脚本: node cdp.js <表达式1> <表达式2> ...
// 连接 --remote-debugging-port=9222 的应用,依次在渲染进程执行表达式并打印结果
const WebSocket = require('ws');
const http = require('http');

function getTarget() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9222/json/list', (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        const pages = JSON.parse(body).filter((t) => t.type === 'page' && t.url.includes('index.html'));
        pages[0] ? resolve(pages[0].webSocketDebuggerUrl) : reject(new Error('no page target'));
      });
    }).on('error', reject);
  });
}

(async () => {
  const wsUrl = await getTarget();
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.on('message', (data) => {
    const m = JSON.parse(data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  await new Promise((r, j) => { ws.on('open', r); ws.onerror = (e) => j(new Error('ws: ' + e.message)); });
  const evalJs = (expr) => new Promise((res) => {
    const mid = ++id;
    pending.set(mid, (m) => {
      if (m.result && m.result.exceptionDetails) res('EXC: ' + (m.result.exceptionDetails.exception.description || '').slice(0, 300));
      else res(JSON.stringify(m.result && m.result.result && m.result.result.value));
    });
    ws.send(JSON.stringify({ id: mid, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  });
  for (const expr of process.argv.slice(2)) {
    console.log('> ' + expr.slice(0, 100));
    console.log('= ' + (await evalJs(expr)));
  }
  ws.close();
  process.exit(0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
