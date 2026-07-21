import { useEffect, useState, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, Loader2, Link2, CheckCircle2, Monitor, Zap, ZapOff, Clock } from 'lucide-react';
import { api } from '../lib/api';
import { useSessionSSE } from '../hooks/useSessionSSE';
import { useScreenShare, QUALITY_OPTIONS } from '../hooks/useScreenShare';
import { copyToClipboard, cn } from '../lib/utils';
import type { SessionInfo } from '../types';

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
function clearActiveShare(): void {
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
  const [qualityIdx, setQualityIdx] = useState(2);
  const [copied, setCopied] = useState(false);
  const [allowedQualities, setAllowedQualities] = useState<string[]>(QUALITY_OPTIONS.map((q) => q.key));
  const [shareError, setShareError] = useState('');
  const [idleCountdown, setIdleCountdown] = useState<number | null>(null);
  const [noViewerCountdown, setNoViewerCountdown] = useState<number | null>(null);
  const idleDeadlineRef = useRef<number | null>(null);
  const noViewerDeadlineRef = useRef<number | null>(null);

  const socket = useSessionSSE(token, 'publisher');
  const screenShare = useScreenShare(token, () => {
    socket.stopSharing();
  });
  const stopRef = useRef(screenShare.stop);
  stopRef.current = screenShare.stop;

  useEffect(() => {
    if (!token) { setLoadError('缺少分享令牌'); setLoading(false); return; }
    api.getShareInfo(token)
      .then((data) => {
        setInfo(data);
        if (data.allowedQualities?.length) {
          setAllowedQualities(data.allowedQualities);
          const idx = QUALITY_OPTIONS.findIndex((q) => q.key === data.allowedQualities![0]);
          if (idx >= 0) setQualityIdx(idx);
        }
        // 恢复已持久化的低延迟模式
        if (data.lowLatency) setLowLatency(true);
        setLoading(false);

        // 清理 stale active cookie：服务器重新部署后旧 session 已失效，
        // 但浏览器 Cookie 仍保存旧 token，会导致误报"请先停止其他共享"
        const staleActive = getActiveShare();
        if (staleActive && staleActive !== token) {
          api.getShareInfo(staleActive)
            .then((staleInfo) => {
              if (staleInfo.status === 'ended') clearActiveShare();
            })
            .catch(() => { clearActiveShare(); });
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
    setShareError('');
    // 检查是否正在其他 session 共享
    const active = getActiveShare();
    if (active && active !== token) {
      setShareError('您正在另一个会话中共享，请先停止那个共享再开始新的。');
      return;
    }
    const result = await screenShare.publish({
      qualityKey: QUALITY_OPTIONS[qualityIdx].key,
      lowLatency,
    });
    if (result.success) {
      const resp = await socket.startSharing(QUALITY_OPTIONS[qualityIdx].key, clientId, lowLatency);
      if (resp.ok) {
        setActiveShare(token);
      } else {
        screenShare.stop();
        setShareError('无法开始共享，可能已有其他人正在共享或链接已失效。');
      }
    }
  }, [screenShare, socket, qualityIdx, token, clientId, lowLatency]);

  const handleStop = useCallback(async () => {
    await screenShare.stop();
    socket.stopSharing();
    clearActiveShare();
  }, [screenShare, socket]);

  useEffect(() => {
    const handler = () => { stopRef.current(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  useEffect(() => {
    if (socket.ended) {
      screenShare.stop();
      clearActiveShare();
    }
  }, [socket.ended, screenShare]);

  // 判断当前用户的共享权限（使用 socket 实时状态，而非初始 API 加载的静态数据）
  const isPublisher = !socket.publisherClientId || socket.publisherClientId === clientId;
  const lockedByOther = !!socket.publisherClientId && socket.publisherClientId !== clientId;
  const activeElsewhere = !!getActiveShare() && getActiveShare() !== token;

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
      <header className="flex items-center justify-between mb-8 max-w-3xl mx-auto">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-brand-dark to-brand flex items-center justify-center text-xl">
            🐑
          </div>
          <div>
            <h1 className="font-bold text-lg leading-tight">Xgoat.Cast</h1>
            <p className="text-xs text-muted">屏幕共享</p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className={cn('w-2.5 h-2.5 rounded-full', socket.connected ? 'bg-green-400' : 'bg-yellow-400', 'animate-pulse')} />
          <span className="text-muted">{socket.connected ? '已连接' : '连接中'}</span>
        </div>
      </header>

      <main className="max-w-3xl mx-auto space-y-5">
        {/* 分享者信息 + 观看链接 */}
        {info && (
          <div className="glass rounded-2xl p-4 flex items-center justify-between flex-wrap gap-3">
            <div>
              <p className="text-sm text-muted">分享者</p>
              <p className="font-semibold">{info.sharerUsername}</p>
            </div>
            <div className="flex items-center gap-2">
              <code className="text-xs text-dim bg-white/5 px-3 py-1.5 rounded-lg max-w-[240px] truncate">
                {info.viewLink}
              </code>
              <button
                onClick={() => { copyToClipboard(info.viewLink); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
                className="btn-brand px-3 py-1.5 rounded-lg text-white text-sm flex items-center gap-1.5"
              >
                {copied ? <CheckCircle2 className="w-4 h-4" /> : <Link2 className="w-4 h-4" />}
                复制观看链接
              </button>
            </div>
          </div>
        )}

        {/* 本地预览画面（不走声网，节省流量） */}
        {screenShare.isSharing && (
          <div className="relative w-full aspect-video rounded-2xl bg-black shadow-2xl overflow-hidden">
            <div ref={screenShare.setLocalPreviewContainer} className="absolute inset-0 w-full h-full" />
          </div>
        )}

        {/* 画质选择 + 大按钮 */}
        <div className="glass-strong rounded-2xl p-6">
          {screenShare.isSharing && (
            <div className="flex items-center justify-center gap-2 mb-4 text-brand-light text-sm">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              正在共享 · {socket.viewerCount} 人观看
              <span className={cn(
                'text-xs px-2 py-0.5 rounded-full',
                lowLatency ? 'bg-blue-500/20 text-blue-300' : 'bg-green-500/20 text-green-300',
              )}>
                {lowLatency ? '低延迟 400-800ms' : '普通模式 1500-2000ms'}
              </span>
            </div>
          )}

          {/* 画质选择按钮组 */}
          <div className="mb-4">
            <label className="text-xs text-muted mb-2 block text-center">选择画质</label>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
              {QUALITY_OPTIONS.map((q) => {
                const idx = QUALITY_OPTIONS.indexOf(q);
                const enabled = allowedQualities.includes(q.key);
                const selected = idx === qualityIdx;
                return (
                  <button
                    key={q.key}
                    disabled={!enabled || screenShare.isSharing || socket.ended || lockedByOther}
                    onClick={() => { if (enabled) setQualityIdx(idx); }}
                    className={cn(
                      'flex flex-col items-center gap-1 px-3 py-2 rounded-lg border cursor-pointer transition-all text-sm',
                      selected
                        ? 'border-brand bg-brand/20 text-white shadow-lg shadow-brand/30 ring-2 ring-brand/50'
                        : enabled
                          ? 'border-white/8 bg-white/[0.03] text-muted hover:border-white/15'
                          : 'border-white/5 bg-white/[0.01] text-dim cursor-not-allowed',
                      (screenShare.isSharing || socket.ended || lockedByOther) && 'opacity-40 cursor-not-allowed',
                    )}
                  >
                    <span className="font-medium">{q.label}</span>
                    <span className="text-dim text-xs">{q.encoderConfig.width}×{q.encoderConfig.height}</span>
                    {!enabled && <span className="text-xs text-dim">未开放</span>}
                  </button>
                );
              })}
            </div>
          </div>

          {/* ===== 大按钮区域 ===== */}
          {screenShare.isSharing ? (
            /* 正在共享 - 红色停止按钮 */
            <button
              onClick={handleStop}
              className="w-full py-5 rounded-2xl bg-red-500/90 hover:bg-red-500 text-white font-semibold text-lg flex items-center justify-center transition-colors"
            >
              停止共享
            </button>
          ) : socket.ended ? (
            /* 链接已失效 - 灰色大按钮 */
            <button
              disabled
              className="w-full py-5 rounded-2xl bg-white/5 border border-white/10 text-dim font-semibold text-lg flex items-center justify-center gap-3 cursor-not-allowed"
            >
              <AlertTriangle className="w-6 h-6" />
              链接已失效
            </button>
          ) : lockedByOther ? (
            /* 已有其他人正在共享 - 灰色按钮 */
            <button
              disabled
              className="w-full py-5 rounded-2xl bg-white/5 border border-white/10 text-dim font-semibold text-lg flex items-center justify-center gap-3 cursor-not-allowed"
            >
              <Monitor className="w-6 h-6" />
              已有其他人正在共享
            </button>
          ) : socket.status === 'grace' && !isPublisher ? (
            /* GRACE 状态 - 非共享者 - 等待恢复 */
            <button
              disabled
              className="w-full py-5 rounded-2xl bg-white/5 border border-white/10 text-dim font-semibold text-lg flex items-center justify-center gap-3 cursor-not-allowed"
            >
              <Clock className="w-6 h-6" />
              等待共享者恢复…
            </button>
          ) : socket.status === 'grace' && isPublisher ? (
            /* GRACE 状态 - 共享者 - 可恢复，显示倒计时 */
            <button
              onClick={handleStart}
              className={cn(
                'w-full py-5 rounded-2xl text-white font-semibold text-lg flex items-center justify-center gap-3 transition-all',
                'bg-gradient-to-r from-brand-dark to-brand hover:scale-[1.01] disabled:opacity-40 disabled:cursor-not-allowed',
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
              className="w-full py-5 rounded-2xl bg-white/5 border border-white/10 text-dim font-semibold text-lg flex items-center justify-center gap-3 cursor-not-allowed"
            >
              <Monitor className="w-6 h-6" />
              请先停止其他共享
            </button>
          ) : (
            /* 正常可用 - 选择共享窗口 */
            <button
              onClick={handleStart}
              className={cn(
                'btn-brand w-full py-5 rounded-2xl text-white font-semibold text-lg',
                'flex items-center justify-center gap-3 disabled:opacity-40 disabled:cursor-not-allowed',
                'transition-all hover:scale-[1.01]',
              )}
            >
              <Monitor className="w-6 h-6" />
              选择共享窗口
              {socket.status === 'pending' && idleCountdown != null && idleCountdown > 0 && (
                <span className="text-sm opacity-80">（剩余 {idleCountdown}s）</span>
              )}
            </button>
          )}

          {/* 按钮下方提示 */}
          {!screenShare.isSharing && !socket.ended && !lockedByOther && !activeElsewhere && (
            <p className="text-xs text-dim text-center mt-3">
              {socket.status === 'grace' && isPublisher
                ? '点击按钮恢复共享，超时未共享屏幕链接将失效'
                : socket.status === 'pending'
                  ? '点击后浏览器会弹窗选择要共享的屏幕或窗口，超时未开始共享链接将失效'
                  : '点击后浏览器会弹窗选择要共享的屏幕或窗口'}
            </p>
          )}
        </div>

        {/* 低延迟模式开关（仅服务器允许时显示） */}
        {info?.allowLowLatency && (
          <div className="flex gap-3">
            <button
              onClick={() => setLowLatency((v) => !v)}
              disabled={screenShare.isSharing || socket.ended || lockedByOther || (socket.status === 'grace' && isPublisher)}
              className={cn(
                'flex-1 flex items-center justify-center gap-2 py-3 rounded-xl border transition-all',
                lowLatency
                  ? 'border-blue-400 bg-blue-500/20 text-white shadow-lg shadow-blue-500/30 ring-2 ring-blue-400/50'
                  : 'border-white/8 bg-white/[0.03] text-muted hover:border-white/15',
                (screenShare.isSharing || socket.ended || lockedByOther || (socket.status === 'grace' && isPublisher)) && 'opacity-40 cursor-not-allowed',
              )}
            >
              {lowLatency ? <Zap className="w-4 h-4" /> : <ZapOff className="w-4 h-4" />}
              <span className="text-sm font-medium">低延迟模式</span>
              <span className={cn(
                'text-xs px-1.5 py-0.5 rounded-full',
                lowLatency ? 'bg-blue-500/20 text-blue-300' : 'bg-white/5 text-dim',
              )}>
                {lowLatency ? '开' : '关'}
              </span>
            </button>
          </div>
        )}

        {/* 低延迟模式说明 */}
        {info?.allowLowLatency && !screenShare.isSharing && (
          <p className="text-xs text-dim text-center">
            {lowLatency
              ? '⚡ 低延迟模式：延迟降低约 60-70%（400-800ms），费用上涨约 100%'
              : '当前为普通模式（延迟 1500-2000ms），费用较低'}
          </p>
        )}

        {/* 无人观看自动结束提示 */}
        {screenShare.isSharing && noViewerCountdown != null && noViewerCountdown > 0 && (
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
