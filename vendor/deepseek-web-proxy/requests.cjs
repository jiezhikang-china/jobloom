// Local request recovery, GPL-3.0-or-later. See LICENSE and UPSTREAM.md.
const fs = require('node:fs');
const path = require('node:path');

// Persist only request/session identifiers. No prompt, answer, cookie or token is written.
class WebRequests {
  constructor(file) {
    this.file = file;
    this.pending = new Map();
    this.completed = new Map();
    if (file && fs.existsSync(file)) {
      const records = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(records) || records.some(item => !item || typeof item.requestId !== 'string'
        || !/^[a-zA-Z0-9_-]{8,100}$/.test(item.requestId) || typeof item.sessionId !== 'string' || !item.sessionId
        || item.sessionId.length > 200 || !Number.isFinite(Date.parse(item.createdAt)))) throw new Error('未完成请求记录无法读取');
      records.forEach(({ requestId, sessionId, createdAt }) => this.pending.set(requestId, { requestId, sessionId, createdAt }));
    }
  }
  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = this.file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(this.list()), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
  list() { return [...this.pending.values()].map(item => ({ ...item })); }
  begin(requestId, sessionId) {
    const previous = this.pending.get(requestId);
    this.pending.set(requestId, { requestId, sessionId, createdAt: new Date().toISOString() });
    try { this.save(); }
    catch (error) { previous ? this.pending.set(requestId, previous) : this.pending.delete(requestId); throw error; }
  }
  clear(requestId) {
    const previous = this.pending.get(requestId);
    this.pending.delete(requestId);
    try { this.save(); }
    catch (error) { if (previous) this.pending.set(requestId, previous); throw error; }
  }
  finish(requestId, completion) {
    this.completed.set(requestId, { expiresAt: Date.now() + 30 * 60 * 1000, completion });
    while (this.completed.size > 100) this.completed.delete(this.completed.keys().next().value);
    this.clear(requestId);
  }
  result(requestId) {
    const result = this.completed.get(requestId);
    if (!result || result.expiresAt <= Date.now()) { this.completed.delete(requestId); return undefined; }
    return result.completion;
  }
}

function retryAfterSeconds(header, fallback = 60, now = Date.now()) {
  if (!header || !header.trim()) return fallback;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const until = Date.parse(header);
  return Number.isFinite(until) ? Math.max(0, Math.ceil((until - now) / 1000)) : fallback;
}

module.exports = { WebRequests, retryAfterSeconds };
