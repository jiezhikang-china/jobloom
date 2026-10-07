import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeJsonAtomic } from '../src/services/atomic-json.js';

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-journal-test-'));
try {
  const file = path.join(folder, 'state.json');
  fs.writeFileSync(file, '{"businessSequenceCount":99}');
  let attempts = 0; const waits: number[] = [];
  writeJsonAtomic(file, { businessSequenceCount: 100 }, { ...fs, renameSync: (from, to) => {
    attempts++;
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).businessSequenceCount, 99, '重试期间旧计数完整');
    if (attempts <= 3) throw Object.assign(Error('Windows sharing lock'), { code: 'EPERM' });
    fs.renameSync(from, to);
  } }, ms => { waits.push(ms); });
  assert.deepEqual(waits, [10, 20, 40]);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).businessSequenceCount, 100);
  let failedAttempts = 0;
  assert.throws(() => writeJsonAtomic(file, { businessSequenceCount: 101 }, { ...fs, renameSync: () => {
    failedAttempts++; throw Object.assign(Error('persistent lock'), { code: 'EACCES' });
  } }, () => {}), /persistent lock/);
  assert.equal(failedAttempts, 6, '永久失败有界停止');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).businessSequenceCount, 100, '失败也不能删除旧记录');
  let unknownAttempts = 0;
  assert.throws(() => writeJsonAtomic(file, {}, { ...fs, renameSync: () => {
    unknownAttempts++; throw Object.assign(Error('disk error'), { code: 'EIO' });
  } }, () => {}), /disk error/);
  assert.equal(unknownAttempts, 1, '其他存储错误不能当作锁冲突重试');
  console.log('PASS | Windows短暂共享锁重试、旧记录完整、永久错误停止、未知错误不重试');
} finally {
  for (const name of fs.readdirSync(folder)) fs.unlinkSync(path.join(folder, name));
  fs.rmdirSync(folder);
}
