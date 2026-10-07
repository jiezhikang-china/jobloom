'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');
function psLiteral(value) { return "'" + value.replace(/'/g, "''") + "'"; }
function windowsArg(value) { return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"'; }
function launchVisibleChrome(executable, args, options = {}) {
  const spawnProcess = options.spawn || spawn;
  const platform = options.platform || process.platform;
  return new Promise((resolve, reject) => {
    let child, errorText = '', output = '', settled = false;
    const finish = error => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve({ accepted: true, pid: Number(output.trim()) || child.pid });
    };
    const timer = setTimeout(() => finish(new Error('Chrome 启动请求超时，请检查是否有浏览器提示窗口。')), options.timeoutMs || 15000);
    try {
      if (platform === 'win32') {
        const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32\\WindowsPowerShell\\v1.0\\powershell.exe');
        const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); "
          + '$p=Start-Process -FilePath ' + psLiteral(executable) + ' -ArgumentList '
          + psLiteral(args.map(windowsArg).join(' ')) + ' -WindowStyle Normal -PassThru; Write-Output $p.Id';
        child = spawnProcess(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
          { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout?.on('data', value => { output = (output + value.toString('utf8')).slice(-256); });
        child.stderr?.on('data', value => { errorText = (errorText + value.toString('utf8')).slice(-2000); });
        child.once('exit', code => {
          if (code === 0) finish();
          else finish(new Error('Chrome 启动失败：' + (errorText.trim() || '启动进程退出 ' + code)));
        });
      } else {
        child = spawnProcess(executable, args, { detached: true, stdio: 'ignore' });
        child.once('spawn', () => { child.unref(); finish(); });
      }
      child.once('error', error => finish(new Error('Chrome 启动失败：' + error.message)));
    } catch (error) { finish(error); }
  });
}
module.exports = { launchVisibleChrome, psLiteral, windowsArg };