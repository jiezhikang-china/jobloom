import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Search, Check } from 'lucide-react';
import type { BossPositionCatalog, BossPositionSelection } from './types.js';

export function flattenPositions(catalog: BossPositionCatalog): BossPositionSelection[] {
  return catalog.categories.flatMap((category) => category.children.flatMap((subcategory) =>
    subcategory.children.map((position) => ({
      code: position.code, name: position.name,
      categoryCode: category.code, categoryName: category.name,
      subcategoryCode: subcategory.code, subcategoryName: subcategory.name,
    }))));
}

interface Props {
  catalog: BossPositionCatalog | null;
  value?: BossPositionSelection;
  loading: boolean;
  error: string;
  disabled?: boolean;
  onChange: (value: BossPositionSelection | undefined) => void;
  onRefresh: () => void;
}

export default function BossPositionPicker({ catalog, value, loading, error, disabled, onChange, onRefresh }: Props) {
  const [categoryCode, setCategoryCode] = useState(value?.categoryCode || '');
  const [subcategoryCode, setSubcategoryCode] = useState(value?.subcategoryCode || '');
  const [search, setSearch] = useState('');
  const positions = useMemo(() => catalog ? flattenPositions(catalog) : [], [catalog]);
  const category = catalog?.categories.find((item) => item.code === categoryCode);
  const subcategory = category?.children.find((item) => item.code === subcategoryCode);
  const query = search.trim().toLowerCase();
  const matches = query ? positions.filter((item) => `${item.name} ${item.categoryName} ${item.subcategoryName}`.toLowerCase().includes(query)) : [];
  const uniqueMatches = [...new Map(matches.map((item) => [item.code, item])).values()];

  useEffect(() => {
    if (value) {
      setCategoryCode(value.categoryCode);
      setSubcategoryCode(value.subcategoryCode);
    }
  }, [value]);

  const choose = (position: BossPositionSelection) => {
    setCategoryCode(position.categoryCode);
    setSubcategoryCode(position.subcategoryCode);
    setSearch('');
    onChange(position);
  };

  return (
    <div className="position-picker" aria-label="BOSS 官方岗位分类">
      <div className="position-picker-head">
        <strong>目标岗位 <span>必填 · BOSS 官方分类</span></strong>
        <button type="button" onClick={onRefresh} disabled={loading || disabled} title="重新获取 BOSS 官网分类">
          <RefreshCw size={13} className={loading ? 'spin' : ''} /> {loading ? '正在更新' : '更新分类'}
        </button>
      </div>
      <div className="position-search">
        <Search size={16} />
        <input aria-label="搜索官方岗位分类" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索官方岗位，例如前端、Java、产品经理" disabled={disabled || !catalog} />
      </div>
      {query && (
        <div className="position-search-results" role="list" aria-label="分类搜索结果">
          {uniqueMatches.slice(0, 30).map((position) => (
            <button type="button" role="listitem" key={position.code} disabled={disabled} onClick={() => choose(position)}>
              <strong>{position.name}</strong><span>{position.categoryName} / {position.subcategoryName}</span>
            </button>
          ))}
          {uniqueMatches.length === 0 && <p>官方分类中没有对应选项，请尝试其他名称或按层级浏览。</p>}
          {uniqueMatches.length > 30 && <p>共 {uniqueMatches.length} 项，请缩小搜索范围。</p>}
        </div>
      )}
      <div className="position-cascade">
        <label>职位大类
          <select aria-label="职位大类" value={categoryCode} disabled={disabled || !catalog} onChange={(event) => {
            setCategoryCode(event.target.value); setSubcategoryCode(''); onChange(undefined);
          }}>
            <option value="">选择大类</option>
            {catalog?.categories.map((item) => <option value={item.code} key={item.code}>{item.name}</option>)}
          </select>
        </label>
        <label>职位子类
          <select aria-label="职位子类" value={subcategoryCode} disabled={disabled || !category} onChange={(event) => {
            setSubcategoryCode(event.target.value); onChange(undefined);
          }}>
            <option value="">选择子类</option>
            {category?.children.map((item) => <option value={item.code} key={item.code}>{item.name}</option>)}
          </select>
        </label>
        <label>具体岗位
          <select aria-label="具体岗位" value={value?.categoryCode === categoryCode && value?.subcategoryCode === subcategoryCode ? value.code : ''} disabled={disabled || !subcategory} onChange={(event) => {
            const position = positions.find((item) => item.categoryCode === categoryCode && item.subcategoryCode === subcategoryCode && item.code === event.target.value);
            if (position) choose(position); else onChange(undefined);
          }}>
            <option value="">选择岗位</option>
            {subcategory?.children.map((item) => <option value={item.code} key={item.code}>{item.name}</option>)}
          </select>
        </label>
      </div>
      {value && <div className="position-selected"><Check size={15} /><strong>{value.name}</strong><span>{value.categoryName} / {value.subcategoryName}</span></div>}
      <div className="position-meta" role="status">
        {error || catalog?.warning || (catalog ? `${catalog.categories.length} 个大类 · ${catalog.positionCount} 个岗位 · 更新于 ${new Date(catalog.fetchedAt).toLocaleDateString('zh-CN')}` : '正在读取官方分类…')}
      </div>
    </div>
  );
}
