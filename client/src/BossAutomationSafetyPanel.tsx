import { useEffect, useState } from 'react';

interface SafetyState { blocked: boolean; hold: null | { id: string; reason: string; message: string; detectedAt: string; retryAfter?: string }; }
export default function BossAutomationSafetyPanel({ onChange, onRestored }: { onChange: (blocked: boolean) => void; onRestored?: () => void }) {
  const [state, setState] = useState<SafetyState | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const response = await fetch('/api/boss/automation-safety'); const json = await response.json();
        if (!response.ok || !json.success || typeof json.data?.blocked !== 'boolean') throw new Error('无法读取 BOSS 停止状态，已暂时禁用自动操作');
        if (!disposed) { setState(previous => { if (previous?.hold?.id !== json.data.hold?.id) setConfirmed(false); return json.data; }); setMessage(''); onChange(json.data.blocked); }
      } catch (error) { if (!disposed) { setMessage((error as Error).message); onChange(true); } }
    };
    void load(); const timer = window.setInterval(load, 5000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [onChange]);
  const openBrowser = async () => {
    setBusy(true); setMessage('');
    try {
      const response = await fetch('/api/boss/automation-safety/open-browser', { method: 'POST' });
      const json = await response.json();
      if (!response.ok || !json.success) throw new Error(json.message || 'BOSS 浏览器打开失败');
      setMessage('已打开 BOSS。请在浏览器中完成登录或验证，再回到这里确认恢复。');
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  };
  const confirmRecovery = async () => {
    setBusy(true); setMessage('');
    try {
      const response = await fetch('/api/boss/automation-safety/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ holdId: state?.hold?.id, platformAccessRestored: confirmed }) });
      const json = await response.json();
      if (!response.ok || !json.success) throw new Error(json.message || '停止状态操作失败');
      setState(json.data); onChange(json.data.blocked); setConfirmed(false); setMessage(''); onRestored?.();
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  };
  if (!state?.blocked && !message) return null;
  return <section className={`boss-safety-panel ${state?.blocked ? 'blocked' : ''}`} aria-label="BOSS 自动操作状态">
    {state?.blocked && state.hold ? <>
      <h2>BOSS 自动操作已停止</h2><p>{state.hold.message}</p>
      <p>先打开 BOSS 处理登录或验证，完成后确认恢复。确认后需主动开始任务。</p>
      {state.hold.retryAfter && <p>至少等待至：{new Date(state.hold.retryAfter).toLocaleString()}</p>}
      <button type="button" disabled={busy} onClick={() => void openBrowser()}>打开 BOSS，人工处理</button>
      <label><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />我已完成登录或验证，并确认 BOSS 页面可正常使用</label>
      <button type="button" disabled={busy || !confirmed || !!state.hold.retryAfter && Date.parse(state.hold.retryAfter) > Date.now()}
        onClick={() => void confirmRecovery()}>确认已恢复（不启动投递）</button>
    </> : null}
    {message && <p role="status">{message}</p>}
  </section>;
}
