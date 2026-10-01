// Local encryption roundtrip only: this test never logs in or contacts the upstream.
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { CredentialVault } = require('../vault.cjs');
const fixtureDir = path.resolve(__dirname, '../../../data/test-deepseek-encryption');
fs.mkdirSync(path.join(fixtureDir, 'electron-profile'), { recursive: true });
app.setPath('userData', path.join(fixtureDir, 'electron-profile'));
app.disableHardwareAcceleration();
app.whenReady().then(() => {
  const file = path.join(fixtureDir, 'credential-fixture.json');
  const unavailableFile = path.join(fixtureDir, 'unavailable-fixture.json');
  fs.mkdirSync(fixtureDir, { recursive: true });
  try {
    assert.equal(safeStorage.isEncryptionAvailable(), true, 'Windows encryption must be available');
    const vault = new CredentialVault(file, safeStorage);
    const sample = 'test-web-token-never-sent-to-network';
    vault.save(sample);
    assert.equal(new CredentialVault(file, safeStorage).load(), sample, 'saved token must survive reload');
    assert.ok(!fs.readFileSync(file, 'utf8').includes(sample), 'no plaintext token in saved credential');
    fs.writeFileSync(file, '{"version":1,"encrypted":"invalid"}');
    assert.throws(() => vault.load(), /重新登录/);
    assert.ok(fs.existsSync(file), 'corrupt credential must not be silently removed');
    const unavailable = new CredentialVault(unavailableFile, { isEncryptionAvailable: () => false });
    assert.throws(() => unavailable.save(sample), /未保存/);
    assert.ok(!fs.existsSync(unavailableFile), 'no plaintext fallback');
    fs.writeFileSync(path.join(fixtureDir, 'result.json'), JSON.stringify({ success: true, encryptionAvailable: true, roundtrip: true, plaintextFallback: false }));
    console.log('Windows encrypted credential roundtrip passed');
  } catch (error) {
    fs.writeFileSync(path.join(fixtureDir, 'result.json'), JSON.stringify({ success: false, message: error.message }));
    console.error(error.message); process.exitCode = 1;
  }
  finally { if (fs.existsSync(file)) fs.unlinkSync(file); app.quit(); }
});
