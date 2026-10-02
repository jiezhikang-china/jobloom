import { useState } from 'react';
import { MapPin, Search, X } from 'lucide-react';
import type { CommuteFilter, CommuteOrigin } from './types.js';

export default function LocationFilterOptions({ value = {}, cityName, disabled, onChange }: {
  value?: CommuteFilter; cityName: string; disabled?: boolean; onChange: (next: CommuteFilter) => void;
}) {
  const [query, setQuery] = useState('');
  const [originCity, setOriginCity] = useState(value.origin?.cityName || cityName);
  const [results, setResults] = useState<CommuteOrigin[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const busy = disabled || searching;
  const search = async () => {
    if (busy) return;
    setSearching(true); setError(''); setResults([]);
    try {
      const response = await fetch('/api/location/search', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query.trim(), cityName: originCity.trim() }) });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || '位置查询失败');
      setResults(data.data);
    } catch (cause) { setError((cause as Error).message); }
    finally { setSearching(false); }
  };
  return <section className="location-options" aria-label="位置与通勤筛选">
    <h3><MapPin size={18} /> 位置与通勤</h3>
    <p>以你的出发位置核对岗位实际工作地点，可同时限制直线距离和公交／地铁通勤时间。</p>
    <div className="location-search">
      <label>出发城市<input aria-label="出发城市" value={originCity} maxLength={30} disabled={busy}
        onChange={event => { setOriginCity(event.target.value); setResults([]); }} /></label>
      <label>出发地址、楼宇或地铁站<input aria-label="出发位置搜索" value={query} maxLength={100} disabled={busy}
        placeholder="例如：人民广场地铁站、某小区"
        onChange={event => { setQuery(event.target.value); setResults([]); }}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void search(); } }} /></label>
      <button type="button" disabled={busy || query.trim().length < 2} onClick={() => void search()}><Search size={15} /> {searching ? '定位中…' : '搜索位置'}</button>
    </div>
    {error && <p role="alert" className="work-review-error">{error}</p>}
    {results.length > 0 && <div className="location-results" aria-label="选择出发位置">
      <p>请选择准确地点，同名地铁站和楼宇可能位于不同位置。</p>
      {results.map((place, index) => <button type="button" disabled={busy} key={index} onClick={() => {
        onChange({ ...value, origin: place }); setResults([]); setQuery('');
      }}><strong>{place.name}</strong><span>{place.address || place.cityName}</span></button>)}
    </div>}
    {value.origin ? <div className="location-origin" role="status">
      <MapPin size={17} /><div><strong>出发位置：{value.origin.cityName} · {value.origin.name}</strong>
        <p>{value.origin.address || '已按所选地图位置定位'}</p></div>
      <button type="button" disabled={busy} aria-label="清除出发位置" onClick={() => onChange({ ...value, origin: undefined })}><X size={15} /></button>
    </div> : <p>尚未设置出发位置。开启距离或通勤限制前，请先搜索并选择地点。</p>}
    <div className="location-limits">
      <div><label><input type="checkbox" aria-label="启用直线距离上限" checked={Boolean(value.maxDistanceKm)} disabled={busy}
        onChange={event => onChange({ ...value, maxDistanceKm: event.target.checked ? 15 : 0 })} /> 限制直线距离</label>
        <label className="location-limit-input"><input type="number" aria-label="最大直线距离" min="0" max="200" step="0.5"
          value={value.maxDistanceKm || 0} disabled={busy} onChange={event => onChange({ ...value, maxDistanceKm: Number(event.target.value) })} /> 公里以内</label></div>
      <div><label><input type="checkbox" aria-label="启用公交地铁通勤上限" checked={Boolean(value.maxTransitMinutes)} disabled={busy}
        onChange={event => onChange({ ...value, maxTransitMinutes: event.target.checked ? 60 : 0 })} /> 限制公交／地铁通勤</label>
        <label className="location-limit-input"><input type="number" aria-label="最大公交地铁通勤时间" min="0" max="240" step="1"
          value={value.maxTransitMinutes || 0} disabled={busy} onChange={event => onChange({ ...value, maxTransitMinutes: Number(event.target.value) })} /> 分钟以内</label></div>
    </div>
    <p className="location-help">0 表示不限。距离按同一地图的坐标计算；通勤采用 BOSS 地图可读路线中的最短预计时间，包含路线给出的步行时间，实际等车和交通状况可能变化。没有准确地址或路线的岗位保留待确认。更改后保存筛选规则。</p>
  </section>;
}
