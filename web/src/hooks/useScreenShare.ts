import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  IAgoraRTCClient,
  ILocalVideoTrack,
  ILocalAudioTrack,
} from 'agora-rtc-sdk-ng';
import { api } from '../lib/api';
import { installScreenAudioInterceptor } from '../lib/screenAudioCapture';

const AgoraRTC = (window as any).AgoraRTC;
AgoraRTC.setLogLevel(2);

// 安装 getDisplayMedia 劫持器（模块级，仅执行一次）
installScreenAudioInterceptor();

export interface PublishResult {
  success: boolean;
  message?: string;
}

export interface QualityOption {
  key: string;
  label: string;
  encoderConfig: {
    width: number;
    height: number;
    frameRate: number;
    bitrateMin: number;
    bitrateMax: number;
  };
}

/** 7 种画质选项，与后端 QUALITY_PRESETS 对应 */
export const QUALITY_OPTIONS: QualityOption[] = [
  {
    key: '480p_2',
    label: '480P 30fps',
    encoderConfig: { width: 640, height: 480, frameRate: 30, bitrateMin: 400, bitrateMax: 1000 },
  },
  {
    key: '720p30',
    label: '720P 30fps',
    encoderConfig: { width: 1280, height: 720, frameRate: 30, bitrateMin: 1000, bitrateMax: 3000 },
  },
  {
    key: '1080p_2',
    label: '1080P 30fps',
    encoderConfig: { width: 1920, height: 1080, frameRate: 30, bitrateMin: 2000, bitrateMax: 5000 },
  },
  {
    key: '1080p60',
    label: '1080P 60fps',
    encoderConfig: { width: 1920, height: 1080, frameRate: 60, bitrateMin: 4000, bitrateMax: 8000 },
  },
  {
    key: '1440p30',
    label: '2K 30fps',
    encoderConfig: { width: 2560, height: 1440, frameRate: 30, bitrateMin: 4000, bitrateMax: 10000 },
  },
  {
    key: '1440p60',
    label: '2K 60fps',
    encoderConfig: { width: 2560, height: 1440, frameRate: 60, bitrateMin: 6000, bitrateMax: 15000 },
  },
  {
    key: '4k30',
    label: '4K 30fps',
    encoderConfig: { width: 3840, height: 2160, frameRate: 30, bitrateMin: 8000, bitrateMax: 20000 },
  },
];

export function useScreenShare(token: string, onTrackEnded?: () => void) {
  const clientRef = useRef<IAgoraRTCClient | null>(null);
  const screenVideoRef = useRef<ILocalVideoTrack | null>(null);
  const screenAudioRef = useRef<ILocalAudioTrack | null>(null);
  const onTrackEndedRef = useRef(onTrackEnded);
  onTrackEndedRef.current = onTrackEnded;
  const [isSharing, setIsSharing] = useState(false);
  const [error, setError] = useState<string>('');
  // 本地预览容器（分享者查看自己的画面，不走声网）
  const localPreviewRef = useRef<HTMLDivElement | null>(null);

  const setLocalPreviewContainer = useCallback((el: HTMLDivElement | null) => {
    localPreviewRef.current = el;
  }, []);

  // 本地预览：当 isSharing 变为 true 且容器已挂载后，播放本地屏幕轨道
  useEffect(() => {
    if (isSharing && localPreviewRef.current && screenVideoRef.current) {
      screenVideoRef.current.play(localPreviewRef.current, { fit: 'contain' });
    }
  }, [isSharing]);

  const publish = useCallback(
    async (opts: {
      qualityKey?: string;
      lowLatency: boolean;
    }) => {
      setError('');
      try {
        if (!(window as any).AgoraRTC) {
          throw new Error('Agora SDK 未加载，请检查网络连接');
        }

        // 1. 先获取 token（不连接服务器）
        const tokenResp = await api.getShareToken(token, 'publisher');

        // 2. 先创建屏幕共享轨道（用户选择窗口）
        const qKey = opts.qualityKey || '1080p_2';
        const qOpt = QUALITY_OPTIONS.find((q) => q.key === qKey) || QUALITY_OPTIONS[2];
        const screenTrack = await AgoraRTC.createScreenVideoTrack(
          {
            encoderConfig: qOpt.encoderConfig,
            // 默认（极速直播）：detail 画质优先；低延迟：motion 流畅优先（弱网降分辨率保帧率）
            optimizationMode: opts.lowLatency ? 'motion' : 'detail',
          },
          // ScreenAudioTrackInitConfig：关 3A 保真多声道 + restrictOwnAudio 防回声
          {
            AEC: false,   // 关闭回声消除（媒体音频被当人声处理会失真）
            AGC: false,   // 关闭自动增益
            ANS: false,   // 关闭噪声抑制
            restrictOwnAudio: true,  // 过滤本浏览器标签页音频，防回声
          },
        );

        if (Array.isArray(screenTrack)) {
          screenVideoRef.current = screenTrack[0];
          screenAudioRef.current = screenTrack[1];
        } else {
          screenVideoRef.current = screenTrack as ILocalVideoTrack;
        }

        const tracks: (ILocalVideoTrack | ILocalAudioTrack)[] = [
          screenVideoRef.current,
        ];
        if (screenAudioRef.current) tracks.push(screenAudioRef.current);

        // 3. 用户已选择窗口，现在连接服务器
        // 极速直播（默认）：mode:'live' + host 角色，观众端用 audience+level:1 低延时 1.5-2s，detail 画质优先
        // 低延迟模式：mode:'rtc'，超低延时 400-800ms，motion 流畅优先
        const client = opts.lowLatency
          ? AgoraRTC.createClient({ mode: 'rtc', codec: 'h264' })
          : AgoraRTC.createClient({ mode: 'live', codec: 'h264' });
        clientRef.current = client;

        // 极速直播共享者必须先切 host 才能 publish
        if (!opts.lowLatency) {
          await client.setClientRole('host');
        }

        await client.join(
          tokenResp.appId,
          tokenResp.channel,
          tokenResp.token || null,
          tokenResp.uid,
        );

        // 4. 发布轨道
        await client.publish(tracks);
        screenVideoRef.current?.on('track-ended', () => {
          // track 意外结束（用户通过浏览器原生 UI 停止、或高分辨率导致资源不足）
          // 通知父组件发送 sharing_stopped，让 session 进入 60 秒恢复宽限期
          stop();
          onTrackEndedRef.current?.();
        });
        setIsSharing(true);
        return { success: true };
      } catch (e: any) {
        // 失败时清理已创建的 Agora 资源，避免泄漏
        await stop();
        let msg = e?.message || String(e);
        // 尝试解析 JSON 格式的错误消息（如 401 share ended）
        try {
          const parsed = JSON.parse(msg);
          if (parsed.message) msg = parsed.message;
        } catch {}
        if (msg.includes('PERMISSION_DENIED') || msg.includes('NotAllowedError')) {
          if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
            msg = '屏幕采集需要 HTTPS 环境才能使用。请通过 https:// 域名访问本页面，当前是 ' + location.protocol + '//' + location.host;
          } else {
            msg = '浏览器拒绝了屏幕采集权限，请在弹窗中点击「允许」并选择要共享的窗口/屏幕';
          }
        } else if (msg.includes('share ended') || msg.includes('Unauthorized')) {
          msg = '共享链接已失效（可能因服务器重启或超时），请重新发起共享';
        } else if (msg.includes('NOT_SUPPORTED') || msg.includes('audio') || msg.includes('Audio')) {
          // enable 语义下用户不勾"共享音频"可能抛错
          msg = '请在共享弹窗中勾选「分享音频」，否则无法共享声音';
        }
        setError(msg);
        return { success: false, message: msg };
      }
    },
    [token],
  );

  const stop = useCallback(async () => {
    const client = clientRef.current;
    try {
      screenVideoRef.current?.stop();
      screenAudioRef.current?.stop();
      if (client) await client.leave();
    } catch (e) {
      console.error('leave error', e);
    }
    screenVideoRef.current = null;
    screenAudioRef.current = null;
    clientRef.current = null;
    setIsSharing(false);
  }, []);

  return { isSharing, error, publish, stop, setLocalPreviewContainer };
}
