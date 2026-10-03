import { decodeBossText } from './boss-text.js';

/** Tracking/query parameters do not identify a job; the encrypted path ID does. */
export function bossJobId(href: string): string {
  try {
    const url = new URL(href, 'https://www.zhipin.com');
    return url.hostname === 'www.zhipin.com'
      ? url.pathname.match(/^\/job_detail\/([a-zA-Z0-9_-]+)\.html$/)?.[1] || '' : '';
  } catch { return ''; }
}
export function sameJobLink(a: string, b: string): boolean {
  const id = bossJobId(a);
  return Boolean(id && id === bossJobId(b));
}
export function normalizedJobName(text: string): string {
  return decodeBossText(text).normalize('NFKC').replace(/\s+/g, '');
}
