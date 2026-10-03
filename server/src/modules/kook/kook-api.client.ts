import { Logger } from '@nestjs/common';

const API_BASE = 'https://www.kookapp.cn/api/v3';

export class KookApiError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly kookCode?: number,
    readonly retryAfterMs?: number,
    readonly kookMessage?: string,
  ) {
    super(message);
    this.name = 'KookApiError';
  }
}

export class KookApiClient {
  private readonly logger = new Logger(KookApiClient.name);
  private readonly timeoutMs: number;
  private botId: string | null = null;
  private readonly sentMessageIds = new Set<string>();
  private readonly maxSentMessageIds = 10000;

  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const configured = Number(process.env.KOOK_API_TIMEOUT_MS || 10000);
    this.timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : 10000;
  }

  getBotId(): string | null {
    return this.botId;
  }

  setBotId(id: string): void {
    this.botId = id || null;
  }

  isOwnMessage(id?: string): boolean {
    return !!id && this.sentMessageIds.has(id);
  }

  async sendTextMessage(channelId: string, content: string): Promise<any> {
    return this.postApi('/message/create', { target_id: channelId, content, type: 1 });
  }

  async sendTempTextMessage(channelId: string, content: string, tempTargetUserId: string): Promise<any> {
    return this.postApi('/message/create', {
      target_id: channelId,
      content,
      type: 1,
      temp_target_id: tempTargetUserId,
    });
  }

  async sendKMarkdownMessage(channelId: string, content: string): Promise<any> {
    return this.postApi('/message/create', { target_id: channelId, content, type: 9 });
  }

  async sendCardMessage(channelId: string, cards: unknown): Promise<any> {
    return this.postApi('/message/create', {
      target_id: channelId,
      type: 10,
      content: typeof cards === 'string' ? cards : JSON.stringify(cards),
    });
  }

  async sendTempCardMessage(channelId: string, cards: unknown, tempTargetUserId: string): Promise<any> {
    return this.postApi('/message/create', {
      target_id: channelId,
      type: 10,
      content: typeof cards === 'string' ? cards : JSON.stringify(cards),
      temp_target_id: tempTargetUserId,
    });
  }

  async updateMessage(msgId: string, content: string, type: number): Promise<any> {
    return this.postApi('/message/update', { msg_id: msgId, content, type });
  }

  async deleteMessage(msgId: string): Promise<any> {
    return this.postApi('/message/delete', { msg_id: msgId });
  }

  async getGuild(guildId: string): Promise<any> {
    return this.getApi(`/guild/view?guild_id=${encodeURIComponent(guildId)}`);
  }

  async getGuildList(): Promise<any[]> {
    const items: any[] = [];
    const guildIds = new Set<string>();
    let page = 1;
    let expectedPages: number | null = null;
    let expectedTotal: number | null = null;
    while (true) {
      const data = await this.getApi(`/guild/list?page=${page}&page_size=50`);
      if (!Array.isArray(data?.items)) {
        throw new KookApiError('KOOK guild list returned invalid items', true);
      }
      const reportedPage = Number(data?.meta?.page);
      if (!Number.isInteger(reportedPage) || reportedPage !== page) {
        throw new KookApiError('KOOK guild list returned an unexpected page', true);
      }
      const rawTotal = data?.meta?.total;
      const reportedTotal = Number(rawTotal);
      if (rawTotal == null || !Number.isInteger(reportedTotal) || reportedTotal < 0) {
        throw new KookApiError('KOOK guild list returned invalid total', true);
      }
      const totalPages = Number(data?.meta?.page_total);
      if (!Number.isInteger(totalPages) || totalPages < 0) {
        throw new KookApiError('KOOK guild list returned invalid pagination', true);
      }
      if (totalPages === 0 && (reportedTotal !== 0 || data.items.length !== 0)) {
        throw new KookApiError('KOOK guild list returned inconsistent empty pagination', true);
      }
      if (expectedPages == null) expectedPages = totalPages;
      if (expectedPages !== totalPages) {
        throw new KookApiError('KOOK guild list pagination changed during sync', true);
      }

      if (expectedTotal == null) expectedTotal = reportedTotal;
      if (expectedTotal !== reportedTotal) {
        throw new KookApiError('KOOK guild list total changed during sync', true);
      }

      const current = data.items;
      if (page < totalPages && current.length === 0) {
        throw new KookApiError('KOOK guild list ended before the last page', true);
      }
      for (const guild of current) {
        const guildId = String(guild?.id || '').trim();
        if (!guildId || guildIds.has(guildId)) {
          throw new KookApiError('KOOK guild list returned missing or duplicate IDs', true);
        }
        guildIds.add(guildId);
        items.push(guild);
      }
      if (page >= totalPages) break;
      page++;
    }
    if (expectedTotal == null || items.length !== expectedTotal) {
      throw new KookApiError(
        `KOOK guild list incomplete: expected ${expectedTotal}, received ${items.length}`,
        true,
      );
    }
    return items;
  }

  /**
   * Fetch only the aggregate member count. page_size=1 keeps KOOK member data out
   * of analytics while avoiding a full member-list download.
   */
  async getGuildMemberCount(guildId: string): Promise<number> {
    const data = await this.getApi(
      `/guild/user-list?guild_id=${encodeURIComponent(guildId)}&page=1&page_size=1`,
    );
    const value = Number(data?.user_count ?? data?.meta?.total);
    if (!Number.isFinite(value) || value < 0) {
      throw new KookApiError('KOOK API returned an invalid guild member count', false);
    }
    return Math.floor(value);
  }

  async getGuildChannels(guildId: string): Promise<any[]> {
    const items: any[] = [];
    let page = 1;
    while (true) {
      const data = await this.getApi(
        `/channel/list?guild_id=${encodeURIComponent(guildId)}&page=${page}&page_size=50`,
      );
      const current = Array.isArray(data?.items) ? data.items : [];
      items.push(...current);
      const totalPages = Number(data?.meta?.page_total || 1);
      if (page >= totalPages || current.length === 0) break;
      page++;
    }
    return items;
  }

  async getChannelInfo(channelId: string): Promise<any> {
    return this.getApi(`/channel/view?target_id=${encodeURIComponent(channelId)}`);
  }

  async getMe(): Promise<any> {
    return this.getApi('/user/me');
  }

  async sendPrivateMessage(userId: string, content: string, type = 1): Promise<any> {
    return this.postApi('/direct-message/create', { target_id: userId, content, type });
  }

  private async request(path: string, init: RequestInit): Promise<any> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${API_BASE}${path}`, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          Authorization: `Bot ${this.token}`,
          ...(init.headers || {}),
        },
      });
    } catch (error: any) {
      const message = error?.name === 'TimeoutError' ? 'request timeout' : 'network failure';
      throw new KookApiError(`KOOK API ${path} ${message}`, true);
    }

    let body: any;
    try {
      body = await response.json();
    } catch {
      throw new KookApiError(
        `KOOK API ${path} invalid response`,
        response.status >= 500,
        response.status,
      );
    }

    const code = Number(body?.code);
    if (!response.ok || code !== 0) {
      const retryable = response.status === 429 || response.status >= 500;
      this.logger.error(
        `KOOK API ${path} failed: status=${response.status} code=${Number.isFinite(code) ? code : 'unknown'}`,
      );
      throw new KookApiError(
        `KOOK API ${path} failed`,
        retryable,
        response.status,
        Number.isFinite(code) ? code : undefined,
        response.status === 429 ? this.getRetryAfterMs(response) : undefined,
        typeof body?.message === 'string' ? body.message : undefined,
      );
    }
    return body?.data;
  }

  private getApi(path: string): Promise<any> {
    return this.request(path, { method: 'GET' });
  }

  private async postApi(path: string, body: unknown): Promise<any> {
    const data = await this.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const sentId = data?.msg_id || data?.id;
    if (sentId) this.registerSentMessage(String(sentId));
    return data;
  }

  private registerSentMessage(id: string): void {
    if (this.sentMessageIds.size >= this.maxSentMessageIds) {
      const first = this.sentMessageIds.values().next().value;
      if (first) this.sentMessageIds.delete(first);
    }
    this.sentMessageIds.add(id);
  }

  private getRetryAfterMs(response: Response): number | undefined {
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
      const date = Date.parse(retryAfter);
      if (Number.isFinite(date)) return Math.max(0, date - Date.now());
    }

    const reset = Number(response.headers.get('x-rate-limit-reset'));
    if (!Number.isFinite(reset) || reset <= 0) return undefined;
    const resetAt = reset > 1_000_000_000_000 ? reset : reset * 1000;
    return Math.max(0, resetAt - Date.now());
  }
}
