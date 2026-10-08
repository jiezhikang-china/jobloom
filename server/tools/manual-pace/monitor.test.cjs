'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { WebSocketServer } = require('../../node_modules/ws');
const { DomMonitor } = require('./monitor.cjs');
async function fixture(sendHandshake) {
  const sockets = new Set(), timers = new Set(), methods = [];
  const ws = new WebSocketServer({ noServer: true });
  let port;
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const host = 'ws://127.0.0.1:' + port;
    res.end(JSON.stringify(req.url === '/json/version'
      ? { webSocketDebuggerUrl: host + '/devtools/browser/fixture' }
      : [{ type: 'page', id: 'fixture-page', url: 'https://www.zhipin.com/web/geek/jobs', webSocketDebuggerUrl: host + '/devtools/page/fixture-page' }]));
  });
  server.on('upgrade', (req, socket, head) => ws.handleUpgrade(req, socket, head, client => ws.emit('connection', client)));
  ws.on('connection', socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let world, binding, scheduled = false;
    socket.on('message', raw => {
      const request = JSON.parse(String(raw)), p = request.params || {}; methods.push(request.method);
      let result = {};
      const emit = (method, params) => socket.send(JSON.stringify({ method, params }));
      if (request.method === 'Runtime.addBinding') binding = p.name;
      if (request.method === 'Page.getFrameTree') result = { frameTree: { frame: { id: 'main' } } };
      if (request.method === 'Page.addScriptToEvaluateOnNewDocument') { world = p.worldName; result = { identifier: 'fixture-script' }; }
      if (request.method === 'Page.createIsolatedWorld') {
        result = { executionContextId: 1 };
        emit('Runtime.executionContextCreated', { context: { id: 1, name: world, auxData: { frameId: 'main' } } });
      }
      if (request.method === 'Runtime.evaluate' && !scheduled) {
        scheduled = true;
        // The initial document returns without installing. The new document is ready later.
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (socket.readyState !== 1 || !sendHandshake) return;
          emit('Runtime.executionContextsCleared', {});
          emit('Runtime.executionContextCreated', { context: { id: 2, name: world, auxData: { frameId: 'main' } } });
          emit('Runtime.bindingCalled', { name: binding, executionContextId: 2, payload: JSON.stringify({ kind: 'observer_ready' }) });
        }, 120);
        timers.add(timer);
      }
      socket.send(JSON.stringify({ id: request.id, result }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); port = server.address().port;
  return { port, methods, close: async () => {
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.terminate();
    await new Promise(resolve => ws.close(resolve));
    await new Promise(resolve => server.close(resolve));
  } };
}
test('初始空文档不算安装成功，等待新文档实际就绪确认', async () => {
  const f = await fixture(true), events = [];
  const monitor = new DomMonitor({ onEvent: value => events.push(value), readyTimeoutMs: 1000 });
  try {
    const start = Date.now(), state = await monitor.start(f.port, '/devtools/browser/fixture');
    assert.equal(state.observingPages, 1); assert.ok(Date.now() - start >= 100);
    assert.equal(events.length, 0, '握手不作为用户操作');
    assert.ok(!f.methods.includes('Runtime.enable'), '被动 DOM 监听不订阅控制台或所有执行环境');
  } finally { await monitor.stop(); await f.close(); }
});
test('端口可连接但没有 DOM 握手时拒绝开始', async () => {
  const f = await fixture(false), monitor = new DomMonitor({ readyTimeoutMs: 180 });
  try {
    await assert.rejects(monitor.start(f.port, '/devtools/browser/fixture'), /未返回就绪确认/);
    assert.equal(monitor.state().observingPages, 0); assert.equal(monitor.state().connected, false);
  } finally { await monitor.stop(); await f.close(); }
});
