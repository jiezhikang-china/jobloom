import { useEffect, useState } from 'react';
import { LocateFixed, MapPin, Map, Search, X } from 'lucide-react';
import type { CommuteFilter, CommuteOrigin } from './types.js';
import LocationMapPicker from './LocationMapPicker.js';
import type { LocationMapPoint } from './LocationMapPicker.js';

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
  const [mapOpen, setMapOpen] = useState(false);
  const [candidate, setCandidate] = useState<LocationMapPoint>();
  const [pointName, setPointName] = useState('出发点');
  const [pointAddress, setPointAddress] = useState('');
  const [oldService, setOldService] = useState(false);
  useEffect(() => {
    let disposed = false;
    void fetch('/health').then(response => response.json()).then(data => {
      if (!disposed && data.app === 'boss-job-agent' && data.integrationVersion < 26) setOldService(true);
    }).catch(() => {});
    return () => { disposed = true; };
  }, []);
  const busy = disabled || searching;
  const getDeviceLocation = async () => {
    if (busy) return;
    setSearching(true); setError('');
    try {
      const response = await fetch('/api/location/device', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userInitiated: true }) });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || '暂时无法获取当前位置，请在地图选点');
      setCandidate(data.data); setPointName('当前位置'); setPointAddress(''); setMapOpen(true);
    } catch (cause) { setError((cause as Error).message); }
    finally { setSearching(false); }
  };
  const saveMapPoint = async () => {
    if (busy || !candidate) return;
    setSearching(true); setError('');
    try {
      const response = await fetch('/api/location/manual', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ position: { ...candidate, name: pointName.trim(), address: pointAddress.trim(), cityName: originCity.trim() } }) });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || '无法使用此出发点');
      onChange({ ...value, origin: data.data }); setCandidate(undefined); setResults([]); setMapOpen(false);
    } catch (cause) { setError((cause as Error).message); }
    finally { setSearching(false); }
  };
  const search = async () => {
    if (busy || oldService) return;
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
  const setManualOrigin = async () => {
    if (busy) return;
    setSearching(true); setError('');
    try {
      const response = await fetch('/api/location/manual', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ position: { name: manualName.trim(), address: manualAddress.trim(), cityName: originCity.trim(),
          longitude: Number(longitude), latitude: Number(latitude), coordinateSystem } }) });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || '无法保存出发位置');
      onChange({ ...value, origin: data.data }); setResults([]); setCandidate(undefined); setMapOpen(false);
    } catch (cause) { setError((cause as Error).message); }
    finally { setSearching(false); }
  };
  return <section className="location-options" aria-label="位置与通勤筛选">
    <h3><MapPin size={18} /> 位置与通勤</h3>
    <p>以你的出发位置核对岗位实际工作地点，可同时限制直线距离和公交／地铁通勤时间。</p>
    {oldService && <p role="status" className="location-upgrade">定位功能已更新。当前后台仍是上一版，请结束投递后关闭并重新打开桌面窗口，启用自动定位与地图选点。</p>}
    <div className="location-actions">
      <button type="button" disabled={busy || oldService} onClick={() => void getDeviceLocation()}><LocateFixed size={16} /> {searching ? '正在获取…' : '获取当前位置'}</button>
      <button type="button" disabled={busy || oldService} onClick={() => { setMapOpen(!mapOpen); setError(''); }}><Map size={16} /> {mapOpen ? '收起地图' : '地图选点'}</button>
      <span>无需申请地图 Key</span>
    </div>
    <p className="location-help">获取当前位置会调用 Windows 系统定位。地图由 Leaflet / OpenStreetMap 提供；选点坐标在本机转换和保存。
      <a href="https://osmfoundation.org/wiki/Privacy_Policy" target="_blank" rel="noreferrer">公共地图隐私政策</a></p>
    {mapOpen && <LocationMapPicker cityName={originCity} origin={value.origin} point={candidate} disabled={busy} onSelect={point => {
      setCandidate(point); setPointName('出发点'); setPointAddress(''); setError('');
    }} />}
    {candidate && <div className="location-point-confirm" aria-label="确认地图出发点">
      <p>{candidate.accuracyMeters ? `系统返回的精度范围约 ${Math.ceil(candidate.accuracyMeters)} 米，请核对地图标记。` : '请核对地图标记；在地图点击可以调整位置。'}</p>
      <div className="location-manual-fields">
        <label>位置名称<input aria-label="地图位置名称" disabled={busy} maxLength={150} value={pointName} onChange={event => setPointName(event.target.value)} /></label>
        <label>地点说明（可选）<input aria-label="地图地点说明" disabled={busy} maxLength={300} value={pointAddress} placeholder="例如：某地铁站出口" onChange={event => setPointAddress(event.target.value)} /></label>
        <button type="button" disabled={busy || !pointName.trim() || originCity.trim().length < 2} onClick={() => void saveMapPoint()}>使用此出发点</button>
        <button type="button" disabled={busy} onClick={() => { setCandidate(undefined); setMapOpen(false); }}>取消选点</button>
      </div>
      <p className="location-help">出发城市：{originCity}，请核对下方城市填写是否正确。确认后保存筛选规则。</p>
    </div>}
    <div className="location-search">
      <label>出发城市<input aria-label="出发城市" value={originCity} maxLength={30} disabled={busy}
        onChange={event => { setOriginCity(event.target.value); setResults([]); }} /></label>
      <label>出发地址、楼宇或地铁站<input aria-label="出发位置搜索" value={query} maxLength={100} disabled={busy}
        placeholder="例如：人民广场地铁站、某小区"
        onChange={event => { setQuery(event.target.value); setResults([]); }}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void search(); } }} /></label>
      <button type="button" disabled={busy || oldService || query.trim().length < 2} onClick={() => void search()}><Search size={15} /> {searching ? '查询中…' : '搜索位置'}</button>
    </div>
    <p className="location-help">公共地址搜索使用 Nominatim，仅点击时查询，限速并缓存，不做输入联想。适合地铁站、楼宇等公开地点，住处可直接在地图选点。
      <a href="https://operations.osmfoundation.org/policies/nominatim/" target="_blank" rel="noreferrer">服务使用规定</a> · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a></p>
    {error && <p role="alert" className="work-review-error">{error}</p>}
    {results.length > 0 && <div className="location-results" aria-label="选择出发位置">
      <p>请选择准确地点，同名地铁站和楼宇可能位于不同位置。</p>
      {results.map((place, index) => <button type="button" disabled={busy} key={index} onClick={() => {
        onChange({ ...value, origin: place }); setResults([]); setQuery(''); setCandidate(undefined); setMapOpen(false);
      }}><strong>{place.name}</strong><span>{place.address || place.cityName}</span></button>)}
    </div>}
    <details className="location-manual"><summary>手动填写经纬度</summary>
      <p className="location-help">也可填写已有坐标。请选择正确坐标系，先填写上方的出发城市；坐标转换在本机完成。</p>
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
    </details>
    {value.origin ? <div className="location-origin" role="status">
      <MapPin size={17} /><div><strong>出发位置：{value.origin.cityName} · {value.origin.name}</strong>
        <p>{value.origin.address || '已按所选地图位置定位'}</p>
        <p className="location-help">经度 {value.origin.longitude.toFixed(6)} · 纬度 {value.origin.latitude.toFixed(6)} · {value.origin.coordinateSystem.toUpperCase()}</p></div>
      <button type="button" disabled={busy} aria-label="清除出发位置" onClick={() => { onChange({ ...value, origin: undefined }); setMapOpen(false); setCandidate(undefined); }}><X size={15} /></button>
    </div> : <p>尚未设置出发位置。可获取当前位置、地图选点，或搜索地点。</p>}
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
    <p className="location-help">0 表示不限。距离会统一坐标系后计算；公交／地铁读取 BOSS 的较快预计方案，包含路线给出的步行时间。没有准确地址或路线的岗位保留待确认。更改后保存筛选规则。</p>
  </section>;
}
