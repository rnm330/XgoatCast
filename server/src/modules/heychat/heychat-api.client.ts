import JSONbig from 'json-bigint';
import { Logger } from '@nestjs/common';
import type {
  HeychatCardMessage,
  HeychatJoinedRoom,
  HeychatRoomChannel,
  HeychatRoomDetail,
} from './heychat.types';

const losslessJson = JSONbig({ storeAsString: true });

const API_BASE = 'https://chat.xiaoheihe.cn';
export const HEYCHAT_HTTP_CHAT_VERSION = '1.30.0';
export const HEYCHAT_API_REQUEST_LIMIT = 300;
export const HEYCHAT_API_RATE_WINDOW_MS = 60_000;
const PRIVATE_MESSAGE_GAP_MS = 7_000;
const JOINED_ROOMS_PAGE_SIZE = 50;
const MAX_JOINED_ROOMS = 10_000;
const DEFAULT_GET_ATTEMPTS = 3;

export interface HeychatApiClientOptions {
  /** Explicit bot ID from the developer console; never infer identity from the opaque token. */
  botId?: string;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  requestLimit?: number;
  rateWindowMs?: number;
  getAttempts?: number;
}

interface JoinedRoomsPage {
  rooms: HeychatJoinedRoom[];
  pagination: {
    total: number;
    offset: number;
    limit: number;
  };
}

export class HeychatApiError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'HeychatApiError';
  }
}

export class HeychatApiClient {
  private readonly logger = new Logger(HeychatApiClient.name);
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly requestLimit: number;
  private readonly rateWindowMs: number;
  private readonly getAttempts: number;
  private ackSequence = 0;
  private requestGateTail: Promise<void> = Promise.resolve();
  private requestStarts: number[] = [];
  private requestsBlockedUntil = 0;
  private privateMessageTail: Promise<void> = Promise.resolve();
  private nextPrivateMessageAt = 0;
  readonly botId: string | null;

  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    options: HeychatApiClientOptions = {},
  ) {
    const configured = Number(options.timeoutMs ?? process.env.HEYCHAT_API_TIMEOUT_MS ?? 10_000);
    this.timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : 10_000;
    this.now = options.now || (() => Date.now());
    this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.requestLimit = this.positiveInteger(
      options.requestLimit,
      HEYCHAT_API_REQUEST_LIMIT,
    );
    this.rateWindowMs = this.positiveInteger(
      options.rateWindowMs,
      HEYCHAT_API_RATE_WINDOW_MS,
    );
    this.getAttempts = this.positiveInteger(options.getAttempts, DEFAULT_GET_ATTEMPTS);
    this.botId = String(options.botId || '').trim() || null;
  }

  async listJoinedRooms(): Promise<HeychatJoinedRoom[]> {
    const rooms: HeychatJoinedRoom[] = [];
    const roomIds = new Set<string>();
    let offset = 0;
    let limit = JOINED_ROOMS_PAGE_SIZE;
    let expectedTotal: number | null = null;
    let expectedLimit: number | null = null;

    while (offset <= MAX_JOINED_ROOMS) {
      const result = await this.get('/chatroom/v2/room/joined', { offset, limit });
      const page = this.parseJoinedRoomsPage(result);

      const pagination = page.pagination;
      if (pagination.offset !== offset) {
        throw new HeychatApiError(
          `Heychat joined-room pagination offset changed: expected ${offset}, received ${pagination.offset}`,
          true,
        );
      }
      if (pagination.limit > limit) {
        throw new HeychatApiError(
          `Heychat joined-room pagination exceeded requested limit ${limit}`,
          true,
        );
      }
      if (expectedTotal === null) {
        expectedTotal = pagination.total;
        expectedLimit = pagination.limit;
        if (expectedTotal > MAX_JOINED_ROOMS) {
          throw new HeychatApiError(
            `Heychat joined-room total exceeds safety limit ${MAX_JOINED_ROOMS}`,
            true,
          );
        }
      } else if (pagination.total !== expectedTotal || pagination.limit !== expectedLimit) {
        throw new HeychatApiError(
          'Heychat joined-room pagination changed during sync',
          true,
        );
      }

      const expectedPageSize = Math.min(
        pagination.limit,
        pagination.total - pagination.offset,
      );
      if (expectedPageSize < 0 || page.rooms.length !== expectedPageSize) {
        throw new HeychatApiError(
          `Heychat joined-room snapshot incomplete at offset ${offset}`,
          true,
        );
      }
      this.appendUniqueJoinedRooms(rooms, roomIds, page.rooms);
      if (rooms.length === expectedTotal) return rooms;
      if (rooms.length > expectedTotal) {
        throw new HeychatApiError(
          `Heychat joined-room snapshot exceeds reported total ${expectedTotal}`,
          true,
        );
      }

      offset = pagination.offset + pagination.limit;
      limit = pagination.limit;
    }

    throw new HeychatApiError('Heychat joined-room pagination did not complete', true);
  }

  async getRoom(roomId: string): Promise<HeychatRoomDetail> {
    const result = await this.get('/chatroom/v2/room/view', { room_id: roomId });
    const roomInfo = result?.room_info || {};
    const room = roomInfo?.room || result?.room || result || {};
    const channels = this.flattenChannels(
      roomInfo?.channels_v2
      || roomInfo?.channels
      || result?.channels_v2
      || result?.channels
      || room?.channels_v2
      || room?.channels
      || [],
    );
    return {
      ...(Number.isSafeInteger(room.member_count) && room.member_count >= 0 ? { memberCount: room.member_count } : {}),
      roomId: String(room?.room_id || roomInfo?.room_id || result?.room_id || roomId),
      roomName: String(room?.room_name || ''),
      ownerId: String(room?.create_by || ''),
      publicId: String(room?.public_id || ''),
      textChannels: channels.filter((channel) => Number(channel.channel_type) === 1),
    };
  }

  async sendChannelMarkdown(roomId: string, channelId: string, message: string): Promise<string> {
    const result = await this.post('/chatroom/v2/channel_msg/send', {
      msg: message,
      msg_type: 4,
      heychat_ack_id: this.nextAckId(),
      reply_id: '',
      room_id: roomId,
      addition: '{}',
      at_user_id: '',
      at_role_id: '',
      mention_channel_id: '',
      channel_id: channelId,
      channel_type: 1,
    });
    return this.requireMessageId(result, '/chatroom/v2/channel_msg/send');
  }

  async sendChannelCard(
    roomId: string,
    channelId: string,
    card: HeychatCardMessage,
    delivery?: { ackId: string; deadline: number },
  ): Promise<string> {
    const result = await this.post('/chatroom/v2/channel_msg/send', {
      msg: JSON.stringify(card),
      msg_type: 20,
      heychat_ack_id: delivery?.ackId || this.nextAckId(),
      reply_id: '',
      room_id: roomId,
      addition: '{}',
      at_user_id: '',
      at_role_id: '',
      mention_channel_id: '',
      channel_id: channelId,
      channel_type: 1,
    }, {}, delivery?.deadline);
    return this.requireMessageId(result, '/chatroom/v2/channel_msg/send');
  }

  async updateChannelCard(
    roomId: string,
    channelId: string,
    messageId: string,
    card: HeychatCardMessage,
  ): Promise<void> {
    await this.post('/chatroom/v2/channel_msg/update', {
      msg: JSON.stringify(card),
      msg_type: 20,
      heychat_ack_id: this.nextAckId(),
      reply_id: '',
      room_id: roomId,
      addition: '{}',
      at_user_id: '',
      at_role_id: '',
      mention_channel_id: '',
      channel_id: channelId,
      channel_type: 1,
      msg_id: messageId,
    });
  }

  /** Same-room private messages are limited to 9/minute and 3 before a reply. */
  sendPrivateMarkdown(userId: string, message: string): Promise<string> {
    return this.schedulePrivateMessage(async () => {
      const result = await this.post('/chatroom/v3/msg/user', {
        msg: message,
        msg_type: 4,
        heychat_ack_id: this.nextAckId(),
        addition: '{}',
        // The API documents this as int64. Keep IDs outside JS's safe integer
        // range as decimal strings so JSON serialization cannot corrupt them.
        to_user_id: this.serializeInt64(userId),
      });
      return this.requireMessageId(result, '/chatroom/v3/msg/user');
    });
  }

  private async request(path: string, init: RequestInit, query: Record<string, unknown> = {}, deadline?: number): Promise<any> {
    const url = new URL(path, API_BASE);
    const params: Record<string, string> = {
      client_type: 'heybox_chat',
      x_client_type: 'web',
      os_type: 'web',
      x_os_type: 'bot',
      x_app: 'heybox_chat',
      chat_os_type: 'bot',
      chat_version: HEYCHAT_HTTP_CHAT_VERSION,
    };
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) params[key] = String(value);
    }
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    const isGet = String(init.method || 'GET').toUpperCase() === 'GET';
    const attempts = isGet ? this.getAttempts : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.scheduleApiRequest(() => this.requestOnce(path, url, init, deadline));
      } catch (error) {
        if (
          !isGet
          || attempt >= attempts
          || !(error instanceof HeychatApiError)
          || !error.retryable
        ) throw error;
        const retryDelay = error.retryAfterMs
          ?? Math.min(2_000, 250 * 2 ** (attempt - 1));
        await this.sleep(retryDelay);
      }
    }
    throw new HeychatApiError(`Heychat API ${path} exhausted retries`, true);
  }

  private async requestOnce(path: string, url: URL, init: RequestInit, deadline?: number): Promise<any> {
    if (deadline !== undefined && this.now() >= deadline) {
      throw new HeychatApiError('Card deduplication window expired', false);
    }
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          token: this.token,
          Accept: 'application/json',
          'Content-Type': 'application/json;charset=UTF-8',
          ...(init.headers || {}),
        },
      });
    } catch (error: any) {
      const reason = error?.name === 'TimeoutError' ? 'request timeout' : 'network failure';
      throw new HeychatApiError(`Heychat API ${path} ${reason}`, true);
    }

    let rawBody: string;
    try {
      rawBody = await response.text();
    } catch {
      throw new HeychatApiError(
        `Heychat API ${path} response body failed`,
        true,
        response.status,
      );
    }
    let body: any;
    let parsed = false;
    if (rawBody.trim()) {
      try {
        body = losslessJson.parse(rawBody, (_key: string, value: any) => (
          value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : value
        ));
        parsed = true;
      } catch {
        // HTTP errors still need to retain their retryability even when an
        // upstream proxy returns HTML or an empty/non-JSON error document.
      }
    }

    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      const retryAfterMs = response.status === 429
        ? this.getRetryAfterMs(response)
        : undefined;
      if (response.status === 429) this.blockRequestsFor(retryAfterMs ?? 1_000);
      this.logger.error(`Heychat API ${path} failed: status=${response.status}`);
      throw new HeychatApiError(
        String(parsed && body?.msg ? body.msg : `Heychat API ${path} failed`),
        retryable,
        response.status,
        retryAfterMs,
      );
    }

    if (!parsed || !body || typeof body !== 'object') {
      throw new HeychatApiError(
        `Heychat API ${path} returned an invalid response`,
        false,
        response.status,
      );
    }
    if (body.status !== 'ok') {
      this.logger.error(`Heychat API ${path} failed: status=${response.status}`);
      throw new HeychatApiError(
        String(body?.msg || `Heychat API ${path} failed`),
        false,
        response.status,
      );
    }
    return body.result;
  }

  private get(path: string, query?: Record<string, unknown>): Promise<any> {
    return this.request(path, { method: 'GET' }, query);
  }

  private post(
    path: string,
    body: unknown,
    query: Record<string, unknown> = {},
    deadline?: number,
  ): Promise<any> {
    return this.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
      body: JSON.stringify(body),
    }, query, deadline);
  }

  private schedulePrivateMessage<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.privateMessageTail.then(async () => {
      const waitMs = Math.max(0, this.nextPrivateMessageAt - Date.now());
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      this.nextPrivateMessageAt = Date.now() + PRIVATE_MESSAGE_GAP_MS;
      return operation();
    });
    this.privateMessageTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private scheduleApiRequest<T>(operation: () => Promise<T>): Promise<T> {
    const permit = this.requestGateTail.then(() => this.acquireRequestPermit());
    this.requestGateTail = permit.then(() => undefined, () => undefined);
    return permit.then(operation);
  }

  private async acquireRequestPermit(): Promise<void> {
    for (;;) {
      const now = this.now();
      if (this.requestsBlockedUntil > now) {
        await this.sleep(this.requestsBlockedUntil - now);
        continue;
      }
      this.requestStarts = this.requestStarts.filter(
        (startedAt) => now - startedAt < this.rateWindowMs,
      );
      if (this.requestStarts.length < this.requestLimit) {
        this.requestStarts.push(now);
        return;
      }
      const waitMs = Math.max(1, this.requestStarts[0] + this.rateWindowMs - now);
      await this.sleep(waitMs);
    }
  }

  private blockRequestsFor(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0) return;
    this.requestsBlockedUntil = Math.max(this.requestsBlockedUntil, this.now() + ms);
  }

  private requireMessageId(result: any, path: string): string {
    const messageId = String(result?.msg_id || '').trim();
    if (messageId) return messageId;
    throw new HeychatApiError(
      `Heychat API ${path} returned success without msg_id`,
      false,
      200,
    );
  }

  private nextAckId(): string {
    this.ackSequence = (this.ackSequence + 1) % 1_000;
    return `${Date.now()}${String(this.ackSequence).padStart(3, '0')}`;
  }

  private serializeInt64(value: string): number | string {
    const numeric = Number(value);
    return Number.isSafeInteger(numeric) ? numeric : value;
  }

  private flattenChannels(value: unknown): HeychatRoomChannel[] {
    const roots = Array.isArray(value) ? value : [];
    const result: HeychatRoomChannel[] = [];
    const visit = (channel: HeychatRoomChannel) => {
      result.push(channel);
      for (const child of channel.channel_list || []) visit(child);
    };
    for (const channel of roots) visit(channel);
    return result;
  }

  private parseJoinedRoomsPage(result: unknown): JoinedRoomsPage {
    if (!result || typeof result !== 'object') {
      throw new HeychatApiError(
        'Heychat joined-room API returned an unverified response',
        true,
      );
    }
    const root = result as {
      rooms?: unknown;
      total?: unknown;
      offset?: unknown;
      limit?: unknown;
    };
    const nested = root.rooms && typeof root.rooms === 'object' && !Array.isArray(root.rooms)
      ? root.rooms as typeof root
      : null;
    const page = nested || root;
    if (!Array.isArray(page.rooms)) {
      throw new HeychatApiError(
        'Heychat joined-room API returned an unverified response',
        true,
      );
    }
    this.validateJoinedRoomEntries(page.rooms);
    if (
      typeof page.total !== 'number' || !Number.isInteger(page.total) || page.total < 0
      || typeof page.offset !== 'number' || !Number.isInteger(page.offset) || page.offset < 0
      || typeof page.limit !== 'number' || !Number.isInteger(page.limit) || page.limit <= 0
    ) {
      throw new HeychatApiError(
        nested
          ? 'Heychat joined-room API returned invalid pagination metadata'
          : 'Heychat joined-room API returned a snapshot without pagination metadata',
        true,
      );
    }
    return {
      rooms: page.rooms,
      pagination: {
        total: Number(page.total),
        offset: Number(page.offset),
        limit: Number(page.limit),
      },
    };
  }

  private validateJoinedRoomEntries(rooms: HeychatJoinedRoom[]): void {
    if (rooms.some((room) => (
      !room
      || typeof room !== 'object'
      || !String(room.room_id || '').trim()
      || !String(room.create_by || '').trim()
    ))) {
      throw new HeychatApiError(
        'Heychat joined-room API returned an invalid room entry',
        true,
      );
    }
  }

  private appendUniqueJoinedRooms(
    target: HeychatJoinedRoom[],
    roomIds: Set<string>,
    rooms: HeychatJoinedRoom[],
  ): void {
    for (const room of rooms) {
      const roomId = String(room.room_id).trim();
      if (roomIds.has(roomId)) {
        throw new HeychatApiError(
          `Heychat joined-room API returned duplicate room ID ${roomId}`,
          true,
        );
      }
      roomIds.add(roomId);
      target.push(room);
    }
  }

  private getRetryAfterMs(response: Response): number | undefined {
    const resetAfter = response.headers.get('x-ratelimit-reset-after');
    if (resetAfter !== null) {
      const seconds = Number(resetAfter);
      if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
    }
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) {
      const retrySeconds = Number(retryAfter);
      if (Number.isFinite(retrySeconds) && retrySeconds >= 0) {
        return Math.ceil(retrySeconds * 1000);
      }
      const retryAt = Date.parse(retryAfter);
      if (Number.isFinite(retryAt)) return Math.max(0, retryAt - this.now());
    }
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    if (!Number.isFinite(reset) || reset <= 0) return undefined;
    return Math.max(0, reset * 1000 - this.now());
  }

  private positiveInteger(value: number | undefined, fallback: number): number {
    return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
  }
}
