const fs = require('node:fs/promises');
const path = require('node:path');

const APP_ORIGIN = 'boss-app://desktop';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'";

function isAppUrl(value) {
  try { const url = new URL(value); return url.protocol === 'boss-app:' && url.host === 'desktop' && !url.username && !url.password; } catch { return false; }
}

/** The renderer loads bundled assets; only this main-process adapter knows the worker address/token. */
function createAppProtocol({ clientDir, getService, fetchService = fetch }) {
  const root = path.resolve(clientDir);
  return async request => {
    if (!isAppUrl(request.url)) return new Response('Forbidden', { status: 403 });
    const url = new URL(request.url);
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { return new Response('Bad path', { status: 400 }); }
    if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').includes('..')) return new Response('Forbidden', { status: 403 });
    try {
      if (pathname === '/health' || pathname.startsWith('/api/')) {
        const service = getService();
        if (!service?.url || !service?.token) return Response.json({ success: false, message: '桌面服务尚未就绪' }, { status: 503 });
        if (!['GET', 'HEAD', 'POST', 'DELETE', 'PUT', 'PATCH'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
        // Preserve multipart boundaries but never pass renderer-controlled host/auth/origin headers.
        const headers = new Headers({ 'x-boss-desktop-token': service.token });
        for (const key of ['content-type', 'accept', 'last-event-id', 'range']) {
          const value = request.headers.get(key); if (value) headers.set(key, value);
        }
        const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();
        const upstream = await fetchService(service.url + url.pathname + url.search, {
          method: request.method, headers, body, signal: request.signal, redirect: 'error',
        });
        // Keep streams live for SSE logs, binary previews and PDF downloads.
        const responseHeaders = new Headers(upstream.headers);
        for (const key of ['set-cookie', 'access-control-allow-origin', 'content-encoding', 'content-length']) responseHeaders.delete(key);
        responseHeaders.set('Content-Security-Policy', CSP);
        return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
      }
      if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
      const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(root + path.sep)) return new Response('Forbidden', { status: 403 });
      const bytes = await fs.readFile(file);
      return new Response(request.method === 'HEAD' ? null : bytes, { headers: {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Security-Policy': CSP,
        'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache',
      } });
    } catch (error) {
      if (error.code === 'ENOENT') return new Response('Not found', { status: 404 });
      return Response.json({ success: false, message: '桌面服务连接中断，请重新打开工作台' }, { status: 502 });
    }
  };
}
module.exports = { APP_ORIGIN, isAppUrl, createAppProtocol };
