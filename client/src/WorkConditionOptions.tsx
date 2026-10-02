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
        <div><h3>你想要的工作条件</h3><p>可添加、修改、启用或删除。启用的条件全部有明确依据，才允许自动投递。</p></div>
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
      <p>最多20条，每条写一个明确要求。缺少依据或描述冲突时留待确认；预设文字也可修改。</p>
      <p>简单条件先用本地脚本判断，复杂要求合并交给 AI。也可写文本规则，例如“必须包含：React”或“不得包含：劳务派遣”，按原词是否出现筛选。</p>
      <p>城市、学历、薪资和其他筛选条件仍然生效。招聘描述代表招聘方的说法，实际执行需向招聘方核实。</p>
    </section>
  );
}
