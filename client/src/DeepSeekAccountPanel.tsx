import { useEffect, useState } from 'react';
import { ExternalLink, LogIn, RefreshCw } from 'lucide-react';

interface WebStatus {
  state: string;
  message: string;
  hasCredential: boolean;
  loginWindowOpen: boolean;
  busy: boolean;
  retryAfterSeconds: number;
  pendingRequests?: { requestId: string; sessionId: string; createdAt: string }[];
}
const panelStyle = { background: 'var(--surface-subtle)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 20 };
const buttonStyle = { padding: '9px 14px', borderRadius: 8, background: 'var(--border-color)', color: 'var(--text-main)', display: 'inline-flex', gap: 7, alignItems: 'center' };

export default function DeepSeekAccountPanel() {
  const [status, setStatus] = useState<WebStatus | null>(null);
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const [working, setWorking] = useState(false);
  const [token, setToken] = useState('');

  useEffect(() => {
    let cancelled = false;
    let pending = false;
    const poll = async () => {
      if (pending) return;
      pending = true;
      try {
        const response = await fetch('/api/llm/web/status');
        const result = await response.json();
        if (!result.success) throw new Error(result.message || '服务未启动');
        if (!cancelled) { setStatus(result.data); setPollError(''); }
      } catch (failure) { if (!cancelled) setPollError((failure as Error).message); }
      finally { pending = false; }
    };
    void poll();
    const interval = setInterval(() => void poll(), 3000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  const action = async (name: 'login' | 'logout' | 'token' | 'status') => {
    if (working) return;
    setWorking(true); setError('');
    try {
      const response = await fetch(`/api/llm/web/${name === 'status' ? 'status?refresh=1' : name}`, {
        method: name === 'status' ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' },
        ...(name === 'token' ? { body: JSON.stringify({ token }) } : {}),
      });
      const result = await response.json();
      if (!result.success) throw new Error(result.message || '操作失败');
      setStatus(result.data);
      if (name === 'token') setToken('');
    } catch (failure) { setError((failure as Error).message); }
    finally { setWorking(false); }
  };
  const ready = status?.state === 'ready';
  const saved = status?.state === 'saved';
  const handlePending = async (requestId: string, action: 'view' | 'retry' | 'recover') => {
    if (working) return;
    setWorking(true); setError('');
    try {
      const response = await fetch('/api/llm/web/requests/' + action, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId }) });
      const result = await response.json();
      if (!result.success) throw new Error(result.message || '操作失败');
      setStatus(result.data);
    } catch (failure) { setError((failure as Error).message); }
    finally { setWorking(false); }
  };

  return (
    <section aria-label="DeepSeek 网页账号" style={panelStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <h3 style={{ fontSize: 16, margin: 0 }}>DeepSeek 网页账号</h3>
        <span style={{ borderRadius: 20, padding: '4px 10px', fontSize: 12, color: ready || saved ? 'var(--success)' : 'var(--accent-amber)', background: 'var(--surface)' }}>
          {ready ? '已登录' : saved ? '登录已保存' : status ? '需要登录或检查' : '正在启动'}
        </span>
      </div>
      <p role="status" style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.7, margin: '12px 0' }}>
        {status?.message || '正在准备本机反代服务…'}
        {status?.busy && ' · 模型正在处理任务'}
        {!!status?.retryAfterSeconds && ` · 等待约 ${status.retryAfterSeconds} 秒后可继续`}
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" style={{ ...buttonStyle, background: 'var(--primary)', color: '#fff' }} disabled={working} onClick={() => void action('login')}>
          <LogIn size={16} />{working ? '处理中…' : status?.loginWindowOpen ? '显示登录窗口' : '打开 DeepSeek 登录'}
        </button>
        <button type="button" style={buttonStyle} disabled={working || status?.busy} onClick={() => void action('status')}>
          <RefreshCw size={15} />检查登录
        </button>
        {status?.hasCredential && (
          <button type="button" style={buttonStyle} disabled={working || status?.busy} onClick={() => void action('logout')}>退出账号</button>
        )}
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7, marginTop: 12 }}>
        在弹出的网页窗口手动登录。成功后自动保存，之后启动会复用；窗口由你手动关闭。
        模型请求使用同一个账号按顺序处理，网页登录和 BOSS 扫码分别保存。
      </p>
      {!!status?.pendingRequests?.length && <div style={{ marginTop: 12, padding: 12, background: 'var(--surface)', borderRadius: 8 }}>
        <h4 style={{ margin: 0, color: 'var(--accent-amber)' }}>上次聊天结果待确认</h4>
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>等待期间会读取原聊天的完成状态。也可以手动读取已完成答案；已有答案会复用，不重复生成。</p>
        {status.pendingRequests.map(item => <div key={item.requestId} style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{new Date(item.createdAt).toLocaleString('zh-CN')}</span>
          <button type="button" style={buttonStyle} disabled={working || status.busy} onClick={() => void handlePending(item.requestId, 'view')}>查看该聊天</button>
          <button type="button" style={buttonStyle} disabled={working || status.busy} onClick={() => void handlePending(item.requestId, 'recover')}>读取已有结果</button>
          <button type="button" style={buttonStyle} disabled={working || status.busy} onClick={() => void handlePending(item.requestId, 'retry')}>确认未完成，允许重试</button>
        </div>)}
      </div>}
      {(error || pollError) && <p role="alert" style={{ color: 'var(--accent-rose)', fontSize: 13 }}>{error || pollError}</p>}
      <details style={{ marginTop: 14, color: 'var(--text-muted)', fontSize: 12 }}>
        <summary style={{ cursor: 'pointer' }}>备用方式：导入网页 userToken</summary>
        <p style={{ lineHeight: 1.6 }}>在已登录的 DeepSeek 网页开发者工具中，打开 Application → Local Storage，复制 userToken 的值并粘贴到此处。</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <input type="password" aria-label="DeepSeek 网页 userToken" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} placeholder="仅保存在本机" style={{ flex: 1, minWidth: 0 }} />
          <button type="button" style={buttonStyle} disabled={!token.trim() || working || status?.busy} onClick={() => void action('token')}>验证并保存</button>
        </div>
      </details>
      <a href="https://github.com/xiaoY233/Chat2API" target="_blank" rel="noreferrer" style={{ color: 'var(--text-muted)', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 16 }}>
        反代来源：Chat2API <ExternalLink size={12} />
      </a>
    </section>
  );
}
