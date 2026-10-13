import './fixtures/activate-isolated-safety.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { WorkConditionReviews, workConditionReviews } from '../src/services/work-condition-reviews.js';
import { apiRouter } from '../src/routes/api.router.js';

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jobloom-review-delete-'));
  const file = path.join(directory, 'reviews.json');
  const store = new WorkConditionReviews(file);
  const items = ['one', 'two', 'three'].map(id => store.add({ jobHref: 'https://www.zhipin.com/job_detail/' + id + '.html', jobName: '虚构岗位', companyName: '虚构公司', salary: '', reason: '工时待确认',
    requirements: [{ id: 'hours', text: '八小时', enabled: true }], assessment: [{ requirementId: 'hours', text: '八小时', status: 'unknown', evidence: '' }] }));
  const original = workConditionReviews.removeMany;
  workConditionReviews.removeMany = ids => store.removeMany(ids);
  const app = express(); app.use(express.json()); app.use('/api', apiRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const endpoint = 'http://127.0.0.1:' + (server.address() as any).port + '/api/delivery/work-condition-reviews';
    const request = (ids: unknown) => fetch(endpoint, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
    const before = fs.readFileSync(file, 'utf8');
    for (const ids of [undefined, [], [items[0].id, 'bad'], [items[0].id, items[0].id]]) {
      assert.equal((await request(ids)).status, 400);
      assert.equal(fs.readFileSync(file, 'utf8'), before, '整批校验失败必须保留所有原记录');
    }
    const response = await request([items[0].id, items[1].id]);
    assert.equal(response.status, 200); assert.equal((await response.json()).data.removed, 2);
    assert.deepEqual(new WorkConditionReviews(file).list().map(item => item.id), [items[2].id], '重启读取也只保留未选记录');
    assert.deepEqual(store.removeMany([items[0].id]), { removed: 0 }, '重复删除幂等，不改剩余记录');
    store.remove(items[2].id); assert.deepEqual(new WorkConditionReviews(file).list(), []);
    fs.writeFileSync(file, '{invalid');
    assert.equal((await request([items[0].id])).status, 400);
    assert.equal(fs.readFileSync(file, 'utf8'), '{invalid', '损坏原件不能被删除请求覆盖');
    console.log('PASS | review DELETE route, single/batch persistence, invalid-batch atomicity, idempotence, corrupt-file preservation; no account operations');
  } finally {
    workConditionReviews.removeMany = original;
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
