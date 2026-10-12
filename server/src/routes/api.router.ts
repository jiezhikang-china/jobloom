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
import type { BossPositionSelection } from '../types.js';
import { deepseekProxyService } from '../services/deepseek.proxy.service.js';
import { workConditionReviews } from '../services/work-condition-reviews.js';
import { notSuitableStore } from '../services/not-suitable-store.js';
import { configuredWorkRequirements, validateWorkRequirements } from '../services/work-requirements.js';
import { hasCommuteLimits, isBossPoint, validateCommuteFilter, validCommuteOrigin, manualCommuteOrigin } from '../services/commute.js';
import { publicLocationService, publicMapConfig } from '../services/public-location.service.js';
import { deviceLocationService } from '../services/device-location.service.js';
import { mapPointToGps } from '../services/coordinates.js';
import { randomUUID } from 'node:crypto';
import { resumePdfService } from '../services/resume-pdf.service.js';
import { ResumeCapacityError, resumeBossUploadService } from '../services/resume-boss-upload.service.js';
import { bossAutomationSafety } from '../services/boss-automation-safety.js';
import { followupRouter } from './followup.router.js';
import { bossTaskOwner } from '../services/boss-task-lock.js';

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
    cb(null, `resume_${randomUUID()}${safeExt}`);
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
apiRouter.use('/followup', followupRouter);
const bossOperationRoutes = new Set(['/browser/page-state', '/resume/boss/attachments', '/resume/boss/upload',
  '/delivery/start', '/delivery/resume', '/delivery/work-condition-reviews/apply']);
// Explicit login verification or task start replaces the separate recovery panel.
async function verifyBossRecovery() {
  const hold = bossAutomationSafety.status().hold;
  const login = await browserService.verifyManualSession();
  if (!login.isLoggedIn) throw new Error(login.reason || '请打开 BOSS 完成登录或验证，再点击验证登录');
  if (await browserService.checkVisibleRestriction()) throw new Error('当前 BOSS 页面仍需要人工处理，请先完成登录或验证');
  if (hold) bossAutomationSafety.confirmRecovery(hold.id);
  return login;
}
apiRouter.use(async (req, res, next) => {
  if (bossTaskOwner() === '沟通跟进' && (bossOperationRoutes.has(req.path) || ['/browser/login', '/browser/verify'].includes(req.path))) {
    return res.status(409).json({ success: false, message: '正在核对沟通记录，请停止监控后再操作 BOSS' });
  }
  if (bossOperationRoutes.has(req.path) && bossAutomationSafety.status().blocked) {
    try { await verifyBossRecovery(); }
    catch (error) { return res.status(423).json({ success: false, message: (error as Error).message }); }
  }
  next();
});
apiRouter.get('/boss/automation-safety', (_req, res) => res.json({ success: true, data: bossAutomationSafety.status() }));
apiRouter.post('/boss/automation-safety/report', (_req, res) => {
  const hold = bossAutomationSafety.halt('user_reported_ban', '你已报告 BOSS 账号受限，自动操作已停止。请先通过平台核实或申诉，账号恢复前不能继续投递。');
  deliveryService.stop(); res.json({ success: true, data: { blocked: true, hold } });
});
apiRouter.post('/boss/automation-safety/open-browser', async (_req, res) => {
  deliveryService.stop();
  try {
    await browserService.openManualRecovery();
    res.json({ success: true, data: bossAutomationSafety.status() });
  } catch (error) { res.status(409).json({ success: false, message: (error as Error).message }); }
});
apiRouter.post('/boss/automation-safety/confirm', async (req, res) => {
  if (req.body?.platformAccessRestored !== true || typeof req.body?.holdId !== 'string') return res.status(400).json({ success: false, message: '请先人工确认 BOSS 账号已恢复正常使用' });
  try {
    const hold = bossAutomationSafety.status().hold;
    const login = await browserService.checkLoginStatus({ restore: false, observeBlocked: true });
    // A human-reported ban can be withdrawn by the same explicit human confirmation.
    // Requiring an open logged-in page would deadlock with the guarded browser/login routes.
    const humanReport = hold?.reason === 'user_reported_ban' && !hold.requiresPageVerification;
    if (login.isBrowserActive && await browserService.checkVisibleRestriction()) {
      bossAutomationSafety.halt('verification', '当前 BOSS 页面仍显示限制或安全验证，请先人工处理');
      return res.status(409).json({ success: false, message: '当前 BOSS 页面仍显示限制或安全验证，请先人工处理' });
    }
    if (!humanReport && !login.isLoggedIn) return res.status(409).json({ success: false, message: '尚未看到可正常使用的已登录 BOSS 页面；请先在浏览器人工核实，系统不会自动刷新或测试账号' });
    bossAutomationSafety.confirmRecovery(req.body.holdId);
    res.json({ success: true, data: bossAutomationSafety.status() });
  } catch (error) { res.status(409).json({ success: false, message: (error as Error).message }); }
});

// 1. 配置与官方免费预设相关接口
apiRouter.get('/config', (_req: Request, res: Response) => {
  res.json({ success: true, data: configManager.getConfig() });
});

apiRouter.post('/config', (req: Request, res: Response) => {
  if (req.body?.filter?.commute !== undefined && !validateCommuteFilter(req.body.filter.commute)) {
    return res.status(400).json({ success: false, message: '出发位置或距离设置无效：公里数需0至200。' });
  }
  if (req.body?.filter?.candidateLanguages !== undefined && (typeof req.body.filter.candidateLanguages !== 'string'
    || req.body.filter.candidateLanguages.length > 1000)) {
    return res.status(400).json({ success: false, message: '请用不超过1000字填写自己的语言能力。' });
  }
  if (req.body?.targetPositions !== undefined && (!Array.isArray(req.body.targetPositions) || req.body.targetPositions.length > 3
    || req.body.targetPositions.some((item: any) => !/^\d{6}$/.test(item?.code))
    || new Set(req.body.targetPositions.map((item: any) => item.code)).size !== req.body.targetPositions.length)) {
    return res.status(400).json({ success: false, message: '目标岗位最多3个，需使用不同的官方分类代码。' });
  }
  for (const key of ['skipMissingCompanyIntro', 'skipVagueJobDescription']) {
    if (req.body?.filter?.[key] !== undefined && typeof req.body.filter[key] !== 'boolean') {
      return res.status(400).json({ success: false, message: '资料筛选选项必须为开启或关闭。' });
    }
  }
  if (req.body?.delivery?.jobSource !== undefined && !['saved_expectations', 'search'].includes(req.body.delivery.jobSource)) {
    return res.status(400).json({ success: false, message: '请选择 BOSS 自选期望或搜索岗位。' });
  }
  const experienceMode = req.body?.filter?.experienceMatchMode;
  if (experienceMode !== undefined && !['flexible', 'strict'].includes(experienceMode)) {
    return res.status(400).json({ success: false, message: '经验筛选方式无效，请选择宽泛或严格。' });
  }
  if (req.body?.filter?.workRequirements !== undefined && !validateWorkRequirements(req.body.filter.workRequirements)) {
    return res.status(400).json({ success: false, message: '工作条件最多20条，每条需2至500字，且不能有重复标识。' });
  }
  const updated = configManager.updateConfig(req.body || {});
  try {
    const cleanup = workConditionReviews.pruneExcluded(updated.filter);
    res.json({ success: true, data: updated, removedReviews: cleanup.removed });
  } catch {
    res.json({ success: true, data: updated, message: '设置已保存；待确认岗位重筛失败，原记录文件已保留。' });
  }
});

apiRouter.get('/presets', (_req: Request, res: Response) => {
  res.json({ success: true, data: FREE_MODEL_PRESETS });
});

let locationSearchActive = false;
apiRouter.get('/location/map', (_req: Request, res: Response) => {
  try { res.json({ success: true, data: publicMapConfig() }); }
  catch (cause) { res.status(400).json({ success: false, message: (cause as Error).message }); }
});
apiRouter.post('/location/map-point', (req: Request, res: Response) => {
  if (!isBossPoint(req.body?.point) || req.body.point.coordinateSystem === 'boss') return res.status(400).json({ success: false, message: '请重新选择来源明确的地图位置' });
  res.json({ success: true, data: mapPointToGps(req.body.point) });
});
apiRouter.post('/location/device', async (req: Request, res: Response) => {
  if (req.body?.userInitiated !== true) return res.status(400).json({ success: false, message: '请点击“获取当前位置”主动定位' });
  const origin = req.get('origin');
  if (origin && origin !== req.protocol + '://' + req.get('host') && !/^http:\/\/(?:localhost|127\.0\.0\.1):5173$/.test(origin)) {
    return res.status(403).json({ success: false, message: '只允许从本机界面发起定位' });
  }
  if (deliveryService.isActive() || locationSearchActive) return res.status(409).json({ success: false, message: '请先结束投递任务或等待当前查询完成' });
  locationSearchActive = true;
  try { res.json({ success: true, data: await deviceLocationService.getPosition() }); }
  catch (cause) { res.status(502).json({ success: false, message: (cause as Error).message }); }
  finally { locationSearchActive = false; }
});
apiRouter.post('/location/search', async (req: Request, res: Response) => {
  if (deliveryService.isActive() || locationSearchActive) {
    return res.status(409).json({ success: false, message: '请先结束投递任务或等待当前位置查询完成，再选择出发位置。' });
  }
  const query = req.body?.query, cityName = req.body?.cityName || configManager.getConfig().filter.cityName;
  if (typeof query !== 'string' || query.trim().length < 2 || query.length > 100
    || typeof cityName !== 'string' || cityName.trim().length < 2 || cityName.length > 30) {
    return res.status(400).json({ success: false, message: '请填写城市及2至100字的地址、楼宇或地铁站名称。' });
  }
  locationSearchActive = true;
  try {
    const data = await publicLocationService.searchOrigins(query.trim(), cityName.trim());
    res.json({ success: true, data });
  } catch (cause) { res.status(502).json({ success: false, message: (cause as Error).message }); }
  finally { locationSearchActive = false; }
});
apiRouter.post('/location/manual', async (req: Request, res: Response) => {
  if (deliveryService.isActive()) return res.status(409).json({ success: false, message: '请先结束投递任务再修改位置' });
  try { res.json({ success: true, data: manualCommuteOrigin(req.body?.position) }); }
  catch (cause) { res.status(400).json({ success: false, message: (cause as Error).message }); }
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
apiRouter.post('/llm/web/requests/:action', async (req: Request, res: Response) => {
  if (!['view', 'retry', 'recover'].includes(String(req.params.action)) || typeof req.body?.requestId !== 'string'
    || !/^[a-zA-Z0-9_-]{8,100}$/.test(req.body.requestId)) return res.status(400).json({ success: false, message: '请选择未完成的聊天' });
  try { res.json({ success: true, data: await deepseekProxyService.request('/requests/' + req.params.action, 'POST', { requestId: req.body.requestId }) }); }
  catch (error) { res.status(409).json({ success: false, message: (error as Error).message }); }
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
      const originalName = /[\u0080-\u00ff]/.test(req.file.originalname) ? Buffer.from(req.file.originalname, 'latin1').toString('utf8') : req.file.originalname;
      const source = await resumePdfService.saveSource(req.file.path, originalName, extractedText);
      res.json({
        success: true,
        data: {
          id: source.id,
          format: source.format,
          fileName: source.fileName,
          savedPath: req.file.path,
          text: extractedText,
        },
      });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });
});

apiRouter.get('/resume/current', async (_req: Request, res: Response) => {
  try {
    const source = await resumePdfService.current(file => resumeService.extractTextFromFile(file));
    const tailored = await resumePdfService.latest();
    res.json({ success: true, data: { source, tailored: tailored?.pdf?.sourceId === source?.id ? tailored : null } });
  } catch (cause) { res.status(500).json({ success: false, message: (cause as Error).message }); }
});
apiRouter.get('/resume/pdf/:id', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id), result = await resumePdfService.result(id);
    res.download(await resumePdfService.pdfPath(id), result.pdf!.fileName);
  } catch (cause) { res.status(404).json({ success: false, message: (cause as Error).message }); }
});
apiRouter.get('/resume/pdf/:id/pages/:page', async (req: Request, res: Response) => {
  try { res.type('png').sendFile(await resumePdfService.pagePath(String(req.params.id), Number(req.params.page))); }
  catch (cause) { res.status(404).json({ success: false, message: (cause as Error).message }); }
});
apiRouter.get('/resume/boss/attachments', async (_req: Request, res: Response) => {
  if (deliveryService.isActive()) return res.status(409).json({ success: false, message: '请先结束当前投递任务，再查看 BOSS 附件' });
  try { res.json({ success: true, data: await resumeBossUploadService.list() }); }
  catch (cause) { res.status(502).json({ success: false, message: (cause as Error).message }); }
});
apiRouter.post('/resume/boss/upload', async (req: Request, res: Response) => {
  if (deliveryService.isActive()) return res.status(409).json({ success: false, message: '请先结束当前投递任务，再上传优化 PDF' });
  const { artifactId, replaceId } = req.body || {};
  if (typeof artifactId !== 'string' || !/^[a-f0-9]{32}$/.test(artifactId)
    || replaceId !== undefined && (typeof replaceId !== 'string' || !/^[a-zA-Z0-9_-]{8,180}$/.test(replaceId))) {
    return res.status(400).json({ success: false, message: '请选择已生成的优化 PDF 和有效的待替换附件' });
  }
  try { res.json({ success: true, data: await resumeBossUploadService.upload(artifactId, replaceId) }); }
  catch (cause) {
    if (cause instanceof ResumeCapacityError) return res.status(409).json({ success: false, message: cause.message, code: 'ATTACHMENTS_FULL',
      data: { attachments: cause.attachments, capacity: cause.capacity } });
    res.status(502).json({ success: false, message: (cause as Error).message });
  }
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
    const { sourceId, targetRole } = req.body || {};
    if (typeof sourceId !== 'string' || typeof targetRole !== 'string' || !targetRole.trim() || targetRole.length > 100) {
      return res.status(400).json({ success: false, message: '请上传原 PDF 并选择目标岗位' });
    }
    const rewritten = await resumeService.rewriteForTargetRole(sourceId, targetRole.trim());
    res.json({ success: true, data: rewritten });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 5. 浏览器与登录状态
apiRouter.get('/browser/status', async (_req: Request, res: Response) => {
  try {
    const status = await browserService.checkLoginStatus({ restore: false, observeBlocked: true });
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
  if (resumeBossUploadService.isBusy()) return res.status(409).json({ success: false, message: '请等待简历上传完成' });
  try {
    if (bossAutomationSafety.status().blocked) await browserService.openManualRecovery();
    else await browserService.promptLogin();
    res.json({ success: true, message: '登录页面已打开，请在 Chrome 中扫码，然后点击“验证登录”' });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

apiRouter.post('/browser/verify', async (_req: Request, res: Response) => {
  if (resumeBossUploadService.isBusy()) return res.status(409).json({ success: false, message: '请等待简历上传完成' });
  try {
    const status = bossAutomationSafety.status().blocked ? await verifyBossRecovery() : await browserService.verifyLogin();
    res.json({ success: status.isLoggedIn, data: status, message: status.isLoggedIn ? '登录已确认' : status.reason });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 6. 投递任务控制
apiRouter.post('/delivery/start', async (req: Request, res: Response) => {
  if (resumeBossUploadService.isBusy()) return res.status(409).json({ success: false, message: '请等待简历上传完成再投递' });
  try {
    let { targetRole } = req.body || {};
    const { keywords, resumeText, requirementsText, defaultGreeting } = req.body || {};
    const positionCode = typeof req.body?.positionCode === 'string' ? req.body.positionCode.trim() : '';
    const mode = req.body?.mode === 'manual' ? 'manual' : 'resume';
    const conditionsOnly = req.body?.conditionsOnly === true && mode === 'manual';
    const useSavedExpectations = configManager.getConfig().delivery.jobSource === 'saved_expectations';
    const filter = configManager.getConfig().filter;
    if (hasCommuteLimits(filter) && !validCommuteOrigin(filter.commute?.origin)) {
      return res.status(400).json({ success: false, message: '已开启距离／通勤筛选，请先在筛选规则中选择出发位置。' });
    }
    const candidateText = mode === 'manual' ? requirementsText : resumeText;
    const keywordList: string[] = Array.isArray(keywords)
      ? keywords.map((k: unknown) => String(k ?? '').trim()).filter(Boolean)
      : [];

    if (!targetRole && useSavedExpectations) targetRole = 'BOSS 自选求职期望';
    if (!targetRole || typeof targetRole !== 'string') {
      return res.status(400).json({ success: false, message: '请指定目标职业' });
    }
    const rawTargets = req.body?.positionCodes ?? (positionCode ? [positionCode] : []);
    if (!Array.isArray(rawTargets) || rawTargets.length > 3 || rawTargets.some(code => typeof code !== 'string' || !/^\d{6}$/.test(code))
      || new Set(rawTargets).size !== rawTargets.length) return res.status(400).json({ success: false, message: '请选择1至3个不同的官方目标岗位' });
    const targets: BossPositionSelection[] = [];
    for (const code of rawTargets) {
      const position = await bossCatalogService.findPosition(code);
      if (!position) return res.status(400).json({ success: false, message: '目标岗位不在 BOSS 官方分类中，请重新选择' });
      targets.push(position);
    }
    if (targets.length) targetRole = targets.map(item => item.name).join('、');
    if (positionCode && !useSavedExpectations) {
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
    if (locationSearchActive) return res.status(409).json({ success: false, message: '请等待位置查询完成再投递。' });
    if (deliveryService.isActive()) {
      return res.status(409).json({ success: false, message: '投递任务已在运行中，请先停止当前任务' });
    }

    // 异步执行投递任务，不阻塞 HTTP 响应；必须接管 promise，否则一次异常会带走整个进程
    if (resumeBossUploadService.isBusy()) return res.status(409).json({ success: false, message: '请等待简历上传完成再投递' });
    deliveryService
      .startDelivery({
        targetRole,
        positionCode: positionCode || undefined,
        targetPositions: targets,
        keywords: keywordList,
        resumeText: candidateText.trim(),
        defaultGreeting: typeof defaultGreeting === 'string' ? defaultGreeting : undefined,
        candidateSource: mode === 'manual' ? 'requirements' : 'resume',
        rulesOnly: false,
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
  if (!['running', 'sage_time'].includes(deliveryService.getStats().status)) {
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
apiRouter.get('/delivery/not-suitable', (_req: Request, res: Response) => {
  try { res.json({ success: true, data: notSuitableStore.list() }); }
  catch (error) { res.status(500).json({ success: false, message: (error as Error).message }); }
});
apiRouter.delete('/delivery/not-suitable/:id', (req: Request, res: Response) => {
  if (deliveryService.isActive()) return res.status(409).json({ success: false, message: '请先停止投递，再撤销本地屏蔽' });
  try { res.json({ success: true, removed: notSuitableStore.remove(req.params.id) }); }
  catch (error) { res.status(500).json({ success: false, message: (error as Error).message }); }
});
apiRouter.get('/delivery/work-condition-reviews', (_req: Request, res: Response) => {
  try { res.json({ success: true, data: workConditionReviews.listEligible() }); }
  catch { res.status(500).json({ success: false, message: '读取待确认岗位失败，原文件已保留。' }); }
});

apiRouter.post('/delivery/work-condition-reviews/apply', async (req: Request, res: Response) => {
  if (resumeBossUploadService.isBusy()) return res.status(409).json({ success: false, message: '请等待简历上传完成再投递' });
  try {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 150
      || ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{20}$/.test(id)) || new Set(ids).size !== ids.length) {
      return res.status(400).json({ success: false, message: '请选择1至150个不同的待确认岗位' });
    }
    if (deliveryService.isActive()) return res.status(409).json({ success: false, message: '请先停止当前投递任务，再投递待确认岗位' });
    if (locationSearchActive) return res.status(409).json({ success: false, message: '请等待位置查询完成再投递。' });
    const filter = configManager.getConfig().filter;
    if (hasCommuteLimits(filter) && !validCommuteOrigin(filter.commute?.origin)) return res.status(400)
      .json({ success: false, message: '请先在筛选规则中选择出发位置。' });
    const eligible = workConditionReviews.listEligible(filter);
    const reviews = ids.map(id => eligible.find(item => item.id === id));
    if (reviews.some(item => !item)) return res.status(400).json({ success: false, message: '所选记录已移除或已命中排除条件，请刷新后重新选择' });
    if (configManager.getConfig().delivery.dailyMaxQuota === 0) return res.status(400).json({ success: false, message: '每日投递上限为0，请先调整上限' });
    let login = await browserService.checkLoginStatus();
    if (!login.isLoggedIn && login.reasonCode === 'unverified') login = await browserService.verifyLogin();
    if (!login.isLoggedIn) return res.status(login.reasonCode === 'login_required' ? 401 : 503)
      .json({ success: false, message: login.reason || '无法确认 BOSS 登录状态', reasonCode: login.reasonCode });
    if (locationSearchActive) return res.status(409).json({ success: false, message: '请等待位置查询完成再投递。' });
    if (deliveryService.isActive()) return res.status(409).json({ success: false, message: '投递任务已经在运行中' });
    if (resumeBossUploadService.isBusy()) return res.status(409).json({ success: false, message: '请等待简历上传完成再投递' });
    deliveryService.startReviewDelivery(reviews as NonNullable<typeof reviews[number]>[])
      .catch(error => deliveryService.log('error', '待确认岗位投递失败：' + (error as Error).message));
    res.json({ success: true, data: deliveryService.getStats(), message: '已开始投递所选岗位，未确认的工作条件仍保留原状态' });
  } catch (error) {
    res.status(500).json({ success: false, message: (error as Error).message });
  }
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
