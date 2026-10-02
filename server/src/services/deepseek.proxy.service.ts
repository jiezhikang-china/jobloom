import fs from 'node:fs';
import path from 'node:path';
import { spawn, ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export interface DeepSeekWebStatus {
  running: boolean;
  state: 'not_logged_in' | 'saved' | 'ready' | 'expired' | 'verification_required' | 'error';
  message: string;
  hasCredential: boolean;
  loginWindowOpen: boolean;
  busy: boolean;
  retryAfterSeconds: number;
  pendingRequests: { requestId: string; sessionId: string; createdAt: string }[];
  models: { id: string; name: string }[];
  source: string;
  sourceUrl: string;
}
interface ProxyConnection { port: number; secret: string; integrationVersion: number; }

const root = path.resolve(process.cwd(), '..');
const runtimeFile = path.join(root, 'data', 'deepseek-proxy-runtime.json');

export class DeepSeekProxyService {
  private startup: Promise<ProxyConnection> | null = null;
  private child: ChildProcess | null = null;

  private async existing(allowPreviousVersion = false): Promise<ProxyConnection | null> {
    try {
      const runtime = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
      if (!Number.isInteger(runtime.port) || runtime.port < 1 || runtime.port > 65535 ||
        typeof runtime.secret !== 'string' || runtime.secret.length < 32 ||
        (runtime.integrationVersion !== 4 && !(allowPreviousVersion && [1, 2, 3].includes(runtime.integrationVersion)))) return null;
      const response = await fetch(`http://127.0.0.1:${runtime.port}/health`, { signal: AbortSignal.timeout(1000) });
      const health: any = await response.json();
      if (health.app !== 'boss-deepseek-web-proxy' || health.integrationVersion !== runtime.integrationVersion || health.status !== 'ok') return null;
      // Verify that the saved local access key belongs to this instance; don't adopt another service.
      const verified = await fetch(`http://127.0.0.1:${runtime.port}/status`, {
        headers: { Authorization: `Bearer ${runtime.secret}` }, signal: AbortSignal.timeout(1500),
      });
      return verified.ok ? { port: runtime.port, secret: runtime.secret, integrationVersion: runtime.integrationVersion } : null;
    } catch { return null; }
  }

  public async ensure(): Promise<ProxyConnection> {
    if (this.startup) return this.startup;
    this.startup = this.start().finally(() => { this.startup = null; });
    return this.startup;
  }

  private async start(): Promise<ProxyConnection> {
    const existing = await this.existing();
    if (existing) return existing;
    const previous = await this.existing(true);
    if (previous?.integrationVersion === 4) return previous;
    if (previous) {
      const stopped = await fetch(`http://127.0.0.1:${previous.port}/shutdown`, {
        method: 'POST', headers: { Authorization: `Bearer ${previous.secret}` }, signal: AbortSignal.timeout(2000),
      });
      if (stopped.status === 409) throw new Error('DeepSeek 旧组件仍在处理任务或显示登录窗口，请等待任务完成并手动关闭登录窗口后重试');
      if (!stopped.ok) throw new Error('DeepSeek 旧组件暂未停止，请稍后重试');
      // Let the old Electron process release the profile lock before starting another.
      let released = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        const current = await this.existing(true);
        if (!current || current.secret !== previous.secret) { released = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!released) throw new Error('DeepSeek 旧组件正在退出，请稍后重试');
      await new Promise((resolve) => setTimeout(resolve, 150));
      const ready = await this.existing();
      if (ready) return ready;
    }
    const binary = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
    const entry = path.join(root, 'vendor', 'deepseek-web-proxy', 'main.cjs');
    if (!fs.existsSync(binary) || !fs.existsSync(entry)) throw new Error('DeepSeek 本机组件缺失，请通过桌面版启动或安装项目依赖');
    const secret = randomBytes(32).toString('hex');
    const env: NodeJS.ProcessEnv = { ...process.env, BOSS_DEEPSEEK_DATA_DIR: path.join(root, 'data'), BOSS_DEEPSEEK_PROXY_SECRET: secret };
    // The backend may itself run in Electron's Node mode. The login process needs full Electron.
    delete env.ELECTRON_RUN_AS_NODE;
    this.child = spawn(binary, [entry], { cwd: root, env, windowsHide: true, stdio: 'ignore', detached: true });
    let spawnError = false;
    this.child.once('error', () => { spawnError = true; });
    const launched = this.child;
    for (let attempt = 0; attempt < 80; attempt++) {
      const ready = await this.existing();
      if (ready) return ready;
      if (spawnError || launched.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (launched.exitCode === null) launched.kill();
    if (this.child === launched) this.child = null;
    throw new Error('DeepSeek 本机服务启动失败，请重试或查看桌面组件是否完整');
  }

  public async request<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
    const connection = await this.ensure();
    const response = await fetch(`http://127.0.0.1:${connection.port}${route}`, {
      method, headers: { Authorization: `Bearer ${connection.secret}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(25000),
    });
    const result: any = await response.json();
    if (!response.ok) throw new Error(result?.error?.message || 'DeepSeek 本机服务请求失败');
    return result as T;
  }

  public async status(refresh = false): Promise<DeepSeekWebStatus> {
    return this.request<DeepSeekWebStatus>(`/status${refresh ? '?refresh=1' : ''}`);
  }
  public async login(): Promise<DeepSeekWebStatus> { return this.request('/login', 'POST'); }
  public async importToken(token: string): Promise<DeepSeekWebStatus> { return this.request('/token', 'POST', { token }); }
  public async logout(): Promise<DeepSeekWebStatus> { return this.request('/logout', 'POST'); }

  public async connection(): Promise<{ baseUrl: string; apiKey: string }> {
    const connection = await this.ensure();
    const status = await this.request<DeepSeekWebStatus>('/status');
    if (!status.hasCredential) throw new Error('请先在【设置 → DeepSeek 网页账号】中登录，成功后会自动保存');
    if (status.state === 'expired' || status.state === 'verification_required') throw new Error(status.message);
    return { baseUrl: `http://127.0.0.1:${connection.port}/v1`, apiKey: connection.secret };
  }

  public async stopIfIdle(): Promise<void> {
    const existing = await this.existing(true);
    if (!existing) return;
    // The proxy keeps a login window alive until the user closes it.
    const response = await fetch(`http://127.0.0.1:${existing.port}/shutdown`, {
      method: 'POST', headers: { Authorization: `Bearer ${existing.secret}` }, signal: AbortSignal.timeout(2000),
    });
    if (!response.ok && response.status !== 409) throw new Error('DeepSeek 本机服务暂未停止');
  }
}
export const deepseekProxyService = new DeepSeekProxyService();
