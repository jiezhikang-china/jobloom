const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

function currentAccount() {
  if (process.platform === 'win32') {
    // 环境变量可能沿用父进程账号；用当前进程令牌对应的 SID 区分 Windows 用户。
    const whoami = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe');
    const output = execFileSync(whoami, ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf8', windowsHide: true, timeout: 5000,
    });
    const sid = output.match(/\bS-1-\d+(?:-\d+)+\b/i)?.[0];
    if (!sid) throw new Error('无法识别当前 Windows 账号，请查看 data/desktop-electron.log。');
    return sid.toUpperCase();
  }
  const user = os.userInfo();
  return `${user.uid}:${user.username}`;
}

function profileDirectory(dataDir, account = currentAccount()) {
  if (typeof account !== 'string' || !account.trim()) throw new Error('缺少桌面用户身份');
  const scope = createHash('sha256').update(account.trim()).digest('hex').slice(0, 24);
  return path.join(dataDir, 'electron-profile-v3', scope);
}

module.exports = { currentAccount, profileDirectory };
