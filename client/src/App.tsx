import React, { useState, useEffect, useRef } from 'react';
import BossPositionPicker, { flattenPositions } from './BossPositionPicker.js';
import DeepSeekAccountPanel from './DeepSeekAccountPanel.js';
import WorkConditionOptions, { withWorkConditionPresets } from './WorkConditionOptions.js';
import WorkConditionReviewPanel from './WorkConditionReviewPanel.js';
import DelimitedListTextArea from './DelimitedListTextArea.js';
import LocationFilterOptions from './LocationFilterOptions.js';
import ResumePdfPanel from './ResumePdfPanel.js';
import DesktopTitleBar from './DesktopTitleBar.js';
import NotSuitablePanel from './NotSuitablePanel.js';
import CareerPanel from './CareerPanel.js';
import FollowupPanel from './FollowupPanel.js';
import {
  FileText,
  Compass,
  Sliders,
  Play,
  Pause,
  Square,
  Upload,
  Settings,
  Sparkles,
  ShieldAlert,
  Activity,
  Terminal,
  RefreshCw,
  Plus,
  X,
  ExternalLink,
  Check,
  MapPin,
  MessageCircle,
} from 'lucide-react';
import {
  AppConfig,
  ModelPreset,
  ResumeAnalysisResult,
  CareerRecommendation,
  TailoredResumeResult,
  DeliveryStats,
  DeliveryLogItem,
  BossPositionCatalog,
  BossPositionSelection,
} from './types.js';

const jobSourceLabels: Record<NonNullable<AppConfig['delivery']['jobSource']>, string> = {
  saved_expectations: 'BOSS 自选职位', search: '分类与关键词搜索',
  recommendation: 'BOSS 推荐页', message_recommendations: '消息“荐”岗位',
};

type WorkbenchTab = 'launch' | 'diagnosis' | 'tailor' | 'rules' | 'delivery' | 'settings' | 'followup' | 'career';
const navigationItems = [
  { id: 'launch', label: '开始投递', icon: Play, description: '选择岗位与工作条件，开始新的投递。' },
  { id: 'delivery', label: '运行记录', icon: Activity, description: '查看筛选结果、AI 评估与投递进度。' },
  { id: 'followup', label: '沟通跟进', icon: MessageCircle, description: '查看招聘方回复，询问工作条件，跟进已经投递的岗位。' },
  { id: 'career', label: '求职进度', icon: Compass, description: '查看候选恢复、面试安排、录用条件与简历版本。' },
  { id: 'rules', label: '筛选规则', icon: Sliders, description: '设置工作条件、通勤范围和每日投递数量。' },
  { id: 'diagnosis', label: '简历分析', icon: FileText, description: '从简历了解优势，找到适合你的岗位方向。' },
  { id: 'tailor', label: '简历优化', icon: Compass, description: '按目标岗位润色经历，保留原 PDF 的版式。' },
] as const;
export default function App() {
  const [activeTab, setActiveTab] = useState<WorkbenchTab>('launch');
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => { mainRef.current?.scrollTo({ top: 0 }); }, [activeTab]);

  // 状态管理
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [presets, setPresets] = useState<ModelPreset[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState<string>('deepseek-web-flash');
  const [isBossLoggedIn, setIsBossLoggedIn] = useState(false);
  const [isCheckingLogin, setIsCheckingLogin] = useState(false);
  const [loginPageOpened, setLoginPageOpened] = useState(false);
  const [loginReason, setLoginReason] = useState('');
  const [loginReasonCode, setLoginReasonCode] = useState('unverified');
  const [isUploading, setIsUploading] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isTestingModel, setIsTestingModel] = useState(false);
  const [modelTestMessage, setModelTestMessage] = useState('');

  // 简历与分析数据
  const [resumeFileName, setResumeFileName] = useState('');
  const [resumeSourceId, setResumeSourceId] = useState('');
  const [resumeFormat, setResumeFormat] = useState('');
  const resumeUploadEpoch = useRef(0);
  const [resumeText, setResumeText] = useState('');
  const [isDiagnosing, setIsDiagnosing] = useState(false);
  const [diagnosis, setDiagnosis] = useState<ResumeAnalysisResult | null>(null);

  // 改写数据
  const [selectedRole, setSelectedRole] = useState<string>('');
  const [bossPositions, setBossPositions] = useState<BossPositionCatalog | null>(null);
  const [selectedPosition, setSelectedPosition] = useState<BossPositionSelection | undefined>();
  const [targetSlots, setTargetSlots] = useState<Array<BossPositionSelection | undefined>>([undefined]);
  const [isLoadingPositions, setIsLoadingPositions] = useState(false);
  const [positionError, setPositionError] = useState('');
  const initialConfigLoaded = useRef(false);
  const [isRewriting, setIsRewriting] = useState(false);
  const [tailoredResult, setTailoredResult] = useState<TailoredResumeResult | null>(null);
  const [customGreeting, setCustomGreeting] = useState('');
  const rewriteContext = useRef('');
  rewriteContext.current = resumeSourceId + '|' + selectedRole;
  useEffect(() => {
    let disposed = false;
    const epoch = resumeUploadEpoch.current;
    void fetch('/api/resume/current').then(response => response.json()).then(json => {
      if (disposed || resumeUploadEpoch.current !== epoch || !json.success || !json.data.source) return;
      const source = json.data.source;
      setResumeSourceId(source.id); setResumeFormat(source.format); setResumeFileName(source.fileName); setResumeText(source.text);
      if (json.data.tailored) { setTailoredResult(json.data.tailored); setCustomGreeting(json.data.tailored.defaultGreetingPitch); }
    }).catch(() => {});
    return () => { disposed = true; };
  }, []);

  // 投递设置与运行状态
  const [searchKeywords, setSearchKeywords] = useState<string[]>([]);
  const [newKeywordInput, setNewKeywordInput] = useState('');
  const [deliveryMode, setDeliveryMode] = useState<'resume' | 'manual'>('manual');
  const [conditionsOnly, setConditionsOnly] = useState(false);
  const [manualRequirements, setManualRequirements] = useState('');
  const [startMessage, setStartMessage] = useState('');
  const [deliveryStats, setDeliveryStats] = useState<DeliveryStats>({
    status: 'idle',
    isPaused: false,
    needsCaptchaVerification: false,
    todayAppliedCount: 0,
    dailyMaxQuota: 80,
    totalScanned: 0,
    passedFilterCount: 0,
    markedNotSuitCount: 0,
    skippedByLlmErrorCount: 0,
  });
  const [logs, setLogs] = useState<DeliveryLogItem[]>([]);
  const logContainerRef = useRef<HTMLDivElement>(null);

  // 初始化加载配置与状态
  useEffect(() => {
    fetchConfig();
    fetchPresets();
    fetchBossPositions();
    checkLoginStatus();

    // 建立 SSE 实时日志连接
    const eventSource = new EventSource('/api/delivery/events');
    eventSource.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === 'init') {
          setDeliveryStats(payload.stats);
          setLogs(payload.logs || []);
        } else if (payload.type === 'update') {
          if (payload.stats) setDeliveryStats(payload.stats);
          if (payload.log) {
            setLogs((prev) => [payload.log, ...prev].slice(0, 300));
          }
        }
      } catch (e) {
        console.error('SSE 数据解析错误:', e);
      }
    };

    return () => {
      eventSource.close();
    };
  }, []);

  const fetchPresets = async () => {
    try {
      const res = await fetch('/api/presets');
      const json = await res.json();
      if (json.success) setPresets(json.data);
    } catch (e) {
      console.warn('获取预设失败:', e);
    }
  };

  useEffect(() => {
    if (!config || !presets.length) return;
    const matched = presets.find((preset) => preset.model === config.llm.model &&
      (preset.connectionMode || 'api') === (config.llm.connectionMode || 'api') &&
      (preset.connectionMode === 'deepseek-web' || preset.baseUrl === config.llm.baseUrl));
    setSelectedPresetId(matched?.id || 'custom-api');
  }, [config?.llm.model, config?.llm.baseUrl, config?.llm.connectionMode, presets]);

  const handleSelectPreset = async (presetId: string) => {
    setSelectedPresetId(presetId);
    setModelTestMessage('');
    if (presetId === 'custom-api' && config) {
      const nextConfig: AppConfig = { ...config, llm: { ...config.llm, connectionMode: 'api', baseUrl: '', apiKey: '', model: '' } };
      setConfig(nextConfig); await saveConfig(nextConfig, true); return;
    }
    const target = presets.find((p) => p.id === presetId);
    if (!target || !config) return;
    const nextConfig: AppConfig = {
      ...config,
      llm: { ...config.llm, connectionMode: target.connectionMode || 'api', baseUrl: target.baseUrl, model: target.model,
        apiKey: target.connectionMode === 'deepseek-web' || config.llm.baseUrl !== target.baseUrl ? '' : config.llm.apiKey },
    };
    setConfig(nextConfig);
    // 立即落库，避免"以为切换了却没生效"
    await saveConfig(nextConfig, true);
  };

  const fetchConfig = async () => {
    try {
      const res = await fetch('/api/config');
      const json = await res.json();
      if (json.success) {
        setConfig(json.data);
        if (!initialConfigLoaded.current) {
          initialConfigLoaded.current = true;
          const positions = Array.isArray(json.data.targetPositions) ? json.data.targetPositions : json.data.targetPosition ? [json.data.targetPosition] : [];
          setTargetSlots(positions.length ? positions : [undefined]);
          setSelectedPosition(positions[0]);
          setSelectedRole(positions[0]?.name || '');
        }
      }
    } catch (e) {
      console.error('获取配置失败:', e);
    }
  };

  const fetchBossPositions = async (refresh = false) => {
    setIsLoadingPositions(true);
    setPositionError('');
    try {
      const response = await fetch(`/api/boss/positions${refresh ? '?refresh=1' : ''}`);
      const json = await response.json();
      if (!response.ok || !json.success) throw new Error(json.message || '读取分类失败');
      setBossPositions(json.data);
    } catch (error) {
      setPositionError(`官方分类获取失败：${(error as Error).message}`);
    } finally { setIsLoadingPositions(false); }
  };

  const handlePositionChange = (position: BossPositionSelection | undefined) => {
    if (position?.name !== selectedRole) {
      setTailoredResult(null);
      setCustomGreeting('');
    }
    setSelectedPosition(position);
    setSelectedRole(position?.name || '');
    setTargetSlots(previous => [position, ...previous.slice(1)]);
    setConfig((previous) => previous ? { ...previous, targetPosition: position,
      targetPositions: [position, ...targetSlots.slice(1)].filter((item): item is BossPositionSelection => !!item) } : previous);
  };

  const handleTargetSlotChange = (index: number, position: BossPositionSelection | undefined) => {
    if (index === 0) { handlePositionChange(position); return; }
    const slots = targetSlots.map((item, slot) => slot === index ? position : item);
    setTargetSlots(slots);
    setConfig(previous => previous ? { ...previous, targetPositions: slots.filter((item): item is BossPositionSelection => !!item) } : previous);
  };

  const removeTargetSlot = (index: number) => {
    const slots = targetSlots.filter((_, slot) => slot !== index);
    setTargetSlots(slots.length ? slots : [undefined]);
    setSelectedPosition(slots[0]); setSelectedRole(slots[0]?.name || '');
    setConfig(previous => previous ? { ...previous, targetPosition: slots[0],
      targetPositions: slots.filter((item): item is BossPositionSelection => !!item) } : previous);
  };

  const saveConfig = async (newCfg: Partial<AppConfig>, silent = false) => {
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newCfg),
      });
      const json = await res.json();
      if (json.success) {
        setConfig(json.data);
        if (!silent) alert('配置已成功保存！');
      } else {
        alert('保存配置失败: ' + (json.message || '未知错误'));
      }
    } catch (e) {
      alert('保存配置失败: ' + (e as Error).message);
    }
  };

  const testModelConnection = async () => {
    if (!config || isTestingModel) return;
    setIsTestingModel(true);
    setModelTestMessage('正在连接模型…');
    try {
      const res = await fetch('/api/llm/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ llm: config.llm }),
      });
      const json = await res.json();
      setModelTestMessage(json.success ? json.message : `连接失败：${json.message || '未知错误'}`);
      if (json.success) await fetchConfig();
    } catch (e) {
      setModelTestMessage(`连接失败：${(e as Error).message}`);
    } finally {
      setIsTestingModel(false);
    }
  };

  const checkLoginStatus = async () => {
    setIsCheckingLogin(true);
    try {
      const res = await fetch('/api/browser/status');
      const json = await res.json();
      if (json.success) {
        setIsBossLoggedIn(json.data.isLoggedIn);
        setLoginReasonCode(json.data.reasonCode || (json.data.isLoggedIn ? 'authenticated' : 'unverified'));
        setLoginReason(json.data.isLoggedIn ? '' : (json.data.reason || 'BOSS直聘未登录'));
        if (json.data.isLoggedIn) setLoginPageOpened(false);
        return json.data;
      } else {
        setIsBossLoggedIn(false);
        setLoginReasonCode('browser_unavailable');
        setLoginReason(json.message || '无法检查 BOSS 会话');
      }
    } catch (e) {
      console.warn('检查登录状态失败:', e);
      setIsBossLoggedIn(false);
      setLoginReasonCode('browser_unavailable');
      setLoginReason('本地服务连接失败，请重试');
    } finally {
      setIsCheckingLogin(false);
    }
  };

  const handlePromptLogin = async () => {
    setIsCheckingLogin(true);
    try {
      const res = await fetch('/api/browser/login', { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        const current = await checkLoginStatus();
        setLoginPageOpened(!current?.isLoggedIn);
      } else {
        setLoginReason(json.message || '登录页打开失败');
        alert(json.message || '登录页打开失败');
      }
    } catch (error) {
      alert('登录页打开失败: ' + (error as Error).message);
    } finally {
      setIsCheckingLogin(false);
    }
  };

  const handleVerifyLogin = async () => {
    setIsCheckingLogin(true);
    try {
      const res = await fetch('/api/browser/verify', { method: 'POST' });
      const json = await res.json();
      setIsBossLoggedIn(!!json.data?.isLoggedIn);
      setLoginReasonCode(json.data?.reasonCode || (json.data?.isLoggedIn ? 'authenticated' : 'unverified'));
      setLoginReason(json.data?.isLoggedIn ? '' : (json.data?.reason || json.message || '尚未确认登录'));
      if (json.success) {
        setLoginPageOpened(false);
      } else {
        alert(json.message || '尚未确认 BOSS 会话，请检查浏览器页面');
      }
    } catch (error) {
      alert('验证登录失败: ' + (error as Error).message);
    } finally {
      setIsCheckingLogin(false);
    }
  };

  // 上传简历
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    resumeUploadEpoch.current++;

    const formData = new FormData();
    formData.append('file', file);

    setIsUploading(true);
    try {
      const res = await fetch('/api/resume/upload', {
        method: 'POST',
        body: formData,
      });
      const json = await res.json();
      if (json.success) {
        setResumeFileName(json.data.fileName);
        setResumeSourceId(json.data.id);
        setResumeFormat(json.data.format);
        setResumeText(json.data.text);
        setDiagnosis(null);
        setTailoredResult(null);
        setCustomGreeting('');
      } else {
        alert('解析简历失败: ' + json.message);
      }
    } catch (err) {
      alert('上传异常: ' + (err as Error).message);
    } finally {
      setIsUploading(false);
    }
  };

  // 深度诊断
  const handleDiagnose = async () => {
    if (!resumeText) {
      alert('请先上传简历文件');
      return;
    }
    setIsDiagnosing(true);
    try {
      const res = await fetch('/api/resume/diagnose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resumeText }),
      });
      const json = await res.json();
      if (json.success) {
        setDiagnosis(json.data);
      } else {
        alert('诊断失败: ' + json.message);
      }
    } catch (err) {
      alert('诊断请求异常: ' + (err as Error).message);
    } finally {
      setIsDiagnosing(false);
    }
  };

  // 选择目标岗位并进入改写
  const handleSelectRole = (role: CareerRecommendation, destination: 'launch' | 'tailor' = 'launch') => {
    if (selectedRole !== role.roleTitle) {
      setTailoredResult(null);
      setCustomGreeting('');
    }
    const position = bossPositions && flattenPositions(bossPositions).find((item) =>
      role.positionCode ? item.code === role.positionCode : item.name === role.roleTitle);
    handlePositionChange(position || undefined);
    if (!position) {
      setSelectedRole(role.roleTitle);
      setStartMessage(`AI 建议岗位：${role.roleTitle}。请在 BOSS 官方分类中选择对应岗位。`);
    }
    setSearchKeywords(role.keywords || [role.roleTitle]);
    setDeliveryMode('resume');
    setActiveTab(destination);
  };

  // 执行针对性改写
  const handleRewrite = async () => {
    if (!selectedRole || !resumeSourceId || resumeFormat !== 'pdf') return;
    const context = rewriteContext.current;
    setIsRewriting(true);
    try {
      const res = await fetch('/api/resume/rewrite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: resumeSourceId, targetRole: selectedRole }),
      });
      const json = await res.json();
      if (rewriteContext.current !== context) return;
      if (json.success) {
        setTailoredResult(json.data);
        setCustomGreeting(json.data.defaultGreetingPitch);
      } else {
        alert('改写失败: ' + json.message);
      }
    } catch (err) {
      alert('改写请求异常: ' + (err as Error).message);
    } finally {
      setIsRewriting(false);
    }
  };

  // 投递控制
  const isTaskRunning = ['running', 'paused', 'sage_time', 'cool_down'].includes(deliveryStats.status);
  const selectedConditions = (config?.filter.workRequirements || []).filter((item) => item.enabled);
  const conditionDescription = selectedConditions.map((item) => item.text).join('、');
  const searchByConditions = deliveryMode === 'manual' && conditionsOnly;
  const usesSavedExpectations = (config?.delivery.jobSource || 'saved_expectations') === 'saved_expectations';
  const usesRecommendation = config?.delivery.jobSource === 'recommendation' || config?.delivery.jobSource === 'message_recommendations';

  const handleStartDelivery = async () => {
    setStartMessage('');
    if (!config) {
      setStartMessage('设置尚未载入，请稍后重试。');
      return;
    }
    if (isTaskRunning) {
      setStartMessage('已有投递任务正在运行，请先在运行记录中停止。');
      return;
    }
    if (!usesSavedExpectations && !usesRecommendation && !searchByConditions && !selectedPosition) {
      setStartMessage('请从 BOSS 官方分类中选择具体岗位。');
      return;
    }
    const targets = targetSlots.filter((item): item is BossPositionSelection => !!item);
    if (usesSavedExpectations && targetSlots.length > 1 && targetSlots.some(item => !item)) {
      setStartMessage('请补全目标岗位，或移除空的岗位位置。'); return;
    }
    if (usesSavedExpectations && new Set(targets.map(item => item.code)).size !== targets.length) {
      setStartMessage('目标岗位不能重复。'); return;
    }
    if (searchByConditions && !selectedConditions.length) {
      setStartMessage('请至少选择一项工作条件。');
      return;
    }
    if (deliveryMode === 'manual' && !searchByConditions && !((usesSavedExpectations || usesRecommendation) && selectedConditions.length) && manualRequirements.trim().length < 10) {
      setStartMessage('请填写至少 10 个字的目标岗位要求。');
      return;
    }
    if (deliveryMode === 'resume' && resumeText.trim().length < 50) {
      setStartMessage('请先上传简历；分析和改写可以跳过。');
      return;
    }
    if ((config?.delivery.dailyMaxQuota ?? 0) === 0) {
      setStartMessage('每日投递数当前为 0，请在筛选规则中调整。');
      return;
    }

    setIsStarting(true);
    try {
      const saved = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      const savedJson = await saved.json();
      if (!saved.ok || !savedJson.success) {
        setStartMessage(`保存投递条件失败：${savedJson.message || '未知错误'}`);
        return;
      }
      setConfig(savedJson.data);
      const res = await fetch('/api/delivery/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetRole: usesSavedExpectations ? targets.map(item => item.name).join('、') || '按当前条件规划目标岗位' : usesRecommendation ? searchByConditions ? '符合当前工作条件的岗位' : selectedRole || '适合当前简历和求职要求的岗位' : searchByConditions ? '符合工作条件的岗位' : selectedRole,
          positionCode: usesSavedExpectations || usesRecommendation || searchByConditions ? undefined : selectedPosition?.code,
          positionCodes: usesSavedExpectations ? targets.map(item => item.code) : usesRecommendation && !searchByConditions && selectedPosition ? [selectedPosition.code] : undefined,
          conditionsOnly: searchByConditions,
          keywords: searchKeywords.length || !searchByConditions ? searchKeywords
            : selectedConditions.filter((item) => item.builtin).map((item) => ({ eightHours: '八小时', doubleRest: '双休', noExperience: '经验不限' })[item.builtin!]),
          mode: deliveryMode,
          resumeText: deliveryMode === 'resume' ? (tailoredResult?.targetRole === selectedRole && tailoredResult.pdf?.sourceId === resumeSourceId
            ? tailoredResult.pdf.text : resumeText) : undefined,
          requirementsText: deliveryMode === 'manual' ? [conditionDescription ? '希望寻找满足以下条件的工作：' + conditionDescription : '', manualRequirements.trim()].filter(Boolean).join('；') : undefined,
          defaultGreeting: deliveryMode === 'resume' && !usesSavedExpectations && tailoredResult?.targetRole === selectedRole ? customGreeting : undefined,
        }),
      });
      const json = await res.json();
      if (json.success) {
        setStartMessage('投递任务已启动，可在运行记录中查看进度。');
        setActiveTab('delivery');
      } else {
        setStartMessage(`启动失败：${json.message || '未知错误'}`);
        if (json.reasonCode) {
          setIsBossLoggedIn(false);
          setLoginReasonCode(json.reasonCode);
          setLoginReason(json.message || '无法确认登录状态');
        }
      }
    } catch (e) {
      setStartMessage(`启动请求失败：${(e as Error).message}`);
    } finally {
      setIsStarting(false);
    }
  };

  const handlePauseDelivery = async () => {
    const res = await fetch('/api/delivery/pause', { method: 'POST' });
    if (!res.ok) alert((await res.json()).message || '暂停失败');
  };

  const handleResumeDelivery = async () => {
    const res = await fetch('/api/delivery/resume', { method: 'POST' });
    if (!res.ok) alert((await res.json()).message || '恢复失败');
  };

  const handleStopDelivery = async () => {
    await fetch('/api/delivery/stop', { method: 'POST' });
  };

  const currentPage = navigationItems.find(item => item.id === activeTab);
  const pageTitle = currentPage?.label || 'AI 设置';
  const pageDescription = currentPage?.description || '管理 DeepSeek 账号、思考模式与批量评估。';
  const modelLabel = config?.llm.connectionMode === 'deepseek-web' ? 'DeepSeek 网页' : config?.llm.model || '尚未设置模型';
  const summaryTargets = usesSavedExpectations ? targetSlots.filter((item): item is BossPositionSelection => !!item)
    : searchByConditions ? [] : selectedPosition ? [selectedPosition] : [];
  const quota = config?.delivery.dailyMaxQuota ?? 0;
  return (
    <div className="app-shell">
      <DesktopTitleBar />
      <div className="workbench">
        <aside className="app-sidebar" aria-label="工作台侧栏">
          <a className="skip-link" href="#workspace-content">跳到页面内容</a>
          <div className="sidebar-brand">
            <span className="brand-mark"><img src="/jobloom-icon.png" width="38" height="38" alt="" /></span>
            <div><strong>拾职</strong><span>Jobloom · 求职工作台</span></div>
          </div>
          <nav className="sidebar-nav" aria-label="工作台导航">
            {navigationItems.map(tab => {
              const Icon = tab.icon;
              return <button key={tab.id} type="button" className={`nav-item ${activeTab === tab.id ? 'active' : ''}`}
                aria-current={activeTab === tab.id ? 'page' : undefined} aria-label={tab.label}
                onClick={() => setActiveTab(tab.id)}>
                <Icon size={18} strokeWidth={1.7} /><span>{tab.label}</span>
                {tab.id === 'delivery' && isTaskRunning && <span className="nav-running-dot" title="任务正在运行" />}
              </button>;
            })}
            <div className="sidebar-settings">
              <button type="button" className={`nav-item ${activeTab === 'settings' ? 'active' : ''}`} aria-label="设置"
                aria-current={activeTab === 'settings' ? 'page' : undefined} onClick={() => setActiveTab('settings')}>
                <Settings size={18} strokeWidth={1.7} /><span>AI 设置</span>
              </button>
            </div>
          </nav>
          <div className="sidebar-model"><Sparkles size={17} /><div><span>当前模型</span><strong>{modelLabel}</strong></div></div>
        </aside>
        <div className="workspace">
          <header className="app-header">
            <div className="page-heading"><h1>{pageTitle}</h1><p>{pageDescription}</p></div>
            <div className="session-tools">
              <div className={`session-status ${isBossLoggedIn ? 'ready' : 'pending'}`} title={loginReason}>
                <span className="session-dot" />
                <span>{isBossLoggedIn ? 'BOSS 已连接' : isCheckingLogin ? '正在检查会话' : loginReasonCode === 'resting' ? 'BOSS 关闭休息中' : loginReasonCode === 'login_required' ? 'BOSS 未登录' : 'BOSS 待检查'}</span>
              </div>
              {!isBossLoggedIn && loginReasonCode === 'login_required' && <button type="button" className="button-small"
                disabled={isCheckingLogin} onClick={handlePromptLogin}>{isCheckingLogin ? '正在打开…' : '打开扫码页'}</button>}
              {!isBossLoggedIn && loginReasonCode !== 'resting' && (loginPageOpened || loginReasonCode === 'unverified') && <button type="button" className="button-small"
                disabled={isCheckingLogin} onClick={handleVerifyLogin} title="扫码完成后点击验证">验证会话</button>}
              <button type="button" className="icon-button" aria-label="刷新 BOSS 会话" title="检查保存的 BOSS 会话"
                disabled={isCheckingLogin} onClick={() => void checkLoginStatus()}>
                <RefreshCw size={16} className={isCheckingLogin ? 'spinning-indicator' : ''} />
              </button>
            </div>
          </header>
          <main className="workspace-main" id="workspace-content" ref={mainRef} tabIndex={-1}>
        {activeTab === 'launch' && (
          <div className="launch-shell">
            <section className="launch-hero">
              <h2>下一份工作，从这里开始。</h2>
              <p>选好目标和工作条件，或用简历让 AI 帮你匹配。</p>
            </section>
            <div className="launch-layout">
              <div className="launch-editor">
                <div className="path-grid" aria-label="投递方式">
                  <button type="button" aria-pressed={deliveryMode === 'resume'} className={`path-card ${deliveryMode === 'resume' ? 'selected' : ''}`}
                    onClick={() => { setDeliveryMode('resume'); setStartMessage(''); }}>
                    <span className="path-icon"><FileText size={20} /></span>
                    <span className="path-copy"><strong>用简历匹配</strong><small>上传简历，直接匹配岗位</small></span>
                    {deliveryMode === 'resume' && <Check size={16} className="path-check" />}
                  </button>
                  <button type="button" aria-pressed={deliveryMode === 'manual'} className={`path-card ${deliveryMode === 'manual' ? 'selected' : ''}`}
                    onClick={() => { setDeliveryMode('manual'); setStartMessage(''); }}>
                    <span className="path-icon"><Sliders size={20} /></span>
                    <span className="path-copy"><strong>手动指定目标</strong><small>按岗位与要求找工作</small></span>
                    {deliveryMode === 'manual' && <Check size={16} className="path-check" />}
                  </button>
                </div>
            <section className="launch-panel">
              <div className="launch-panel-head">
                <div>
                  <h3>{deliveryMode === 'resume' ? '简历匹配' : '手动目标'}</h3>
                </div>
                <span className="optional-tag">分析与优化按需使用</span>
              </div>

              <div className="launch-field">
                <label htmlFor="boss-job-source">BOSS 职位来源</label>
                <select id="boss-job-source" value={config?.delivery.jobSource || 'saved_expectations'} disabled={!config || isTaskRunning}
                  onChange={(event) => config && setConfig({ ...config, delivery: { ...config.delivery,
                    jobSource: event.target.value as AppConfig['delivery']['jobSource'] } })}>
                  <option value="saved_expectations">按目标设置 BOSS 自选岗位</option>
                  <option value="search">按官方分类和关键词搜索</option>
                  <option value="recommendation">按 BOSS 推荐页找岗位</option>
                  <option value="message_recommendations">消息中带「荐」标记的岗位</option>
                </select>
                <p>{usesSavedExpectations ? '按目标岗位和城市调整 BOSS 的自选职位，再逐个筛选。' : config?.delivery.jobSource === 'message_recommendations' ? '读取电脑网页消息列表中 BOSS 标记「荐」的岗位，再按当前条件筛选。当前没有标记时会显示未发现。手机「综合推荐 → 新职位」汇总尚未接入，与此来源不同。' : usesRecommendation ? '从 BOSS 的推荐列表找岗位，继续核对你的目标、工作条件、排除项和距离。' : '按官方分类和搜索词查找职位。'}</p>
              </div>

              {deliveryMode === 'manual' && (
                <label className="conditions-only-choice">
                  <input type="checkbox" checked={conditionsOnly} disabled={isTaskRunning}
                    onChange={(event) => {
                      setConditionsOnly(event.target.checked);
                      if (event.target.checked && config) {
                        setConfig({ ...config, filter: { ...config.filter, workRequirements: selectedConditions.length
                          ? config.filter.workRequirements : withWorkConditionPresets(config.filter.workRequirements || []) } });
                        setSearchKeywords([]);
                      }
                    }} />
                  {usesSavedExpectations ? '根据工作条件找岗位' : '不限岗位，按工作条件找'}
                </label>
              )}

              {deliveryMode === 'resume' ? (
                <div className="launch-source-box">
                  <div>
                    <strong>{resumeFileName || '选择一份简历'}</strong>
                    <p>{resumeText ? `已读取 ${resumeText.length} 字，可直接用于岗位评估` : '支持 PDF、Word、Markdown 和纯文本'}</p>
                  </div>
                  <label className="file-pick">
                    {isUploading ? '正在读取…' : resumeText ? '更换简历' : '上传简历'}
                    <input type="file" accept=".pdf,.docx,.txt,.md" onChange={handleFileUpload} disabled={isUploading} />
                  </label>
                </div>
              ) : (
                <div className="launch-field">
                  <label htmlFor="manual-requirements">{searchByConditions || usesSavedExpectations ? '补充要求' : '你的岗位要求'} <span>{searchByConditions || (usesSavedExpectations && selectedConditions.length) ? '可选' : '必填'}</span></label>
                  <textarea
                    id="manual-requirements"
                    rows={3}
                    value={manualRequirements}
                    onChange={(e) => setManualRequirements(e.target.value)}
                    placeholder={searchByConditions ? '例如：不做销售、不上夜班、希望离地铁近。已选工作条件无需重复填写。' : '例如：优先内容运营或文职岗位，不做销售、不上夜班，可以接受从基础工作做起。'}
                  />
                  <p>AI 会按这里写的条件筛选职位，不会替你编造工作经历。</p>
                </div>
              )}

              <div className="launch-fields-grid">
                <div className="launch-field wide">
                  {usesSavedExpectations && <section aria-label="BOSS 自选目标设置" style={{ display: 'grid', gap: '16px', marginBottom: '20px' }}>
                    <strong>目标岗位 <span className="field-hint">最多 3 个</span></strong>
                    <p>按这里选择的官方岗位调整 BOSS 自选职位。留空时，AI 根据当前简历或求职要求选择方向。</p>
                    {targetSlots.map((position, index) => <div key={index} aria-label={`目标岗位${index + 1}`}>
                      <BossPositionPicker catalog={bossPositions} value={position} loading={isLoadingPositions} error={positionError} disabled={isTaskRunning}
                        optional onChange={value => handleTargetSlotChange(index, value)} onRefresh={() => fetchBossPositions(true)} />
                      {position || targetSlots.length > 1 ? <button type="button" disabled={isTaskRunning} onClick={() => removeTargetSlot(index)} style={{ marginTop: '8px' }}>移除目标{index + 1}</button> : null}
                    </div>)}
                    {targetSlots.length < 3 && <button type="button" disabled={isTaskRunning} onClick={() => setTargetSlots(previous => [...previous, undefined])}>添加目标岗位</button>}
                  </section>}
                  {(searchByConditions || usesSavedExpectations || usesRecommendation) && config ? (
                    <>
                      {usesRecommendation && !searchByConditions && <section><strong>目标岗位（可选）</strong><BossPositionPicker catalog={bossPositions} value={selectedPosition} loading={isLoadingPositions} error={positionError} disabled={isTaskRunning} optional onChange={handlePositionChange} onRefresh={() => fetchBossPositions(true)} /></section>}
                      <WorkConditionOptions value={config.filter.workRequirements} disabled={isTaskRunning}
                        onChange={(value) => setConfig({ ...config, filter: { ...config.filter, workRequirements: value } })} />
                      <div className="conditions-salary">
                        <span>当前薪资：{config.filter.salaryMin || config.filter.salaryMax
                          ? (config.filter.salaryMin || 0) + '–' + (config.filter.salaryMax || '不限') + 'K/月' : '不限'}</span>
                        {(config.filter.salaryMin || config.filter.salaryMax) ? <button type="button" disabled={isTaskRunning}
                          onClick={() => setConfig({ ...config, filter: { ...config.filter, salaryMin: 0, salaryMax: 0 } })}>薪资改为不限</button> : null}
                      </div>
                    </>
                  ) : <BossPositionPicker catalog={bossPositions} value={selectedPosition} loading={isLoadingPositions} error={positionError} disabled={isTaskRunning} onChange={handlePositionChange} onRefresh={() => fetchBossPositions(true)} />}
                </div>
                <div className="launch-field">
                  <label htmlFor="target-city">{usesSavedExpectations ? '筛选城市' : '搜索城市'}</label>
                  <select
                    id="target-city"
                    value={config?.filter.cityCode || '101010100'}
                    onChange={(e) => {
                      if (!config) return;
                      const cities: Record<string, string> = {
                        '101010100': '北京', '101020100': '上海', '101280100': '广州',
                        '101280600': '深圳', '101210100': '杭州', '101270100': '成都', '101200100': '武汉',
                      };
                      setConfig({ ...config, filter: { ...config.filter, cityCode: e.target.value, cityName: cities[e.target.value] } });
                    }}
                  >
                    <option value="101010100">北京</option>
                    <option value="101020100">上海</option>
                    <option value="101280100">广州</option>
                    <option value="101280600">深圳</option>
                    <option value="101210100">杭州</option>
                    <option value="101270100">成都</option>
                    <option value="101200100">武汉</option>
                  </select>
                </div>
                {!usesSavedExpectations && <div className="launch-field wide">
                  <label htmlFor="search-keywords">搜索词 <span>可选</span></label>
                  <input
                    id="search-keywords"
                    value={searchKeywords.join('，')}
                    onChange={(e) => setSearchKeywords(e.target.value.split(/[，,、]/).map((word) => word.trim()).filter(Boolean))}
                    placeholder={searchByConditions ? '可填行政、客服等方向；留空时使用预设搜索词，没有预设则浏览该城市岗位' : '留空则搜索该官方岗位分类下的全部职位；填写后进一步缩小范围'}
                  />
                </div>}
              </div>

              <div className="launch-options">
                <button type="button" onClick={() => setActiveTab('rules')}><Sliders size={16} /> 筛选规则与每日数量</button>
                {deliveryMode === 'resume' && resumeText && (
                  <button type="button" onClick={() => setActiveTab('diagnosis')}><Sparkles size={16} /> 分析简历并推荐岗位</button>
                )}
                {deliveryMode === 'resume' && selectedRole && resumeText && (
                  <button type="button" onClick={() => setActiveTab('tailor')}><Compass size={16} /> 优化简历与开场语</button>
                )}
              </div>

            </section>
              </div>
              <aside className="launch-summary" aria-label="投递概览">
                <div className="summary-heading"><Compass size={19} /><h3>这次投递</h3></div>
                <dl className="summary-details">
                  <div><dt><MapPin size={14} />求职城市</dt><dd>{config?.filter.cityName || '尚未载入'}</dd></div>
                  <div><dt>匹配方式</dt><dd>{deliveryMode === 'resume' ? '简历匹配' : '手动目标'}</dd></div>
                  <div><dt>职位来源</dt><dd>{jobSourceLabels[config?.delivery.jobSource || 'saved_expectations']}</dd></div>
                </dl>
                <div className="summary-section"><h4>目标方向</h4>
                  <p>{summaryTargets.length ? summaryTargets.map(item => item.name).join('、') : searchByConditions ? '按工作条件找岗位' : usesSavedExpectations ? '由 AI 规划目标岗位' : '选择一个官方岗位'}</p>
                </div>
                <div className="summary-section"><h4>工作条件 <span>{selectedConditions.length} 项</span></h4>
                  {selectedConditions.length ? <ul className="summary-conditions">{selectedConditions.map(item => <li key={item.id}><Check size={13} />{item.text}</li>)}</ul>
                    : <p className="summary-empty">可添加工作时长、休息日等要求</p>}
                </div>
                <div className="summary-quota"><div><span>今日已投递</span><strong>{deliveryStats.todayAppliedCount}<small> / {quota}</small></strong></div>
                  <progress aria-label="今日投递进度" max={Math.max(1, quota)} value={Math.min(deliveryStats.todayAppliedCount, Math.max(1, quota))} />
                  <button type="button" className="text-button" onClick={() => setActiveTab('rules')}>调整筛选与每日数量</button>
                </div>
                {startMessage && <p role="status" className={`launch-message ${startMessage.startsWith('投递任务已启动') ? 'success' : ''}`}>{startMessage}</p>}
                <button type="button" className="launch-submit" onClick={handleStartDelivery} disabled={isStarting || isTaskRunning}>
                  <Play size={16} /> {isStarting ? '正在检查并启动…' : isTaskRunning ? '投递任务运行中' : '开始投递'}
                </button>
                <p className="summary-footnote">开始时检查已保存的 BOSS 会话。</p>
                {isTaskRunning && <button type="button" className="text-button" onClick={() => setActiveTab('delivery')}>查看运行进度</button>}
              </aside>
            </div>
          </div>
        )}
        {/* TAB 1: 简历诊断与推荐 */}
        {activeTab === 'diagnosis' && (
          <div className="page-column diagnosis-page">
            {/* 上传卡片 */}
            <div
              style={{
                backgroundColor: 'var(--surface)',
                padding: '24px',
                borderRadius: '12px',
                border: '1px solid var(--border-color)',
              }}
            >
              <h2 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Upload size={18} color="var(--primary)" />
                上传简历
              </h2>

              <div
                style={{
                  border: '2px dashed var(--border-strong)',
                  borderRadius: '8px',
                  padding: '32px',
                  textAlign: 'center',
                  backgroundColor: 'var(--surface-subtle)',
                  cursor: 'pointer',
                  position: 'relative',
                }}
              >
                <input
                  type="file"
                  accept=".pdf,.docx,.txt,.md"
                  onChange={handleFileUpload}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: '100%',
                    opacity: 0,
                    cursor: 'pointer',
                  }}
                />
                <FileText size={40} color="var(--text-muted)" style={{ margin: '0 auto 12px' }} />
                {isUploading ? (
                  <div>
                    <p style={{ color: 'var(--accent-blue)', fontWeight: 600, fontSize: '15px' }}>正在解析简历文本中...</p>
                    <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '4px' }}>正在安全读取 PDF/Word 内容，请稍候</p>
                  </div>
                ) : resumeFileName ? (
                  <div>
                    <p style={{ color: 'var(--success)', fontWeight: 600, fontSize: '15px' }}>已加载: {resumeFileName}</p>
                    <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '4px' }}>
                      已成功提取约 {resumeText.length} 字内容，点击下方按钮开始 AI 深度诊断
                    </p>
                  </div>
                ) : (
                  <div>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '15px' }}>点击或将简历文件拖拽至此处上传</p>
                    <p style={{ color: 'var(--text-muted)', fontSize: '12px', marginTop: '6px' }}>
                      支持 PDF、Word、Markdown 和纯文本
                    </p>
                  </div>
                )}
              </div>

              {resumeText && (
                <div style={{ marginTop: '16px', display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
                  <button
                    onClick={handleDiagnose}
                    disabled={isDiagnosing}
                    style={{
                      padding: '10px 24px',
                      backgroundColor: 'var(--primary)',
                      color: '#fff',
                      borderRadius: '8px',
                      fontWeight: 600,
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                    }}
                  >
                    <Sparkles size={18} />
                    {isDiagnosing ? 'AI 正在分析…' : '分析简历与推荐岗位'}
                  </button>
                </div>
              )}
            </div>

            {/* 诊断结果展示 */}
            {diagnosis && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                <div
                  style={{
                    backgroundColor: 'var(--surface)',
                    padding: '20px',
                    borderRadius: '12px',
                    border: '1px solid var(--border-color)',
                  }}
                >
                  <h3 style={{ fontSize: '15px', color: 'var(--text-muted)', marginBottom: '8px' }}>求职者核心竞争力画像</h3>
                  <p style={{ fontSize: '15px', lineHeight: '1.6', color: 'var(--text-main)' }}>{diagnosis.summary}</p>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '12px' }}>
                    {diagnosis.coreSkills?.map((skill, idx) => (
                      <span
                        key={idx}
                        style={{
                          padding: '4px 10px',
                          borderRadius: '6px',
                          backgroundColor: 'var(--border-color)',
                          color: 'var(--accent-blue)',
                          fontSize: '12px',
                          fontWeight: 500,
                        }}
                      >
                        {skill}
                      </span>
                    ))}
                  </div>
                </div>

                <h3 style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text-main)' }}>
                  推荐岗位方向：选定后即可投递，简历改写可按需进行
                </h3>

                <div className="recommendation-grid">
                  {diagnosis.recommendations?.map((rec, idx) => (
                    <div
                      key={idx}
                      style={{
                        backgroundColor: 'var(--surface)',
                        borderRadius: '12px',
                        border: selectedRole === rec.roleTitle ? '2px solid var(--primary)' : '1px solid var(--border-color)',
                        padding: '20px',
                        display: 'flex',
                        flexDirection: 'column',
                        justifyContent: 'space-between',
                      }}
                    >
                      <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                          <h4 style={{ fontSize: '16px', fontWeight: 'bold', color: 'var(--text-main)' }}>{rec.roleTitle}</h4>
                          <span
                            style={{
                              padding: '2px 8px',
                              borderRadius: '12px',
                              backgroundColor: 'var(--success-bg)',
                              color: 'var(--success)',
                              fontSize: '12px',
                              fontWeight: 600,
                            }}
                          >
                            匹配度 {rec.matchScore}%
                          </span>
                        </div>
                        <p style={{ fontSize: '13px', color: 'var(--text-muted)', lineHeight: '1.5', marginBottom: '12px' }}>
                          {rec.recommendedReason}
                        </p>

                        <div style={{ marginBottom: '8px' }}>
                          <span style={{ fontSize: '12px', color: 'var(--accent-blue)', fontWeight: 600 }}>核心胜任优势:</span>
                          <ul style={{ paddingLeft: '18px', fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                            {rec.advantages?.map((adv, aIdx) => <li key={aIdx}>{adv}</li>)}
                          </ul>
                        </div>

                        {rec.gapAdvice?.length > 0 && (
                          <div style={{ marginBottom: '12px' }}>
                            <span style={{ fontSize: '12px', color: 'var(--accent-amber)', fontWeight: 600 }}>建议准备/补强:</span>
                            <ul style={{ paddingLeft: '18px', fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
                              {rec.gapAdvice?.map((gap, gIdx) => <li key={gIdx}>{gap}</li>)}
                            </ul>
                          </div>
                        )}
                      </div>

                      <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
                        <button
                          onClick={() => handleSelectRole(rec, 'launch')}
                          style={{ flex: 1, padding: '10px', borderRadius: '8px', backgroundColor: 'var(--primary)', color: '#fff', fontWeight: 600, fontSize: '13px' }}
                        >
                          选此岗位去投递
                        </button>
                        <button
                          onClick={() => handleSelectRole(rec, 'tailor')}
                          style={{ padding: '10px', borderRadius: '8px', backgroundColor: 'var(--border-color)', color: 'var(--accent-blue)', fontWeight: 600, fontSize: '13px' }}
                        >
                          先优化简历
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* TAB 2: 针对性改写与自荐语 */}
        {activeTab === 'tailor' && (
          <div className="page-column">
            <div
              style={{
                backgroundColor: 'var(--surface)',
                padding: '20px',
                borderRadius: '12px',
                border: '1px solid var(--border-color)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: '14px',
              }}
            >
              <div>
                <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>当前选择的投递目标方向:</span>
                <h2 style={{ fontSize: '20px', fontWeight: 'bold', color: 'var(--primary)', marginTop: '4px' }}>
                  {selectedRole || '请从 BOSS 官方分类或简历分析中选择'}
                </h2>
              </div>
              <div className="action-row">
                <button type="button" onClick={() => setActiveTab('launch')}>选择官方岗位</button>
                <button
                  onClick={handleRewrite}
                  disabled={isRewriting || !selectedRole || !resumeSourceId || resumeFormat !== 'pdf'}
                  style={{
                    padding: '10px 20px',
                    backgroundColor: 'var(--primary)',
                    color: '#fff',
                    borderRadius: '8px',
                    fontWeight: 600,
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}
                >
                  <Sparkles size={16} />
                  {isRewriting ? 'AI 润色并生成 PDF…' : '优化并生成原版式 PDF'}
                </button>
              </div>
            </div>

            <p className="resume-source-help">{resumeSourceId && resumeFormat === 'pdf' ? `原 PDF：${resumeFileName}，分析步骤可跳过。`
              : '请先在简历分析页上传原 PDF 简历；可以直接优化，无需先分析。'}
              <button type="button" disabled={isRewriting} onClick={() => setActiveTab('diagnosis')}>选择原 PDF</button></p>

            {tailoredResult && tailoredResult.targetRole === selectedRole && tailoredResult.pdf?.sourceId === resumeSourceId && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                {/* 3大核心亮点与首聊词 */}
                <div className="form-grid">
                  <div
                    style={{
                      backgroundColor: 'var(--surface)',
                      padding: '16px',
                      borderRadius: '12px',
                      border: '1px solid var(--border-color)',
                    }}
                  >
                    <h3 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--accent-blue)', marginBottom: '8px' }}>
                      适合【{selectedRole}】的核心优势
                    </h3>
                    <ul style={{ paddingLeft: '20px', fontSize: '13px', lineHeight: '1.6', color: 'var(--text-secondary)' }}>
                      {tailoredResult.topHighlights?.map((h, i) => (
                        <li key={i}>{h}</li>
                      ))}
                    </ul>
                  </div>

                  <div
                    style={{
                      backgroundColor: 'var(--surface)',
                      padding: '16px',
                      borderRadius: '12px',
                      border: '1px solid var(--border-color)',
                    }}
                  >
                    <h3 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--success)', marginBottom: '8px' }}>
                      打招呼内容（可编辑）
                    </h3>
                    <textarea
                      rows={4}
                      value={customGreeting}
                      onChange={(e) => setCustomGreeting(e.target.value)}
                      style={{ width: '100%', resize: 'vertical', fontSize: '13px', lineHeight: '1.5' }}
                    />
                  </div>
                </div>

                <ResumePdfPanel key={tailoredResult.pdf?.id || 'legacy'} result={tailoredResult} disabled={isTaskRunning || isRewriting}
                  onUpdate={setTailoredResult} onUse={() => { setDeliveryMode('resume'); setActiveTab('launch'); }} />
              </div>
            )}
          </div>
        )}

        {/* TAB 3: 筛选规则 */}
        {activeTab === 'rules' && config && (
          <div className="page-column rules-page">
            <div
              style={{
                backgroundColor: 'var(--surface)',
                padding: '24px',
                borderRadius: '12px',
                border: '1px solid var(--border-color)',
              }}
            >
              <h2 style={{ fontSize: '18px', fontWeight: 'bold', marginBottom: '20px', color: 'var(--text-main)' }}>
                岗位筛选规则
              </h2>

              <WorkConditionOptions value={config.filter.workRequirements} disabled={isTaskRunning}
                onChange={(value) => setConfig({ ...config, filter: { ...config.filter, workRequirements: value } })} />

              <LocationFilterOptions value={config.filter.commute} cityName={config.filter.cityName} disabled={isTaskRunning}
                onChange={commute => setConfig({ ...config, filter: { ...config.filter, commute } })} />

              <NotSuitablePanel disabled={isTaskRunning} />

              <div className="form-grid">
                {/* 城市 */}
                <div>
                  <label style={{ fontSize: '13px', color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>
                    目标求职城市
                  </label>
                  <select
                    value={config.filter.cityCode}
                    onChange={(e) => {
                      const mapping: Record<string, string> = {
                        '101010100': '北京',
                        '101020100': '上海',
                        '101280100': '广州',
                        '101280600': '深圳',
                        '101210100': '杭州',
                        '101270100': '成都',
                        '101200100': '武汉',
                      };
                      setConfig({
                        ...config,
                        filter: {
                          ...config.filter,
                          cityCode: e.target.value,
                          cityName: mapping[e.target.value] || '其他',
                        },
                      });
                    }}
                    style={{ width: '100%' }}
                  >
                    <option value="101010100">北京</option>
                    <option value="101020100">上海</option>
                    <option value="101280600">深圳</option>
                    <option value="101280100">广州</option>
                    <option value="101210100">杭州</option>
                    <option value="101270100">成都</option>
                    <option value="101200100">武汉</option>
                  </select>
                </div>

                {/* 薪资范围 */}
                <div>
                  <label style={{ fontSize: '13px', color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>
                    期望月薪区间 (K)
                  </label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <input
                      type="number"
                      min="0" aria-label="期望月薪下限" placeholder="不限"
                      value={config.filter.salaryMin || ''}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          filter: { ...config.filter, salaryMin: Number(e.target.value) },
                        })
                      }
                      style={{ width: '80px' }}
                    />
                    <span>K ~</span>
                    <input
                      type="number"
                      min="0" aria-label="期望月薪上限" placeholder="不限"
                      value={config.filter.salaryMax || ''}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          filter: { ...config.filter, salaryMax: Number(e.target.value) },
                        })
                      }
                      style={{ width: '80px' }}
                    />
                    <span>K</span>
                  </div>
                </div>

                <div>
                  <label htmlFor="candidate-degree" style={{ fontSize: '13px', color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>
                    我的最高学历
                  </label>
                  <select id="candidate-degree" value={config.filter.degree[0] || ''} onChange={(event) =>
                    setConfig({ ...config, filter: { ...config.filter, degree: event.target.value ? [event.target.value] : [] } })
                  } style={{ width: '100%' }}>
                    <option value="">不设置</option>
                    {['初中', '高中', '中专', '大专', '本科', '硕士', '博士'].map((degree) => <option key={degree} value={degree}>{degree}</option>)}
                  </select>
                  <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '6px', lineHeight: 1.6 }}>
                    按岗位最低学历判断。本科可匹配大专、本科及学历不限的岗位。
                  </p>
                </div>

                <div style={{ gridColumn: '1 / -1' }}>
                  <label htmlFor="candidate-languages" style={{ fontSize: '13px', color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>我的语言能力</label>
                  <textarea id="candidate-languages" value={config.filter.candidateLanguages || ''} maxLength={1000} rows={2}
                    placeholder="例如：英语 CET4；日语 N1，口语流利；西班牙语熟练，能听懂哥斯达黎加口音"
                    disabled={isTaskRunning} onChange={event => setConfig({ ...config, filter: { ...config.filter, candidateLanguages: event.target.value } })}
                    style={{ width: '100%' }} />
                  <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '6px', lineHeight: 1.6 }}>
                    填写自己具备的语言、水平和证书，也可从简历读取。岗位明确要求某语言而没有达标依据时，先淘汰；“优先”和“可培训”保留。证书不能自动证明口语流利或掌握特定口音。
                  </p>
                </div>

                <div>
                  <label htmlFor="experience-match-mode" style={{ fontSize: '13px', color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>
                    经验筛选方式
                  </label>
                  <select id="experience-match-mode" value={config.filter.experienceMatchMode || 'flexible'} onChange={(event) =>
                    setConfig({ ...config, filter: { ...config.filter, experienceMatchMode: event.target.value === 'strict' ? 'strict' : 'flexible' } })
                  } style={{ width: '100%' }}>
                    <option value="flexible">宽泛：经验标签作参考（推荐）</option>
                    <option value="strict">严格：按经验标签和条件筛选</option>
                  </select>
                  <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '6px', lineHeight: 1.6 }}>
                    {config.filter.experienceMatchMode === 'strict'
                      ? '启用“允许无经验”时核对标签与正文，冲突留待确认；否则按下方经验范围筛选，留空表示不限。'
                      : '“1—3年”标签和“经验优先”不直接淘汰。正文明确允许无经验可继续筛选；经验条件不清楚时留待确认。'}
                  </p>
                  {config.filter.experienceMatchMode === 'strict' && <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '8px' }}>
                    {['应届生', '1年以内', '1-3年', '3-5年', '5-10年', '10年以上'].map((experience) => <label key={experience} style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                      <input type="checkbox" checked={(config.filter.experience || []).includes(experience)} onChange={(event) =>
                        setConfig({ ...config, filter: { ...config.filter, experience: event.target.checked
                          ? [...(config.filter.experience || []), experience] : (config.filter.experience || []).filter((item) => item !== experience) } })
                      } /> {experience}
                    </label>)}
                  </div>}
                </div>

                <div>
                  <label className="conditions-only-choice">
                    <input type="checkbox" checked={config.filter.skipMissingCompanyIntro !== false} disabled={isTaskRunning}
                      onChange={(event) => setConfig({ ...config, filter: { ...config.filter, skipMissingCompanyIntro: event.target.checked } })} />
                    排除公司页没有公司介绍的岗位
                  </label>
                  <label className="conditions-only-choice">
                    <input type="checkbox" checked={config.filter.skipVagueJobDescription !== false} disabled={isTaskRunning}
                      onChange={(event) => setConfig({ ...config, filter: { ...config.filter, skipVagueJobDescription: event.target.checked } })} />
                    排除职责语焉不详的岗位
                  </label>
                  <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>本地先核对职责和公司介绍，再评估其他条件。简短但写明具体工作内容的描述可以继续筛选。</p>
                </div>

                {/* HR活跃度 */}
                <div>
                  <label style={{ fontSize: '13px', color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>
                    HR 最近活跃要求 (防僵尸岗位浪费额度)
                  </label>
                  <select
                    value={config.filter.hrActiveDaysLimit}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        filter: { ...config.filter, hrActiveDaysLimit: Number(e.target.value) },
                      })
                    }
                    style={{ width: '100%' }}
                  >
                    <option value="1">只投 24小时内 / 今日活跃 HR</option>
                    <option value="3">严格过滤：3日内活跃 HR (推荐)</option>
                    <option value="7">本周内活跃 HR</option>
                  </select>
                </div>

                {/* 大模型最低打分 */}
                <div>
                  <label style={{ fontSize: '13px', color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>
                    LLM 语义匹配最低准入门槛 (0~100 分)
                  </label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <input
                      type="range"
                      min="60"
                      max="95"
                      value={config.filter.minLlmMatchScore || 75}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          filter: { ...config.filter, minLlmMatchScore: Number(e.target.value) },
                        })
                      }
                      style={{ flex: 1 }}
                    />
                    <span style={{ fontWeight: 'bold', color: 'var(--accent-blue)' }}>
                      {config.filter.minLlmMatchScore || 75} 分
                    </span>
                  </div>
                </div>
              </div>

              {/* 需求词与淘汰词 */}
              <div style={{ marginTop: '20px' }}>
                <label style={{ fontSize: '13px', color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>
                  需求词（职位名称、技能标签或职位描述至少命中一个；留空表示不限）
                </label>
                <DelimitedListTextArea
                  rows={2}
                  placeholder="例如：React，TypeScript，前端架构"
                  aria-label="需求词"
                  values={config.filter.requiredKeywords || []}
                  onValuesChange={values => setConfig(previous => previous ? {
                    ...previous, filter: { ...previous.filter, requiredKeywords: values },
                  } : previous)}
                  style={{ width: '100%', fontSize: '13px' }}
                />
              </div>
              <div style={{ marginTop: '20px' }}>
                <label style={{ fontSize: '13px', color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>
                  排除行业、岗位或公司（逗号分隔）
                </label>
                <DelimitedListTextArea
                  rows={3}
                  aria-label="排除行业、岗位或公司（逗号分隔）"
                  values={config.filter.companyBlacklist || []}
                  onValuesChange={values => setConfig(previous => previous ? {
                    ...previous, filter: { ...previous.filter, companyBlacklist: values },
                  } : previous)}
                  style={{ width: '100%', fontSize: '13px' }}
                />
                <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '6px' }}>
                  检查岗位名称、标签、明确职责，以及公司页行业、介绍和经营范围。金融包含银行、证券、信贷、助贷等；销售会识别电销、网销及实际销售任务。
                </p>
              </div>

              {/* 每日投递限制与浏览间隔 */}
              <div className="form-grid" style={{ marginTop: 20 }}>
                <div>
                  <label style={{ fontSize: '13px', color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>
                    每日自动投递数（0–150；0 表示不投递）
                  </label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <input
                      type="range"
                      min="0"
                      max="150"
                      step="1"
                      value={config.delivery.dailyMaxQuota ?? 80}
                      onChange={(e) => setConfig({
                        ...config,
                        delivery: { ...config.delivery, dailyMaxQuota: Number(e.target.value) },
                      })}
                      style={{ flex: 1 }}
                    />
                    <input
                      type="number"
                      min="0"
                      max="150"
                      step="1"
                      value={config.delivery.dailyMaxQuota ?? 80}
                      onChange={(e) => setConfig({
                        ...config,
                        delivery: { ...config.delivery, dailyMaxQuota: Math.max(0, Math.min(150, Number(e.target.value) || 0)) },
                      })}
                      style={{ width: '72px' }}
                    />
                  </div>
                </div>

              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '24px', gap: '12px' }}>
                <button
                  onClick={() => saveConfig(config)}
                  style={{
                    padding: '10px 24px',
                    backgroundColor: 'var(--border-color)',
                    color: '#fff',
                    borderRadius: '8px',
                    fontWeight: 600,
                  }}
                >
                  保存配置
                </button>
                <button
                  onClick={() => {
                    saveConfig(config);
                    setActiveTab('launch');
                  }}
                  style={{
                    padding: '10px 24px',
                    backgroundColor: 'var(--primary)',
                    color: '#fff',
                    borderRadius: '8px',
                    fontWeight: 600,
                  }}
                >
                  保存并返回投递 →
                </button>
              </div>
            </div>
          </div>
        )}

        {/* TAB 4: 投递控制台与实时监控 */}
        {activeTab === 'delivery' && (
          <div className="page-column">
            {/* 风控告警 Banner */}
            {deliveryStats.needsCaptchaVerification && (
              <div
                style={{
                  backgroundColor: 'var(--danger-bg)',
                  border: '2px solid var(--accent-rose)',
                  borderRadius: '12px',
                  padding: '16px 20px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <ShieldAlert size={28} color="var(--accent-rose)" />
                  <div>
                    <h3 style={{ fontSize: '15px', fontWeight: 'bold', color: 'var(--accent-rose)' }}>
                      BOSS 页面需要人工验证，任务已停止
                    </h3>
                    <p style={{ fontSize: '13px', color: 'var(--accent-rose)', marginTop: '2px' }}>
                      请在 BOSS 浏览器窗口完成验证，再确认账号状态并主动恢复任务。
                    </p>
                  </div>
                </div>
                <button
                  onClick={handleResumeDelivery}

                  style={{
                    padding: '8px 16px',
                    borderRadius: '8px',
                    backgroundColor: 'var(--accent-rose)',
                    color: '#fff',
                    fontWeight: 600,
                    fontSize: '13px',
                  }}
                >
                  我已完成滑动，继续投递
                </button>
              </div>
            )}

            {/* 控制卡片 */}
            <div
              style={{
                backgroundColor: 'var(--surface)',
                padding: '20px',
                borderRadius: '12px',
                border: '1px solid var(--border-color)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: '14px',
              }}
            >
              <div>
                <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>当前投递职业与检索关键词:</span>
                <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginTop: '6px' }}>
                  <strong style={{ fontSize: '18px', color: 'var(--primary)' }}>{deliveryStats.targetRoles?.join('、') || (usesSavedExpectations ? targetSlots.filter(Boolean).map(item => item!.name).join('、') || 'AI 规划目标岗位' : searchByConditions ? '按工作条件找岗位' : selectedRole || '未选择')}</strong>
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px', marginLeft: '8px' }}>
                    {searchKeywords.map((kw, i) => (
                      <span
                        key={i}
                        style={{
                          padding: '2px 8px',
                          borderRadius: '6px',
                          backgroundColor: 'var(--border-color)',
                          fontSize: '12px',
                          color: 'var(--accent-blue)',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px',
                        }}
                      >
                        {kw}
                        <X
                          size={12}
                          color="var(--text-muted)"
                          style={{ cursor: 'pointer' }}
                          onClick={() => setSearchKeywords(searchKeywords.filter((_, idx) => idx !== i))}
                        />
                      </span>
                    ))}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <input
                        type="text"
                        placeholder="加词..."
                        value={newKeywordInput}
                        onChange={(e) => setNewKeywordInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && newKeywordInput.trim()) {
                            if (!searchKeywords.includes(newKeywordInput.trim())) {
                              setSearchKeywords([...searchKeywords, newKeywordInput.trim()]);
                            }
                            setNewKeywordInput('');
                          }
                        }}
                        style={{ width: '80px', padding: '2px 6px', fontSize: '12px' }}
                      />
                      <button
                        onClick={() => {
                          if (newKeywordInput.trim() && !searchKeywords.includes(newKeywordInput.trim())) {
                            setSearchKeywords([...searchKeywords, newKeywordInput.trim()]);
                            setNewKeywordInput('');
                          }
                        }}
                        style={{ background: 'none', color: 'var(--accent-blue)', padding: '2px' }}
                      >
                        <Plus size={16} />
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* 运行控制按键 */}
              <div className="action-row">
                {deliveryStats.status === 'idle' || deliveryStats.status === 'finished' || deliveryStats.status === 'failed' ? (
                  <button
                    onClick={() => setActiveTab('launch')}
                    disabled={isStarting}
                    style={{
                      padding: '10px 24px',
                      borderRadius: '8px',
                      backgroundColor: 'var(--primary)',
                      color: '#fff',
                      fontWeight: 600,
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                    }}
                  >
                    <Play size={18} />
                    配置并开始投递
                  </button>
                ) : ['running', 'sage_time'].includes(deliveryStats.status) ? (
                  <button
                    onClick={handlePauseDelivery}
                    style={{
                      padding: '10px 20px',
                      borderRadius: '8px',
                      backgroundColor: 'var(--accent-amber)',
                      color: 'var(--surface-subtle)',
                      fontWeight: 600,
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                    }}
                  >
                    <Pause size={18} />
                    暂停投递
                  </button>
                ) : null}

                {deliveryStats.isPaused && (
                  <button
                    onClick={handleResumeDelivery}

                    style={{
                      padding: '10px 20px',
                      borderRadius: '8px',
                      backgroundColor: 'var(--primary)',
                      color: '#fff',
                      fontWeight: 600,
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                    }}
                  >
                    <Play size={18} />
                    恢复运行
                  </button>
                )}

                <button
                  onClick={handleStopDelivery}
                  style={{
                    padding: '10px 16px',
                    borderRadius: '8px',
                    backgroundColor: 'var(--border-color)',
                    color: 'var(--accent-rose)',
                    border: '1px solid var(--accent-rose)',
                    fontWeight: 600,
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}
                >
                  <Square size={16} />
                  停止任务
                </button>
              </div>
            </div>

            {/* 指标看板 */}
            <div className="delivery-metrics">
              <div style={{ backgroundColor: 'var(--surface)', padding: '16px', borderRadius: '12px', border: '1px solid var(--border-color)' }}>
                <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>今日成功开聊</span>
                <p style={{ fontSize: '24px', fontWeight: 'bold', color: 'var(--success)', marginTop: '6px' }}>
                  {deliveryStats.todayAppliedCount} <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>/ {deliveryStats.dailyMaxQuota}</span>
                </p>
              </div>

              <div style={{ backgroundColor: 'var(--surface)', padding: '16px', borderRadius: '12px', border: '1px solid var(--border-color)' }}>
                <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>本轮去重浏览</span>
                <p style={{ fontSize: '24px', fontWeight: 'bold', color: 'var(--text-main)', marginTop: '6px' }}>
                  {deliveryStats.totalScanned}
                </p>
              </div>

              <div style={{ backgroundColor: 'var(--surface)', padding: '16px', borderRadius: '12px', border: '1px solid var(--border-color)' }}>
                <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>筛选通过</span>
                <p style={{ fontSize: '24px', fontWeight: 'bold', color: 'var(--accent-blue)', marginTop: '6px' }}>
                  {deliveryStats.passedFilterCount}
                </p>
              </div>

              <div style={{ backgroundColor: 'var(--surface)', padding: '16px', borderRadius: '12px', border: '1px solid var(--border-color)' }}>
                <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>已标记不合适</span>
                <p style={{ fontSize: '24px', fontWeight: 'bold', color: 'var(--accent-rose)', marginTop: '6px' }}>
                  {deliveryStats.markedNotSuitCount || 0}
                </p>
              </div>

              <div style={{ backgroundColor: 'var(--surface)', padding: '16px', borderRadius: '12px', border: '1px solid var(--border-color)' }}>
                <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>AI 异常记录</span>
                <p style={{ fontSize: '24px', fontWeight: 'bold', color: 'var(--accent-amber)', marginTop: '6px' }}>
                  {deliveryStats.skippedByLlmErrorCount || 0}
                </p>
              </div>

              <div style={{ backgroundColor: 'var(--surface)', padding: '16px', borderRadius: '12px', border: '1px solid var(--border-color)' }}>
                <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>任务状态</span>
                <p style={{ fontSize: '15px', fontWeight: 600, color: 'var(--accent-amber)', marginTop: '10px' }}>
                  {deliveryStats.status === 'running'
                    ? '正在筛选与投递'
                    : deliveryStats.status === 'paused'
                    ? '已暂停'
                    : deliveryStats.status === 'sage_time'
                    ? `浏览器关闭休息中 (${deliveryStats.sageTimeRemainingSeconds ?? 0}s)`
                    : deliveryStats.status === 'cool_down'
                    ? '等待平台限制解除'
                    : deliveryStats.status === 'finished'
                    ? '任务已完成'
                    : deliveryStats.status === 'failed'
                    ? '任务异常中止，请查看日志'
                    : '尚未开始'}
                </p>
              </div>
            </div>

            {/* 实时终端日志流 */}
            <p aria-label="评估用量" style={{ fontSize: '13px', color: 'var(--text-muted)', margin: 0 }}>
              {isTaskRunning && deliveryStats.phase ? ({ planning: '正在规划目标岗位', configuring: '正在设置 BOSS 自选岗位', screening: '脚本初筛中', evaluating: 'AI 批量分析中', delivering: '投递中' })[deliveryStats.phase] + ' · ' : ''}
              本地处理 {deliveryStats.localDecisionCount || 0} 个 · 待批量评估 {deliveryStats.pendingEvaluationCount || 0} 个 ·
              AI 请求 {deliveryStats.aiRequestCount || 0} 次 · 复用评估 {deliveryStats.cachedEvaluationCount || 0} 个
            </p>
            <div
              style={{
                backgroundColor: 'var(--surface-subtle)',
                border: '1px solid var(--border-color)',
                borderRadius: '12px',
                padding: '16px',
                display: 'flex',
                flexDirection: 'column',
                height: '420px',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: '12px',
                  borderBottom: '1px solid var(--surface)',
                  paddingBottom: '8px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Terminal size={18} color="var(--primary)" />
                  <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-main)' }}>
                    筛选与投递动态
                  </span>
                </div>
                <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>最新 300 条动态</span>
              </div>

              <div
                ref={logContainerRef}
                className="custom-scrollbar"
                style={{
                  flex: 1,
                  overflowY: 'auto',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                  fontFamily: 'Consolas, Monaco, "Courier New", monospace',
                  fontSize: '12px',
                }}
              >
                {logs.length === 0 ? (
                  <p style={{ color: 'var(--text-muted)', textAlign: 'center', marginTop: '40px' }}>
                    开始投递后，这里会显示岗位筛选和投递进度。
                  </p>
                ) : (
                  logs.map((log) => {
                    const colorMap = {
                      info: 'var(--text-muted)',
                      warn: 'var(--accent-amber)',
                      error: 'var(--accent-rose)',
                      success: 'var(--success)',
                    };
                    return (
                      <div key={log.id} style={{ display: 'flex', gap: '8px', lineHeight: '1.4' }}>
                        <span style={{ color: 'var(--text-muted)', minWidth: '70px' }}>[{log.timestamp}]</span>
                        <span style={{ color: colorMap[log.level] }}>{log.message}</span>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        )}

        {/* TAB 5: 设置 */}
        {activeTab === 'career' && <CareerPanel onResumeSelected={source => {
          setResumeSourceId(source.id); setResumeFormat(source.format); setResumeFileName(source.fileName); setResumeText(source.text);
          setDiagnosis(null); setTailoredResult(null); setCustomGreeting(''); setDeliveryMode('resume'); setActiveTab('launch');
        }} />}
        {activeTab === 'followup' && <FollowupPanel />}
        {activeTab === 'delivery' && deliveryStats.sourceMetrics && <section className="followup-settings"><h3>搜索来源效果</h3><p>各来源累计去重；同一岗位可能来自多个来源。后续轮次按确认结果分配，筛选条件保持生效。</p><div className="career-table-wrap"><table><thead><tr><th>来源</th><th>发现</th><th>详情</th><th>通过</th><th>沟通</th><th>待恢复</th><th>需决定</th></tr></thead><tbody>{deliveryStats.sourceMetrics.map(m => <tr key={m.source}><td>{m.source}</td><td>{m.unique}</td><td>{m.details}</td><td>{m.passed}</td><td>{m.sent}</td><td>{m.recovery}</td><td>{m.decisions}</td></tr>)}</tbody></table></div></section>}
        {activeTab === 'settings' && config && (
          <div className="page-column settings-page">
            <div
              style={{
                backgroundColor: 'var(--surface)',
                padding: '24px',
                borderRadius: '12px',
                border: '1px solid var(--border-color)',
              }}
            >
              <h2 style={{ fontSize: '18px', fontWeight: 'bold', marginBottom: '20px' }}>
                模型与账号
              </h2>

              {/* 模型连接预设 */}
              <div
                style={{
                  backgroundColor: 'var(--surface-subtle)',
                  border: '1px solid var(--primary)',
                  borderRadius: '10px',
                  padding: '16px',
                  marginBottom: '10px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Sparkles size={18} color="var(--primary)" />
                    <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-main)' }}>
                      选择模型连接方式
                    </span>
                  </div>
                  <span style={{ fontSize: '12px', color: 'var(--success)', backgroundColor: 'var(--accent-soft)', padding: '2px 8px', borderRadius: '10px' }}>
                    {config.llm.connectionMode === 'deepseek-web' ? 'DeepSeek 网页反代' : '兼容 API'}
                  </span>
                </div>

                <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginTop: '12px' }}>
                  <select
                    aria-label="AI 连接方式"
                    value={selectedPresetId}
                    onChange={(e) => handleSelectPreset(e.target.value)}
                    style={{ flex: 1, backgroundColor: 'var(--surface)', border: '1px solid var(--border-color)' }}
                  >
                    {presets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} — [{p.badge}]
                      </option>
                    ))}
                    <option value="custom-api">其他 OpenAI 兼容接口</option>
                  </select>
                </div>

                {/* 选定预设的说明与一键申请外链 */}
                {(() => {
                  const curr = presets.find((p) => p.id === selectedPresetId);
                  if (!curr) return null;
                  return (
                    <div style={{ marginTop: '12px', padding: '10px', backgroundColor: 'var(--surface)', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                      <p style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: '1.5' }}>
                        {curr.description}
                      </p>
                      {curr.applyUrl && (
                        <div style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <a
                            href={curr.applyUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                              color: 'var(--accent-blue)',
                              fontSize: '13px',
                              textDecoration: 'none',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '4px',
                              fontWeight: 500,
                            }}
                          >
                            {curr.connectionMode === 'deepseek-web' ? '查看反代项目' : '打开接口提供方'}
                            <ExternalLink size={14} />
                          </a>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                {config.llm.connectionMode === 'deepseek-web' && <DeepSeekAccountPanel />}
                {config.llm.connectionMode !== 'deepseek-web' && <div>
                  <label style={{ fontSize: '13px', color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>
                    接口地址（Base URL）
                  </label>
                  <input
                    type="text"
                    value={config.llm.baseUrl}
                    onChange={(e) => {
                      setConfig({ ...config, llm: { ...config.llm, baseUrl: e.target.value } });
                      setModelTestMessage('');
                    }}
                    placeholder="填写接口提供方的完整地址"
                    style={{ width: '100%' }}
                  />
                </div>}

                {config.llm.connectionMode !== 'deepseek-web' && <div>
                  <label style={{ fontSize: '13px', color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>
                    API Key
                  </label>
                  <input
                    type="password"
                    value={config.llm.apiKey}
                    onChange={(e) => {
                      setConfig({ ...config, llm: { ...config.llm, apiKey: e.target.value } });
                      setModelTestMessage('');
                    }}
                    placeholder="sk-..."
                    style={{ width: '100%' }}
                  />
                  <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
                    更换 Key 后点击“保存并测试连接”，可直接检查模型接口是否可用。
                  </p>
                </div>}

                {config.llm.connectionMode !== 'deepseek-web' && <div>
                  <label style={{ fontSize: '13px', color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>
                    Model Name (模型名称)
                  </label>
                  <input
                    type="text"
                    value={config.llm.model}
                    onChange={(e) => {
                      setConfig({ ...config, llm: { ...config.llm, model: e.target.value } });
                      setModelTestMessage('');
                    }}
                    placeholder="填写接口提供方指定的模型名称"
                    style={{ width: '100%' }}
                  />
                </div>}

                {config.llm.connectionMode === 'deepseek-web' && (
                  <section aria-label="DeepSeek 网页功能" style={{ padding: '18px', border: '1px solid var(--border-color)', borderRadius: '12px', background: 'var(--surface-subtle)' }}>
                    <h3 style={{ fontSize: '15px', margin: '0 0 8px', color: 'var(--text-main)' }}>网页功能</h3>
                    <p style={{ fontSize: '12px', lineHeight: 1.7, color: 'var(--text-muted)', margin: '0 0 16px' }}>
                      深度思考和联网搜索可以分别开启，也可以同时开启。保存后用于简历分析和岗位匹配。
                    </p>
                    <div className="settings-options-grid">
                      <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '14px', borderRadius: '10px', background: 'var(--surface)', cursor: 'pointer' }}>
                        <input type="checkbox" aria-label="深度思考" disabled={isTestingModel} checked={config.llm.thinking === 'enabled'} onChange={(event) => {
                          setConfig({ ...config, llm: { ...config.llm, thinking: event.target.checked ? 'enabled' : 'disabled' } });
                          setModelTestMessage('');
                        }} />
                        <span><strong style={{ display: 'block', fontSize: '13px', color: 'var(--text-main)' }}>深度思考</strong>
                          <span style={{ display: 'block', fontSize: '12px', lineHeight: 1.6, color: 'var(--text-muted)', marginTop: '4px' }}>深入分析简历和岗位，回答通常需要更长时间。</span>
                        </span>
                      </label>
                      <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '14px', borderRadius: '10px', background: 'var(--surface)', cursor: 'pointer' }}>
                        <input type="checkbox" aria-label="联网搜索" disabled={isTestingModel} checked={config.llm.webSearch === true} onChange={(event) => {
                          setConfig({ ...config, llm: { ...config.llm, webSearch: event.target.checked } });
                          setModelTestMessage('');
                        }} />
                        <span><strong style={{ display: 'block', fontSize: '13px', color: 'var(--text-main)' }}>联网搜索</strong>
                          <span style={{ display: 'block', fontSize: '12px', lineHeight: 1.6, color: 'var(--text-muted)', marginTop: '4px' }}>允许模型搜索网页，补充公司或岗位相关信息。</span>
                        </span>
                      </label>
                    </div>
                  </section>
                )}
                {modelTestMessage && (
                  <p role="status" style={{ fontSize: '13px', color: modelTestMessage.startsWith('连接失败') ? 'var(--accent-rose)' : 'var(--success)' }}>
                    {modelTestMessage}
                  </p>
                )}
                <section aria-label="AI 调用安排" style={{ padding: '18px', border: '1px solid var(--border-color)', borderRadius: '12px', background: 'var(--surface-subtle)' }}>
                  <h3 style={{ fontSize: '15px', margin: '0 0 8px', color: 'var(--text-main)' }}>先初筛，再批量评估</h3>
                  <p style={{ fontSize: '12px', lineHeight: 1.7, color: 'var(--text-muted)', margin: '0 0 16px' }}>
                    脚本先检查明确条件，攒齐候选岗位后共用一次简历和要求。重复岗位短期复用结果；最后不足一批也会处理。
                  </p>
                  <div className="settings-options-grid">
                    <label style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>每批岗位数（1–10）
                      <input type="number" aria-label="每批岗位数" min={1} max={10} value={config.llm.jobBatchSize ?? 5}
                        disabled={isTestingModel || isTaskRunning} style={{ display: 'block', width: '100%', marginTop: '8px' }}
                        onChange={(event) => setConfig({ ...config, llm: { ...config.llm, jobBatchSize: Number(event.target.value) } })} />
                    </label>
                    {config.llm.connectionMode === 'deepseek-web' && <label style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>请求间隔秒数（10–300）
                      <input type="number" aria-label="请求间隔秒数" min={10} max={300} value={config.llm.minRequestIntervalSeconds ?? 30}
                        disabled={isTestingModel || isTaskRunning} style={{ display: 'block', width: '100%', marginTop: '8px' }}
                        onChange={(event) => setConfig({ ...config, llm: { ...config.llm, minRequestIntervalSeconds: Number(event.target.value) } })} />
                    </label>}
                  </div>
                  <p style={{ fontSize: '12px', lineHeight: 1.7, color: 'var(--text-muted)', margin: '12px 0 0' }}>
                    网页请求按顺序执行，间隔从上一轮结束算起；限流或暂时繁忙时保留岗位，等待后重试。岗位描述过长会自动缩小批次。
                  </p>
                </section>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '16px' }}>
                  <button
                    type="button"
                    onClick={testModelConnection}
                    disabled={isTestingModel}
                    style={{ padding: '10px 24px', backgroundColor: 'var(--border-color)', color: 'var(--text-main)', borderRadius: '8px', fontWeight: 600 }}
                  >
                    {isTestingModel ? '测试中…' : '保存并测试连接'}
                  </button>
                  <button
                    onClick={() => saveConfig(config)}
                    style={{
                      padding: '10px 24px',
                      backgroundColor: 'var(--primary)',
                      color: '#fff',
                      borderRadius: '8px',
                      fontWeight: 600,
                    }}
                  >
                    保存设置
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
        {(activeTab === 'delivery' || (activeTab === 'launch' && selectedConditions.length > 0)) && <WorkConditionReviewPanel
          taskRunning={isTaskRunning} onStarted={stats => { setDeliveryStats(stats); setActiveTab('delivery'); }} />}
          </main>
        </div>
      </div>
    </div>
  );
}
