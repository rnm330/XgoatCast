import { Injectable, Logger } from '@nestjs/common';
import { RtcTokenBuilder, RtcRole } from 'agora-token';
import { DatabaseService } from '../database/database.service';
import { AgoraRole, AgoraTokenResponse } from './agora.types';
import { QUALITY_PRESETS } from '../session/session.types';

@Injectable()
export class AgoraService {
  private readonly logger = new Logger(AgoraService.name);

  constructor(
    private readonly db: DatabaseService,
  ) {}

  generateChannelName(sessionShortId: string): string {
    return 'xc_' + sessionShortId;
  }

  /** Generate token with per-server Agora config */
  generateToken(channel: string, uid: number, role: AgoraRole, serverId?: string): AgoraTokenResponse {
    // Try server-specific config first
    let appId = '';
    let cert = '';
    let expireSec = 3600;

    if (serverId) {
      const server = this.db.getServer(serverId);
      if (server && server.agoraAppId) {
        appId = server.agoraAppId;
        cert = server.agoraAppCertificate;
        expireSec = server.agoraTokenExpireSec;
      }
    }

    if (!appId || !cert) {
      this.logger.warn('Agora App ID or Certificate not configured for server ' + (serverId || 'unknown'));
    }

    const rtcRole = role === 'publisher' ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER;
    const token = appId && cert
      ? RtcTokenBuilder.buildTokenWithUid(appId, cert, channel, uid, rtcRole, expireSec, expireSec)
      : '';

    return { token, channel, uid, appId, expireSec };
  }

  /** Get allowed qualities for a server */
  getAllowedQualities(serverId?: string): string[] {
    if (!serverId) return [];
    const server = this.db.getServer(serverId);
    if (!server || !server.bound || server.status !== 'active') return [];
    try {
      const parsed = JSON.parse(server.allowedQualities);
      if (!Array.isArray(parsed)) return [];
      const validKeys = new Set(QUALITY_PRESETS.map(quality => quality.key));
      return [...new Set(parsed.filter((key): key is string => typeof key === 'string' && validKeys.has(key)))];
    } catch {
      this.logger.warn(`Invalid allowed qualities for server ${serverId}`);
      return [];
    }
  }
}
