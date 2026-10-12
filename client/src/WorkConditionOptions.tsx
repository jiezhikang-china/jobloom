import { useState } from 'react';
import type { WorkRequirement } from './types.js';

export const workConditionPresets: Array<{ text: string; builtin: NonNullable<WorkRequirement['builtin']>; shortName: string }> = [
  { text: '每天工作不超过八小时', builtin: 'eightHours', shortName: '八小时' },
  { text: '每周双休', builtin: 'doubleRest', shortName: '双休' },
  { text: '允许无经验入职', builtin: 'noExperience', shortName: '允许无经验' },
];
const makeRequirement = (text: string, builtin?: WorkRequirement['builtin']): WorkRequirement =>
  ({ id: crypto.randomUUID(), text, enabled: true, ...(builtin ? { builtin } : {}) });
export function withWorkConditionPresets(current: WorkRequirement[]): WorkRequirement[] {
  let result = [...current];
  for (const preset of workConditionPresets) {
    const existing = result.find((item) => item.builtin === preset.builtin && item.text === preset.text);
    if (existing) result = result.map((item) => item.id === existing.id ? { ...item, enabled: true } : item);
    else if (result.length < 20) result.push(makeRequirement(preset.text, preset.builtin));
  }
  return result;
}

export default function WorkConditionOptions({ value, onChange, disabled = false }: {
  value?: WorkRequirement[]; onChange: (value: WorkRequirement[]) => void; disabled?: boolean;
}) {
  const conditions = value || [];
  const [draft, setDraft] = useState('');
  const missingPresets = workConditionPresets.filter((preset) => !conditions.some((item) => item.builtin === preset.builtin && item.text === preset.text)).length;
  const add = (text: string, builtin?: WorkRequirement['builtin']) => {
    if (conditions.length >= 20 || text.trim().length < 2) return;
    const existing = conditions.find((item) => item.text === text.trim());
    if (existing) onChange(conditions.map((item) => item.id === existing.id ? { ...item, enabled: true } : item));
    else onChange([...conditions, makeRequirement(text.trim(), builtin)]);
    setDraft('');
  };
  return (
    <section className="work-conditions" aria-label="工作条件">
      <div className="work-condition-head">
        <div><h3>你想要的工作条件</h3><p>每条条件可选择处理方式；明确冲突仍会淘汰，偏好用于排序。</p></div>
        <button type="button" disabled={disabled || conditions.length + missingPresets > 20}
          onClick={() => onChange(withWorkConditionPresets(conditions))}>加入八小时·双休·无经验</button>
      </div>
      <div className="work-condition-presets">
        <span>快捷添加</span>
        {workConditionPresets.map((preset) => <button type="button" key={preset.builtin} disabled={disabled || conditions.length >= 20}
          onClick={() => add(preset.text, preset.builtin)}>{preset.shortName}</button>)}
      </div>
      <div className="work-condition-options">
        {conditions.map((item, index) => (
          <div key={item.id} className={'work-requirement-row' + (item.enabled ? ' checked' : '')}>
            <label><input type="checkbox" aria-label={'启用条件：' + item.text} checked={item.enabled} disabled={disabled}
              onChange={(event) => onChange(conditions.map((row) => row.id === item.id ? { ...row, enabled: event.target.checked } : row))} />
              <span>启用</span></label>
            <input type="text" aria-label={'工作条件' + (index + 1)} value={item.text} maxLength={500} disabled={disabled}
              onChange={(event) => onChange(conditions.map((row) => row.id === item.id ? { ...row, text: event.target.value, builtin: undefined } : row))} />
            <select aria-label={'处理方式：' + item.text} value={item.policy || 'required'} disabled={disabled}
              onChange={event => onChange(conditions.map(row => row.id === item.id ? { ...row, policy: event.target.value as WorkRequirement['policy'] } : row))}>
              <option value="required">投递前必须确认</option><option value="ask">投递后追问</option><option value="preference">仅作偏好</option>
            </select>
            <button type="button" aria-label={'删除条件：' + item.text} disabled={disabled}
              onClick={() => onChange(conditions.filter((row) => row.id !== item.id))}>删除</button>
          </div>
        ))}
      </div>
      <div className="work-condition-add">
        <input type="text" aria-label="新增工作条件" value={draft} maxLength={500} disabled={disabled || conditions.length >= 20}
          placeholder="例如：不做销售、只接受白班、必须缴纳五险一金"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add(draft); } }} />
        <button type="button" disabled={disabled || conditions.length >= 20 || draft.trim().length < 2} onClick={() => add(draft)}>添加条件</button>
      </div>
      <p>最多20条，每条写一个明确要求。“必须确认”缺少证据时保留待决定；“投递后追问”允许未知条件投递并加入跟进台账；“仅作偏好”不单独阻止投递。必备资格和排除条件仍然生效。自动询问需在“沟通跟进”启用并开始自动跟进。</p>
      <p>简单条件先用本地脚本判断，复杂要求合并交给 AI。也可写文本规则，例如“必须包含：React”或“不得包含：劳务派遣”，按原词是否出现筛选。</p>
      <p>城市、学历、薪资和其他筛选条件仍然生效。招聘描述代表招聘方的说法，实际执行需向招聘方核实。</p>
    </section>
  );
}
