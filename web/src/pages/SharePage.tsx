import { useEffect, useState, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, Loader2, Link2, CheckCircle2, Monitor, MonitorUp, Zap, Clock, Mic, MicOff, Users } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useSessionSSE } from '../hooks/useSessionSSE';
import { useScreenShare, QUALITY_OPTIONS } from '../hooks/useScreenShare';
import { copyToClipboard, cn } from '../lib/utils';
import type { SessionInfo } from '../types';
import { NoticeBanners } from '../components/notices/NoticeCenter';
import { getClientEnvironment, markPageOpenOnce, sanitizeShareFailureReason } from '../lib/clientEnv';
import { buildDesktopLaunch, CLIENT_RELEASE_PAGE } from '../lib/desktopLaunch';

// ===== Cookie 工具 =====
const CID_KEY = 'xgoatcast_cid';
const ACTIVE_KEY = 'xgoatcast_active';

function getCookie(name: string): string | null {
  const m = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
  return m ? m[2] : null;
}
function setCookie(name: string, value: string, days: number): void {
  const d = new Date();
  d.setTime(d.getTime() + days * 86400000);
  document.cookie = name + '=' + value + ';path=/;expires=' + d.toUTCString();
}
function getClientId(): string {
  let id = getCookie(CID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    setCookie(CID_KEY, id, 365);
  }
  return id;
}
function getActiveShare(): string | null {
  return getCookie(ACTIVE_KEY);
}
function setActiveShare(token: string): void {
  setCookie(ACTIVE_KEY, token, 1);
}
function clearActiveShare(expectedToken?: string): void {
  if (expectedToken && getActiveShare() !== expectedToken) return;
  setCookie(ACTIVE_KEY, '', 0);
}

export default function SharePage() {
  const [params] = useSearchParams();
  const token = params.get('t') || '';
  const clientId = useRef(getClientId()).current;
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [lowLatency, setLowLatency] = useState(false);
  const [microphoneEnabled, setMicrophoneEnabled] = useState(false);
  const [optimizationMode, setOptimizationMode] = useState<'detail' | 'motion'>('motion');
  const [qualityIdx, setQualityIdx] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [allowedQualities, setAllowedQualities] = useState<string[]>([]);
  const [activeShareToken, setActiveShareToken] = useState(getActiveShare);
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const [shareError, setShareError] = useState('');
  const [desktopRequested, setDesktopRequested] = useState(() => sessionStorage.getItem('xgoatcast_desktop') === token);
  const [desktopAttempt, setDesktopAttempt] = useState<{ id: string; token: string } | null>(null);
  const [desktopResponse, setDesktopResponse] = useState<'waiting' | 'ready'>('waiting');
  const [idleCountdown, setIdleCountdown] = useState<number | null>(null);
  const [noViewerCountdown, setNoViewerCountdown] = useState<number | null>(null);
  const idleDeadlineRef = useRef<number | null>(null);
  const noViewerDeadlineRef = useRef<number | null>(null);

  // Cookies have no cross-tab change event. Refresh the guard when another tab stops.
  useEffect(() => {
    const refresh = () => setActiveShareToken(getActiveShare());
    const timer = window.setInterval(refresh, 2_000);
    window.addEventListener('focus', refresh);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, []);

  const socket = useSessionSSE(token, 'publisher', desktopRequested);
  const desktopSharing = desktopRequested && socket.status === 'active' && socket.publisherClientId === clientId;
  useEffect(() => {
    if (!desktopRequested || !desktopAttempt || desktopAttempt.token !== token || desktopSharing || socket.ended) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const data = await api.getShareInfo(token);
        if (disposed) return;
        if (data.desktopLaunch?.id === desktopAttempt.id && data.desktopLaunch.clientId === clientId) {
          setDesktopResponse('ready');
          return;
        }
      } catch { /* The normal session stream owns authentication and network errors. */ }
      if (disposed) return;
      timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [desktopRequested, desktopAttempt, desktopSharing, socket.ended, token, clientId]);
  const screenShare = useScreenShare(token, () => {
    setMicrophoneEnabled(false);
    socket.stopSharing();
  });
  const stopRef = useRef(screenShare.stop);
  stopRef.current = screenShare.stop;

  useEffect(() => {
    if (!token) { setLoadError('缺少分享令牌'); setLoading(false); return; }
    api.getShareInfo(token)
      .then((data) => {
        setInfo(data);
        const allowed = QUALITY_OPTIONS.filter((q) => data.allowedQualities?.includes(q.key));
        setAllowedQualities(allowed.map((q) => q.key));
        setQualityIdx(allowed.length > 0 ? QUALITY_OPTIONS.indexOf(allowed[0]) : null);
        // 恢复已持久化的低延迟模式
        if (data.lowLatency) setLowLatency(true);
        setLoading(false);
        if (markPageOpenOnce(token, 'share')) {
          void api.reportShareTelemetry({
            token,
            pageType: 'share',
            eventType: 'page_open',
            ...getClientEnvironment(),
          }).catch(() => {});
        }

        // 清理 stale active cookie：服务器重新部署后旧 session 已失效，
        // 但浏览器 Cookie 仍保存旧 token，会导致误报"请先停止其他共享"
        const staleActive = getActiveShare();
        if (staleActive && staleActive !== token) {
          api.getShareInfo(staleActive)
            .then((staleInfo) => {
              if (staleInfo.status === 'ended') {
                clearActiveShare(staleActive);
                setActiveShareToken(getActiveShare());
              }
            })
            .catch((error) => {
              if (error instanceof ApiError && [401, 404].includes(error.statusCode)) {
                clearActiveShare(staleActive);
                setActiveShareToken(getActiveShare());
              }
            });
        }
      })
      .catch((e) => { setLoadError(e.message || '加载失败'); setLoading(false); });
	  }, [token]);

	  // 未共享屏幕倒计时：基于绝对时间戳，避免后台/节能模式下 setTimeout 节流导致与服务器不同步
  useEffect(() => {
    if (socket.idleRemainingSec != null && socket.idleRemainingSec > 0) {
      idleDeadlineRef.current = Date.now() + socket.idleRemainingSec * 1000;
    } else {
      idleDeadlineRef.current = null;
    }
  }, [socket.idleRemainingSec]);

  useEffect(() => {
    if (idleDeadlineRef.current == null) {
      setIdleCountdown(null);
      return;
    }
    const tick = () => {
      const remain = Math.max(0, Math.ceil((idleDeadlineRef.current! - Date.now()) / 1000));
      setIdleCountdown(remain);
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [socket.idleRemainingSec]);

  // 无人观看自动结束倒计时（同样基于绝对时间戳）
  useEffect(() => {
    if (socket.noViewerRemainingSec != null && socket.noViewerRemainingSec > 0) {
      noViewerDeadlineRef.current = Date.now() + socket.noViewerRemainingSec * 1000;
    } else {
      noViewerDeadlineRef.current = null;
    }
  }, [socket.noViewerRemainingSec]);

  useEffect(() => {
    if (noViewerDeadlineRef.current == null) {
      setNoViewerCountdown(null);
      return;
    }
    const tick = () => {
      const remain = Math.max(0, Math.ceil((noViewerDeadlineRef.current! - Date.now()) / 1000));
      setNoViewerCountdown(remain);
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [socket.noViewerRemainingSec]);

  const handleStart = useCallback(async () => {
    if (startingRef.current) return;
    setDesktopRequested(false);
    setDesktopAttempt(null);
    sessionStorage.removeItem('xgoatcast_desktop');
    setShareError('');
    if (qualityIdx === null || !allowedQualities.includes(QUALITY_OPTIONS[qualityIdx]?.key)) {
      setShareError('该服务器暂未开放任何共享画质，请联系服务器管理员。');
      return;
    }
    // 检查是否正在其他 session 共享
    const active = getActiveShare();
    if (active && active !== token) {
      setShareError('您正在另一个会话中共享，请先停止那个共享再开始新的。');
      return;
    }
    startingRef.current = true;
    setStarting(true);
    try {
      const result = await screenShare.publish({
        qualityKey: QUALITY_OPTIONS[qualityIdx].key,
        lowLatency,
        microphoneEnabled: info?.platform === 'panel' && microphoneEnabled,
        optimizationMode: info?.allowQualityPreference ? optimizationMode : 'motion',
        bitrateConfig: info?.qualityBitrates?.[QUALITY_OPTIONS[qualityIdx].key],
      });
      if (result.success) {
        const resp = await socket.startSharing(QUALITY_OPTIONS[qualityIdx].key, clientId, lowLatency);
        if (resp.ok) {
          setActiveShare(token);
          setActiveShareToken(token);
        } else {
          screenShare.stop();
          setMicrophoneEnabled(false);
          setShareError(resp.message || '无法开始共享，可能已有其他人正在共享或链接已失效。');
          void api.reportShareTelemetry({
            token, pageType: 'share', eventType: 'start_failed',
            failureReason: 'start_rejected', ...getClientEnvironment(),
          }).catch(() => {});
        }
      } else {
        void api.reportShareTelemetry({
          token, pageType: 'share', eventType: 'start_failed',
          failureReason: sanitizeShareFailureReason(result.message || screenShare.error),
          ...getClientEnvironment(),
        }).catch(() => {});
      }
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }, [screenShare, socket, qualityIdx, allowedQualities, token, clientId, lowLatency, microphoneEnabled, optimizationMode, info]);

  const handleMicrophoneToggle = async () => {
    const next = !microphoneEnabled;
    if (screenShare.isSharing) {
      if (await screenShare.setMicrophoneEnabled(next)) setMicrophoneEnabled(next);
    } else {
      setMicrophoneEnabled(next);
    }
  };

  const handleDesktopStart = () => {
    if (allowedQualities.length === 0 || starting || screenShare.isSharing || desktopSharing) return;
    const active = getActiveShare();
    if (active && active !== token) { setShareError('请先停止其他共享。'); return; }
    setShareError('');
    setMicrophoneEnabled(false);
    setDesktopRequested(true);
    const launchId = crypto.randomUUID();
    setDesktopAttempt({ id: launchId, token });
    setDesktopResponse('waiting');
    sessionStorage.setItem('xgoatcast_desktop', token);
    // Keep this navigation synchronous with the user click for external-protocol activation.
    window.location.href = buildDesktopLaunch({
      server: window.location.origin, token, clientId, launchId,
    });
  };

  useEffect(() => {
    if (desktopSharing) { setActiveShare(token); setActiveShareToken(token); }
    else if (desktopRequested && (socket.status === 'grace' || socket.ended)) { clearActiveShare(token); setActiveShareToken(getActiveShare()); }
  }, [desktopSharing, desktopRequested, socket.status, socket.ended, token]);

  const handleStop = useCallback(async () => {
    await screenShare.stop();
    setMicrophoneEnabled(false);
    socket.stopSharing();
    clearActiveShare(token);
    setActiveShareToken(getActiveShare());
  }, [screenShare, socket, token]);

  useEffect(() => {
    const handler = () => { stopRef.current(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  useEffect(() => {
    if (socket.ended) {
      screenShare.stop();
      setMicrophoneEnabled(false);
      clearActiveShare(token);
      setActiveShareToken(getActiveShare());
    }
  }, [socket.ended, screenShare, token]);

  // 判断当前用户的共享权限（使用 socket 实时状态，而非初始 API 加载的静态数据）
  const isPublisher = !socket.publisherClientId || socket.publisherClientId === clientId;
  const lockedByOther = !!socket.publisherClientId && socket.publisherClientId !== clientId;
  const activeElsewhere = !!activeShareToken && activeShareToken !== token;

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-brand animate-spin" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="glass rounded-xl px-6 py-5 max-w-sm text-center">
          <AlertTriangle className="w-10 h-10 text-yellow-400 mx-auto mb-3" />
          <h2 className="text-base font-semibold mb-1.5">无法进入共享</h2>
          <p className="text-muted text-xs">{loadError}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-4 sm:p-6 lg:p-8">
      <header className="flex items-center justify-between mb-7 max-w-7xl mx-auto">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-brand flex items-center justify-center"><MonitorUp size={23} strokeWidth={1.7} /></div>
          <h1 className="font-semibold text-lg leading-tight">Xgoat.Cast 屏幕共享</h1>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className={cn('w-2.5 h-2.5 rounded-full', socket.connected ? 'bg-green-500' : 'bg-yellow-500')} />
          <span className="text-muted">{socket.connected ? '已连接' : '连接中'}</span>
        </div>
      </header>

      <div className="max-w-7xl mx-auto">
        <NoticeBanners />
      </div>

      <main className="max-w-7xl mx-auto space-y-5">
        {/* 共享人信息 + 观看链接 */}
        {info && (
          <div className="glass rounded-xl px-4 sm:px-6 py-4 grid grid-cols-[minmax(0,1fr)_auto] sm:flex sm:items-center gap-4 sm:gap-6">
            <div className="min-w-0"><p className="text-xs text-muted">共享人</p><p className="font-semibold truncate">{info.sharerUsername}</p></div>
            <div className="col-span-2 row-start-2 sm:row-auto flex min-w-0 flex-1 w-full sm:w-auto items-center gap-2">
              <code className="hidden sm:block text-xs text-dim bg-[#f3f4f0] px-3 py-2.5 rounded-lg min-w-0 flex-1 truncate">
                {info.viewLink}
              </code>
              <button
                onClick={() => { copyToClipboard(info.viewLink); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
                className="w-full justify-center sm:w-auto rounded-lg border border-[#cbd0c7] bg-[#fffefd] hover:bg-[#f3f4f0] px-3 py-2 text-sm flex shrink-0 items-center gap-1.5"
              >
                {copied ? <CheckCircle2 className="w-4 h-4" /> : <Link2 className="w-4 h-4" />}
                复制观看链接
              </button>
            </div>
            <span className="col-start-2 row-start-1 sm:col-auto sm:row-auto inline-flex items-center gap-1.5 text-sm text-muted"><Users size={16} />{socket.viewerCount} 人观看</span>
          </div>
        )}

        <div className="grid lg:grid-cols-[minmax(0,1.55fr)_minmax(330px,.85fr)] gap-5 items-start">
        <div>
          <div className="relative w-full aspect-video rounded-xl bg-[#24292b] overflow-hidden flex items-center justify-center video-stage">
            {screenShare.isSharing ? <div ref={screenShare.setLocalPreviewContainer} className="absolute inset-0 w-full h-full" /> : <div className="text-center px-4"><MonitorUp size={54} strokeWidth={1.2} className="mx-auto text-[#c9d1cd]" /><p className="mt-5 text-[#d9e0dc] text-sm">选择屏幕后将在这里预览</p></div>}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted"><span className="inline-flex items-center gap-2"><span className={cn('w-2 h-2 rounded-full', screenShare.isSharing || desktopSharing ? 'bg-green-500' : 'bg-[#a0a7a1]')} />{screenShare.isSharing || desktopSharing ? '正在共享屏幕' : '尚未开始共享'}</span><span>{socket.viewerCount} 人观看</span></div>
        </div>
        <div className="space-y-5">
        {/* 共享设置 */}
        <section aria-label="共享模式" className="glass rounded-xl p-4 sm:p-5">
          <div className="flex items-center justify-between gap-2 mb-3">
            <h2 className="text-lg font-semibold">共享设置</h2>
          </div>
          <div className="space-y-3">
            <div className="rounded-md border border-[#d9ddd6] bg-[#f8f9f6] p-3">
              <p className="mb-2 text-xs font-medium">画面偏好</p>
              <div role="group" aria-label="画面偏好" aria-describedby="quality-preference-description" className="grid grid-cols-2 gap-1 rounded-md bg-[#e2e4df] p-1">
                {([['detail', '画质优先'], ['motion', '帧率优先']] as const).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={optimizationMode === mode}
                    title={mode === 'detail' ? '适合文字和细节' : '适合游戏和动态画面'}
                    disabled={!info?.allowQualityPreference || starting || screenShare.isSharing || desktopSharing || socket.ended || lockedByOther}
                    onClick={() => setOptimizationMode(mode)}
                    className={cn(
                      'min-h-9 rounded-[3px] border px-2 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed',
                      optimizationMode === mode
                        ? 'border-[#b7beb4] bg-[#fffefd] font-medium text-[#242923] shadow-[0_1px_2px_rgba(40,48,38,.12)]'
                        : 'border-transparent text-[#596057] hover:bg-[#d9ddd5] disabled:hover:bg-transparent',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p id="quality-preference-description" className="mt-2 text-[11px] leading-relaxed text-muted">{info?.allowQualityPreference ? '画质优先适合文字与细节；帧率优先适合游戏和动态画面。' : '服务器固定为帧率优先。'}</p>
            </div>
            {info?.allowLowLatency && <div className="rounded-xl border border-white/10 bg-white/[0.025] p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-xs font-medium">
                  <Zap className="h-3.5 w-3.5 text-blue-300" />
                  <span id="low-latency-label">超低延迟模式</span>
                  <span className="text-[10px] text-muted">{lowLatency ? '已开启' : '已关闭'}</span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={lowLatency}
                  aria-labelledby="low-latency-label"
                  aria-describedby="low-latency-description"
                  disabled={starting || screenShare.isSharing || desktopSharing || socket.ended || lockedByOther || (socket.status === 'grace' && isPublisher)}
                  onClick={() => setLowLatency((value) => !value)}
                  className={cn('flex h-8 w-11 shrink-0 items-center rounded-full px-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-50', lowLatency ? 'bg-blue-500' : 'bg-white/[0.15]')}
                >
                  <span className={cn('h-5 w-5 rounded-full bg-white shadow-sm transition-transform', lowLatency ? 'translate-x-4' : 'translate-x-0')} />
                </button>
              </div>
              <p id="low-latency-description" className="mt-2 text-[11px] leading-relaxed text-muted">开启：减少观看延迟至最低160ms，适合超低延迟要求，但是时长用量将会提升约100%</p>
            </div>}
          </div>
          {info?.platform === 'panel' && (
            <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.025] p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-xs font-medium">
                  {microphoneEnabled ? <Mic className="h-4 w-4 text-brand-light" /> : <MicOff className="h-4 w-4 text-muted" />}
                  <span id="microphone-label">麦克风</span>
                  <span className="text-[10px] text-muted">{microphoneEnabled ? '已开启' : '已关闭'}</span>
                </div>
                <button type="button" role="switch" aria-checked={microphoneEnabled} aria-labelledby="microphone-label" aria-describedby="microphone-description"
                  disabled={starting || screenShare.microphoneBusy || desktopSharing || socket.ended || lockedByOther || activeElsewhere}
                  onClick={() => void handleMicrophoneToggle()}
                  className={cn('flex h-8 w-11 shrink-0 items-center rounded-full px-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-50', microphoneEnabled ? 'bg-brand' : 'bg-white/[0.15]')}>
                  <span className={cn('h-5 w-5 rounded-full bg-white shadow-sm transition-transform', microphoneEnabled ? 'translate-x-4' : 'translate-x-0')} />
                </button>
              </div>
              <p id="microphone-description" className="mt-2 text-[11px] leading-relaxed text-muted">默认关闭。开启后，浏览器共享时会将麦克风声音与屏幕音频一起传给观众；共享过程中也可切换。</p>
            </div>
          )}
          <fieldset className="mt-3 border-t border-[#e1e4dd] pt-4" disabled={starting || screenShare.isSharing || desktopSharing || socket.ended || lockedByOther}>
            <legend className="sr-only">浏览器共享画质</legend>
            <label htmlFor="share-quality" className="mb-2.5 flex items-center gap-2 text-sm font-medium">
              浏览器共享画质 <span className="text-xs text-muted font-light">{allowedQualities.length} 档可选</span>
            </label>
            <select id="share-quality" className="w-full rounded-md border border-[#cbd0c7] bg-[#fffefd] px-3.5 py-3 text-sm disabled:opacity-60" value={qualityIdx ?? ''} onChange={e => setQualityIdx(e.target.value ? Number(e.target.value) : null)}>
              {qualityIdx === null && <option value="">暂无可用画质</option>}
              {QUALITY_OPTIONS.filter(q => allowedQualities.includes(q.key)).map(q => <option key={q.key} value={QUALITY_OPTIONS.indexOf(q)}>{q.label} · {q.encoderConfig.width}×{q.encoderConfig.height}</option>)}
            </select>
            {allowedQualities.length === 0 && <p className="mt-2 text-xs text-muted">该服务器暂未开放共享画质，请联系服务器管理员。</p>}
          </fieldset>
        </section>

        {/* 共享操作 */}
        <div className="space-y-3">
          {/* ===== 大按钮区域 ===== */}
          {screenShare.isSharing || desktopSharing ? (
            /* 正在共享 - 红色停止按钮 */
            <button
              onClick={handleStop}
              className="stop-share-button w-full py-4 rounded-lg bg-[#a0342d] hover:bg-[#8b2b25] text-white font-semibold text-lg flex items-center justify-center transition-colors"
            >
              停止共享
            </button>
          ) : socket.ended ? (
            /* 链接已失效 - 灰色大按钮 */
            <button
              disabled
              className="w-full py-5 rounded-md bg-white/5 border border-white/10 text-dim font-semibold text-lg flex items-center justify-center gap-3 cursor-not-allowed"
            >
              <AlertTriangle className="w-6 h-6" />
              链接已失效
            </button>
          ) : lockedByOther ? (
            /* 已有其他人正在共享 - 灰色按钮 */
            <button
              disabled
              className="w-full py-5 rounded-md bg-white/5 border border-white/10 text-dim font-semibold text-lg flex items-center justify-center gap-3 cursor-not-allowed"
            >
              <Monitor className="w-6 h-6" />
              已有其他人正在共享
            </button>
          ) : socket.status === 'grace' && !isPublisher ? (
            /* GRACE 状态 - 非共享者 - 等待恢复 */
            <button
              disabled
              className="w-full py-5 rounded-md bg-white/5 border border-white/10 text-dim font-semibold text-lg flex items-center justify-center gap-3 cursor-not-allowed"
            >
              <Clock className="w-6 h-6" />
              等待共享者恢复…
            </button>
          ) : socket.status === 'grace' && isPublisher ? (
            /* GRACE 状态 - 共享者 - 可恢复，显示倒计时 */
            <button
              onClick={handleStart}
              disabled={qualityIdx === null || starting}
              className={cn(
                'btn-brand w-full py-4 rounded-lg font-semibold text-lg flex items-center justify-center gap-3 disabled:opacity-40 disabled:cursor-not-allowed',
              )}
            >
              <Monitor className="w-6 h-6" />
              恢复共享
              {idleCountdown != null && idleCountdown > 0 && (
                <span className="text-sm opacity-80">（剩余 {idleCountdown}s）</span>
              )}
            </button>
          ) : activeElsewhere ? (
            /* 正在其他 session 共享 */
            <button
              disabled
              className="w-full py-5 rounded-md bg-white/5 border border-white/10 text-dim font-semibold text-lg flex items-center justify-center gap-3 cursor-not-allowed"
            >
              <Monitor className="w-6 h-6" />
              请先停止其他共享
            </button>
          ) : (
            /* 正常可用 - 选择共享窗口 */
            <button
              onClick={handleStart}
              disabled={starting || qualityIdx === null}
              className={cn(
                'btn-brand w-full py-4 rounded-lg font-semibold text-lg',
                'flex items-center justify-center gap-3 disabled:opacity-40 disabled:cursor-not-allowed',
                'transition-colors',
              )}
            >
              <Monitor className="w-6 h-6" />
              {starting ? '正在启动共享…' : '选择共享窗口'}
              {socket.status === 'pending' && idleCountdown != null && idleCountdown > 0 && (
                <span className="text-sm opacity-80">（剩余 {idleCountdown}s）</span>
              )}
            </button>
          )}

          {!screenShare.isSharing && !socket.ended && !lockedByOther && !activeElsewhere && (
            <div className="mt-3 space-y-2">
              <button onClick={handleDesktopStart} disabled={starting || allowedQualities.length === 0 || desktopSharing}
                className="w-full py-3 rounded-lg border border-[#cbd0c7] bg-[#fffefd] text-sm font-medium disabled:opacity-40 hover:bg-[#f3f4f0]">
                {desktopSharing ? `Windows 客户端正在共享 · ${socket.viewerCount} 人观看` : '使用 Windows 客户端共享'}
              </button>
              <div className="text-sm text-center">
                <a href={CLIENT_RELEASE_PAGE} target="_blank" rel="noopener noreferrer" className="inline-flex py-2 text-[#a94004] underline underline-offset-4">下载共享客户端</a>
              </div>
              {desktopRequested && !desktopSharing && desktopResponse === 'ready' && <p role="status" className="text-sm text-muted text-center">客户端已响应，请在客户端选择窗口或屏幕开始共享。</p>}
              {desktopSharing && <p className="text-xs text-muted text-center">关闭此网页不会停止客户端共享，可在此处或系统托盘停止。</p>}
            </div>
          )}

        </div>
        </div>
        </div>

        {/* 无人观看自动结束提示 */}
        {(screenShare.isSharing || desktopSharing) && noViewerCountdown != null && noViewerCountdown > 0 && (
          <div className="glass rounded-xl p-4 border border-yellow-400/40 flex items-center gap-3">
            <AlertTriangle className="w-5 h-5 text-yellow-400 shrink-0" />
            <div>
              <p className="text-sm text-yellow-300 font-medium">当前无人观看</p>
              <p className="text-xs text-muted mt-0.5">
                {noViewerCountdown} 秒后将自动结束直播以节省费用，有人观看即取消
              </p>
            </div>
          </div>
        )}

        {/* 错误提示 */}
        {(screenShare.error || shareError) && (
          <div className="glass rounded-xl p-4 border border-red-400/30 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-red-300 text-sm">共享出错</p>
              <p className="text-xs text-muted mt-1">{shareError || screenShare.error}</p>
            </div>
          </div>
        )}

        {/* ===== 链接已失效 - 大号醒目提示 ===== */}
        {socket.ended && (
          <div className="glass rounded-2xl p-8 border border-red-400/40 text-center">
            <AlertTriangle className="w-16 h-16 text-red-400 mx-auto mb-4" />
            <h2 className="text-2xl font-bold text-red-300 mb-2">共享链接已失效</h2>
            <p className="text-muted text-sm">本次共享已结束，链接无法继续使用。如需再次共享请重新发起。</p>
          </div>
        )}
      </main>
    </div>
  );
}
