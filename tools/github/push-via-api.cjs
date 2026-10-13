// GitHub Git Database fallback: preserve native commits and publish only a fast-forward.
// Credentials stay in memory and are sent only to api.github.com over HTTPS.
const { spawnSync } = require('node:child_process');
const https = require('node:https');
function git(args, options = {}) {
  const result = spawnSync('git', args, { encoding: 'utf8', timeout: 15000, maxBuffer: 32 * 1024 * 1024, windowsHide: true, ...options });
  if (result.error || result.status !== 0) throw Error('Git command failed: ' + args[0]);
  return result.stdout;
}
function identity(line) {
  const match = /^(?:author|committer) (.*) <([^>]*)> (\d+) ([+-])(\d{2})(\d{2})$/.exec(line);
  if (!match) throw Error('Unsupported commit identity');
  const offset = (Number(match[5]) * 60 + Number(match[6])) * (match[4] === '+' ? 1 : -1);
  return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000 + offset * 60000).toISOString().slice(0, 19) + match[4] + match[5] + ':' + match[6] };
}
async function main() {
  if (git(['status', '--porcelain']).trim()) throw Error('Commit local changes before upload');
  const remote = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(git(['remote', 'get-url', 'origin']).trim());
  if (!remote) throw Error('This fallback requires a GitHub HTTPS origin');
  const repo = remote[1] + '/' + remote[2];
  const branch = git(['branch', '--show-current']).trim();
  if (!branch || /[\r\n]/.test(branch)) throw Error('A local branch is required');
  const head = git(['rev-parse', 'HEAD']).trim();
  const credential = git(['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' } });
  const token = /^password=(.+)$/m.exec(credential)?.[1].trim();
  if (!token) throw Error('No existing GitHub credential; sign in before upload');
  const api = (method, route, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = https.request({ hostname: 'api.github.com', family: 4, path: '/repos/' + repo + route, method,
      headers: { 'User-Agent': 'Jobloom-Git-Upload', Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token,
        'X-GitHub-Api-Version': '2022-11-28', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        try { const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode < 200 || res.statusCode >= 300) reject(Error('GitHub API HTTP ' + res.statusCode + ': ' + (result.message || 'request failed')));
          else resolve(result);
        } catch { reject(Error('Invalid GitHub API response')); }
      });
    });
    const timer = setTimeout(() => req.destroy(Error('GitHub API connection timed out')), 20000);
    req.on('close', () => clearTimeout(timer)); req.on('error', reject); req.end(payload);
  });
  const refRoute = '/git/ref/heads/' + encodeURIComponent(branch);
  const initialHead = (await api('GET', refRoute)).object.sha;
  if (initialHead === head) { console.log('GitHub already matches local HEAD: ' + head); return; }
  git(['merge-base', '--is-ancestor', initialHead, head]);
  const commits = git(['rev-list', '--reverse', initialHead + '..' + head]).trim().split('\n');
  const uploaded = new Set();
  for (const sha of commits) {
    const raw = git(['cat-file', 'commit', sha]);
    const split = raw.indexOf('\n\n'), headers = raw.slice(0, split).split('\n');
    if (headers.some(line => !/^(tree|parent|author|committer) /.test(line))) throw Error('Unsupported commit headers; remote branch was not changed');
    const tree = headers.find(line => line.startsWith('tree ')).slice(5);
    const parents = headers.filter(line => line.startsWith('parent ')).map(line => line.slice(7));
    if (parents.length !== 1) throw Error('This fallback only uploads ordinary single-parent commits');
    const base = await api('GET', '/git/commits/' + parents[0]);
    const paths = git(['diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', parents[0], sha]).split('\0').filter(Boolean);
    const entries = [];
    for (const file of paths) {
      if (!file || file.startsWith('/') || file.split('/').includes('..')) throw Error('Invalid repository path');
      const entry = git(['ls-tree', '-z', sha, '--', file]);
      if (!entry) { entries.push({ path: file, mode: '100644', type: 'blob', sha: null }); continue; }
      const match = /^(\d+) (\w+) ([a-f0-9]{40})\t/.exec(entry);
      if (!match || match[2] !== 'blob') throw Error('Unsupported changed tree entry');
      const blobSha = match[3];
      if (!uploaded.has(blobSha)) {
        const bytes = git(['cat-file', 'blob', blobSha], { encoding: null });
        const blob = await api('POST', '/git/blobs', { content: bytes.toString('base64'), encoding: 'base64' });
        if (blob.sha !== blobSha) throw Error('Blob mismatch; remote branch was not changed');
        uploaded.add(blobSha);
      }
      entries.push({ path: file, mode: match[1], type: 'blob', sha: blobSha });
    }
    const createdTree = await api('POST', '/git/trees', { base_tree: base.tree.sha, tree: entries });
    if (createdTree.sha !== tree) throw Error('Tree mismatch; remote branch was not changed');
    const commit = await api('POST', '/git/commits', { tree, parents, message: raw.slice(split + 2),
      author: identity(headers.find(line => line.startsWith('author '))), committer: identity(headers.find(line => line.startsWith('committer '))) });
    if (commit.sha !== sha) throw Error('Commit mismatch; remote branch was not changed');
    console.log('Verified native commit: ' + sha.slice(0, 7) + ' (' + paths.length + ' changed paths)');
  }
  if ((await api('GET', refRoute)).object.sha !== initialHead) throw Error('Remote branch changed during upload; inspect it before retrying');
  await api('PATCH', '/git/refs/heads/' + encodeURIComponent(branch), { sha: head, force: false });
  if ((await api('GET', refRoute)).object.sha !== head) throw Error('Remote HEAD verification failed');
  git(['update-ref', 'refs/remotes/origin/' + branch, head]);
  console.log('Uploaded and verified GitHub HEAD: ' + head);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
