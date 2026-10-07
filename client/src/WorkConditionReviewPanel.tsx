import { useEffect, useState } from 'react';
import { ExternalLink, RefreshCw, Send, X } from 'lucide-react';
import type { DeliveryStats, WorkConditionReview } from './types.js';

const statusLabels = { met: '描述符合', not_met: '描述不符合', unknown: '待确认' };

export default function WorkConditionReviewPanel({ taskRunning = false, onStarted }: {
  taskRunning?: boolean; onStarted?: (stats: DeliveryStats) => void;
}) {
  const [items, setItems] = useState<WorkConditionReview[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const busy = taskRunning || submitting;
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch('/api/delivery/work-condition-reviews', { signal: controller.signal });
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.message || '读取待确认岗位失败');
        setItems(result.data); setSelected(previous => previous.filter(id => result.data.some((item: WorkConditionReview) => item.id === id))); setError('');
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
  const apply = async (ids: string[]) => {
    if (busy || !ids.length) return;
    setSubmitting(true); setNotice(''); setError('');
    try {
      const response = await fetch('/api/delivery/work-condition-reviews/apply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.message || '投递未启动');
      setNotice(result.message || '已开始投递所选岗位'); setSelected([]);
      if (result.data) onStarted?.(result.data);
      setRefresh(value => value + 1);
    } catch (cause) { setError((cause as Error).message); }
    finally { setSubmitting(false); }
  };

  return (
    <section className="work-reviews" aria-label="待确认岗位">
      <div className="work-condition-head">
        <div><h3>待确认岗位 <span>{items.length}</span></h3><p>排除条件先执行；记录时未自动投递。其余条件尚未确认，你可以选择先投递。</p></div>
        <button type="button" aria-label="刷新待确认岗位" onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={14} /> 刷新</button>
      </div>
      {error && <p role="alert" className="work-review-error">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {items.length > 0 && <div className="work-review-selection">
        <label><input type="checkbox" aria-label="全选待确认岗位" disabled={busy} checked={selected.length === items.length}
          onChange={event => setSelected(event.target.checked ? items.map(item => item.id) : [])} /> 全选</label>
        <span>已选 {selected.length} 个{taskRunning ? ' · 当前有投递任务，请结束后操作' : ''}</span>
        <button type="button" disabled={busy || !selected.length} onClick={() => void apply(selected)}><Send size={14} /> 投递所选（{selected.length}）</button>
      </div>}
      {!items.length && !error && <p className="work-review-empty">暂时没有待确认岗位。运行投递后，缺少依据或描述冲突的岗位会显示在这里。</p>}
      <div className="work-review-list">
        {items.map((item) => (
          <article key={item.id} className="work-review-item">
            <div className="work-review-title">
              <div className="work-review-job"><input type="checkbox" aria-label={'选择岗位：' + item.jobName} disabled={busy} checked={selected.includes(item.id)}
                  onChange={event => setSelected(previous => event.target.checked ? [...previous, item.id] : previous.filter(id => id !== item.id))} />
                <div><a href={item.jobHref} target="_blank" rel="noreferrer">{item.jobName} <ExternalLink size={13} /></a>
                <p>{item.companyName}{item.screening?.industry ? ' · ' + item.screening.industry : ''} · {item.salary || '薪资未注明'}</p></div>
              </div><button type="button" disabled={busy} aria-label={'移除记录：' + item.jobName} onClick={() => void remove(item.id)}><X size={16} /></button>
            </div>
            <p>{item.reason}</p>
            {(item.screening?.workAddress || item.screening?.commute) && <div className="work-review-location">
              <p>工作地点：{item.screening.workAddress?.address || '未提供可核对的地址'}</p>
              {item.screening.commute && <>
                <p>出发位置：{item.screening.commute.origin.cityName} · {item.screening.commute.origin.name}</p>
                <p>直线距离：{item.screening.commute.distanceKm !== undefined ? '约 ' + item.screening.commute.distanceKm.toFixed(1) + ' 公里' : '待确认'}</p>
                {item.screening.needsCommuteConfirmation && <p>地点尚未通过当前限制。点击投递时会重新核对工作地址和距离，确认符合后才发起沟通。</p>}
              </>}
            </div>}
            {item.screening?.needsDetailConfirmation && <p>岗位详情需重新读取。点击投递时，会打开该岗位自己的完整页面并重新筛选。</p>}
            {item.evaluationSource && <p>{item.screening?.needsEvaluationConfirmation ? 'AI 已返回，评估格式待确认' : item.evaluationSource === 'rules' ? '脚本筛选' : item.evaluationSource === 'cache' ? '复用 AI 评估' : 'AI 已评估'}
              {item.score !== undefined ? ' · 匹配度 ' + item.score + ' 分' : ''}</p>}
            {item.screening?.companyInfo && <details className="work-review-company">
              <summary>已核查公司页 · {item.screening.companyInfo.industry}</summary>
              <p><a href={item.screening.companyInfo.url} target="_blank" rel="noreferrer">查看该公司的 BOSS 页面 <ExternalLink size={12} /></a></p>
              <p>公司介绍：{item.screening.companyInfo.introduction || '未提供'}</p>
              <p>经营范围：{item.screening.companyInfo.businessScope || '未提供'}</p>
            </details>}
            <dl>
              {item.assessment.map((condition) => (
                <div key={condition.requirementId}><dt>{condition.text} <span className={condition.status}>{statusLabels[condition.status]}</span></dt>
                  <dd>{condition.evidence || '岗位描述未提供明确依据'}</dd></div>
              ))}
            </dl>
            <p>记录于 {new Date(item.updatedAt).toLocaleString('zh-CN')}</p>
            <div className="work-review-actions"><p>投递后会自动打开 BOSS 沟通窗口。</p>
              <button type="button" disabled={busy} aria-label={'投递岗位：' + item.jobName} onClick={() => void apply([item.id])}><Send size={14} /> 投递</button></div>
          </article>
        ))}
      </div>
    </section>
  );
}
