import fs from 'node:fs';
import path from 'node:path';
import type { BossPositionCatalog, BossPositionNode, BossPositionSelection } from '../types.js';

// 来自 BOSS 首页加载的 main.js 中 Search.loadPositionData，非猜测的接口。
export const BOSS_POSITION_SOURCE = 'https://www.zhipin.com/wapi/zpCommon/data/getCityShowPosition?cityCode=100010000';
const CACHE_PATH = path.resolve(process.cwd(), '../data/boss-position-catalog.json');
const SNAPSHOT_PATH = path.resolve(__dirname, '../../resources/boss-positions.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function positionSelections(categories: BossPositionNode[]): BossPositionSelection[] {
  return categories.flatMap((category) => category.children.flatMap((subcategory) =>
    subcategory.children.map((position) => ({
      code: position.code, name: position.name,
      categoryCode: category.code, categoryName: category.name,
      subcategoryCode: subcategory.code, subcategoryName: subcategory.name,
    }))));
}

export function parseBossPositionResponse(response: unknown, fetchedAt = new Date().toISOString()): BossPositionCatalog {
  const body = response as any;
  if (body?.code !== 0 || !Array.isArray(body?.zpData?.position)) {
    throw new Error(`BOSS 岗位分类获取失败：${String(body?.message || '返回结构不符').slice(0, 120)}`);
  }
  function node(raw: any, depth: number): BossPositionNode {
    const code = String(raw?.code ?? '');
    const name = String(raw?.name ?? '').trim();
    if (!/^\d{6,8}$/.test(code) || !name) throw new Error('BOSS 岗位分类缺少有效代码或名称');
    const children = raw.subLevelModelList;
    if (depth < 3 && (!Array.isArray(children) || children.length === 0)) throw new Error('BOSS 岗位分类层级不完整');
    if (depth === 3 && Array.isArray(children) && children.length > 0) throw new Error('BOSS 岗位分类层级已变化');
    return { code, name, children: depth < 3 ? children.map((child: unknown) => node(child, depth + 1)) : [] };
  }
  const categories = body.zpData.position.map((raw: unknown) => node(raw, 1));
  const positions = positionSelections(categories);
  if (positions.length === 0) throw new Error('BOSS 返回了空的岗位分类');
  return {
    fetchedAt, sourceUrl: BOSS_POSITION_SOURCE, cityCode: '100010000', categories,
    positionCount: new Set(positions.map((position) => position.code)).size,
  };
}

export class BossCatalogService {
  private cached?: BossPositionCatalog;
  private refreshPromise?: Promise<BossPositionCatalog>;

  constructor(private readonly cachePath = CACHE_PATH, private readonly snapshotPath = SNAPSHOT_PATH) {
    for (const file of [cachePath, snapshotPath]) {
      try {
        const catalog = JSON.parse(fs.readFileSync(file, 'utf8')) as BossPositionCatalog;
        if (catalog.sourceUrl !== BOSS_POSITION_SOURCE || !Number.isFinite(Date.parse(catalog.fetchedAt))) continue;
        // 缓存必须含真实的三级分类；不接受只有名称的旧数据。
        const positions = positionSelections(catalog.categories);
        if (!positions.length || positions.some((item) => !/^\d{6}$/.test(item.code) || !item.name)) continue;
        this.cached = catalog;
        break;
      } catch { /* 无缓存时读取官方接口 */ }
    }
  }

  async getPositions(forceRefresh = false): Promise<BossPositionCatalog> {
    if (!forceRefresh && this.cached && Date.now() - Date.parse(this.cached.fetchedAt) < CACHE_TTL_MS) {
      return { ...this.cached, stale: false };
    }
    if (!this.refreshPromise) {
      this.refreshPromise = this.refresh().finally(() => { this.refreshPromise = undefined; });
    }
    try { return await this.refreshPromise; }
    catch (error) {
      if (!this.cached) throw error;
      return { ...this.cached, stale: true, warning: `更新失败，使用 ${this.cached.fetchedAt.slice(0, 10)} 的官方分类：${(error as Error).message}` };
    }
  }

  private async refresh(): Promise<BossPositionCatalog> {
    const response = await fetch(BOSS_POSITION_SOURCE, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`BOSS 分类接口 HTTP ${response.status}`);
    const catalog = parseBossPositionResponse(await response.json());
    fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
    const temporary = `${this.cachePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(catalog, null, 2), 'utf8');
    fs.renameSync(temporary, this.cachePath);
    this.cached = catalog;
    return { ...catalog, stale: false };
  }

  async findPosition(code: string): Promise<BossPositionSelection | undefined> {
    const catalog = await this.getPositions();
    return positionSelections(catalog.categories).find((position) => position.code === code);
  }
}

export const bossCatalogService = new BossCatalogService();
