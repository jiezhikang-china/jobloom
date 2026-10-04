const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { APP_ORIGIN, createAppProtocol, isAppUrl } = require('../app-protocol.cjs');

test('Electron bundled assets, API streams, multipart uploads and origin restrictions', async () => {
  const base = path.resolve(__dirname, '../../data');
  const dir = fs.mkdtempSync(path.join(base, 'desktop-protocol-test-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<html>工作台</html>');
  const forwarded = [];
  const handler = createAppProtocol({ clientDir: dir, getService: () => ({ url: 'http://127.0.0.1:4567', token: 'private-worker-token' }),
    fetchService: async (url, options) => {
      forwarded.push({ url, options });
      if (url.includes('/events')) return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"init"}\n\n')); } }), { headers: { 'Content-Type': 'text/event-stream' } });
      return new Response(new Uint8Array([0, 255, 1]), { headers: { 'Content-Type': 'application/pdf' } });
    } });
  try {
    const page = await handler(new Request(APP_ORIGIN + '/'));
    assert.match(await page.text(), /工作台/); assert.match(page.headers.get('Content-Security-Policy'), /object-src 'none'/);
    assert.equal((await handler(new Request(APP_ORIGIN + '/missing.js'))).status, 404);
    assert.equal(isAppUrl('boss-app://other/'), false);
    assert.equal((await handler(new Request('https://example.com/api/config'))).status, 403);
    assert.equal((await handler(new Request(APP_ORIGIN + '/%2e%2e%5csecret'))).status, 403);
    const form = new FormData(); form.append('resume', new Blob(['中文简历']), '简历.pdf');
    const upload = new Request(APP_ORIGIN + '/api/resume/upload', { method: 'POST', body: form, headers: { 'x-boss-desktop-token': 'fake', 'authorization': 'fake' } });
    const result = await handler(upload);
    assert.deepEqual([...new Uint8Array(await result.arrayBuffer())], [0, 255, 1]);
    assert.equal(forwarded[0].options.headers.get('x-boss-desktop-token'), 'private-worker-token');
    assert.equal(forwarded[0].options.headers.get('authorization'), null);
    assert.match(forwarded[0].options.headers.get('content-type'), /multipart\/form-data; boundary=/);
    assert.match(new TextDecoder().decode(forwarded[0].options.body), /中文简历/);
    const stream = await handler(new Request(APP_ORIGIN + '/api/delivery/events'));
    const reader = stream.body.getReader(); assert.match(new TextDecoder().decode((await reader.read()).value), /"init"/); await reader.cancel();
    assert.equal(forwarded[1].url, 'http://127.0.0.1:4567/api/delivery/events');
    const notReady = createAppProtocol({ clientDir: dir, getService: () => null });
    assert.equal((await notReady(new Request(APP_ORIGIN + '/api/config'))).status, 503);
  } finally {
    assert.ok(dir.startsWith(base + path.sep)); fs.rmSync(dir, { recursive: true, force: true });
  }
});
