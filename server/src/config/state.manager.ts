import fs from 'fs';
import path from 'path';

const STATE_FILE_PATH = path.resolve(process.cwd(), '../data/state.json');

export interface PersistedState {
  quotaDate: string;
  todayAppliedCount: number;
  updatedAt: string;
}

/** 本地自然日 YYYY-MM-DD */
export function todayStr(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export class StateManager {
  /**
   * 读取"今日已投递"计数。跨自然日自动归零，
   * 确保服务常驻跨天时配额能正确重置，重启时也不会凭空清零导致超投。
   */
  public loadQuota(): { date: string; count: number } {
    const today = todayStr();
    try {
      if (fs.existsSync(STATE_FILE_PATH)) {
        const raw = JSON.parse(fs.readFileSync(STATE_FILE_PATH, 'utf-8')) as Partial<PersistedState>;
        if (raw.quotaDate === today && typeof raw.todayAppliedCount === 'number' && raw.todayAppliedCount >= 0) {
          return { date: today, count: Math.floor(raw.todayAppliedCount) };
        }
      }
    } catch (err) {
      console.warn('读取状态文件失败，按 0 计:', err);
    }
    // 跨天或首次运行：新的一天从 0 开始
    return { date: today, count: 0 };
  }

  public saveQuota(date: string, count: number): void {
    try {
      const dir = path.dirname(STATE_FILE_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const state: PersistedState = {
        quotaDate: date,
        todayAppliedCount: count,
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(state, null, 2), 'utf-8');
    } catch (err) {
      console.error('保存状态文件失败:', err);
    }
  }
}

export const stateManager = new StateManager();
