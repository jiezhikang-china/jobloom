import { useEffect, useRef, useState } from 'react';
import { circle, circleMarker, map as createMap, tileLayer } from 'leaflet';
import type { Circle, CircleMarker, Map as LeafletMap } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { CommuteOrigin } from './types.js';

export interface LocationMapPoint { longitude: number; latitude: number; coordinateSystem: 'wgs84'; accuracyMeters?: number; }
// Only an initial viewing area. No centre is saved as the user's origin.
const cityViews: Record<string, [number, number]> = {
  上海: [31.2304, 121.4737], 北京: [39.9042, 116.4074], 广州: [23.1291, 113.2644],
  深圳: [22.5431, 114.0579], 杭州: [30.2741, 120.1551], 成都: [30.5728, 104.0668], 武汉: [30.5928, 114.3055],
};
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export default function LocationMapPicker({ cityName, origin, point, disabled, onSelect }: {
  cityName: string; origin?: CommuteOrigin; point?: LocationMapPoint; disabled?: boolean; onSelect: (point: LocationMapPoint) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const map = useRef<LeafletMap>();
  const marker = useRef<CircleMarker>();
  const accuracy = useRef<Circle>();
  const callback = useRef(onSelect); callback.current = onSelect;
  const blocked = useRef(disabled); blocked.current = disabled;
  const latestPoint = useRef(point); latestPoint.current = point;
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    const setup = async () => {
      const response = await fetch('/api/location/map');
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || '地图配置读取失败');
      if (disposed || !element.current) return;
      const instance = createMap(element.current, { scrollWheelZoom: false, attributionControl: true, zoomControl: true });
      map.current = instance;
      instance.setView(cityViews[cityName.replace(/市$/, '')] || [35, 105], cityViews[cityName.replace(/市$/, '')] ? 12 : 4);
      const tiles = tileLayer(data.data.tileUrl, { maxZoom: 19, updateWhenIdle: true, keepBuffer: 0,
        attribution: '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">' + escapeHtml(data.data.attribution) + '</a>' }).addTo(instance);
      tiles.on('tileerror', () => { if (!disposed) setError('地图图片暂未加载，可重试，或使用地址搜索／手动坐标。'); });
      instance.on('click', event => {
        if (!blocked.current && event.latlng.lng >= 70 && event.latlng.lng <= 140 && event.latlng.lat > 0 && event.latlng.lat <= 60) {
          callback.current({ longitude: event.latlng.lng, latitude: event.latlng.lat, coordinateSystem: 'wgs84' });
        }
      });
      // Existing BOSS / AMap / Baidu locations must be converted before displaying on OSM.
      let initial = latestPoint.current;
      if (!initial && origin) {
        const converted = await fetch('/api/location/map-point', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ point: origin }) });
        const result = await converted.json();
        if (!converted.ok || !result.success) throw new Error(result.message || '原出发点无法在地图核对，请重新选点');
        initial = latestPoint.current || result.data;
      }
      if (initial && !disposed) draw(initial, instance);
    };
    const draw = (position: LocationMapPoint, instance: LeafletMap) => {
      if (marker.current) marker.current.setLatLng([position.latitude, position.longitude]);
      else marker.current = circleMarker([position.latitude, position.longitude], { radius: 9, color: '#fff', weight: 3, fillColor: '#ad4d31', fillOpacity: 1 }).addTo(instance);
      accuracy.current?.remove(); accuracy.current = undefined;
      if (position.accuracyMeters) accuracy.current = circle([position.latitude, position.longitude], { radius: position.accuracyMeters, color: '#ad4d31', weight: 1, fillOpacity: .1 }).addTo(instance);
      instance.setView([position.latitude, position.longitude], position.accuracyMeters && position.accuracyMeters > 2000 ? 12 : 16, { animate: false });
    };
    void setup().catch(cause => { if (!disposed) setError((cause as Error).message); });
    return () => { disposed = true; map.current?.remove(); map.current = undefined; marker.current = undefined; accuracy.current = undefined; };
    // Selecting a point moves the marker in the next effect without rebuilding the map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const instance = map.current;
    if (!instance || !point) return;
    const latLng: [number, number] = [point.latitude, point.longitude];
    if (marker.current) marker.current.setLatLng(latLng);
    else marker.current = circleMarker(latLng, { radius: 9, color: '#fff', weight: 3, fillColor: '#ad4d31', fillOpacity: 1 }).addTo(instance);
    accuracy.current?.remove(); accuracy.current = undefined;
    if (point.accuracyMeters) accuracy.current = circle(latLng, { radius: point.accuracyMeters, color: '#ad4d31', weight: 1, fillOpacity: .1 }).addTo(instance);
    // Pan only when the selected point is outside the viewport, keeping nearby clicks steady.
    if (!instance.getBounds().contains(latLng)) instance.setView(latLng, point.accuracyMeters && point.accuracyMeters > 2000 ? 12 : 16, { animate: false });
  }, [point]);
  return <div className="location-map-wrap">
    <p>点击地图放置出发点，可拖动地图、用左上角按钮缩放。</p>
    <div ref={element} className="location-map" aria-label="出发位置地图" />
    {error && <p role="alert" className="work-review-error">{error}</p>}
  </div>;
}
