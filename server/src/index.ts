import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { apiRouter } from './routes/api.router.js';
import { browserService } from './services/browser.service.js';
import { deepseekProxyService } from './services/deepseek.proxy.service.js';
import { desktopAuth } from './desktop-auth.js';
import { deliveryService } from './services/delivery.service.js';
import { followupService } from './services/followup.service.js';

const app = express();
const PORT = Number(process.env.PORT) || 3001;
// 默认只监听本机回环地址：该服务持有大模型密钥与会话 Cookie，且接口无鉴权，
// 暴露到局域网等于把凭据交出去（实测原版监听 :::3001 且 CORS 为 *）。
// 确需局域网访问时，用 HOST=0.0.0.0 显式开启。
const HOST = process.env.HOST || '127.0.0.1';

// 仅放行本机来源（页面与 API 同源部署时本就不需要跨域，这里只服务 vite dev 5173）
app.use(
  cors({
    origin: [/^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/],
  })
);
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// 挂载 API
app.use('/api', desktopAuth(process.env.BOSS_DESKTOP_TOKEN), apiRouter);

// 未匹配的 /api 路由必须返回 JSON 404，不能被下面的 SPA fallback 吞成 200 + HTML
app.use('/api', (_req, res) => {
  res.status(404).json({ success: false, message: 'API 路径不存在' });
});

// 健康检查
app.get('/health', (_req, res) => {
  res.json({ app: 'jobloom', integrationVersion: 34, desktopManaged: !!process.env.BOSS_DESKTOP_TOKEN, status: 'ok', timestamp: new Date().toISOString() });
});

// 静态托管前端生产页面 (开箱即用)
const clientDistPath = path.resolve(process.cwd(), '../client/dist');
if (fs.existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDistPath, 'index.html'));
  });
}

const server = app.listen(PORT, HOST, () => {
  console.log(`====================================================`);
  console.log(`🚀 Jobloom 后端服务已成功启动！`);
  console.log(`📡 服务地址: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`📄 健康检查: http://localhost:${PORT}/health`);
  console.log(`🔒 监听地址: ${HOST}（如需局域网访问请设置环境变量 HOST=0.0.0.0）`);
  console.log(`====================================================`);
});

// 兜底保险：任何遗漏的 Promise 拒绝都不应该带走整个服务（会中断正在跑的投递批次）
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ 未处理的 Promise 拒绝:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️ 未捕获异常:', err);
});

// 优雅停机守护
let isShuttingDown = false;
const cleanup = async (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  deliveryService.stop();
  followupService.stop();
  console.log(`\n收到 ${signal}，正在优雅关闭服务与释放浏览器资源...`);
  try {
    await browserService.close();
  } catch (err) {
    console.error('关闭浏览器失败:', err);
  }
  try { await deepseekProxyService.stopIfIdle(); } catch { console.warn('DeepSeek 服务保持运行，可在下次启动复用'); }
  server.close(() => {
    console.log('✅ 服务已安全关闭');
    process.exit(0);
  });
  // 兜底：5 秒内未正常退出则强制结束
  setTimeout(() => process.exit(0), 5000).unref();
};

process.on('SIGINT', () => void cleanup('SIGINT'));
process.on('SIGTERM', () => void cleanup('SIGTERM'));
// If the owning Electron process crashes, its worker must not keep sending in the background.
if (process.env.BOSS_DESKTOP_TOKEN && process.connected) {
  process.on('disconnect', () => void cleanup('DESKTOP_DISCONNECT'));
}
