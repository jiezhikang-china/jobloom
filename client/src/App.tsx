import React, { useState, useEffect, useRef } from 'react';
import BossPositionPicker, { flattenPositions } from './BossPositionPicker.js';
import DeepSeekAccountPanel from './DeepSeekAccountPanel.js';
import WorkConditionOptions, { withWorkConditionPresets } from './WorkConditionOptions.js';
import WorkConditionReviewPanel from './WorkConditionReviewPanel.js';
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
  Coffee,
  ExternalLink,
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

export default function App() {
  const [activeTab, setActiveTab] = useState<'launch' | 'diagnosis' | 'tailor' | 'rules' | 'delivery' | 'settings'>('launch');
  
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
    if (!selectedRole || !resumeText) return;
    setIsRewriting(true);
    try {
      const res = await fetch('/api/resume/rewrite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resumeText, targetRole: selectedRole }),
      });
      const json = await res.json();
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
  const usesSavedExpectations = config?.delivery.jobSource !== 'search';

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
    if (!usesSavedExpectations && !searchByConditions && !selectedPosition) {
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
    if (deliveryMode === 'manual' && !searchByConditions && !(usesSavedExpectations && selectedConditions.length) && manualRequirements.trim().length < 10) {
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
          targetRole: usesSavedExpectations ? targets.map(item => item.name).join('、') || '按当前条件规划目标岗位' : searchByConditions ? '符合工作条件的岗位' : selectedRole,
          positionCode: usesSavedExpectations || searchByConditions ? undefined : selectedPosition?.code,
          positionCodes: usesSavedExpectations ? targets.map(item => item.code) : undefined,
          conditionsOnly: searchByConditions,
          keywords: searchKeywords.length || !searchByConditions ? searchKeywords
            : selectedConditions.filter((item) => item.builtin).map((item) => ({ eightHours: '八小时', doubleRest: '双休', noExperience: '经验不限' })[item.builtin!]),
          mode: deliveryMode,
          resumeText: deliveryMode === 'resume' ? (!usesSavedExpectations && tailoredResult?.targetRole === selectedRole ? tailoredResult.rewrittenResumeMarkdown : resumeText) : undefined,
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

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* 顶部导航与状态栏 */}
      <header
        className="app-header"
        style={{
          borderBottom: '1px solid #334155',
          background: 'linear-gradient(100deg, #12231f 0%, #142226 55%, #182530 100%)',
          padding: '18px 28px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div
            style={{
              width: '42px',
              height: '42px',
              borderRadius: '13px',
              background: 'linear-gradient(135deg, #00c982, #38bdf8)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Compass color="#fff" size={22} />
          </div>
          <div>
            <h1 style={{ fontSize: '18px', fontWeight: 'bold', letterSpacing: '0.5px' }}>
              求职投递工作台
            </h1>
            <p style={{ fontSize: '12px', color: '#94a3b8' }}>
              选定目标，检查岗位，再决定投递
            </p>
          </div>
        </div>

        {/* 状态指示器与快捷操作 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          {/* BOSS 登录状态 */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '6px 12px',
              borderRadius: '20px',
              backgroundColor: isBossLoggedIn ? 'rgba(0, 190, 104, 0.15)' : 'rgba(244, 63, 94, 0.15)',
              border: `1px solid ${isBossLoggedIn ? '#00be68' : '#f43f5e'}`,
            }}
          >
            <span
              style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                backgroundColor: isBossLoggedIn ? '#00be68' : '#f43f5e',
              }}
            />
            <span title={loginReason} style={{ fontSize: '13px', color: isBossLoggedIn ? '#4ade80' : '#fda4af', maxWidth: '230px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {isBossLoggedIn ? 'BOSS 会话已就绪' : loginReason || (loginPageOpened ? '等待扫码确认' : '正在检查 BOSS 会话')}
            </span>
            {!isBossLoggedIn && loginReasonCode === 'login_required' && (
              <button
                onClick={handlePromptLogin}
                disabled={isCheckingLogin}
                style={{
                  padding: '2px 8px',
                  borderRadius: '4px',
                  backgroundColor: '#00be68',
                  color: '#fff',
                  fontSize: '12px',
                  fontWeight: 500,
                  marginLeft: '4px',
                }}
              >
                {isCheckingLogin ? '正在打开...' : '打开扫码页'}
              </button>
            )}
            {!isBossLoggedIn && loginReasonCode === 'unverified' && (
              <button
                onClick={handleVerifyLogin}
                disabled={isCheckingLogin}
                title="扫码完成后主动验证；打开登录页时不会自动跳转"
                style={{ padding: '2px 8px', borderRadius: '4px', backgroundColor: '#334155', color: '#e2e8f0', fontSize: '12px' }}
              >
                验证会话
              </button>
            )}
            <button
              onClick={checkLoginStatus}
              title="重新连接并检查保存的登录会话"
              style={{ background: 'none', color: '#94a3b8', padding: '2px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
            >
              <RefreshCw size={14} className={isCheckingLogin ? 'pulsing-indicator' : ''} />
              {loginReasonCode === 'browser_unavailable' && <span style={{ fontSize: '12px' }}>重连</span>}
            </button>
          </div>

          {/* 模型指标 */}
          <div style={{ fontSize: '13px', color: '#cbd5e1', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Sparkles size={16} color="#38bdf8" />
            <span>模型: <strong style={{ color: '#38bdf8' }}>{config?.llm?.connectionMode === 'deepseek-web' ? 'DeepSeek 网页' : config?.llm?.model || '未设置'}</strong></span>
          </div>

          {/* 设置入口 */}
          <button
            onClick={() => setActiveTab('settings')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '6px 12px',
              borderRadius: '8px',
              backgroundColor: activeTab === 'settings' ? '#334155' : 'transparent',
              color: '#cbd5e1',
              border: '1px solid #475569',
            }}
          >
            <Settings size={16} />
            <span style={{ fontSize: '13px' }}>设置</span>
          </button>
        </div>
      </header>

      {/* 标签页导航栏 */}
      <nav
        style={{
          display: 'flex',
          gap: '8px',
          padding: '12px 28px',
          backgroundColor: '#101b22',
          borderBottom: '1px solid #1e293b',
          overflowX: 'auto',
        }}
      >
        {[
          { id: 'launch', label: '开始投递', icon: Play },
          { id: 'diagnosis', label: '简历分析', icon: FileText },
          { id: 'tailor', label: '简历优化（可选）', icon: Compass },
          { id: 'rules', label: '筛选规则', icon: Sliders },
          { id: 'delivery', label: '运行记录', icon: Activity },
        ].map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '8px 16px',
                borderRadius: '8px',
                backgroundColor: isActive ? 'rgba(0, 190, 104, 0.16)' : 'transparent',
                color: isActive ? '#7ae3b3' : '#94a3b8',
                border: `1px solid ${isActive ? '#00be68' : 'transparent'}`,
                fontWeight: isActive ? 600 : 400,
                fontSize: '14px',
              }}
            >
              <Icon size={16} />
              {tab.label}
            </button>
          );
        })}
      </nav>

      {/* 核心内容区 */}
      <main style={{ flex: 1, padding: '24px', overflowY: 'auto' }}>
        {activeTab === 'launch' && (
          <div className="launch-shell">
            <section className="launch-hero">
              <div>
                <span className="launch-eyebrow">APPLICATION WORKSPACE</span>
                <h2>从你的目标出发，直接开始投递</h2>
                <p>选择简历匹配或手动设置目标。分析简历、优化文案和筛选规则都可以按需使用。</p>
              </div>
              <div className="launch-hero-stats">
                <span>今日已投递 <strong>{deliveryStats.todayAppliedCount}</strong> / {config?.delivery.dailyMaxQuota ?? 0}</span>
                <span className={isBossLoggedIn ? 'status-ready' : 'status-pending'}>
                  {isBossLoggedIn ? 'BOSS 会话已连接' : '启动时自动检查 BOSS 会话'}
                </span>
              </div>
            </section>

            <div className="path-grid">
              <button type="button" className={`path-card ${deliveryMode === 'resume' ? 'selected' : ''}`} onClick={() => { setDeliveryMode('resume'); setStartMessage(''); }}>
                <span className="path-icon"><FileText size={22} /></span>
                <span className="path-copy"><strong>用简历匹配岗位</strong><small>上传简历后可直接投递；分析与改写均可跳过</small></span>
                <span className="path-arrow">↗</span>
              </button>
              <button type="button" className={`path-card ${deliveryMode === 'manual' ? 'selected' : ''}`} onClick={() => { setDeliveryMode('manual'); setStartMessage(''); }}>
                <span className="path-icon"><Sliders size={22} /></span>
                <span className="path-copy"><strong>手动指定目标</strong><small>填写岗位和筛选要求，无需先上传简历</small></span>
                <span className="path-arrow">↗</span>
              </button>
            </div>

            <section className="launch-panel">
              <div className="launch-panel-head">
                <div>
                  <span className="section-kicker">投递方案</span>
                  <h3>{deliveryMode === 'resume' ? '简历匹配' : '手动目标'}</h3>
                </div>
                <span className="optional-tag">无需按步骤完成其他页面</span>
              </div>

              <div className="launch-field">
                <label htmlFor="boss-job-source">BOSS 职位来源</label>
                <select id="boss-job-source" value={config?.delivery.jobSource || 'saved_expectations'} disabled={isTaskRunning}
                  onChange={(event) => config && setConfig({ ...config, delivery: { ...config.delivery,
                    jobSource: event.target.value === 'search' ? 'search' : 'saved_expectations' } })}>
                  <option value="saved_expectations">按目标设置 BOSS 自选岗位</option>
                  <option value="search">按官方分类和关键词搜索</option>
                </select>
                <p>{usesSavedExpectations ? '启动时将目标岗位和城市保存到 BOSS 推荐旁的自选位置，再逐个筛选。明确不符合的职位会点“不合适”。' : '按下方分类和搜索词查找职位；平台未提供“不合适”时只记录淘汰。'}</p>
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
                    rows={5}
                    value={manualRequirements}
                    onChange={(e) => setManualRequirements(e.target.value)}
                    placeholder={searchByConditions ? '例如：不做销售、不上夜班、希望离地铁近。已选工作条件无需重复填写。' : '例如：希望找上海的前端开发岗位，技术栈以 React、TypeScript 为主，偏产品研发，不考虑外包，期望 20K 以上。'}
                  />
                  <p>AI 会按这里写的条件筛选职位，不会替你编造工作经历。</p>
                </div>
              )}

              <div className="launch-fields-grid">
                <div className="launch-field wide">
                  {usesSavedExpectations && <section aria-label="BOSS 自选目标设置" style={{ display: 'grid', gap: '16px', marginBottom: '20px' }}>
                    <strong>自选目标 · 最多3个</strong>
                    <p>按这里选择的官方岗位调整 BOSS 自选职位。留空时，AI 根据当前简历或求职要求选择方向。</p>
                    {targetSlots.map((position, index) => <div key={index} aria-label={`目标岗位${index + 1}`}>
                      <BossPositionPicker catalog={bossPositions} value={position} loading={isLoadingPositions} error={positionError} disabled={isTaskRunning}
                        optional onChange={value => handleTargetSlotChange(index, value)} onRefresh={() => fetchBossPositions(true)} />
                      {position || targetSlots.length > 1 ? <button type="button" disabled={isTaskRunning} onClick={() => removeTargetSlot(index)} style={{ marginTop: '8px' }}>移除目标{index + 1}</button> : null}
                    </div>)}
                    {targetSlots.length < 3 && <button type="button" disabled={isTaskRunning} onClick={() => setTargetSlots(previous => [...previous, undefined])}>添加目标岗位</button>}
                  </section>}
                  {(searchByConditions || usesSavedExpectations) && config ? (
                    <>
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

              {!searchByConditions && conditionDescription && <p className="work-condition-summary">已启用工作条件：{conditionDescription}</p>}

              {startMessage && <p role="status" className={`launch-message ${startMessage.startsWith('投递任务已启动') ? 'success' : ''}`}>{startMessage}</p>}
              <div className="launch-footer">
                <p>启动时会重新检查已保存的 BOSS 会话；只有确认失效时才需要扫码。</p>
                <button type="button" className="launch-submit" onClick={handleStartDelivery} disabled={isStarting || isTaskRunning}>
                  <Play size={18} /> {isStarting ? '正在检查并启动…' : isTaskRunning ? '投递任务运行中' : '开始投递'}
                </button>
              </div>
            </section>
          </div>
        )}
        {/* TAB 1: 简历诊断与推荐 */}
        {activeTab === 'diagnosis' && (
          <div style={{ maxWidth: '1000px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '24px' }}>
            {/* 上传卡片 */}
            <div
              style={{
                backgroundColor: '#1e293b',
                padding: '24px',
                borderRadius: '12px',
                border: '1px solid #334155',
              }}
            >
              <h2 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Upload size={18} color="#00be68" />
                上传您的简历文件 (支持 PDF, Word .docx, Markdown, 纯文本)
              </h2>

              <div
                style={{
                  border: '2px dashed #475569',
                  borderRadius: '8px',
                  padding: '32px',
                  textAlign: 'center',
                  backgroundColor: '#0f172a',
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
                <FileText size={40} color="#64748b" style={{ margin: '0 auto 12px' }} />
                {isUploading ? (
                  <div>
                    <p style={{ color: '#38bdf8', fontWeight: 600, fontSize: '15px' }}>正在解析简历文本中...</p>
                    <p style={{ color: '#94a3b8', fontSize: '13px', marginTop: '4px' }}>正在安全读取 PDF/Word 内容，请稍候</p>
                  </div>
                ) : resumeFileName ? (
                  <div>
                    <p style={{ color: '#4ade80', fontWeight: 600, fontSize: '15px' }}>已加载: {resumeFileName}</p>
                    <p style={{ color: '#94a3b8', fontSize: '13px', marginTop: '4px' }}>
                      已成功提取约 {resumeText.length} 字内容，点击下方按钮开始 AI 深度诊断
                    </p>
                  </div>
                ) : (
                  <div>
                    <p style={{ color: '#cbd5e1', fontSize: '15px' }}>点击或将简历文件拖拽至此处上传</p>
                    <p style={{ color: '#64748b', fontSize: '12px', marginTop: '6px' }}>
                      本地安全解析，仅用于与大模型交互评估职业方向与改写
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
                      backgroundColor: '#00be68',
                      color: '#fff',
                      borderRadius: '8px',
                      fontWeight: 600,
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                    }}
                  >
                    <Sparkles size={18} />
                    {isDiagnosing ? '大模型深度诊断中...' : '开始 AI 职业方向深度诊断'}
                  </button>
                </div>
              )}
            </div>

            {/* 诊断结果展示 */}
            {diagnosis && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                <div
                  style={{
                    backgroundColor: '#1e293b',
                    padding: '20px',
                    borderRadius: '12px',
                    border: '1px solid #334155',
                  }}
                >
                  <h3 style={{ fontSize: '15px', color: '#94a3b8', marginBottom: '8px' }}>求职者核心竞争力画像</h3>
                  <p style={{ fontSize: '15px', lineHeight: '1.6', color: '#f8fafc' }}>{diagnosis.summary}</p>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '12px' }}>
                    {diagnosis.coreSkills?.map((skill, idx) => (
                      <span
                        key={idx}
                        style={{
                          padding: '4px 10px',
                          borderRadius: '6px',
                          backgroundColor: '#334155',
                          color: '#38bdf8',
                          fontSize: '12px',
                          fontWeight: 500,
                        }}
                      >
                        {skill}
                      </span>
                    ))}
                  </div>
                </div>

                <h3 style={{ fontSize: '16px', fontWeight: 600, color: '#f8fafc' }}>
                  推荐岗位方向：选定后即可投递，简历改写可按需进行
                </h3>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '16px' }}>
                  {diagnosis.recommendations?.map((rec, idx) => (
                    <div
                      key={idx}
                      style={{
                        backgroundColor: '#1e293b',
                        borderRadius: '12px',
                        border: selectedRole === rec.roleTitle ? '2px solid #00be68' : '1px solid #334155',
                        padding: '20px',
                        display: 'flex',
                        flexDirection: 'column',
                        justifyContent: 'space-between',
                      }}
                    >
                      <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                          <h4 style={{ fontSize: '16px', fontWeight: 'bold', color: '#f8fafc' }}>{rec.roleTitle}</h4>
                          <span
                            style={{
                              padding: '2px 8px',
                              borderRadius: '12px',
                              backgroundColor: 'rgba(0, 190, 104, 0.2)',
                              color: '#4ade80',
                              fontSize: '12px',
                              fontWeight: 600,
                            }}
                          >
                            匹配度 {rec.matchScore}%
                          </span>
                        </div>
                        <p style={{ fontSize: '13px', color: '#94a3b8', lineHeight: '1.5', marginBottom: '12px' }}>
                          {rec.recommendedReason}
                        </p>

                        <div style={{ marginBottom: '8px' }}>
                          <span style={{ fontSize: '12px', color: '#38bdf8', fontWeight: 600 }}>核心胜任优势:</span>
                          <ul style={{ paddingLeft: '18px', fontSize: '12px', color: '#cbd5e1', marginTop: '4px' }}>
                            {rec.advantages?.map((adv, aIdx) => <li key={aIdx}>{adv}</li>)}
                          </ul>
                        </div>

                        {rec.gapAdvice?.length > 0 && (
                          <div style={{ marginBottom: '12px' }}>
                            <span style={{ fontSize: '12px', color: '#fbbf24', fontWeight: 600 }}>建议准备/补强:</span>
                            <ul style={{ paddingLeft: '18px', fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>
                              {rec.gapAdvice?.map((gap, gIdx) => <li key={gIdx}>{gap}</li>)}
                            </ul>
                          </div>
                        )}
                      </div>

                      <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
                        <button
                          onClick={() => handleSelectRole(rec, 'launch')}
                          style={{ flex: 1, padding: '10px', borderRadius: '8px', backgroundColor: '#00be68', color: '#fff', fontWeight: 600, fontSize: '13px' }}
                        >
                          选此岗位去投递 →
                        </button>
                        <button
                          onClick={() => handleSelectRole(rec, 'tailor')}
                          style={{ padding: '10px', borderRadius: '8px', backgroundColor: '#334155', color: '#dbeafe', fontWeight: 600, fontSize: '13px' }}
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
          <div style={{ maxWidth: '1100px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <div
              style={{
                backgroundColor: '#1e293b',
                padding: '20px',
                borderRadius: '12px',
                border: '1px solid #334155',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div>
                <span style={{ fontSize: '13px', color: '#94a3b8' }}>当前选择的投递目标方向:</span>
                <h2 style={{ fontSize: '20px', fontWeight: 'bold', color: '#00be68', marginTop: '4px' }}>
                  {selectedRole || '请从 BOSS 官方分类或简历分析中选择'}
                </h2>
              </div>
              <div style={{ display: 'flex', gap: '12px' }}>
                <button type="button" onClick={() => setActiveTab('launch')}>选择官方岗位</button>
                <button
                  onClick={handleRewrite}
                  disabled={isRewriting || !selectedRole}
                  style={{
                    padding: '10px 20px',
                    backgroundColor: '#00be68',
                    color: '#fff',
                    borderRadius: '8px',
                    fontWeight: 600,
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}
                >
                  <Sparkles size={16} />
                  {isRewriting ? '正在基于岗位重构简历...' : '按此岗位一键针对性改写'}
                </button>
              </div>
            </div>

            {tailoredResult && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                {/* 3大核心亮点与首聊词 */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                  <div
                    style={{
                      backgroundColor: '#1e293b',
                      padding: '16px',
                      borderRadius: '12px',
                      border: '1px solid #334155',
                    }}
                  >
                    <h3 style={{ fontSize: '14px', fontWeight: 600, color: '#38bdf8', marginBottom: '8px' }}>
                      🔥 针对【{selectedRole}】提炼的 3 大核心卖点
                    </h3>
                    <ul style={{ paddingLeft: '20px', fontSize: '13px', lineHeight: '1.6', color: '#cbd5e1' }}>
                      {tailoredResult.topHighlights?.map((h, i) => (
                        <li key={i}>{h}</li>
                      ))}
                    </ul>
                  </div>

                  <div
                    style={{
                      backgroundColor: '#1e293b',
                      padding: '16px',
                      borderRadius: '12px',
                      border: '1px solid #334155',
                    }}
                  >
                    <h3 style={{ fontSize: '14px', fontWeight: 600, color: '#4ade80', marginBottom: '8px' }}>
                      💬 开聊破冰首语（可直接编辑修改，用于自动发起沟通）
                    </h3>
                    <textarea
                      rows={4}
                      value={customGreeting}
                      onChange={(e) => setCustomGreeting(e.target.value)}
                      style={{ width: '100%', resize: 'vertical', fontSize: '13px', lineHeight: '1.5' }}
                    />
                  </div>
                </div>

                {/* 改写后简历预览 */}
                <div
                  style={{
                    backgroundColor: '#1e293b',
                    padding: '20px',
                    borderRadius: '12px',
                    border: '1px solid #334155',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                    <h3 style={{ fontSize: '15px', fontWeight: 600 }}>重构后的 Markdown 针对性简历</h3>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(tailoredResult.rewrittenResumeMarkdown);
                        alert('已复制改写后的简历 Markdown 内容到剪贴板！');
                      }}
                      style={{
                        padding: '6px 12px',
                        borderRadius: '6px',
                        backgroundColor: '#334155',
                        color: '#cbd5e1',
                        fontSize: '12px',
                      }}
                    >
                      一键复制全文
                    </button>
                  </div>
                  <textarea
                    rows={16}
                    value={tailoredResult.rewrittenResumeMarkdown}
                    onChange={(e) =>
                      setTailoredResult({ ...tailoredResult, rewrittenResumeMarkdown: e.target.value })
                    }
                    style={{
                      width: '100%',
                      fontFamily: 'monospace',
                      fontSize: '13px',
                      lineHeight: '1.6',
                      padding: '16px',
                    }}
                  />

                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '16px' }}>
                    <button
                        onClick={() => { setDeliveryMode('resume'); setActiveTab('launch'); }}
                      style={{
                        padding: '10px 24px',
                        backgroundColor: '#00be68',
                        color: '#fff',
                        borderRadius: '8px',
                        fontWeight: 600,
                        fontSize: '14px',
                      }}
                    >
                      使用此简历去投递 →
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* TAB 3: 筛选规则 */}
        {activeTab === 'rules' && config && (
          <div style={{ maxWidth: '900px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <div
              style={{
                backgroundColor: '#1e293b',
                padding: '24px',
                borderRadius: '12px',
                border: '1px solid #334155',
              }}
            >
              <h2 style={{ fontSize: '18px', fontWeight: 'bold', marginBottom: '20px', color: '#f8fafc' }}>
                岗位筛选规则
              </h2>

              <WorkConditionOptions value={config.filter.workRequirements} disabled={isTaskRunning}
                onChange={(value) => setConfig({ ...config, filter: { ...config.filter, workRequirements: value } })} />

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
                {/* 城市 */}
                <div>
                  <label style={{ fontSize: '13px', color: '#94a3b8', display: 'block', marginBottom: '6px' }}>
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
                    <option value="101010100">北京 (101010100)</option>
                    <option value="101020100">上海 (101020100)</option>
                    <option value="101280600">深圳 (101280600)</option>
                    <option value="101280100">广州 (101280100)</option>
                    <option value="101210100">杭州 (101210100)</option>
                    <option value="101270100">成都 (101270100)</option>
                    <option value="101200100">武汉 (101200100)</option>
                  </select>
                </div>

                {/* 薪资范围 */}
                <div>
                  <label style={{ fontSize: '13px', color: '#94a3b8', display: 'block', marginBottom: '6px' }}>
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
                  <label htmlFor="candidate-degree" style={{ fontSize: '13px', color: '#94a3b8', display: 'block', marginBottom: '6px' }}>
                    我的最高学历
                  </label>
                  <select id="candidate-degree" value={config.filter.degree[0] || ''} onChange={(event) =>
                    setConfig({ ...config, filter: { ...config.filter, degree: event.target.value ? [event.target.value] : [] } })
                  } style={{ width: '100%' }}>
                    <option value="">不设置</option>
                    {['初中', '高中', '中专', '大专', '本科', '硕士', '博士'].map((degree) => <option key={degree} value={degree}>{degree}</option>)}
                  </select>
                  <p style={{ fontSize: '12px', color: '#64748b', marginTop: '6px', lineHeight: 1.6 }}>
                    按岗位最低学历判断。本科可匹配大专、本科及学历不限的岗位。
                  </p>
                </div>

                <div>
                  <label htmlFor="experience-match-mode" style={{ fontSize: '13px', color: '#94a3b8', display: 'block', marginBottom: '6px' }}>
                    经验筛选方式
                  </label>
                  <select id="experience-match-mode" value={config.filter.experienceMatchMode || 'flexible'} onChange={(event) =>
                    setConfig({ ...config, filter: { ...config.filter, experienceMatchMode: event.target.value === 'strict' ? 'strict' : 'flexible' } })
                  } style={{ width: '100%' }}>
                    <option value="flexible">宽泛：经验标签作参考（推荐）</option>
                    <option value="strict">严格：按经验标签和条件筛选</option>
                  </select>
                  <p style={{ fontSize: '12px', color: '#64748b', marginTop: '6px', lineHeight: 1.6 }}>
                    {config.filter.experienceMatchMode === 'strict'
                      ? '启用“允许无经验”时核对标签与正文，冲突留待确认；否则按下方经验范围筛选，留空表示不限。'
                      : '“1—3年”标签和“经验优先”不直接淘汰。正文明确允许无经验可继续筛选；经验条件不清楚时留待确认。'}
                  </p>
                  {config.filter.experienceMatchMode === 'strict' && <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '8px' }}>
                    {['应届生', '1年以内', '1-3年', '3-5年', '5-10年', '10年以上'].map((experience) => <label key={experience} style={{ fontSize: '12px', color: '#94a3b8' }}>
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
                  <p style={{ fontSize: '12px', color: '#94a3b8' }}>本地先核对职责和公司介绍，再评估其他条件。简短但写明具体工作内容的描述可以继续筛选。</p>
                </div>

                {/* HR活跃度 */}
                <div>
                  <label style={{ fontSize: '13px', color: '#94a3b8', display: 'block', marginBottom: '6px' }}>
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
                  <label style={{ fontSize: '13px', color: '#94a3b8', display: 'block', marginBottom: '6px' }}>
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
                    <span style={{ fontWeight: 'bold', color: '#38bdf8' }}>
                      {config.filter.minLlmMatchScore || 75} 分
                    </span>
                  </div>
                </div>
              </div>

              {/* 需求词与淘汰词 */}
              <div style={{ marginTop: '20px' }}>
                <label style={{ fontSize: '13px', color: '#94a3b8', display: 'block', marginBottom: '6px' }}>
                  需求词（职位名称、技能标签或职位描述至少命中一个；留空表示不限）
                </label>
                <textarea
                  rows={2}
                  placeholder="例如：React，TypeScript，前端架构"
                  value={config.filter.requiredKeywords?.join('，') || ''}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      filter: {
                        ...config.filter,
                        requiredKeywords: e.target.value.split(/[，,、;；\n]/).map((s) => s.trim()).filter(Boolean),
                      },
                    })
                  }
                  style={{ width: '100%', fontSize: '13px' }}
                />
              </div>
              <div style={{ marginTop: '20px' }}>
                <label style={{ fontSize: '13px', color: '#94a3b8', display: 'block', marginBottom: '6px' }}>
                  排除行业、岗位或公司（逗号分隔）
                </label>
                <textarea
                  rows={3}
                  value={config.filter.companyBlacklist?.join('，')}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      filter: {
                        ...config.filter,
                        companyBlacklist: e.target.value.split(/[，,、;；\n]/).map((s) => s.trim()).filter(Boolean),
                      },
                    })
                  }
                  style={{ width: '100%', fontSize: '13px' }}
                />
                <p style={{ fontSize: '12px', color: '#94a3b8', marginTop: '6px' }}>
                  检查岗位名称、标签、明确职责，以及公司页行业、介绍和经营范围。金融包含银行、证券、信贷、助贷等；销售会识别电销、网销及实际销售任务。
                </p>
              </div>

              {/* 每日投递限制与防封间隔 */}
              <div style={{ marginTop: '20px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
                <div>
                  <label style={{ fontSize: '13px', color: '#94a3b8', display: 'block', marginBottom: '6px' }}>
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
                <div>
                  <label style={{ fontSize: '13px', color: '#94a3b8', display: 'block', marginBottom: '6px' }}>
                    拟人化停顿浮动区间 (秒，防封控)
                  </label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <input
                      type="number"
                      value={config.delivery.minDelaySeconds || 8}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          delivery: { ...config.delivery, minDelaySeconds: Number(e.target.value) },
                        })
                      }
                      style={{ width: '80px' }}
                    />
                    <span>秒 ~</span>
                    <input
                      type="number"
                      value={config.delivery.maxDelaySeconds || 18}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          delivery: { ...config.delivery, maxDelaySeconds: Number(e.target.value) },
                        })
                      }
                      style={{ width: '80px' }}
                    />
                    <span>秒</span>
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '24px', gap: '12px' }}>
                <button
                  onClick={() => saveConfig(config)}
                  style={{
                    padding: '10px 24px',
                    backgroundColor: '#334155',
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
                    backgroundColor: '#00be68',
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
          <div style={{ maxWidth: '1100px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '20px' }}>
            {/* 风控告警 Banner */}
            {deliveryStats.needsCaptchaVerification && (
              <div
                style={{
                  backgroundColor: 'rgba(244, 63, 94, 0.2)',
                  border: '2px solid #f43f5e',
                  borderRadius: '12px',
                  padding: '16px 20px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <ShieldAlert size={28} color="#f43f5e" />
                  <div>
                    <h3 style={{ fontSize: '15px', fontWeight: 'bold', color: '#fda4af' }}>
                      🚨 触发平台风控滑块验证码！系统已安全暂停
                    </h3>
                    <p style={{ fontSize: '13px', color: '#fecdd3', marginTop: '2px' }}>
                      请切换到后台启动的 Chrome 浏览器窗口完成滑块拖动。完成后点击右侧按钮，或等待系统自动感知恢复。
                    </p>
                  </div>
                </div>
                <button
                  onClick={handleResumeDelivery}
                  style={{
                    padding: '8px 16px',
                    borderRadius: '8px',
                    backgroundColor: '#f43f5e',
                    color: '#fff',
                    fontWeight: 600,
                    fontSize: '13px',
                  }}
                >
                  我已完成滑动，继续投递
                </button>
              </div>
            )}

            {/* 贤者时间深度防封休眠横幅 */}
            {deliveryStats.status === 'sage_time' && (
              <div
                style={{
                  backgroundColor: 'rgba(251, 191, 36, 0.15)',
                  border: '2px solid #fbbf24',
                  borderRadius: '12px',
                  padding: '16px 20px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '16px',
                }}
              >
                <Coffee size={32} color="#fbbf24" className="pulsing-indicator" />
                <div>
                  <h3 style={{ fontSize: '15px', fontWeight: 'bold', color: '#fde047' }}>
                    ☕ 触发【贤者时间】批次拟人化深度休眠 (还剩 {deliveryStats.sageTimeRemainingSeconds ?? 0} 秒)
                  </h3>
                  <p style={{ fontSize: '13px', color: '#fef08a', marginTop: '2px' }}>
                    系统已连续开聊一批岗位，正在严格模拟真人去喝水与离开屏幕，打破固定频控审计，倒计时结束后将全自动恢复！
                  </p>
                </div>
              </div>
            )}

            {/* 控制卡片 */}
            <div
              style={{
                backgroundColor: '#1e293b',
                padding: '20px',
                borderRadius: '12px',
                border: '1px solid #334155',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div>
                <span style={{ fontSize: '13px', color: '#94a3b8' }}>当前投递职业与检索关键词:</span>
                <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginTop: '6px' }}>
                  <strong style={{ fontSize: '18px', color: '#00be68' }}>{deliveryStats.targetRoles?.join('、') || (usesSavedExpectations ? targetSlots.filter(Boolean).map(item => item!.name).join('、') || 'AI 规划目标岗位' : searchByConditions ? '按工作条件找岗位' : selectedRole || '未选择')}</strong>
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px', marginLeft: '8px' }}>
                    {searchKeywords.map((kw, i) => (
                      <span
                        key={i}
                        style={{
                          padding: '2px 8px',
                          borderRadius: '6px',
                          backgroundColor: '#334155',
                          fontSize: '12px',
                          color: '#38bdf8',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px',
                        }}
                      >
                        {kw}
                        <X
                          size={12}
                          color="#94a3b8"
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
                        style={{ background: 'none', color: '#38bdf8', padding: '2px' }}
                      >
                        <Plus size={16} />
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* 运行控制按键 */}
              <div style={{ display: 'flex', gap: '12px' }}>
                {deliveryStats.status === 'idle' || deliveryStats.status === 'finished' || deliveryStats.status === 'failed' ? (
                  <button
                    onClick={() => setActiveTab('launch')}
                    disabled={isStarting}
                    style={{
                      padding: '10px 24px',
                      borderRadius: '8px',
                      backgroundColor: '#00be68',
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
                ) : deliveryStats.status === 'running' ? (
                  <button
                    onClick={handlePauseDelivery}
                    style={{
                      padding: '10px 20px',
                      borderRadius: '8px',
                      backgroundColor: '#fbbf24',
                      color: '#0f172a',
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
                      backgroundColor: '#00be68',
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
                    backgroundColor: '#334155',
                    color: '#f43f5e',
                    border: '1px solid #f43f5e',
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
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '14px' }}>
              <div style={{ backgroundColor: '#1e293b', padding: '16px', borderRadius: '12px', border: '1px solid #334155' }}>
                <span style={{ fontSize: '13px', color: '#94a3b8' }}>今日成功开聊</span>
                <p style={{ fontSize: '24px', fontWeight: 'bold', color: '#4ade80', marginTop: '6px' }}>
                  {deliveryStats.todayAppliedCount} <span style={{ fontSize: '13px', color: '#64748b' }}>/ {deliveryStats.dailyMaxQuota}</span>
                </p>
              </div>

              <div style={{ backgroundColor: '#1e293b', padding: '16px', borderRadius: '12px', border: '1px solid #334155' }}>
                <span style={{ fontSize: '13px', color: '#94a3b8' }}>扫描岗位总数</span>
                <p style={{ fontSize: '24px', fontWeight: 'bold', color: '#f8fafc', marginTop: '6px' }}>
                  {deliveryStats.totalScanned}
                </p>
              </div>

              <div style={{ backgroundColor: '#1e293b', padding: '16px', borderRadius: '12px', border: '1px solid #334155' }}>
                <span style={{ fontSize: '13px', color: '#94a3b8' }}>双筛选达标岗位</span>
                <p style={{ fontSize: '24px', fontWeight: 'bold', color: '#38bdf8', marginTop: '6px' }}>
                  {deliveryStats.passedFilterCount}
                </p>
              </div>

              <div style={{ backgroundColor: '#1e293b', padding: '16px', borderRadius: '12px', border: '1px solid #334155' }}>
                <span style={{ fontSize: '13px', color: '#94a3b8' }}>反向调优(标记不合适)</span>
                <p style={{ fontSize: '24px', fontWeight: 'bold', color: '#f43f5e', marginTop: '6px' }}>
                  {deliveryStats.markedNotSuitCount || 0}
                </p>
              </div>

              <div style={{ backgroundColor: '#1e293b', padding: '16px', borderRadius: '12px', border: '1px solid #334155' }}>
                <span style={{ fontSize: '13px', color: '#94a3b8' }}>AI 不可用跳过</span>
                <p style={{ fontSize: '24px', fontWeight: 'bold', color: '#fbbf24', marginTop: '6px' }}>
                  {deliveryStats.skippedByLlmErrorCount || 0}
                </p>
              </div>

              <div style={{ backgroundColor: '#1e293b', padding: '16px', borderRadius: '12px', border: '1px solid #334155' }}>
                <span style={{ fontSize: '13px', color: '#94a3b8' }}>当前智能体状态</span>
                <p style={{ fontSize: '15px', fontWeight: 600, color: '#fbbf24', marginTop: '10px' }}>
                  {deliveryStats.status === 'running'
                    ? '🚀 正在检索与投递'
                    : deliveryStats.status === 'paused'
                    ? '⏸️ 已暂停'
                    : deliveryStats.status === 'sage_time'
                    ? `☕ 贤者时间 (${deliveryStats.sageTimeRemainingSeconds ?? 0}s)`
                    : deliveryStats.status === 'cool_down'
                    ? '⏳ 冷却防封休眠中'
                    : deliveryStats.status === 'finished'
                    ? '🎉 任务已完成'
                    : deliveryStats.status === 'failed'
                    ? '❌ 任务异常中止，请查看日志'
                    : '💤 空闲中'}
                </p>
              </div>
            </div>

            {/* 实时终端日志流 */}
            <p aria-label="评估用量" style={{ fontSize: '13px', color: '#94a3b8', margin: 0 }}>
              {isTaskRunning && deliveryStats.phase ? ({ planning: '正在规划目标岗位', configuring: '正在设置 BOSS 自选岗位', screening: '脚本初筛中', evaluating: 'AI 批量分析中', delivering: '投递中' })[deliveryStats.phase] + ' · ' : ''}
              本地处理 {deliveryStats.localDecisionCount || 0} 个 · 待批量评估 {deliveryStats.pendingEvaluationCount || 0} 个 ·
              AI 请求 {deliveryStats.aiRequestCount || 0} 次 · 复用评估 {deliveryStats.cachedEvaluationCount || 0} 个
            </p>
            <div
              style={{
                backgroundColor: '#0f172a',
                border: '1px solid #334155',
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
                  borderBottom: '1px solid #1e293b',
                  paddingBottom: '8px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Terminal size={18} color="#00be68" />
                  <span style={{ fontSize: '14px', fontWeight: 600, color: '#f8fafc' }}>
                    实时投递控制台与风控日志
                  </span>
                </div>
                <span style={{ fontSize: '12px', color: '#64748b' }}>最新 300 条动态</span>
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
                  <p style={{ color: '#475569', textAlign: 'center', marginTop: '40px' }}>
                    控制台准备就绪，点击上方【开始自动投递】查看实时流...
                  </p>
                ) : (
                  logs.map((log) => {
                    const colorMap = {
                      info: '#94a3b8',
                      warn: '#fbbf24',
                      error: '#f43f5e',
                      success: '#4ade80',
                    };
                    return (
                      <div key={log.id} style={{ display: 'flex', gap: '8px', lineHeight: '1.4' }}>
                        <span style={{ color: '#475569', minWidth: '70px' }}>[{log.timestamp}]</span>
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
        {activeTab === 'settings' && config && (
          <div style={{ maxWidth: '700px', margin: '0 auto' }}>
            <div
              style={{
                backgroundColor: '#1e293b',
                padding: '24px',
                borderRadius: '12px',
                border: '1px solid #334155',
              }}
            >
              <h2 style={{ fontSize: '18px', fontWeight: 'bold', marginBottom: '20px' }}>
                模型与账号
              </h2>

              {/* 模型连接预设 */}
              <div
                style={{
                  backgroundColor: '#0f172a',
                  border: '1px solid #00be68',
                  borderRadius: '10px',
                  padding: '16px',
                  marginBottom: '10px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Sparkles size={18} color="#00be68" />
                    <span style={{ fontSize: '14px', fontWeight: 600, color: '#f8fafc' }}>
                      选择模型连接方式
                    </span>
                  </div>
                  <span style={{ fontSize: '12px', color: '#4ade80', backgroundColor: 'rgba(0,190,104,0.15)', padding: '2px 8px', borderRadius: '10px' }}>
                    {config.llm.connectionMode === 'deepseek-web' ? 'DeepSeek 网页反代' : '兼容 API'}
                  </span>
                </div>

                <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginTop: '12px' }}>
                  <select
                    aria-label="AI 连接方式"
                    value={selectedPresetId}
                    onChange={(e) => handleSelectPreset(e.target.value)}
                    style={{ flex: 1, backgroundColor: '#1e293b', border: '1px solid #334155' }}
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
                    <div style={{ marginTop: '12px', padding: '10px', backgroundColor: '#1e293b', borderRadius: '8px', border: '1px solid #334155' }}>
                      <p style={{ fontSize: '13px', color: '#cbd5e1', lineHeight: '1.5' }}>
                        {curr.description}
                      </p>
                      {curr.applyUrl && (
                        <div style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <a
                            href={curr.applyUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                              color: '#38bdf8',
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
                  <label style={{ fontSize: '13px', color: '#94a3b8', display: 'block', marginBottom: '6px' }}>
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
                  <label style={{ fontSize: '13px', color: '#94a3b8', display: 'block', marginBottom: '6px' }}>
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
                  <p style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>
                    更换 Key 后点击“保存并测试连接”，可直接检查模型接口是否可用。
                  </p>
                </div>}

                {config.llm.connectionMode !== 'deepseek-web' && <div>
                  <label style={{ fontSize: '13px', color: '#94a3b8', display: 'block', marginBottom: '6px' }}>
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
                  <section aria-label="DeepSeek 网页功能" style={{ padding: '18px', border: '1px solid #334155', borderRadius: '12px', background: '#0f172a' }}>
                    <h3 style={{ fontSize: '15px', margin: '0 0 8px', color: '#e2e8f0' }}>网页功能</h3>
                    <p style={{ fontSize: '12px', lineHeight: 1.7, color: '#94a3b8', margin: '0 0 16px' }}>
                      深度思考和联网搜索可以分别开启，也可以同时开启。保存后用于简历分析和岗位匹配。
                    </p>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' }}>
                      <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '14px', borderRadius: '10px', background: '#1e293b', cursor: 'pointer' }}>
                        <input type="checkbox" aria-label="深度思考" disabled={isTestingModel} checked={config.llm.thinking === 'enabled'} onChange={(event) => {
                          setConfig({ ...config, llm: { ...config.llm, thinking: event.target.checked ? 'enabled' : 'disabled' } });
                          setModelTestMessage('');
                        }} />
                        <span><strong style={{ display: 'block', fontSize: '13px', color: '#e2e8f0' }}>深度思考</strong>
                          <span style={{ display: 'block', fontSize: '12px', lineHeight: 1.6, color: '#94a3b8', marginTop: '4px' }}>深入分析简历和岗位，回答通常需要更长时间。</span>
                        </span>
                      </label>
                      <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '14px', borderRadius: '10px', background: '#1e293b', cursor: 'pointer' }}>
                        <input type="checkbox" aria-label="联网搜索" disabled={isTestingModel} checked={config.llm.webSearch === true} onChange={(event) => {
                          setConfig({ ...config, llm: { ...config.llm, webSearch: event.target.checked } });
                          setModelTestMessage('');
                        }} />
                        <span><strong style={{ display: 'block', fontSize: '13px', color: '#e2e8f0' }}>联网搜索</strong>
                          <span style={{ display: 'block', fontSize: '12px', lineHeight: 1.6, color: '#94a3b8', marginTop: '4px' }}>允许模型搜索网页，补充公司或岗位相关信息。</span>
                        </span>
                      </label>
                    </div>
                  </section>
                )}
                {modelTestMessage && (
                  <p role="status" style={{ fontSize: '13px', color: modelTestMessage.startsWith('连接失败') ? '#fda4af' : '#4ade80' }}>
                    {modelTestMessage}
                  </p>
                )}
                <section aria-label="AI 调用安排" style={{ padding: '18px', border: '1px solid #334155', borderRadius: '12px', background: '#0f172a' }}>
                  <h3 style={{ fontSize: '15px', margin: '0 0 8px', color: '#e2e8f0' }}>先初筛，再批量评估</h3>
                  <p style={{ fontSize: '12px', lineHeight: 1.7, color: '#94a3b8', margin: '0 0 16px' }}>
                    脚本先检查明确条件，攒齐候选岗位后共用一次简历和要求。重复岗位短期复用结果；最后不足一批也会处理。
                  </p>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px' }}>
                    <label style={{ fontSize: '13px', color: '#cbd5e1' }}>每批岗位数（1–10）
                      <input type="number" aria-label="每批岗位数" min={1} max={10} value={config.llm.jobBatchSize ?? 5}
                        disabled={isTestingModel || isTaskRunning} style={{ display: 'block', width: '100%', marginTop: '8px' }}
                        onChange={(event) => setConfig({ ...config, llm: { ...config.llm, jobBatchSize: Number(event.target.value) } })} />
                    </label>
                    {config.llm.connectionMode === 'deepseek-web' && <label style={{ fontSize: '13px', color: '#cbd5e1' }}>请求间隔秒数（10–300）
                      <input type="number" aria-label="请求间隔秒数" min={10} max={300} value={config.llm.minRequestIntervalSeconds ?? 30}
                        disabled={isTestingModel || isTaskRunning} style={{ display: 'block', width: '100%', marginTop: '8px' }}
                        onChange={(event) => setConfig({ ...config, llm: { ...config.llm, minRequestIntervalSeconds: Number(event.target.value) } })} />
                    </label>}
                  </div>
                  <p style={{ fontSize: '12px', lineHeight: 1.7, color: '#94a3b8', margin: '12px 0 0' }}>
                    网页请求按顺序执行，间隔从上一轮结束算起；限流时暂停，遵守网站给出的等待时间。岗位描述过长会自动缩小批次。
                  </p>
                </section>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '16px' }}>
                  <button
                    type="button"
                    onClick={testModelConnection}
                    disabled={isTestingModel}
                    style={{ padding: '10px 24px', backgroundColor: '#334155', color: '#f8fafc', borderRadius: '8px', fontWeight: 600 }}
                  >
                    {isTestingModel ? '测试中…' : '保存并测试连接'}
                  </button>
                  <button
                    onClick={() => saveConfig(config)}
                    style={{
                      padding: '10px 24px',
                      backgroundColor: '#00be68',
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
        {(activeTab === 'delivery' || (activeTab === 'launch' && selectedConditions.length > 0)) && <WorkConditionReviewPanel />}
      </main>
    </div>
  );
}
