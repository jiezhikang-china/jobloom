import { useEffect, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
interface Candidate { legacyUnscoped?: boolean; jobHref: string; jobName: string; companyName: string; status: string; reason: string; attempts: number; updatedAt: number; history: Array<{ at: number; status: string; reason: string }>; }
interface Entry { id: string; jobHref: string; jobName: string; companyName: string; stage: string; interviewAt?: string; interviewPlace: string; notes: string; offerSalary: string; offerHours: string; offerRest: string; offerBenefits: string; offerDeadline?: string; resumeVersionId?: string; }
interface Resume { id: string; fileName: string; label: string; targetRole: string; createdAt: number; }
interface State { entries: Entry[]; resumes: Resume[]; candidates: Candidate[]; summary: { unique: number; details: number; passed: number; sent: number; recovery: number; decisions: number; uncertain: number }; replies: number; nextSteps: Array<{ jobHref: string; text: string }>; }
const stages: Record<string, string> = { contacted: '已沟通', interview: '面试', offer: '收到录用', accepted: '已接受', rejected: '未通过', withdrawn: '已放弃' };
const candidateLabels: Record<string, string> = { discovered: '待读取', read_retry: '等待重读', evaluation_retry: '等待评估', ready: '待投递', decision: '需要决定', rejected: '已筛除', sending: '发送待核对', sent: '已沟通', send_unknown: '发送待核对' };
const date = (at: number) => new Date(at).toLocaleString('zh-CN', { hour12: false });
function ResumeRow({ resume, save, activate }: { resume: Resume; save: (path: string, data: unknown) => Promise<void>; activate: (id: string) => Promise<void> }) {
  const [label, setLabel] = useState(resume.label), [target, setTarget] = useState(resume.targetRole);
  return <form className="career-resume-row" onSubmit={e => { e.preventDefault(); void save('resumes/' + resume.id, { label, targetRole: target }); }}>
    <label>版本名称<input aria-label="简历版本名称" value={label} maxLength={200} required onChange={e => setLabel(e.target.value)} /></label>
    <label>目标岗位<input aria-label="简历版本目标岗位" value={target} maxLength={200} onChange={e => setTarget(e.target.value)} /></label>
    <small>{date(resume.createdAt)}<br />{resume.fileName}</small>
    <div className="followup-actions"><button type="submit">保存名称</button><button type="button" onClick={() => void activate(resume.id)}>用此版本投递</button><a href={'/api/career/resumes/' + encodeURIComponent(resume.id) + '/file'} download>下载原文件</a></div>
  </form>;
}
function EntryEditor({ entry, resumes, save }: { entry: Entry; resumes: Resume[]; save: (path: string, data: unknown) => Promise<void> }) {
  const [draft, setDraft] = useState(entry);
  return <form onSubmit={e => { e.preventDefault(); void save('entries/' + entry.id, draft); }} className="career-entry">
    <header><a href={entry.jobHref} target="_blank" rel="noreferrer">{entry.jobName} <ExternalLink size={13} /></a><p>{entry.companyName}</p></header>
    <div className="followup-fields">
      <label>求职阶段<select aria-label="求职阶段" value={draft.stage} onChange={e => setDraft({ ...draft, stage: e.target.value })}>{Object.entries(stages).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      <label>本次使用的简历<select value={draft.resumeVersionId || ''} onChange={e => setDraft({ ...draft, resumeVersionId: e.target.value })}><option value="">未指定</option>{resumes.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}</select></label>
      <label>面试时间<input type="datetime-local" value={draft.interviewAt || ''} onChange={e => setDraft({ ...draft, interviewAt: e.target.value })} /></label>
      <label>面试地点或会议链接<input value={draft.interviewPlace} onChange={e => setDraft({ ...draft, interviewPlace: e.target.value })} /></label>
      <label>薪资与发薪规则<input value={draft.offerSalary} onChange={e => setDraft({ ...draft, offerSalary: e.target.value })} /></label>
      <label>工作时间<input value={draft.offerHours} onChange={e => setDraft({ ...draft, offerHours: e.target.value })} /></label>
      <label>休息安排<input value={draft.offerRest} onChange={e => setDraft({ ...draft, offerRest: e.target.value })} /></label>
      <label>社保、试用期与其他条件<input value={draft.offerBenefits} onChange={e => setDraft({ ...draft, offerBenefits: e.target.value })} /></label>
      <label>录用答复截止<input type="datetime-local" value={draft.offerDeadline || ''} onChange={e => setDraft({ ...draft, offerDeadline: e.target.value })} /></label>
    </div>
    <label>备注<textarea rows={2} value={draft.notes} maxLength={3000} onChange={e => setDraft({ ...draft, notes: e.target.value })} /></label>
    <div className="followup-actions"><button type="submit" className="followup-primary">保存进度</button>{entry.interviewAt && <a href={'/api/career/entries/' + entry.id + '/calendar'} download>导出面试日历</a>}</div>
  </form>;
}
export default function CareerPanel({ onResumeSelected }: { onResumeSelected: (source: { id: string; format: string; fileName: string; text: string }) => void }) {
  const [data, setData] = useState<State>(), [error, setError] = useState(''), [notice, setNotice] = useState(''), [stage, setStage] = useState('all'), [candidateFilter, setCandidateFilter] = useState('recovery'), [limit, setLimit] = useState(30);
  async function load(signal?: AbortSignal) {
    const response = await fetch('/api/career', { signal }), json = await response.json();
    if (!response.ok || !json.success) throw new Error(json.message || '读取求职进度失败'); setData(json.data);
  }
  useEffect(() => { const controller = new AbortController(); void load(controller.signal).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    const timer = setInterval(() => void load(controller.signal).catch(e => { if (!controller.signal.aborted) setError(e.message); }), 10000);
    return () => { controller.abort(); clearInterval(timer); }; }, []);
  async function save(path: string, body: unknown) {
    setError(''); setNotice('');
    try { const response = await fetch('/api/career/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), json = await response.json();
      if (!response.ok || !json.success) throw new Error(json.message || '保存失败'); await load(); setNotice('已保存'); } catch (e) { setError((e as Error).message); }
  }
  async function activate(id: string) {
    setError('');
    try { const response = await fetch('/api/career/resumes/' + encodeURIComponent(id) + '/activate', { method: 'POST' }), json = await response.json();
      if (!response.ok || !json.success) throw new Error(json.message || '切换版本失败'); onResumeSelected(json.data); }
    catch (e) { setError((e as Error).message); }
  }
  if (!data) return <p role={error ? 'alert' : 'status'}>{error || '正在读取求职进度…'}</p>;
  const candidates = data.candidates.filter(c => candidateFilter === 'all' || (candidateFilter === 'historical' ? c.legacyUnscoped : candidateFilter === 'recovery' ? !c.legacyUnscoped && ['discovered', 'read_retry', 'evaluation_retry', 'ready'].includes(c.status)
    : candidateFilter === 'uncertain' ? ['sending', 'send_unknown'].includes(c.status) : c.status === candidateFilter)).sort((a, b) => b.updatedAt - a.updatedAt);
  const offers = data.entries.filter(e => ['offer', 'accepted'].includes(e.stage));
  const upcoming = data.entries.filter(e => e.stage === 'interview' && e.interviewAt && Date.parse(e.interviewAt) >= Date.now()).sort((a, b) => Date.parse(a.interviewAt!) - Date.parse(b.interviewAt!));
  return <section className="career-panel" aria-label="求职进度">
    <div className="followup-toolbar"><div><h2>每个岗位的下一步</h2><p>候选、沟通、面试与录用记录保存在本机。开始投递后会恢复符合当前资料与条件的未完成岗位。</p></div><button onClick={() => void load().catch(e => setError(e.message))}><RefreshCw size={15} /> 刷新</button></div>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <dl className="career-funnel">{([['unique', '去重发现'], ['details', '已读详情'], ['passed', '筛选通过'], ['sent', '已确认沟通'], ['recovery', '系统待恢复'], ['decisions', '需要决定'], ['uncertain', '发送待核对']] as const).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{data.summary[key]}</dd></div>)}<div><dt>收到回复</dt><dd>{data.replies}</dd></div></dl>
    <p className="career-help">以上是台账累计的去重岗位数，不是本轮重读次数；“通过”包含后来资料发生变化的历史通过记录，最终是否投递以确认沟通为准。</p>
    {upcoming.length > 0 && <section className="career-upcoming"><h3>即将面试</h3>{upcoming.map(e => <p key={e.id}>{new Date(e.interviewAt!).toLocaleString('zh-CN')} · {e.companyName} · {e.jobName} · {e.interviewPlace || '地点未记录'}</p>)}</section>}
    <details className="followup-settings" open><summary>候选处理记录 · {candidates.length}</summary>
      <label>显示<select aria-label="候选状态筛选" value={candidateFilter} onChange={e => { setCandidateFilter(e.target.value); setLimit(30); }}><option value="recovery">系统待恢复</option><option value="decision">需要决定</option><option value="uncertain">发送待核对</option><option value="historical">历史来源待核实</option><option value="all">全部</option></select></label>
      {!candidates.length && <p>这里没有对应的岗位。读取或 AI 格式失败会保留到系统恢复，不进入人工条件队列。</p>}
      {candidates.slice(0, limit).map(c => <article className="career-candidate" key={c.jobHref}><a href={c.jobHref} target="_blank" rel="noreferrer">{c.companyName} · {c.jobName}</a><span>{c.legacyUnscoped ? '历史岗位 · 来源未核实' : candidateLabels[c.status]}</span><p>{c.legacyUnscoped ? '保留历史记录；在当前目标列表重新发现前，不进入自动恢复或当前来源统计。' : c.reason}</p>
        {['sending', 'send_unknown'].includes(c.status) && <div className="followup-actions"><button onClick={() => void save('candidates/resolve', { jobHref: c.jobHref, sent: true })}>我已核对：已沟通</button><button onClick={() => void save('candidates/resolve', { jobHref: c.jobHref, sent: false })}>我已核对：未发送</button></div>}
        <details><summary>处理经过</summary>{c.history.map((h, i) => <p key={i}>{date(h.at)} · {candidateLabels[h.status]} · {h.reason}</p>)}</details></article>)}
      {candidates.length > limit && <button onClick={() => setLimit(limit + 30)}>再显示30条</button>}
    </details>
    <div className="followup-list-head"><h3>面试与录用</h3><label>阶段<select aria-label="进度阶段筛选" value={stage} onChange={e => setStage(e.target.value)}><option value="all">全部</option>{Object.entries(stages).map(([id, text]) => <option key={id} value={id}>{text}</option>)}</select></label></div>
    <p>招聘方的面试邀请和资料要求显示为下一步；具体时间、录用和接受意向由你核对后记录。</p>
    {data.entries.filter(e => stage === 'all' || e.stage === stage).map(entry => <div key={entry.id}>{data.nextSteps.find(n => n.jobHref === entry.jobHref) && <p className="followup-next">{data.nextSteps.find(n => n.jobHref === entry.jobHref)!.text}</p>}<EntryEditor entry={entry} resumes={data.resumes} save={save} /></div>)}
    {!data.entries.length && <p>确认投递成功的岗位会自动加入；以前的岗位可在“沟通跟进”中加入。</p>}
    {offers.length > 0 && <section><h3>录用条件比较</h3><div className="career-table-wrap"><table><thead><tr><th>岗位</th><th>薪资</th><th>工时</th><th>休息</th><th>社保与其他</th><th>答复截止</th></tr></thead><tbody>{offers.map(e => <tr key={e.id}><td>{e.companyName}<br />{e.jobName}</td><td>{e.offerSalary || '未记录'}</td><td>{e.offerHours || '未记录'}</td><td>{e.offerRest || '未记录'}</td><td>{e.offerBenefits || '未记录'}</td><td>{e.offerDeadline ? new Date(e.offerDeadline).toLocaleString('zh-CN') : '未记录'}</td></tr>)}</tbody></table></div></section>}
    <section className="followup-settings"><h3>简历版本</h3><p>每次上传原文件保留一个版本，可标记目标岗位并关联求职记录。简历优化、保留版式生成优化 PDF 和自动上传优化稿仍未实现。</p>{data.resumes.map(r => <ResumeRow key={r.id} resume={r} save={save} activate={activate} />)}{!data.resumes.length && <p>先在“简历分析”上传原文件。</p>}</section>
  </section>;
}
