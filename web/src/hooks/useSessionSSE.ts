import { useEffect, useRef, useState, useCallback } from 'react';
import type { SessionStatus } from '../types';
import { api } from '../lib/api';

interface SessionState {
  connected: boolean;
  status: SessionStatus | null;
  viewerCount: number;
  ended: boolean;
  publisherClientId?: string;
  idleRemainingSec?: number;
  noViewerRemainingSec?: number;
  lowLatency?: boolean;
}

/**
 * SSE + fetch 替代原 WebSocket (socket.io)。
 *
 * 发布端: GET /api/share/stream?t=<token>&role=publisher&cid=<clientId>
 * 观众端: GET /api/share/stream?t=<token>&role=viewer&vid=<viewerId>
 *
 * 发布端→服务端操作（start/stop）改为 fetch POST:
 *   POST /api/share/start  { token, quality, clientId, lowLatency }
 *   POST /api/share/stop   { token }
 */
export function useSessionSSE(token: string, role: 'publisher' | 'viewer') {
  const esRef = useRef<EventSource | null>(null);
  const [state, setState] = useState<SessionState>({
    connected: false,
    status: null,
    viewerCount: 0,
    ended: false,
  });

  // 生成稳定的 viewerId（sessionStorage 保证同标签页刷新不变，私有标签页独立）
  const viewerIdRef = useRef('');
  if (!viewerIdRef.current && role === 'viewer') {
    let vid = sessionStorage.getItem('xgoatcast_vid');
    if (!vid) {
      vid = crypto.randomUUID();
      sessionStorage.setItem('xgoatcast_vid', vid);
    }
    viewerIdRef.current = vid;
  }

  useEffect(() => {
    if (!token) return;

    // 构建 SSE URL
    const params = new URLSearchParams({ t: token, role });
    if (role === 'viewer') {
      params.set('vid', viewerIdRef.current);
    }
    // publisher 的 clientId 由调用方通过 SharePage 的 cookie cid 来识别，
    // 这里不需要额外传；服务端用 token 来关联 session
    const url = `/api/share/stream?${params.toString()}`;

    const es = new EventSource(url);
    esRef.current = es;

    es.onopen = () => {
      setState((s) => ({ ...s, connected: true }));
    };

    es.addEventListener('session_state', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        setState((s) => ({
          ...s,
          status: data.status,
          viewerCount: data.viewerCount ?? s.viewerCount,
          publisherClientId: data.publisherClientId,
          idleRemainingSec: data.idleRemainingSec,
          noViewerRemainingSec: data.noViewerRemainingSec,
          lowLatency: data.lowLatency,
        }));
      } catch {
        // ignore parse errors
      }
    });

    es.addEventListener('session_ended', () => {
      setState((s) => ({ ...s, ended: true, status: 'ended' }));
    });

    es.addEventListener('session_error', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        console.error('session error:', data.message);
      } catch {
        console.error('session error');
      }
      setState((s) => ({ ...s, ended: true, status: 'ended', connected: false }));
    });

    es.onerror = () => {
      // EventSource 会自动重连；仅当 readyState === CLOSED 时标记断开
      if (es.readyState === EventSource.CLOSED) {
        setState((s) => ({ ...s, connected: false }));
      }
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [token, role]);

  // ===== 发布端操作（fetch POST） =====

  const startSharing = useCallback(
    async (
      quality?: string,
      clientId?: string,
      lowLatency?: boolean,
    ): Promise<{ ok: boolean }> => {
      try {
        const resp = await api.startSharing(token, quality, clientId, lowLatency);
        return resp;
      } catch (e: any) {
        console.error('startSharing fetch error:', e);
        return { ok: false };
      }
    },
    [token],
  );

  const stopSharing = useCallback(async () => {
    try {
      await api.stopSharing(token);
    } catch (e: any) {
      console.error('stopSharing fetch error:', e);
    }
  }, [token]);

  return { ...state, startSharing, stopSharing };
}
