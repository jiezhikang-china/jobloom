import assert from 'node:assert/strict';
import { sanitizeApiKey, isApiKeyFormatValid } from '../src/services/llm.service.js';
import { filterService } from '../src/services/filter.service.js';

assert.equal(sanitizeApiKey(' KEY:abc123xyz '), 'abc123xyz');
assert.equal(sanitizeApiKey('  "sk-abc123"  '), 'sk-abc123');
assert.equal(sanitizeApiKey('Bearer abc123xyz'), 'abc123xyz');
assert.equal(isApiKeyFormatValid('ab cd1234'), false);
assert.equal(isApiKeyFormatValid('abc123xyz'), true);
assert.deepEqual(filterService.parseSalaryRangeK('15-25K·13薪'), { min: 15, max: 25 });
assert.deepEqual(filterService.parseSalaryRangeK('1.5-2.5万'), { min: 15, max: 25 });
assert.equal(filterService.parseSalaryRangeK('面议'), null);
assert.equal(filterService.parseSalaryRangeK('200-300元/天'), null);

process.stdout.write('PASS | 基础自检：密钥清洗与薪资解析\n');
