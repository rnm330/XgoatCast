export type SessionStatus = 'pending' | 'active' | 'grace' | 'ended';

export interface SessionInfo {
  id: string;
  channel: string;
  sharerUsername: string;
  status: SessionStatus;
  viewerCount: number;
  peakViewers: number;
  totalViewerJoins: number;
  quality: string;
  shareLink: string;
  viewLink: string;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  billingMinutes: number;
  billingDetail: string;
  /** 标准时长（分钟） */
  standardMinutes: number;
  /** 预估费用（元） */
  estimatedCost: number;
  allowedQualities?: string[];
  publisherClientId?: string;
  idleRemainingSec?: number;
  noViewerRemainingSec?: number;
  /** true=低延迟模式(rtc/互动直播)，false=极速直播(默认) */
  lowLatency?: boolean;
  /** 服务器是否允许开启低延迟模式 */
  allowLowLatency?: boolean;
}

export interface AgoraTokenResponse {
  token: string;
  channel: string;
  uid: number;
  appId: string;
  expireSec: number;
}
