import { useEffect, useState } from 'react';
import { MessageCircle, Play, Square, RefreshCw, Plus, X, ExternalLink } from 'lucide-react';

interface Settings {
  enabled: boolean; intervalHours: number; maxFollowups: number; dailyMaxMessages: number;
  startHour: number; endHour: number; pollMinutes: number; askConditions: boolean;
  autoAnswerFacts: boolean; facts: Array<{ keywords: string[]; answer: string }>; template: string;
}
interface Action { id: string; text: string; kind: string; state: string; error?: string; sentAt?: number; }
interface Contact { id: string; jobHref: string; jobName: string; companyName: string; status: string;
  lastOutgoingAt: number; lastIncomingAt?: number; nextStep?: string; messages: Array<{ id: string; direction: string; text: string }>; actions: Action[]; }
interface State { settings: Settings; contacts: Contact[]; active: boolean; busy: boolean; message: string; lastCheckedAt?: number; }
const labels: Record<string, string> = { waiting: '等待回复', replied: '收到回复', needs_user: '需要处理', closed: '已结束', uncertain: '发送待核对', sent: '已发送', sending: '正在发送', cancelled: '已取消', queued: '待发送' };
const date = (time?: number) => time ? new Date(time).toLocaleString('zh-CN', { hour12: false }) : '—';
export default function FollowupPanel() {
  const [state, setState] = useState<State>();
  const [draft, setDraft] = useState<Settings>();
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [requesting, setRequesting] = useState(false);
  const [filter, setFilter] = useState('all');
  const [newContact, setNewContact] = useState({ jobHref: '', jobName: '', companyName: '', contactedAt: '' });
  async function load(signal?: AbortSignal) {
    const response = await fetch('/api/followup', { signal }); const json = await response.json();
    if (!response.ok || !json.success) throw new Error(json.message || '读取沟通台账失败');
    setState(json.data); return json.data as State;
  }
  useEffect(() => {
    const controller = new AbortController();
    const read = () => load(controller.signal).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    void read(); const timer = window.setInterval(read, 5000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, []);
  useEffect(() => { if (!dirty && state) setDraft(state.settings); }, [state, dirty]);
  function change(update: Partial<Settings>) { setDirty(true); setDraft(previous => previous && ({ ...previous, ...update })); }
  async function request(route: string, value?: unknown) {
    setRequesting(true); setError(''); setNotice('');
    try {
      const response = await fetch('/api/followup/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value || {}) });
      const json = await response.json(); if (!response.ok || !json.success) throw new Error(json.message || '操作失败');
      setNotice(json.message || '已完成'); if (route === 'settings') setDirty(false); await load();
    } catch (cause) { setError((cause as Error).message); } finally { setRequesting(false); }
  }
  const busy = requesting || state?.busy;
  if (!state || !draft) return <section className="followup-panel"><p role={error ? 'alert' : 'status'}>{error || '正在读取沟通台账…'}</p></section>;
  const visible = state.contacts.filter(c => filter === 'all' || c.status === filter);
  return <section className="followup-panel" aria-label="沟通跟进">
    <div className="followup-toolbar"><div><p className="followup-eyebrow">投递之后</p><h2><MessageCircle size={21} /> 沟通与下一步</h2><p role="status">{state.message}</p>
      <small>上次核对：{date(state.lastCheckedAt)} · 台账 {state.contacts.length} 个岗位</small></div>
      <div className="followup-actions">
        <button disabled={requesting} onClick={() => void request('open')}><ExternalLink size={15} /> 打开 BOSS 消息</button>
        <button disabled={busy} onClick={() => void request('scan')}><RefreshCw size={15} /> 只读核对</button>
        {state.active || state.busy ? <button disabled={requesting} onClick={() => void request('stop')}><Square size={15} /> 停止监控</button>
          : <button className="followup-primary" disabled={busy || dirty || !draft.enabled} onClick={() => void request('start')}><Play size={15} /> 开始自动跟进</button>}
      </div></div>
    {error && <p role="alert" className="work-review-error">{error}</p>}{notice && <p role="status">{notice}</p>}
    <details className="followup-settings" open={!state.contacts.length}>
      <summary>跟进设置{dirty ? ' · 尚未保存' : ''}</summary>
      <p>开启后会实际发送消息。只跟进台账中的岗位；收到回复即停止催问。面试、薪资承诺、联系方式和附件要求由你处理。</p>
      <label className="followup-check"><input type="checkbox" checked={draft.enabled} disabled={state.active || state.busy} onChange={e => change({ enabled: e.target.checked })} /> 启用自动跟进</label>
      <div className="followup-fields">
        {([['intervalHours', '无回复追聊间隔（小时）', 1, 720], ['maxFollowups', '每个岗位最多追聊', 0, 10], ['dailyMaxMessages', '每日消息上限', 0, 150], ['pollMinutes', '核对间隔（分钟）', 1, 120], ['startHour', '发送开始时段（北京时间）', 0, 23], ['endHour', '发送结束时段（北京时间）', 1, 24]] as const).map(([key, label, min, max]) =>
          <label key={key}>{label}<input type="number" min={min} max={max} disabled={state.active || state.busy} value={draft[key]} onChange={e => change({ [key]: Number(e.target.value) })} /></label>)}
      </div>
      <label className="followup-check"><input type="checkbox" checked={draft.askConditions} disabled={state.active || state.busy} onChange={e => change({ askConditions: e.target.checked })} /> 自动询问投递时尚未明确的工作条件（每个岗位一次）</label>
      <label className="followup-template">无回复时的追聊内容<textarea aria-label="无回复时的追聊内容" rows={3} maxLength={300} disabled={state.active || state.busy} value={draft.template} onChange={e => change({ template: e.target.value })} /><small>支持 {'{job}'} 和 {'{company}'}，分别替换为岗位和公司。</small></label>
      <label className="followup-check"><input type="checkbox" checked={draft.autoAnswerFacts} disabled={state.active || state.busy} onChange={e => change({ autoAnswerFacts: e.target.checked })} /> 对命中下列规则的问题，自动发送我确认的事实回答</label>
      <div className="followup-facts">{draft.facts.map((fact, index) => <div key={index} className="followup-fact">
        <label>问题关键词（逗号或换行分隔）<textarea aria-label="问题关键词（逗号或换行分隔）" rows={2} value={fact.keywords.join('，')} disabled={state.active || state.busy}
          onChange={e => { const facts = [...draft.facts]; facts[index] = { ...fact, keywords: e.target.value.split(/[，,\n]+/) }; change({ facts }); }} /></label>
        <label>授权发送的回答<textarea aria-label="授权发送的回答" rows={2} maxLength={300} value={fact.answer} disabled={state.active || state.busy}
          onChange={e => { const facts = [...draft.facts]; facts[index] = { ...fact, answer: e.target.value }; change({ facts }); }} /></label>
        <button disabled={state.active || state.busy} aria-label={'删除回答规则' + (index + 1)} onClick={() => change({ facts: draft.facts.filter((_, i) => i !== index) })}><X size={16} /></button>
      </div>)}</div>
      <div className="followup-actions"><button disabled={state.active || state.busy || draft.facts.length >= 30} onClick={() => change({ facts: [...draft.facts, { keywords: [], answer: '' }] })}><Plus size={15} /> 添加事实回答</button>
        <button disabled={busy || state.active || !dirty} className="followup-primary" onClick={() => void request('settings', draft)}>保存设置</button></div>
    </details>
    <details className="followup-settings"><summary>加入以前投递的岗位</summary><p>填写已经沟通过的岗位；加入记录不会立即发送。首次核对会读取当前消息。</p>
      <form onSubmit={e => { e.preventDefault(); void request('contacts', { ...newContact, contactedAt: new Date(newContact.contactedAt).getTime() }); }} className="followup-fields">
        <label>岗位详情链接<input required type="url" value={newContact.jobHref} onChange={e => setNewContact({ ...newContact, jobHref: e.target.value })} /></label>
        <label>岗位名称<input required value={newContact.jobName} onChange={e => setNewContact({ ...newContact, jobName: e.target.value })} /></label>
        <label>公司名称<input required value={newContact.companyName} onChange={e => setNewContact({ ...newContact, companyName: e.target.value })} /></label>
        <label>最近沟通时间<input required type="datetime-local" value={newContact.contactedAt} onChange={e => setNewContact({ ...newContact, contactedAt: e.target.value })} /></label>
        <button disabled={busy || state.active} type="submit">加入台账</button></form></details>
    <div className="followup-list-head"><h3>沟通台账</h3><label>显示<select aria-label="沟通状态筛选" value={filter} onChange={e => setFilter(e.target.value)}>
      <option value="all">全部</option>{['waiting', 'replied', 'needs_user', 'uncertain', 'closed'].map(key => <option key={key} value={key}>{labels[key]}</option>)}</select></label></div>
    {!visible.length && <p className="followup-empty">这里还没有对应的沟通记录。新投递成功后会自动加入，也可以加入以前的岗位。</p>}
    <div className="followup-contact-list">{visible.map(contact => <article className="followup-contact" key={contact.id}>
      <header><div><a href={contact.jobHref} target="_blank" rel="noreferrer">{contact.jobName} <ExternalLink size={13} /></a><p>{contact.companyName}</p></div><span className={'followup-badge status-' + contact.status}>{labels[contact.status]}</span></header>
      <small>最近发送 {date(contact.lastOutgoingAt)} · 最近收到回复 {date(contact.lastIncomingAt)}</small>
      {contact.nextStep && <p className="followup-next">{contact.nextStep}</p>}
      <details><summary>最近对话与发送记录</summary><ol className="followup-messages">{contact.messages.slice(-8).map(m => <li key={m.id}><strong>{m.direction === 'incoming' ? '招聘方' : '我'}</strong><p>{m.text}</p></li>)}</ol>
        {contact.actions.map(action => <div key={action.id} className="followup-record"><p>{labels[action.state]} · {action.text}</p>{action.error && <small>{action.error}</small>}
          {action.state === 'uncertain' && <div className="followup-actions"><button disabled={busy || state.active} onClick={() => void request('resolve', { id: contact.id, actionId: action.id, sent: true })}>我已核对：已发送</button>
            <button disabled={busy || state.active} onClick={() => void request('resolve', { id: contact.id, actionId: action.id, sent: false })}>我已核对：未发送</button></div>}</div>)}
      </details>
      {contact.status !== 'closed' && <button disabled={busy} onClick={() => void request('close', { id: contact.id })}>结束此岗位跟进</button>}
    </article>)}</div>
  </section>;
}
