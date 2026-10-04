import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

/** Desktop worker credentials stay between Electron main and its child process. */
export function desktopAuth(token: string | undefined): RequestHandler {
  return (req, res, next) => {
    if (!token) { next(); return; }
    const actual = Buffer.from(req.get('x-boss-desktop-token') || '');
    const expected = Buffer.from(token);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      res.status(401).json({ success: false, message: '请通过 Electron 工作台访问桌面服务' }); return;
    }
    next();
  };
}
