'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { launchVisibleChrome } = require('./native-launch.cjs');
function processStub(run) {
  return (executable, args, options) => {
    const child = new EventEmitter(); child.pid = 20;
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    queueMicrotask(() => run(child, executable, args, options));
    return child;
  };
}
test('Windows 启动保持中文和空格参数，等待实际退出结果', async () => {
  const result = await launchVisibleChrome('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    ['--user-data-dir=D:\\简历 项目\\profile', 'https://www.zhipin.com/web/geek/jobs'], {
      platform: 'win32', spawn: processStub((child, executable, args, options) => {
        assert.match(executable, /WindowsPowerShell\\v1.0\\powershell.exe$/i);
        const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
        assert.match(script, /"--user-data-dir=D:\\简历 项目\\profile"/);
        assert.match(script, /-WindowStyle Normal -PassThru/);
        assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
        child.stdout.emit('data', Buffer.from('12345\r\n')); child.emit('exit', 0);
      }),
    });
  assert.equal(result.pid, 12345); assert.equal(result.accepted, true);
});
test('启动失败向调用方报告 stderr，不伪装成功', async () => {
  await assert.rejects(launchVisibleChrome('chrome.exe', [], {
    platform: 'win32', spawn: processStub(child => { child.stderr.emit('data', Buffer.from('拒绝访问')); child.emit('exit', 1); }),
  }), /拒绝访问/);
});
test('程序不存在与启动超时均返回失败', async () => {
  await assert.rejects(launchVisibleChrome('chrome.exe', [], {
    platform: 'win32', spawn: processStub(child => child.emit('error', new Error('ENOENT'))),
  }), /ENOENT/);
  await assert.rejects(launchVisibleChrome('chrome.exe', [], {
    platform: 'win32', timeoutMs: 5, spawn: processStub(() => {}),
  }), /超时/);
});