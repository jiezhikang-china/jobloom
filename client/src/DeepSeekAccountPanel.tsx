import { useEffect, useState } from 'react';
import { ExternalLink, LogIn, RefreshCw } from 'lucide-react';

interface WebStatus {
  state: string;
  message: string;
  hasCredential: boolean;
  loginWindowOpen: boolean;
  busy: boolean;
  retryAfterSeconds: number;
}
const panelStyle = { background: '#0f172a', border: '1px solid #334155', borderRadius: 12, padding: 20 };
const buttonStyle = { padding: '9px 14px', borderRadius: 8, background: '#334155', color: '#e2e8f0', display: 'inline-flex', gap: 7, alignItems: 'center' };

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

  return (
    <section aria-label="DeepSeek 网页账号" style={panelStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <h3 style={{ fontSize: 16, margin: 0 }}>DeepSeek 网页账号</h3>
        <span style={{ borderRadius: 20, padding: '4px 10px', fontSize: 12, color: ready || saved ? '#4ade80' : '#fbbf24', background: '#1e293b' }}>
          {ready ? '已登录' : saved ? '登录已保存' : status ? '需要登录或检查' : '正在启动'}
        </span>
      </div>
      <p role="status" style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.7, margin: '12px 0' }}>
        {status?.message || '正在准备本机反代服务…'}
        {status?.busy && ' · 模型正在处理任务'}
        {!!status?.retryAfterSeconds && ` · 等待约 ${status.retryAfterSeconds} 秒后可继续`}
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" style={{ ...buttonStyle, background: '#2563eb' }} disabled={working} onClick={() => void action('login')}>
          <LogIn size={16} />{working ? '处理中…' : status?.loginWindowOpen ? '显示登录窗口' : '打开 DeepSeek 登录'}
        </button>
        <button type="button" style={buttonStyle} disabled={working || status?.busy} onClick={() => void action('status')}>
          <RefreshCw size={15} />检查登录
        </button>
        {status?.hasCredential && (
          <button type="button" style={buttonStyle} disabled={working || status?.busy} onClick={() => void action('logout')}>退出账号</button>
        )}
      </div>
      <p style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.7, marginTop: 12 }}>
        在弹出的网页窗口手动登录。成功后自动保存，之后启动会复用；窗口由你手动关闭。
        模型请求使用同一个账号按顺序处理，网页登录和 BOSS 扫码分别保存。
      </p>
      {(error || pollError) && <p role="alert" style={{ color: '#fda4af', fontSize: 13 }}>{error || pollError}</p>}
      <details style={{ marginTop: 14, color: '#94a3b8', fontSize: 12 }}>
        <summary style={{ cursor: 'pointer' }}>备用方式：导入网页 userToken</summary>
        <p style={{ lineHeight: 1.6 }}>在已登录的 DeepSeek 网页开发者工具中，打开 Application → Local Storage，复制 userToken 的值并粘贴到此处。</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <input type="password" aria-label="DeepSeek 网页 userToken" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} placeholder="仅保存在本机" style={{ flex: 1, minWidth: 0 }} />
          <button type="button" style={buttonStyle} disabled={!token.trim() || working || status?.busy} onClick={() => void action('token')}>验证并保存</button>
        </div>
      </details>
      <a href="https://github.com/xiaoY233/Chat2API" target="_blank" rel="noreferrer" style={{ color: '#64748b', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 16 }}>
        反代来源：Chat2API <ExternalLink size={12} />
      </a>
    </section>
  );
}
