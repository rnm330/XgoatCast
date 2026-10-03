import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { HeychatApiClient } from './heychat-api.client';

@Injectable()
export class HeychatApiService {
  private currentToken = '';
  private currentBotId = '';
  private currentClient: HeychatApiClient | null = null;

  constructor(private readonly db: DatabaseService) {
    this.refresh();
  }

  get token(): string {
    return this.currentToken;
  }

  get client(): HeychatApiClient | null {
    return this.currentClient;
  }

  /** Reload a credential changed in the admin panel without restarting Nest. */
  refresh(): boolean {
    const config = this.db.getGlobalConfig();
    const nextToken = config.heychatBotToken.trim();
    const nextBotId = String(config.heychatBotId || '').trim();
    if (nextToken === this.currentToken && nextBotId === this.currentBotId) return false;
    this.currentToken = nextToken;
    this.currentBotId = nextBotId;
    this.currentClient = nextToken
      ? new HeychatApiClient(nextToken, fetch, { botId: nextBotId })
      : null;
    return true;
  }

  get isReady(): boolean {
    return !!this.currentClient;
  }

  get botId(): string | null {
    return this.currentBotId || null;
  }

  requireClient(): HeychatApiClient {
    if (!this.currentClient) throw new Error('Heychat bot token is not configured');
    return this.currentClient;
  }
}
