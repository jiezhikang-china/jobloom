import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Must execute before importing the browser singleton. Mock delivery cleanup must never
// reconnect to the human's persistent BOSS profile, even when invoked from the repo root.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jobloom-offline-browser-'));
process.env.BOSS_PROFILE_DIR = path.join(directory, 'profile');
process.once('exit', () => {
  if (path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(directory, { recursive: true, force: true });
});

