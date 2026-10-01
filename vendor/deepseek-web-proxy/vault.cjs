// GPL-3.0-or-later; see LICENSE. Local integration changes, 2026-10-01.
const fs = require('node:fs');
const path = require('node:path');
const { normalizeToken, ProxyError } = require('./protocol.cjs');

class CredentialVault {
  constructor(file, safeStorage) { this.file = file; this.safeStorage = safeStorage; }
  load() {
    if (!fs.existsSync(this.file)) return '';
    if (!this.safeStorage.isEncryptionAvailable()) throw new ProxyError('Windows 凭据加密不可用，请在当前 Windows 用户下运行桌面版');
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved.version !== 1 || typeof saved.encrypted !== 'string') throw new Error('format');
      const token = normalizeToken(this.safeStorage.decryptString(Buffer.from(saved.encrypted, 'base64')));
      if (!token) throw new Error('empty');
      return token;
    } catch {
      throw new ProxyError('已保存的 DeepSeek 登录无法读取，请重新登录（凭据未被删除）');
    }
  }
  save(raw) {
    const token = normalizeToken(raw);
    if (!token) throw new ProxyError('DeepSeek 登录凭据格式无效', 400, 'invalid_token');
    if (!this.safeStorage.isEncryptionAvailable()) throw new ProxyError('Windows 凭据加密不可用，未保存登录凭据');
    const encrypted = this.safeStorage.encryptString(token).toString('base64');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tempFile = `${this.file}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify({ version: 1, encrypted, savedAt: new Date().toISOString() }), { mode: 0o600 });
    fs.renameSync(tempFile, this.file);
    return token;
  }
  clear() { if (fs.existsSync(this.file)) fs.unlinkSync(this.file); }
}
module.exports = { CredentialVault };
