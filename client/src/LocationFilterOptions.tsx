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
  const [manualName, setManualName] = useState('');
  const [manualAddress, setManualAddress] = useState('');
  const [longitude, setLongitude] = useState('');
  const [latitude, setLatitude] = useState('');
  const [coordinateSystem, setCoordinateSystem] = useState('gcj02');
  const locationApi = value.locationApi || { provider: 'boss' as const };
  const busy = disabled || searching;
  const search = async () => {
    if (busy) return;
    setSearching(true); setError(''); setResults([]);
    try {
      const response = await fetch('/api/location/search', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query.trim(), cityName: originCity.trim(), locationApi }) });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || '位置查询失败');
      setResults(data.data);
    } catch (cause) { setError((cause as Error).message); }
    finally { setSearching(false); }
  };
  const setManualOrigin = async () => {
    if (busy) return;
    setSearching(true); setError('');
    try {
      const response = await fetch('/api/location/manual', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locationApi, position: { name: manualName.trim(), address: manualAddress.trim(), cityName: originCity.trim(),
          longitude: Number(longitude), latitude: Number(latitude), coordinateSystem } }) });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || '无法保存出发位置');
      onChange({ ...value, origin: data.data }); setResults([]);
    } catch (cause) { setError((cause as Error).message); }
    finally { setSearching(false); }
  };
  return <section className="location-options" aria-label="位置与通勤筛选">
    <h3><MapPin size={18} /> 位置与通勤</h3>
    <p>以你的出发位置核对岗位实际工作地点，可同时限制直线距离和公交／地铁通勤时间。</p>
    <div className="location-api-config">
      <label>位置与路线来源<select aria-label="定位接口来源" disabled={busy} value={locationApi.provider} onChange={event => {
        onChange({ ...value, locationApi: { provider: event.target.value as 'boss' | 'amap' | 'baidu', apiKey: '' } });
        setResults([]); setError('');
      }}><option value="boss">BOSS 内置地图</option><option value="amap">高德地图 API</option><option value="baidu">百度地图 API</option></select></label>
      {locationApi.provider !== 'boss' && <label>{locationApi.provider === 'amap' ? '高德 Web 服务 Key' : '百度 Web 服务 AK'}
        <input type="password" aria-label="地图 API Key" autoComplete="off" disabled={busy} maxLength={512} value={locationApi.apiKey || ''}
          placeholder="填写你自己的 Key" onChange={event => onChange({ ...value, locationApi: { ...locationApi, apiKey: event.target.value.trim() } })} /></label>}
    </div>
    {locationApi.provider !== 'boss' && <p className="location-help">点击搜索时使用你填写的地图 API，无需打开 BOSS。
      <a href={locationApi.provider === 'amap' ? 'https://console.amap.com/dev/key/app' : 'https://lbsyun.baidu.com/apiconsole/key#/home'} target="_blank" rel="noreferrer">管理自己的地图 Key</a>。
      保存筛选规则后，通勤查询也使用所选接口，并缓存路线结果。</p>}
    <div className="location-search">
      <label>出发城市<input aria-label="出发城市" value={originCity} maxLength={30} disabled={busy}
        onChange={event => { setOriginCity(event.target.value); setResults([]); }} /></label>
      <label>出发地址、楼宇或地铁站<input aria-label="出发位置搜索" value={query} maxLength={100} disabled={busy}
        placeholder="例如：人民广场地铁站、某小区"
        onChange={event => { setQuery(event.target.value); setResults([]); }}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void search(); } }} /></label>
      <button type="button" disabled={busy || query.trim().length < 2 || (locationApi.provider !== 'boss' && !locationApi.apiKey?.trim())} onClick={() => void search()}><Search size={15} /> {searching ? '定位中…' : '搜索位置'}</button>
    </div>
    {error && <p role="alert" className="work-review-error">{error}</p>}
    {results.length > 0 && <div className="location-results" aria-label="选择出发位置">
      <p>请选择准确地点，同名地铁站和楼宇可能位于不同位置。</p>
      {results.map((place, index) => <button type="button" disabled={busy} key={index} onClick={() => {
        onChange({ ...value, origin: place }); setResults([]); setQuery('');
      }}><strong>{place.name}</strong><span>{place.address || place.cityName}</span></button>)}
    </div>}
    <details className="location-manual"><summary>手动填写经纬度</summary>
      <p className="location-help">可从自己的地图或定位 API 复制坐标。请按来源选择坐标系，先填写上方的出发城市。</p>
      <div className="location-manual-fields">
        <label>位置名称<input aria-label="手动位置名称" maxLength={150} disabled={busy} value={manualName} placeholder="例如：住处、某地铁站" onChange={event => setManualName(event.target.value)} /></label>
        <label>地址说明<input aria-label="手动位置地址" maxLength={300} disabled={busy} value={manualAddress} onChange={event => setManualAddress(event.target.value)} /></label>
        <label>经度<input aria-label="手动经度" type="number" min="70" max="140" step="any" disabled={busy} value={longitude} onChange={event => setLongitude(event.target.value)} /></label>
        <label>纬度<input aria-label="手动纬度" type="number" min="0" max="60" step="any" disabled={busy} value={latitude} onChange={event => setLatitude(event.target.value)} /></label>
        <label>坐标来源<select aria-label="手动坐标系" disabled={busy} value={coordinateSystem} onChange={event => setCoordinateSystem(event.target.value)}>
          <option value="gcj02">高德 / 腾讯（GCJ02）</option><option value="bd09">百度（BD09）</option><option value="wgs84">设备 GPS（WGS84）</option></select></label>
        <button type="button" disabled={busy || !manualName.trim() || !longitude || !latitude || originCity.trim().length < 2}
          onClick={() => void setManualOrigin()}>使用这组坐标</button>
      </div>
      {coordinateSystem === 'wgs84' && <p className="location-help">GPS 坐标通过你选择的高德或百度 API 转换，请填写对应 Key。</p>}
    </details>
    {value.origin ? <div className="location-origin" role="status">
      <MapPin size={17} /><div><strong>出发位置：{value.origin.cityName} · {value.origin.name}</strong>
        <p>{value.origin.address || '已按所选地图位置定位'}</p>
        <p className="location-help">经度 {value.origin.longitude.toFixed(6)} · 纬度 {value.origin.latitude.toFixed(6)} · {value.origin.coordinateSystem.toUpperCase()}</p></div>
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
    <p className="location-help">0 表示不限。距离会统一坐标系后计算；公交／地铁采用所选地图的较快预计方案，包含路线给出的步行时间，实际等车和交通状况可能变化。没有准确地址或路线的岗位保留待确认。更改后保存筛选规则。</p>
  </section>;
}
