const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const candidates = process.env.BOSS_PDF_PYTHON ? [[process.env.BOSS_PDF_PYTHON, []]] : [['python', []], ['py', ['-3']], ['python3', []]];
let python;
for (const [command, prefix] of candidates) {
  const result = spawnSync(command, [...prefix, '-c', 'import sys;print(sys.version_info >= (3, 10))'], { encoding: 'utf8', windowsHide: true });
  if (result.status === 0 && result.stdout.trim() === 'True') { python = [command, prefix]; break; }
}
if (!python) { console.error('请安装 Python 3.10 或更新版本，再运行 npm run setup:pdf。'); process.exit(1); }
const result = spawnSync(python[0], [...python[1], '-m', 'pip', 'install', '--target', path.join(root, 'vendor/pdf-runtime'),
  '-r', path.join(root, 'server/resources/pdf-requirements.txt'), '--index-url', 'https://pypi.org/simple', '--use-feature=truststore', '--disable-pip-version-check'],
  { cwd: root, stdio: 'inherit', windowsHide: true });
process.exit(result.status ?? 1);
