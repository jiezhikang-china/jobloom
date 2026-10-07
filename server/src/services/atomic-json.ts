import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Keep the old journal intact while Windows readers/scanners briefly hold its replacement lock. */
export function writeJsonAtomic(file: string, value: unknown,
  io: Pick<typeof fs, 'mkdirSync' | 'writeFileSync' | 'renameSync'> = fs,
  wait = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }): void {
  io.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + process.pid + '.' + randomUUID() + '.tmp';
  io.writeFileSync(temporary, JSON.stringify(value), 'utf8');
  for (let attempt = 0; ; attempt++) {
    try { io.renameSync(temporary, file); return; }
    catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException).code || '') || attempt >= 5) throw error;
      // At most 310ms, only after a lock conflict; never delete the last valid journal.
      wait(10 * 2 ** attempt);
    }
  }
}
