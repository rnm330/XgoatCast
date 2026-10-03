import type {
  SessionInfo,
  AgoraTokenResponse,
} from '../types';
import type {
  AnalyticsOverview,
  AnalyticsRangeQuery,
  AnalyticsRealtime,
  AnalyticsRecordQuery,
  AnalyticsRecords,
  ClientEnvironment,
  ClientStatsResponse,
  ServerAnalyticsRecord,
  ServerStateAnalyticsRecord,
  ShareAnalyticsRecord,
  ShareTelemetryPayload,
} from '../types/analytics';

const SUPER_TOKEN_KEY = 'xgoat_super_token';
export type Platform = 'kook' | 'heychat' | 'qq' | 'discord';

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

function getSpaceAdminTokenKey(platform: Platform, externalId: string): string {
  return `xgoat_space_${platform}_${externalId}`;
}

export function getSpaceAdminToken(platform: Platform, externalId: string): string | null {
  const token = localStorage.getItem(getSpaceAdminTokenKey(platform, externalId));
  if (token) return token;
  if (platform !== 'kook') return null;
  const legacy = getServerAdminToken(externalId);
  if (legacy) {
    localStorage.setItem(getSpaceAdminTokenKey(platform, externalId), legacy);
  }
  return legacy;
}

export function setSpaceAdminToken(platform: Platform, externalId: string, token: string): void {
  localStorage.setItem(getSpaceAdminTokenKey(platform, externalId), token);
}

export function clearSpaceAdminToken(platform: Platform, externalId: string): void {
  localStorage.removeItem(getSpaceAdminTokenKey(platform, externalId));
  if (platform === 'kook') clearServerAdminToken(externalId);
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
  const res = await fetch(url, { ...options, headers, credentials: 'include' });
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
  const res = await fetch(url, { ...options, headers, credentials: 'include' });
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

async function spaceRequest<T>(
  platform: Platform,
  externalId: string,
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  const token = getSpaceAdminToken(platform, externalId);
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(url, { ...options, headers, credentials: 'include' });
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

function spaceApiBase(platform: Platform, externalId: string): string {
  return `/api/spaces/${encodeURIComponent(platform)}/${encodeURIComponent(externalId)}`;
}

function analyticsRangeParams(query: AnalyticsRangeQuery): URLSearchParams {
  const params = new URLSearchParams({ range: query.range });
  if (query.range === 'custom') {
    if (query.from !== undefined) params.set('from', String(query.from));
    if (query.to !== undefined) params.set('to', String(query.to));
  }
  return params;
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

  reportShareTelemetry(payload: ShareTelemetryPayload): Promise<{ ok: boolean }> {
    return request('/api/share/telemetry', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  getNotices(page: 'server_admin' | 'share' | 'view'): Promise<any[]> {
    return request('/api/notices?page=' + encodeURIComponent(page));
  },
  getAdminMigration(): Promise<{ legacyAdminSunsetAt: number; canonicalPlatform: string }> {
    return request('/api/meta/admin-migration');
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
  getHeychatStatus(): Promise<any> {
    return superRequest('/api/super/heychat/status');
  },
  getQqStatus(): Promise<any> { return superRequest('/api/super/qq/status'); },
  verifyQq(): Promise<any> { return superRequest('/api/super/qq/verify', { method: 'POST', body: '{}' }); },
  syncQqPanel(): Promise<any> { return superRequest('/api/super/qq/panel', { method: 'POST', body: '{}' }); },
  syncHeychat(): Promise<any> {
    return superRequest('/api/super/heychat/sync', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },
  getSuperServers(): Promise<any[]> {
    return superRequest('/api/super/servers');
  },
  getSuperSpaces(platform?: Platform): Promise<any[]> {
    const qs = platform ? `?platform=${encodeURIComponent(platform)}` : '';
    return superRequest('/api/super/spaces' + qs);
  },
  getSuperSpace(platform: Platform, externalId: string): Promise<any> {
    return superRequest(`/api/super/spaces/${encodeURIComponent(platform)}/${encodeURIComponent(externalId)}`);
  },
  getSuperSpaceEvents(platform: Platform, externalId: string): Promise<any[]> {
    return superRequest(`/api/super/spaces/${encodeURIComponent(platform)}/${encodeURIComponent(externalId)}/events`);
  },
  getSuperSpaceSessions(platform: Platform, externalId: string): Promise<any[]> {
    return superRequest(`/api/super/spaces/${encodeURIComponent(platform)}/${encodeURIComponent(externalId)}/sessions`);
  },
  updateSuperSpace(platform: Platform, externalId: string, config: any): Promise<{ ok: boolean }> {
    return superRequest(`/api/super/spaces/${encodeURIComponent(platform)}/${encodeURIComponent(externalId)}`, {
      method: 'PUT',
      body: JSON.stringify(config),
    });
  },
  deleteSuperSpace(platform: Platform, externalId: string): Promise<{ ok: boolean }> {
    return superRequest(`/api/super/spaces/${encodeURIComponent(platform)}/${encodeURIComponent(externalId)}`, {
      method: 'DELETE',
    });
  },
  getSuperNotices(): Promise<any[]> {
    return superRequest('/api/super/notices');
  },
  createSuperNotice(notice: any): Promise<any> {
    return superRequest('/api/super/notices', {
      method: 'POST',
      body: JSON.stringify(notice),
    });
  },
  updateSuperNotice(id: string, notice: any): Promise<any> {
    return superRequest('/api/super/notices/' + encodeURIComponent(id), {
      method: 'PUT',
      body: JSON.stringify(notice),
    });
  },
  deleteSuperNotice(id: string): Promise<{ ok: boolean }> {
    return superRequest('/api/super/notices/' + encodeURIComponent(id), {
      method: 'DELETE',
    });
  },
  reorderSuperNotices(ids: string[]): Promise<{ ok: boolean }> {
    return superRequest('/api/super/notices/order', {
      method: 'PUT',
      body: JSON.stringify({ ids }),
    });
  },
  republishSuperNotice(id: string): Promise<any> {
    return superRequest('/api/super/notices/' + encodeURIComponent(id) + '/republish', {
      method: 'POST',
      body: JSON.stringify({}),
    });
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

  getAnalyticsRealtime(): Promise<AnalyticsRealtime> {
    return superRequest('/api/super/analytics/realtime');
  },
  getAnalyticsOverview(query: AnalyticsRangeQuery): Promise<AnalyticsOverview> {
    const params = analyticsRangeParams(query);
    return superRequest('/api/super/analytics/overview?' + params.toString());
  },
  getAnalyticsRecords<T extends ShareAnalyticsRecord | ServerAnalyticsRecord | ServerStateAnalyticsRecord>(
    query: AnalyticsRecordQuery,
  ): Promise<AnalyticsRecords<T>> {
    const params = analyticsRangeParams(query);
    params.set('type', query.type);
    params.set('page', String(query.page));
    params.set('pageSize', String(query.pageSize));
    if (query.status) params.set('status', query.status);
    if (query.server) params.set('server', query.server);
    if (query.platform) params.set('platform', query.platform);
    return superRequest('/api/super/analytics/records?' + params.toString());
  },
  getAnalyticsClientStats(query: AnalyticsRangeQuery): Promise<ClientStatsResponse> {
    const params = analyticsRangeParams(query);
    return superRequest('/api/super/analytics/client-stats?' + params.toString());
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

  // ===== Canonical Platform Space Admin API =====
  getSpaceStatus(
    platform: Platform,
    externalId: string,
    token?: string,
  ): Promise<{ exists: boolean; bound?: boolean; guildName?: string; openId?: string; tokenValid?: boolean }> {
    const qs = token ? `?token=${encodeURIComponent(token)}` : '';
    return spaceRequest(platform, externalId, spaceApiBase(platform, externalId) + `/status${qs}`);
  },
  bindSpace(
    platform: Platform,
    externalId: string,
    password: string,
    token?: string,
  ): Promise<{ ok: boolean; message?: string }> {
    return spaceRequest(platform, externalId, spaceApiBase(platform, externalId) + '/bind', {
      method: 'POST',
      body: JSON.stringify({ password, token }),
    });
  },
  getHeychatBindingIntentStatus(
    externalId: string,
    intentId: string,
    platform: 'heychat' | 'qq' = 'heychat',
  ): Promise<{ ok: boolean; state: string; expiresAt?: number; roomName?: string }> {
    return request(`/api/spaces/${platform}/${encodeURIComponent(externalId)}/binding/${encodeURIComponent(intentId)}/status`);
  },
  claimHeychatBinding(
    externalId: string,
    intentId: string,
    platform: 'heychat' | 'qq' = 'heychat',
  ): Promise<{ ok: boolean; state: string; code?: string; expiresAt?: number }> {
    return request(`/api/spaces/${platform}/${encodeURIComponent(externalId)}/binding/${encodeURIComponent(intentId)}/claim`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },
  pollHeychatBinding(
    externalId: string,
    intentId: string,
    platform: 'heychat' | 'qq' = 'heychat',
  ): Promise<{ ok: boolean; state: string; expiresAt?: number }> {
    return request(`/api/spaces/${platform}/${encodeURIComponent(externalId)}/binding/${encodeURIComponent(intentId)}/poll`);
  },
  bindHeychatBinding(
    externalId: string,
    intentId: string,
    password: string,
    platform: 'heychat' | 'qq' = 'heychat',
  ): Promise<{ ok: boolean; message?: string }> {
    return request(`/api/spaces/${platform}/${encodeURIComponent(externalId)}/binding/${encodeURIComponent(intentId)}/bind`, {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
  },
  spaceAdminLogin(
    platform: Platform,
    externalId: string,
    password: string,
  ): Promise<{ ok: boolean; token?: string; message?: string }> {
    return spaceRequest(platform, externalId, spaceApiBase(platform, externalId) + '/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
  },
  getSpaceConfig(platform: Platform, externalId: string): Promise<any> {
    return spaceRequest(platform, externalId, spaceApiBase(platform, externalId) + '/config');
  },
  updateSpaceConfig(platform: Platform, externalId: string, config: any): Promise<{ ok: boolean }> {
    return spaceRequest(platform, externalId, spaceApiBase(platform, externalId) + '/config', {
      method: 'PUT',
      body: JSON.stringify(config),
    });
  },
  getSpaceSessions(platform: Platform, externalId: string): Promise<any[]> {
    return spaceRequest(platform, externalId, spaceApiBase(platform, externalId) + '/sessions');
  },
  heartbeatSpacePresence(
    platform: Platform,
    externalId: string,
    browserSessionId: string,
    environment: ClientEnvironment,
  ): Promise<{ ok: boolean }> {
    return spaceRequest(platform, externalId, spaceApiBase(platform, externalId) + '/presence', {
      method: 'POST',
      body: JSON.stringify({ browserSessionId, ...environment }),
    });
  },
};
