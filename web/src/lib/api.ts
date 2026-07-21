import type {
  SessionInfo,
  AgoraTokenResponse,
} from '../types';

const SUPER_TOKEN_KEY = 'xgoat_super_token';

export function getSuperAdminToken(): string | null {
  return localStorage.getItem(SUPER_TOKEN_KEY);
}

export function clearSuperAdminToken(): void {
  localStorage.removeItem(SUPER_TOKEN_KEY);
}

export function getServerAdminToken(serverId: string): string | null {
  return localStorage.getItem(`xgoat_server_${serverId}`);
}

export function setServerAdminToken(serverId: string, token: string): void {
  localStorage.setItem(`xgoat_server_${serverId}`, token);
}

export function clearServerAdminToken(serverId: string): void {
  localStorage.removeItem(`xgoat_server_${serverId}`);
}

export class ApiError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
  }
}

/** 将后端错误映射为面向用户的友好文案 */
function mapFriendlyMessage(statusCode: number, serverMsg: string): string {
  const msg = (serverMsg || '').toLowerCase();
  if (statusCode === 401) {
    if (msg.includes('ended') || msg.includes('失效') || msg.includes('结束')) {
      return '共享已结束，链接已失效';
    }
    return '链接无效或无权限访问';
  }
  if (statusCode === 403) return '无权限访问';
  if (statusCode === 404) return '资源不存在或链接已失效';
  if (statusCode === 429) return '操作过于频繁，请稍后再试';
  if (statusCode >= 500) return '服务器暂时不可用，请稍后重试';
  return serverMsg || '请求失败，请稍后重试';
}

async function request<T>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    let serverMsg = '';
    let statusCode = res.status;
    try {
      const data = await res.json();
      serverMsg = data?.message || data?.error || '';
      if (typeof data?.statusCode === 'number') statusCode = data.statusCode;
    } catch {
      try {
        serverMsg = await res.text();
      } catch {
        serverMsg = res.statusText;
      }
    }
    throw new ApiError(statusCode, mapFriendlyMessage(statusCode, serverMsg));
  }
  return res.json() as Promise<T>;
}

async function superRequest<T>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  const token = localStorage.getItem(SUPER_TOKEN_KEY);
  if (token) {
    headers['Authorization'] = 'Bearer ' + token;
  }
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    let serverMsg = '';
    try {
      const data = await res.json();
      serverMsg = data?.message || '';
    } catch {
      serverMsg = res.statusText;
    }
    throw new ApiError(res.status, serverMsg);
  }
  return res.json() as Promise<T>;
}

async function serverRequest<T>(
  serverId: string,
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  const token = getServerAdminToken(serverId);
  if (token) {
    headers['Authorization'] = 'Bearer ' + token;
  }
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    let serverMsg = '';
    try {
      const data = await res.json();
      serverMsg = data?.message || '';
    } catch {
      serverMsg = res.statusText;
    }
    throw new ApiError(res.status, serverMsg);
  }
  return res.json() as Promise<T>;
}

export const api = {
  // ===== Share API =====
  getShareInfo(token: string): Promise<SessionInfo> {
    return request('/api/share/info?t=' + encodeURIComponent(token));
  },
  getShareToken(
    token: string,
    role: 'publisher' | 'subscriber',
  ): Promise<AgoraTokenResponse> {
    return request(
      '/api/share/token?t=' + encodeURIComponent(token) + '&role=' + role,
    );
  },

  /** 发布端开始共享（替代原 WebSocket sharing_started） */
  startSharing(
    token: string,
    quality?: string,
    clientId?: string,
    lowLatency?: boolean,
  ): Promise<{ ok: boolean }> {
    return request('/api/share/start?t=' + encodeURIComponent(token), {
      method: 'POST',
      body: JSON.stringify({ quality, clientId, lowLatency }),
    });
  },

  /** 发布端停止共享（替代原 WebSocket sharing_stopped） */
  stopSharing(token: string): Promise<{ ok: boolean }> {
    return request('/api/share/stop?t=' + encodeURIComponent(token), {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  // ===== Super Admin API =====
  superLogin(password: string): Promise<{ ok: boolean; token?: string; message?: string }> {
    return superRequest('/api/super/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
  },
  getSuperConfig(): Promise<any> {
    return superRequest('/api/super/config');
  },
  updateSuperConfig(config: any): Promise<{ ok: boolean }> {
    return superRequest('/api/super/config', {
      method: 'PUT',
      body: JSON.stringify(config),
    });
  },
  getSuperServers(): Promise<any[]> {
    return superRequest('/api/super/servers');
  },
  getSuperServer(serverId: string): Promise<any> {
    return superRequest('/api/super/servers/' + serverId);
  },
  getSuperServerEvents(serverId: string): Promise<any[]> {
    return superRequest('/api/super/servers/' + serverId + '/events');
  },
  getSuperServerSessions(serverId: string): Promise<any[]> {
    return superRequest('/api/super/servers/' + serverId + '/sessions');
  },
  updateSuperServer(serverId: string, config: any): Promise<{ ok: boolean }> {
    return superRequest('/api/super/servers/' + serverId, {
      method: 'PUT',
      body: JSON.stringify(config),
    });
  },
  deleteSuperServer(serverId: string): Promise<{ ok: boolean }> {
    return superRequest('/api/super/servers/' + serverId, { method: 'DELETE' });
  },
  getSuperSessions(): Promise<any[]> {
    return superRequest('/api/super/sessions');
  },

  // ===== Server Admin API =====
  getServerStatus(serverId: string, token?: string): Promise<{ exists: boolean; bound?: boolean; guildName?: string; tokenValid?: boolean }> {
    const qs = token ? `?token=${encodeURIComponent(token)}` : '';
    return serverRequest(serverId, `/api/server/${serverId}/status${qs}`);
  },
  bindServer(serverId: string, password: string, token?: string): Promise<{ ok: boolean; message?: string }> {
    return serverRequest(serverId, `/api/server/${serverId}/bind`, {
      method: 'POST',
      body: JSON.stringify({ password, token }),
    });
  },
  serverAdminLogin(serverId: string, password: string): Promise<{ ok: boolean; token?: string; message?: string }> {
    return serverRequest(serverId, `/api/server/${serverId}/login`, {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
  },
  getServerConfig(serverId: string): Promise<any> {
    return serverRequest(serverId, `/api/server/${serverId}/config`);
  },
  updateServerConfig(serverId: string, config: any): Promise<{ ok: boolean }> {
    return serverRequest(serverId, `/api/server/${serverId}/config`, {
      method: 'PUT',
      body: JSON.stringify(config),
    });
  },
  getServerSessions(serverId: string): Promise<any[]> {
    return serverRequest(serverId, `/api/server/${serverId}/sessions`);
  },
};
