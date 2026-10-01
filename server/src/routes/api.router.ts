import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { configManager, FREE_MODEL_PRESETS } from '../config/config.manager.js';
import { resumeService } from '../services/resume.service.js';
import { browserService } from '../services/browser.service.js';
import { bossPageService } from '../services/boss.page.service.js';
import { deliveryService } from '../services/delivery.service.js';
import { llmService } from '../services/llm.service.js';
import { bossCatalogService } from '../services/boss.catalog.service.js';
import { deepseekProxyService } from '../services/deepseek.proxy.service.js';
import { workConditionReviews } from '../services/work-condition-reviews.js';
import { configuredWorkRequirements, validateWorkRequirements } from '../services/work-requirements.js';

const uploadDir = path.resolve(process.cwd(), '../data/resumes');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10MB
const ALLOWED_EXTENSIONS = ['.pdf', '.docx', '.doc', '.txt', '.md'];

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const safeExt = ALLOWED_EXTENSIONS.includes(ext) ? ext : '.bin';
    cb(null, `resume_${Date.now()}${safeExt}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      cb(new Error(`不支持的文件格式: ${ext || '未知'}，仅支持 ${ALLOWED_EXTENSIONS.join(', ')}`));
      return;
    }
    cb(null, true);
  },
});

export const apiRouter = Router();

// 1. 配置与官方免费预设相关接口
apiRouter.get('/config', (_req: Request, res: Response) => {
  res.json({ success: true, data: configManager.getConfig() });
});

apiRouter.post('/config', (req: Request, res: Response) => {
  if (req.body?.filter?.workRequirements !== undefined && !validateWorkRequirements(req.body.filter.workRequirements)) {
    return res.status(400).json({ success: false, message: '工作条件最多20条，每条需2至500字，且不能有重复标识。' });
  }
  const updated = configManager.updateConfig(req.body || {});
  res.json({ success: true, data: updated });
});

apiRouter.get('/presets', (_req: Request, res: Response) => {
  res.json({ success: true, data: FREE_MODEL_PRESETS });
});

apiRouter.get('/boss/positions', async (req: Request, res: Response) => {
  try {
    const catalog = await bossCatalogService.getPositions(req.query.refresh === '1');
    res.json({ success: true, data: catalog });
  } catch (error) {
    res.status(502).json({ success: false, message: (error as Error).message });
  }
});

apiRouter.post('/llm/test', async (req: Request, res: Response) => {
  try {
    if (!req.body?.llm || typeof req.body.llm !== 'object') {
      return res.status(400).json({ success: false, message: '缺少模型设置' });
    }
    const updated = configManager.updateConfig({ llm: req.body.llm });
    const started = Date.now();
    const result = await llmService.chatJson<{ ok: boolean }>([
      { role: 'user', content: '请返回 JSON 对象 {"ok":true}。' },
    ], 1);
    if (result.ok !== true) throw new Error('模型未返回预期的 JSON 测试结果');
    const elapsedMs = Date.now() - started;
    res.json({ success: true, message: `${updated.llm.model} JSON 调用成功（${(elapsedMs / 1000).toFixed(1)} 秒）`, data: { model: updated.llm.model, elapsedMs } });
  } catch (err: any) {
    res.status(502).json({ success: false, message: err.message || '模型连接失败' });
  }
});

apiRouter.use('/llm/web', (req: Request, res: Response, next) => {
  const origin = req.get('Origin');
  if (origin) {
    try {
      if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)) throw new Error('origin');
    } catch { res.status(403).json({ success: false, message: '网页登录管理仅供本机窗口使用' }); return; }
  }
  next();
});
apiRouter.get('/llm/web/status', async (req: Request, res: Response) => {
  try { res.json({ success: true, data: await deepseekProxyService.status(req.query.refresh === '1') }); }
  catch (error) { res.status(503).json({ success: false, message: (error as Error).message }); }
});
apiRouter.post('/llm/web/login', async (_req: Request, res: Response) => {
  try { res.json({ success: true, data: await deepseekProxyService.login() }); }
  catch (error) { res.status(503).json({ success: false, message: (error as Error).message }); }
});
apiRouter.post('/llm/web/token', async (req: Request, res: Response) => {
  if (typeof req.body?.token !== 'string') return res.status(400).json({ success: false, message: '请输入网页登录凭据' });
  try { res.json({ success: true, data: await deepseekProxyService.importToken(req.body.token) }); }
  catch (error) { res.status(502).json({ success: false, message: (error as Error).message }); }
});
apiRouter.post('/llm/web/logout', async (_req: Request, res: Response) => {
  try { res.json({ success: true, data: await deepseekProxyService.logout() }); }
  catch (error) { res.status(409).json({ success: false, message: (error as Error).message }); }
});
apiRouter.post('/llm/web/stop', async (_req: Request, res: Response) => {
  try { await deepseekProxyService.stopIfIdle(); res.json({ success: true }); }
  catch (error) { res.status(503).json({ success: false, message: (error as Error).message }); }
});

// 2. 简历上传与提取接口
apiRouter.post('/resume/upload', (req: Request, res: Response) => {
  upload.single('file')(req, res, async (uploadErr: any) => {
    if (uploadErr) {
      return res.status(400).json({ success: false, message: uploadErr.message || '文件上传失败' });
    }
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, message: '请选择要上传的简历文件' });
      }
      const extractedText = await resumeService.extractTextFromFile(req.file.path);
      res.json({
        success: true,
        data: {
          fileName: req.file.originalname,
          savedPath: req.file.path,
          text: extractedText,
        },
      });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });
});

// 3. 简历诊断与职业推荐
apiRouter.post('/resume/diagnose', async (req: Request, res: Response) => {
  try {
    const { resumeText } = req.body || {};
    if (!resumeText || typeof resumeText !== 'string') {
      return res.status(400).json({ success: false, message: '缺少简历文本' });
    }
    const diagnosis = await resumeService.diagnoseResume(resumeText);
    res.json({ success: true, data: diagnosis });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 4. 针对目标职业重写简历
apiRouter.post('/resume/rewrite', async (req: Request, res: Response) => {
  try {
    const { resumeText, targetRole } = req.body || {};
    if (!resumeText || !targetRole) {
      return res.status(400).json({ success: false, message: '缺少简历文本或目标岗位名称' });
    }
    const rewritten = await resumeService.rewriteForTargetRole(resumeText, targetRole);
    res.json({ success: true, data: rewritten });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 5. 浏览器与登录状态
apiRouter.get('/browser/status', async (_req: Request, res: Response) => {
  try {
    const status = await browserService.checkLoginStatus();
    res.json({ success: true, data: status });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 读取当前职位页的可见状态，便于定位加载问题；不启动投递或触发沟通。
apiRouter.get('/browser/page-state', async (_req: Request, res: Response) => {
  try {
    const status = await browserService.checkLoginStatus();
    if (!status.isBrowserActive) return res.status(503).json({ success: false, message: status.reason || 'BOSS 浏览器未连接' });
    const state = await bossPageService.inspectPage(await browserService.getWorkerPage());
    res.json({ success: true, data: state });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

apiRouter.post('/browser/login', async (_req: Request, res: Response) => {
  try {
    await browserService.promptLogin();
    res.json({ success: true, message: '登录页面已打开，请在 Chrome 中扫码，然后点击“验证登录”' });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

apiRouter.post('/browser/verify', async (_req: Request, res: Response) => {
  try {
    const status = await browserService.verifyLogin();
    res.json({ success: status.isLoggedIn, data: status, message: status.isLoggedIn ? '登录已确认' : status.reason });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 6. 投递任务控制
apiRouter.post('/delivery/start', async (req: Request, res: Response) => {
  try {
    let { targetRole } = req.body || {};
    const { keywords, resumeText, requirementsText, defaultGreeting } = req.body || {};
    const positionCode = typeof req.body?.positionCode === 'string' ? req.body.positionCode.trim() : '';
    const mode = req.body?.mode === 'manual' ? 'manual' : 'resume';
    const conditionsOnly = req.body?.conditionsOnly === true && mode === 'manual';
    const candidateText = mode === 'manual' ? requirementsText : resumeText;
    const keywordList: string[] = Array.isArray(keywords)
      ? keywords.map((k: unknown) => String(k ?? '').trim()).filter(Boolean)
      : [];

    if (!targetRole || typeof targetRole !== 'string') {
      return res.status(400).json({ success: false, message: '请指定目标职业' });
    }
    if (positionCode) {
      const position = await bossCatalogService.findPosition(positionCode);
      if (!position) return res.status(400).json({ success: false, message: '所选岗位不在 BOSS 官方分类中，请重新选择' });
      targetRole = position.name;
    }
    if (conditionsOnly && !configuredWorkRequirements(configManager.getConfig().filter).length) {
      return res.status(400).json({ success: false, message: '请至少启用一条工作条件' });
    }
    if (keywordList.length === 0) keywordList.push(conditionsOnly || positionCode ? '' : targetRole.trim());
    if (typeof candidateText !== 'string' || candidateText.trim().length < (mode === 'manual' ? 10 : 50)) {
      return res.status(400).json({ success: false, message: mode === 'manual' ? '请填写至少 10 个字的目标岗位要求' : '简历内容不足，无法进行岗位匹配评估' });
    }
    let login = await browserService.checkLoginStatus();
    if (!login.isLoggedIn && login.reasonCode === 'unverified') login = await browserService.verifyLogin();
    if (!login.isLoggedIn) {
      return res.status(login.reasonCode === 'login_required' ? 401 : 503).json({ success: false, message: login.reason || '无法确认 BOSS 登录状态', reasonCode: login.reasonCode });
    }

    // 同步前置检查：任务在跑时直接返回 409，而不是抛错（避免未处理的 Promise 拒绝）
    if (deliveryService.isActive()) {
      return res.status(409).json({ success: false, message: '投递任务已在运行中，请先停止当前任务' });
    }

    // 异步执行投递任务，不阻塞 HTTP 响应；必须接管 promise，否则一次异常会带走整个进程
    deliveryService
      .startDelivery({
        targetRole,
        positionCode: positionCode || undefined,
        keywords: keywordList,
        resumeText: candidateText.trim(),
        defaultGreeting: typeof defaultGreeting === 'string' ? defaultGreeting : undefined,
        candidateSource: mode === 'manual' ? 'requirements' : 'resume',
      })
      .catch((err: unknown) => {
        deliveryService.log('error', `投递任务异常终止: ${(err as Error).message}`);
      });

    res.json({ success: true, message: '投递任务已启动' });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

apiRouter.post('/delivery/pause', (_req: Request, res: Response) => {
  if (deliveryService.getStats().status !== 'running') {
    return res.status(409).json({ success: false, message: '当前任务不在运行状态' });
  }
  deliveryService.pause();
  res.json({ success: true, message: '已暂停' });
});

apiRouter.post('/delivery/resume', async (_req: Request, res: Response) => {
  const stats = deliveryService.getStats();
  if (stats.status !== 'paused') {
    return res.status(409).json({ success: false, message: '当前任务未暂停' });
  }
  if (stats.needsCaptchaVerification && await browserService.checkCaptcha()) {
    return res.status(409).json({ success: false, message: '请先在 Chrome 中完成人工验证' });
  }
  deliveryService.resume();
  res.json({ success: true, message: '已恢复' });
});

apiRouter.post('/delivery/stop', (_req: Request, res: Response) => {
  deliveryService.stop();
  res.json({ success: true, message: '已停止' });
});

apiRouter.get('/delivery/status', (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      stats: deliveryService.getStats(),
      logs: deliveryService.getLogs(),
    },
  });
});

// 7. SSE 实时事件流
apiRouter.get('/delivery/work-condition-reviews', (_req: Request, res: Response) => {
  try { res.json({ success: true, data: workConditionReviews.list() }); }
  catch { res.status(500).json({ success: false, message: '读取待确认岗位失败，原文件已保留。' }); }
});

apiRouter.delete('/delivery/work-condition-reviews/:id', (req: Request, res: Response) => {
  try { workConditionReviews.remove(req.params.id); res.json({ success: true }); }
  catch { res.status(400).json({ success: false, message: '移除待确认记录失败，请刷新后重试。' }); }
});

apiRouter.get('/delivery/events', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // 首次连接先发送当前最新全量状态
  res.write(
    `data: ${JSON.stringify({ type: 'init', stats: deliveryService.getStats(), logs: deliveryService.getLogs().slice(0, 50) })}\n\n`
  );

  // 监听并流式推送
  const unsubscribe = deliveryService.subscribe((stats, log) => {
    try {
      res.write(`data: ${JSON.stringify({ type: 'update', stats, log })}\n\n`);
    } catch {}
  });

  // 心跳保活：贤者时间（2~3 分钟）与冷却（15 分钟）期间长时间无数据，避免连接被中间层判定为空闲断开
  const heartbeat = setInterval(() => {
    try {
      res.write(`: keep-alive\n\n`);
    } catch {}
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});
