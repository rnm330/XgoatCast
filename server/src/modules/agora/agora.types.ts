export type AgoraRole = 'publisher' | 'subscriber';

export interface AgoraTokenRequest {
  channel: string;
  uid: number;
  role: AgoraRole;
}

export interface AgoraTokenResponse {
  token: string;
  channel: string;
  uid: number;
  appId: string;
  expireSec: number;
}
