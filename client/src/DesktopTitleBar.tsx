import { Minus, Square, X } from 'lucide-react';

declare global {
  interface Window { jobloomDesktop?: { platform: string; minimize(): Promise<void>; toggleMaximize(): Promise<void>; close(): Promise<void> }; }
}
export default function DesktopTitleBar() {
  const desktop = window.jobloomDesktop;
  if (!desktop) return null;
  return <div className="desktop-titlebar" onDoubleClick={() => void desktop.toggleMaximize()}>
    <span className="desktop-brand"><img src="/jobloom-icon.png" width="20" height="20" alt="" /> 拾职 · Jobloom <span>工作台</span></span>
    <div className="desktop-window-controls" onDoubleClick={event => event.stopPropagation()}>
      <button title="最小化" aria-label="最小化" onClick={() => void desktop.minimize()}><Minus size={16} /></button>
      <button title="最大化／还原" aria-label="最大化或还原" onClick={() => void desktop.toggleMaximize()}><Square size={13} /></button>
      <button className="desktop-close" title="关闭并停止任务" aria-label="关闭并停止任务" onClick={() => void desktop.close()}><X size={17} /></button>
    </div>
  </div>;
}
