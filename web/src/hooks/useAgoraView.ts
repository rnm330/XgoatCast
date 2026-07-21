import { useCallback, useEffect, useRef, useState } from 'react';
import type { IAgoraRTCClient, IRemoteVideoTrack, IRemoteAudioTrack } from 'agora-rtc-sdk-ng';
import { api } from '../lib/api';

const AgoraRTC = (window as any).AgoraRTC;
AgoraRTC.setLogLevel(2);

export interface ViewerState {
  joined: boolean;
  hasVideo: boolean;
  hasAudio: boolean;
  audioBlocked: boolean;
  error: string;
}

export function useAgoraView(token: string, active: boolean, lowLatency: boolean) {
  const clientRef = useRef<IAgoraRTCClient | null>(null);
  const videoRef = useRef<IRemoteVideoTrack | null>(null);
  const audioRef = useRef<IRemoteAudioTrack | null>(null);
  // 专门用于 Agora play() 的容器，与 React 管理的 DOM 隔离
  const playerContainerRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<ViewerState>({
    joined: false,
    hasVideo: false,
    hasAudio: false,
    audioBlocked: false,
    error: '',
  });

  /** 注册播放器容器（由 ViewPage 通过 ref callback 传入专用 div） */
  const setPlayerContainer = useCallback((el: HTMLDivElement | null) => {
    playerContainerRef.current = el;
  }, []);

  // 监听 Agora SDK 自动播放失败事件（浏览器 Autoplay Policy 拦截）
  // IRremoteAudioTrack.play() 返回 void，无法用 Promise.catch() 检测，
  // 必须通过 SDK 内置的 onAutoplayFailed 回调（v4.6.0+）
  useEffect(() => {
    const handleAutoplayFailed = () => {
      audioRef.current?.setVolume(0);
      setState((s) => ({ ...s, audioBlocked: true }));
    };
    AgoraRTC.onAutoplayFailed = handleAutoplayFailed;
    return () => {
      if (AgoraRTC.onAutoplayFailed === handleAutoplayFailed) {
        AgoraRTC.onAutoplayFailed = undefined;
      }
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    const join = async () => {
      try {
        const tokenResp = await api.getShareToken(token, 'subscriber');
        if (cancelled) return;

        // 极速直播（默认）：mode:'live' + audience + level:1，低延时 1.5-2s，画质优先
        // 低延迟模式：mode:'rtc'，超低延时 400-800ms，流畅优先
        const client = lowLatency
          ? AgoraRTC.createClient({ mode: 'rtc', codec: 'h264' })
          : AgoraRTC.createClient({ mode: 'live', codec: 'h264' });
        clientRef.current = client;

        // 极速直播观众：设 role='audience', level=1（低延时）
        if (!lowLatency) {
          await client.setClientRole('audience', { level: 1 });
        }

        // 严格按 Agora 官方示例
        client.on('user-published', async (user: any, mediaType: 'video' | 'audio') => {
          try {
            await client.subscribe(user, mediaType);
            if (cancelled) return;

            if (mediaType === 'video') {
              videoRef.current = user.videoTrack;
              // 在专用容器中播放（不触碰 React 管理的 DOM）
              // fit: 'contain' 完整显示屏幕内容，避免边缘被裁切
              if (playerContainerRef.current) {
                user.videoTrack.play(playerContainerRef.current, { fit: 'contain' });
              }
              setState((s) => ({ ...s, hasVideo: true }));
            }

            if (mediaType === 'audio') {
              audioRef.current = user.audioTrack;
              // play() 返回 void（非 Promise），浏览器 Autoplay Policy 拦截由
              // AgoraRTC.onAutoplayFailed 全局回调统一检测（SDK v4.6.0+）
              audioRef.current.play();
              setState((s) => ({ ...s, hasAudio: true }));
            }
          } catch (e) {
            console.error('subscribe error', e);
          }
        });

        client.on('user-unpublished', (user: any, mediaType: 'video' | 'audio') => {
          if (mediaType === 'video') {
            // 停止播放并移除 Agora 在容器中创建的 <video> 元素，
            // 否则分享者暂停/停止发布后画面中央会残留原生播放器占位图标
            try { user?.videoTrack?.stop(); } catch {}
            videoRef.current = null;
            setState((s) => ({ ...s, hasVideo: false }));
          }
          if (mediaType === 'audio') {
            try { user?.audioTrack?.stop(); } catch {}
            audioRef.current = null;
            setState((s) => ({ ...s, hasAudio: false }));
          }
        });

        await client.join(
          tokenResp.appId,
          tokenResp.channel,
          tokenResp.token || null,
          tokenResp.uid,
        );
        if (cancelled) return;
        setState((s) => ({ ...s, joined: true }));
      } catch (e: any) {
        if (!cancelled) {
          setState((s) => ({ ...s, error: e?.message || String(e) }));
        }
      }
    };

    join();

    return () => {
      cancelled = true;
      const client = clientRef.current;
      if (client) {
        client.leave().catch(() => {});
      }
      clientRef.current = null;
      videoRef.current = null;
      audioRef.current = null;
    };
  }, [token, active, lowLatency]);

  const setAudioMuted = useCallback((muted: boolean) => {
    if (muted) {
      audioRef.current?.setVolume(0);
    } else {
      audioRef.current?.setVolume(100);
      // 用户交互后浏览器允许播放，恢复音频
      audioRef.current?.play();
      setState((s) => (s.audioBlocked ? { ...s, audioBlocked: false } : s));
    }
  }, []);

  const setVolume = useCallback((level: number) => {
    if (audioRef.current) {
      audioRef.current.setVolume(level);
    }
  }, []);

  return { ...state, setPlayerContainer, setAudioMuted, setVolume };
}
