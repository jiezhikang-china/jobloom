import { decodeBossText } from './boss-text.js';

/** Tracking/query parameters do not identify a job; the encrypted path ID does. */
export function canonicalBossJobHref(href: string): string {
  const url = new URL(href, 'https://www.zhipin.com');
  // BOSS encrypted job IDs can end in '~'; tracking parameters are not part of identity.
  if (url.origin !== 'https://www.zhipin.com' || url.username || url.password
    || !/^\/job_detail\/[a-zA-Z0-9_~-]+\.html$/.test(url.pathname)) throw new Error('请使用有效的 BOSS 职位详情链接');
  return url.origin + url.pathname;
}
export function bossJobId(href: string): string {
  try {
    return new URL(canonicalBossJobHref(href)).pathname.slice('/job_detail/'.length, -'.html'.length);
  } catch { return ''; }
}
export function sameJobLink(a: string, b: string): boolean {
  const id = bossJobId(a);
  return Boolean(id && id === bossJobId(b));
}
export function normalizedJobName(text: string): string {
  return decodeBossText(text).normalize('NFKC').replace(/\s+/g, '');
}
