import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

export interface DevicePosition {
  longitude: number; latitude: number; coordinateSystem: 'wgs84'; accuracyMeters?: number; timestamp: string;
}
const execFileAsync = promisify(execFile);
async function readWindowsPosition(): Promise<string> {
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await execFileAsync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.resolve(process.cwd(), 'resources/location-device.ps1')], { windowsHide: true, encoding: 'utf8', timeout: 20000, maxBuffer: 16384 });
  return stdout;
}
export class DeviceLocationService {
  constructor(private read = readWindowsPosition, private platform = process.platform, private now = Date.now) {}
  public async getPosition(): Promise<DevicePosition> {
    if (this.platform !== 'win32') throw new Error('系统定位目前适用于 Windows；可直接搜索地址或在地图选点');
    let data: any;
    try { data = JSON.parse(await this.read()); } catch { throw new Error('Windows 定位未完成，可重试或在地图选点'); }
    if (data?.success !== true) {
      throw new Error(data?.code === 'permission_denied' ? 'Windows 未允许定位，请在系统“位置”设置中开启权限，或直接搜索地址／地图选点'
        : 'Windows 暂未提供当前位置，请检查系统“位置”服务，或直接搜索地址／地图选点');
    }
    const { longitude, latitude, accuracyMeters, timestamp } = data;
    if (typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < 70 || longitude > 140
      || typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude <= 0 || latitude > 60) throw new Error('系统定位不在支持的国内范围内，请手动选择出发位置');
    const time = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
    if (!Number.isFinite(time) || this.now() - time > 5 * 60 * 1000 || time > this.now() + 60000) throw new Error('Windows 返回的位置已过期，请重试或手动选择出发位置');
    return { longitude, latitude, coordinateSystem: 'wgs84', timestamp,
      ...(typeof accuracyMeters === 'number' && Number.isFinite(accuracyMeters) && accuracyMeters > 0 ? { accuracyMeters } : {}) };
  }
}
export const deviceLocationService = new DeviceLocationService();
