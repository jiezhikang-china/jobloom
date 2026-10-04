const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

async function main() {
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  // Disable external cleanup adapters; this test checks the worker lifecycle, never account windows.
  const code = `require('./dist/services/browser.service.js').browserService.close = async () => {};
    require('./dist/services/deepseek.proxy.service.js').deepseekProxyService.stopIfIdle = async () => {};
    const delivery = require('./dist/services/delivery.service.js').deliveryService;
    delivery.stop = () => console.log('FIXTURE_DELIVERY_STOPPED');
    require('./dist/index.js');`;
  const child = spawn(process.execPath, ['-e', code], { cwd: path.resolve(__dirname, '..'), windowsHide: true,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', BOSS_DESKTOP_TOKEN: 'fixture-owner-token' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = ''; child.stdout.on('data', data => { output += data.toString(); });
  const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try { const health = await fetch('http://127.0.0.1:' + port + '/health').then(r => r.json()); ready = health.desktopManaged === true; if (ready) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true);
    child.disconnect();
    let timer;
    const ended = await Promise.race([exit, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('worker remained after owner disconnected')), 6500); })]).finally(() => clearTimeout(timer));
    assert.equal(ended.code, 0); assert.match(output, /FIXTURE_DELIVERY_STOPPED/);
    console.log('PASS | Electron 所属 IPC 断开时立即停止投递并退出后台，无无人管理任务');
  } finally { if (child.exitCode === null) { child.kill(); await exit; } }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
