import { useEffect, useState } from 'react';

interface BlockedCompany { id: string; companyName: string; scope?: 'job' | 'company'; jobs: Array<{ jobName: string }> }
export default function NotSuitablePanel({ disabled }: { disabled?: boolean }) {
  const [companies, setCompanies] = useState<BlockedCompany[]>([]);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async () => {
    const response = await fetch('/api/delivery/not-suitable'); const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.message || '无法读取不感兴趣清单');
    setCompanies(data.data);
  };
  useEffect(() => { void load().catch(cause => setError(cause.message)); }, []);
  const restore = async (id: string) => {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/delivery/not-suitable/' + id, { method: 'DELETE' }); const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || '撤销失败');
      await load();
    } catch (cause) { setError((cause as Error).message); } finally { setBusy(false); }
  };
  const filtered = companies.filter(row => row.companyName.includes(query.trim()));
  return <details className="not-suitable-panel">
    <summary>本地不感兴趣清单 · {companies.length} 家公司</summary>
    <p>命中主动排除条件的公司或岗位会直接过滤，避免重复读取和 AI 评估。可以撤销本地屏蔽；BOSS 此前的反馈需在平台自行调整。</p>
    {error && <p role="alert">{error}</p>}
    {companies.length ? <>
      <input aria-label="搜索不感兴趣公司" placeholder="搜索公司" value={query} onChange={event => setQuery(event.target.value)} />
      <div className="not-suitable-list">
        {filtered.slice(0, 100).map(row => <div key={row.id}><span><strong>{row.companyName}</strong><span>{row.scope === 'job' ? '仅已排除的岗位' : '整家公司'}</span><small>{row.jobs.length} 个岗位已记录</small></span>
          <button type="button" disabled={disabled || busy} aria-label={'撤销本地屏蔽：' + row.companyName} onClick={() => void restore(row.id)}>撤销屏蔽</button></div>)}
      </div>
      {filtered.length > 100 && <p>当前显示前 100 家，可搜索公司名称。</p>}
    </> : <p>尚无本地屏蔽记录。</p>}
  </details>;
}
