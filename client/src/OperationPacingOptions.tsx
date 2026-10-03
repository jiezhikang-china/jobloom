import type { AppConfig } from './types.js';

export default function OperationPacingOptions({ value, onChange }: {
  value: AppConfig['delivery']; onChange: (next: AppConfig['delivery']) => void;
}) {
  const fields = [
    { key: 'operationIntervalSeconds', label: '页面操作最少间隔（秒）', fallback: 2, min: 1, max: 10 },
    { key: 'operationBurstLimit', label: '连续操作后休息（次数）', fallback: 20, min: 5, max: 100 },
    { key: 'operationRestSeconds', label: '每次短休息（秒）', fallback: 20, min: 5, max: 300 },
    { key: 'feedbackIntervalSeconds', label: '反馈与保存最少间隔（秒）', fallback: 15, min: 10, max: 120 },
    { key: 'operationMaxPerMinute', label: '每分钟最多操作数', fallback: 12, min: 1, max: 30 },
    { key: 'operationMaxPerHour', label: '每小时最多操作数', fallback: 240, min: 30, max: 1000 },
    { key: 'writeMaxPerHour', label: '每小时最多沟通、反馈和保存数', fallback: 10, min: 1, max: 30 },
  ] as const;
  return <section className="operation-pacing" aria-label="网页操作频率">
    <h3>网页操作频率</h3>
    <p>所有 BOSS 页面共用间隔与滚动额度，包括详情、公司页、滚动、地图、输入和反馈。限频、验证或账号限制后停止操作，需要人工确认恢复。</p>
    <div className="operation-pacing-fields">{fields.map(field => <label key={field.key}>{field.label}
      <input aria-label={field.label} type="number" step="1" min={field.min} max={field.max}
        value={value[field.key] ?? field.fallback} onChange={event => onChange({ ...value,
          [field.key]: Math.max(field.min, Math.min(field.max, Number(event.target.value) || field.fallback)) })} />
    </label>)}</div>
    <p>“继续沟通”确认会及时点击。以上是可调整的操作节奏，不是平台公布的安全阈值。</p>
  </section>;
}
