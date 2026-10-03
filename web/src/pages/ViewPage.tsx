import { panelRequest } from '../lib/panels';
import { useEffect, useState, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  Loader2,
  Maximize,
  Minimize,
  Volume2,
  VolumeX,
  LogOut,
  Users,
  PictureInPicture2,
  Link2,
  CheckCircle2,
  Copy,
  MonitorUp,
} from 'lucide-react';
import { api } from '../lib/api';
import { useSessionSSE } from '../hooks/useSessionSSE';
import { useAgoraView } from '../hooks/useAgoraView';
import { cn, copyToClipboard } from '../lib/utils';
import type { SessionInfo } from '../types';
import { NoticeBanners } from '../components/notices/NoticeCenter';
import { getClientEnvironment, markPageOpenOnce } from '../lib/clientEnv';

export default function ViewPage() {
  const [params] = useSearchParams();
  const token = params.get('t') || '';
  return token.startsWith('v_') ? <RoomPasswordGate key={token} token={token} /> : <ViewContent key={token} />;
}

function RoomPasswordGate({ token }: { token: string }) {
  const [allowed, setAllowed] = useState(false);
  const [checking, setChecking] = useState(true);
  const [required, setRequired] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    panelRequest(`share/room-access?t=${encodeURIComponent(token)}`).then(result => {
      if (cancelled) return;
      setRequired(result.required); setAllowed(!result.required);
    }).catch(e => { if (!cancelled) setError(e.message); }).finally(() => { if (!cancelled) setChecking(false); });
    return () => { cancelled = true; };
  }, [token]);
  if (allowed) return <ViewContent />;
  return <div className="min-h-screen flex items-center justify-center p-6"><form className="glass rounded-2xl p-8 w-full max-w-md space-y-5" onSubmit={async e => {
    e.preventDefault(); setBusy(true); setError('');
    try { await panelRequest('share/room-access', { token, password }); setPassword(''); setAllowed(true); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }}><h1 className="text-xl font-semibold">{checking ? '正在检查共享…' : '观看共享'}</h1>{required && <><p className="text-sm text-muted">此共享设置了观看密码。</p><input aria-label="观看密码" autoComplete="current-password" className="w-full rounded-xl px-4 py-3 bg-white/5 border border-white/10" type="password" value={password} onChange={e => setPassword(e.target.value)} maxLength={72} required /><button disabled={busy} className="btn-brand rounded-xl px-5 py-3 w-full">{busy ? '验证中…' : '验证并观看'}</button></>}{error && <p role="alert" className="text-red-300 text-sm">{error}</p>}</form></div>;
}

function ViewContent() {
  const [params] = useSearchParams();
  const token = params.get('t') || '';
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(100);
  const [copied, setCopied] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const socket = useSessionSSE(token, 'viewer');
  // 仅在共享者已开始共享（active/grace）时才接入声网，pending 状态不连接以节省计费；
  // GRACE 期间保持 Agora 连接不 leave/rejoin，分享者恢复时 user-published 自动触发重新订阅
  const active = socket.status === 'active' || socket.status === 'grace';
  const view = useAgoraView(token, active, socket.lowLatency ?? false);
  const screenRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!token) {
      setLoadError('缺少观看令牌');
      setLoading(false);
      return;
    }
    api
      .getShareInfo(token)
      .then((data) => {
        setInfo(data);
        setLoading(false);
        if (markPageOpenOnce(token, 'view')) {
          void api.reportShareTelemetry({
            token,
            pageType: 'view',
            eventType: 'page_open',
            ...getClientEnvironment(),
          }).catch(() => {});
        }
      })
      .catch((e) => {
        setLoadError(e.message || '加载失败');
        setLoading(false);
      });
  }, [token]);

  // 鼠标移动时显示控制条，3秒后隐藏
  const handleMouseMove = useCallback(() => {
    setShowControls(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setShowControls(false), 3000);
  }, []);

  // 全屏切换：兼容 iOS Safari（webkitEnterFullscreen）并锁定横屏
  const toggleFullscreen = useCallback(async () => {
    const container = screenRef.current;
    if (!container) return;
    const video = container.querySelector('video') as
      | (HTMLVideoElement & { webkitEnterFullscreen?: () => void })
      | null;

    if (!document.fullscreenElement) {
      try {
        if (video?.webkitEnterFullscreen) {
          // iOS Safari 仅支持对 video 元素全屏
          video.webkitEnterFullscreen();
        } else if (container.requestFullscreen) {
          await container.requestFullscreen();
          // Android / 桌面：进入全屏后锁定横屏
          const orientation = screen.orientation as any;
          if (orientation?.lock) {
            try { await orientation.lock('landscape'); } catch { /* 忽略不支持 */ }
          }
        }
      } catch (e) {
        console.error('fullscreen failed', e);
      }
    } else {
      await document.exitFullscreen?.();
      const orientation = screen.orientation as any;
      if (orientation?.unlock) {
        try { await orientation.unlock(); } catch { /* 忽略不支持 */ }
      }
    }
  }, []);

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  // 画中画
  const togglePiP = useCallback(async () => {
    const container = screenRef.current;
    if (!container) return;
    const video = container.querySelector('video');
    if (!video) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await video.requestPictureInPicture();
      }
    } catch (e) {
      console.error('PiP failed:', e);
    }
  }, []);

  // 用户点击开启声音（浏览器阻止自动播放后，用户交互恢复播放）
  const handleEnableAudio = useCallback(() => {
    setMuted(false);
    view.setAudioMuted(false);
  }, [view]);

  // 音量调节
  const handleVolumeChange = useCallback((newVolume: number) => {
    setVolume(newVolume);
    view.setVolume(newVolume);
    if (newVolume > 0 && muted) {
      setMuted(false);
      view.setAudioMuted(false);
    }
  }, [view, muted]);

  // 静音切换：操作 Agora audioTrack 而非 DOM video 元素（视频元素不含音频）
  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m;
      view.setAudioMuted(next);
      return next;
    });
  }, [view]);

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
          <h2 className="text-base font-semibold mb-1.5">无法观看</h2>
          <p className="text-muted text-xs">{loadError}</p>
          <button
            onClick={() => (window.location.href = '/')}
            className="mt-4 text-xs text-brand hover:text-brand-light transition-colors"
          >
            返回首页
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-surface-dark">
      {/* 顶部信息栏 */}
      <header className={cn(
        'fixed top-0 left-0 right-0 z-20 glass-strong px-5 py-3 flex items-center justify-between',
        isFullscreen && 'hidden'
      )}>
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand/10 text-brand-light"><MonitorUp size={20} strokeWidth={1.7} /></span>
          <div>
            <p className="font-semibold text-sm leading-tight">Xgoat.Cast 屏幕共享</p>
            <p className="text-xs text-dim">共享人：{info?.sharerUsername || '加载中'}</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5 text-sm text-muted">
            <Users className="w-4 h-4" />
            {socket.viewerCount}
          </span>
          <button
            onClick={() => (window.location.href = '/')}
            className="flex items-center gap-1.5 text-sm text-muted hover:text-brand-light transition-colors"
          >
            <LogOut className="w-4 h-4" />
            退出
          </button>
        </div>
      </header>

      {/* 视频播放区 */}
      <main className={cn(
        'flex-1 flex flex-col items-center justify-center',
        !isFullscreen && 'pt-16 pb-8 px-4'
      )}>
        {!isFullscreen && <div className="w-full max-w-6xl"><NoticeBanners /></div>}
        <div
          ref={screenRef}
          onMouseMove={handleMouseMove}
          onTouchMove={handleMouseMove}
          onMouseLeave={() => setShowControls(false)}
          onClick={() => { if (view.audioBlocked) handleEnableAudio(); }}
          className={cn(
            'video-stage relative bg-black shadow-2xl overflow-hidden',
            isFullscreen
              ? 'fixed inset-0 z-50 w-screen h-screen rounded-none'
              : 'w-full max-w-6xl aspect-video rounded-2xl'
          )}
        >
          {/* Agora 专用播放容器 */}
          <div
            ref={view.setPlayerContainer}
            className="absolute inset-0 w-full h-full"
          />

          {/* 加载/等待/暂停状态：未加入、暂停宽限期、或等待分享者开始 */}
          {(!view.joined || socket.status === 'grace' || socket.status === 'pending') && !socket.ended && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 pointer-events-none">
              <Loader2 className="w-8 h-8 text-brand animate-spin" />
              <p className="text-sm text-muted">
                {socket.status === 'grace'
                  ? '分享者已暂停，等待恢复...'
                  : socket.status === 'pending'
                    ? '等待分享者开始共享...'
                    : '正在连接...'}
              </p>
            </div>
          )}
          {/* 纯音频占位：已加入、无视频、非暂停、非等待中 */}
          {view.joined && !view.hasVideo && socket.status !== 'grace' && socket.status !== 'pending' && !socket.ended && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <Volume2 className="w-10 h-10 text-muted animate-pulse" />
            </div>
          )}

          {/* 音频被阻止提示：浏览器自动播放策略限制 */}
          {view.audioBlocked && view.hasAudio && (
            <div
              onClick={handleEnableAudio}
              className="absolute top-4 left-1/2 -translate-x-1/2 z-30 cursor-pointer bg-brand/90 hover:bg-brand text-white px-4 py-2 rounded-full shadow-lg shadow-brand/30 flex items-center gap-2 transition-all animate-pulse"
            >
              <Volume2 className="w-4 h-4" />
              <span className="text-sm font-medium">点击开启声音</span>
            </div>
          )}
          {socket.ended && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 pointer-events-none">
              <AlertTriangle className="w-10 h-10 text-yellow-400" />
              <p className="text-sm text-muted">共享已结束，链接已失效</p>
            </div>
          )}

          {/* 播放器控制条 - 右下角，类似标准浏览器播放器 */}
          {view.hasVideo && !socket.ended && (
            <div
              className={cn(
                'absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-4 py-3 flex items-center justify-end gap-2 transition-opacity duration-300',
                showControls ? 'opacity-100' : 'opacity-0 pointer-events-none',
              )}
            >
              {/* 左侧：观看人数 */}
              <span className="flex items-center gap-1.5 text-xs text-white/80 mr-auto">
                <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                {socket.viewerCount} 人在看
              </span>

              {/* 右侧控制按钮 */}
              <div className="flex items-center gap-1">
                <button
                  onClick={toggleMute}
                  title={muted ? '取消静音' : '静音'}
                  className="p-2 rounded-lg text-white/80 hover:text-white hover:bg-white/10 transition-colors"
                >
                  {muted ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
                </button>
                {/* 音量滑动条 */}
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={muted ? 0 : volume}
                  onChange={(e) => handleVolumeChange(Number(e.target.value))}
                  className="w-20 h-1 bg-white/30 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:cursor-pointer"
                  title={`音量: ${muted ? 0 : volume}%`}
                />
              </div>

              <button
                onClick={togglePiP}
                title="画中画"
                className="p-2 rounded-lg text-white/80 hover:text-white hover:bg-white/10 transition-colors"
              >
                <PictureInPicture2 className="w-5 h-5" />
              </button>

              <button
                onClick={toggleFullscreen}
                title={isFullscreen ? '退出全屏' : '全屏'}
                className="p-2 rounded-lg text-white/80 hover:text-white hover:bg-white/10 transition-colors"
              >
                {isFullscreen ? <Minimize className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}
              </button>
            </div>
          )}
        </div>

        {/* 播放器下方信息栏：连接状态、观看人数、可复制链接 */}
        {!isFullscreen && info && (
          <div className="w-full max-w-6xl mt-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              <span className={cn('w-2 h-2 rounded-full', socket.connected ? 'bg-green-400' : 'bg-yellow-400', 'animate-pulse')} />
              <span className="text-xs text-muted">{socket.connected ? '已连接' : '连接中'}</span>
            </div>
            <button
              onClick={() => { copyToClipboard(info.viewLink); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
              className="flex items-center gap-1.5 text-xs text-dim hover:text-brand-light transition-colors cursor-pointer"
              title="点击复制页面链接"
            >
              <Link2 className="w-3.5 h-3.5" />
              <span className="truncate max-w-[280px] underline underline-offset-2 decoration-dotted">
                {info.viewLink}
              </span>
              {copied
                ? <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />
                : <Copy className="w-3.5 h-3.5" />
              }
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
