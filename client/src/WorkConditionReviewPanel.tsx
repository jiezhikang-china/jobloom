import { useEffect, useState } from 'react';
import { ExternalLink, RefreshCw, Copy, X } from 'lucide-react';
import type { WorkConditionReview } from './types.js';

const statusLabels = { met: '描述符合', not_met: '描述不符合', unknown: '待确认' };

export default function WorkConditionReviewPanel() {
  const [items, setItems] = useState<WorkConditionReview[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch('/api/delivery/work-condition-reviews', { signal: controller.signal });
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.message || '读取待确认岗位失败');
        setItems(result.data); setError('');
      } catch (cause) {
        if (!controller.signal.aborted) setError((cause as Error).message);
      }
    };
    void load();
    const interval = window.setInterval(load, 10000);
    return () => { controller.abort(); window.clearInterval(interval); };
  }, [refresh]);

  const remove = async (id: string) => {
    try {
      const response = await fetch('/api/delivery/work-condition-reviews/' + id, { method: 'DELETE' });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.message || '移除记录失败');
      setItems((previous) => previous.filter((item) => item.id !== id));
      setNotice('已移除本地记录'); setError('');
    } catch (cause) { setError((cause as Error).message); }
  };
  const copy = async (item: WorkConditionReview) => {
    try { await navigator.clipboard.writeText(item.question); setNotice('询问内容已复制'); }
    catch { setNotice('无法访问剪贴板，请选中下方询问内容复制。'); }
  };

  return (
    <section className="work-reviews" aria-label="待确认岗位">
      <div className="work-condition-head">
        <div><h3>待确认岗位 <span>{items.length}</span></h3><p>记录时未自动投递。请核对最新岗位信息，再决定是否联系。</p></div>
        <button type="button" aria-label="刷新待确认岗位" onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={14} /> 刷新</button>
      </div>
      {error && <p role="alert" className="work-review-error">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!items.length && !error && <p className="work-review-empty">暂时没有待确认岗位。运行投递后，缺少依据或描述冲突的岗位会显示在这里。</p>}
      <div className="work-review-list">
        {items.map((item) => (
          <article key={item.id} className="work-review-item">
            <div className="work-review-title">
              <div><a href={item.jobHref} target="_blank" rel="noreferrer">{item.jobName} <ExternalLink size={13} /></a>
                <p>{item.companyName} · {item.salary || '薪资未注明'}</p></div>
              <button type="button" aria-label={'移除记录：' + item.jobName} onClick={() => void remove(item.id)}><X size={16} /></button>
            </div>
            <p>{item.reason}</p>
            <dl>
              {item.assessment.map((condition) => (
                <div key={condition.requirementId}><dt>{condition.text} <span className={condition.status}>{statusLabels[condition.status]}</span></dt>
                  <dd>{condition.evidence || '岗位描述未提供明确依据'}</dd></div>
              ))}
            </dl>
            <p>记录于 {new Date(item.updatedAt).toLocaleString('zh-CN')}</p>
            <div className="work-review-question"><p>{item.question}</p>
              <button type="button" onClick={() => void copy(item)}><Copy size={14} /> 复制询问内容</button></div>
          </article>
        ))}
      </div>
    </section>
  );
}
