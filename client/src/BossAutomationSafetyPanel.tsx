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
      <p>停止状态会跨重启保留；等待结束、关闭弹窗或验证码消失都不会自动恢复。账号封禁只能通过平台核实或申诉。</p>
      {state.hold.retryAfter && <p>至少等待至：{new Date(state.hold.retryAfter).toLocaleString()}</p>}
      <label><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />我已通过 BOSS 人工确认账号和页面恢复正常，可以继续使用</label>
      <button type="button" disabled={busy || !confirmed || !!state.hold.retryAfter && Date.parse(state.hold.retryAfter) > Date.now()}
        onClick={() => void confirmRecovery()}>确认已恢复（不启动投递）</button>
    </> : null}
    {message && <p role="status">{message}</p>}
  </section>;
}
