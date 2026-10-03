import { Injectable, Logger } from '@nestjs/common';
import { HeychatService } from './heychat.service';
import type {
  HeychatCardButtonEventData,
  HeychatCommandEventData,
  HeychatEventEnvelope,
  HeychatRoomMembershipEventData,
  HeychatTextMessageEventData,
} from './heychat.types';

const EVENT_FRESHNESS_WINDOW_MS = 5 * 60_000;

type KnownEventType = '5' | '50' | 'card_message_btn_click' | '3001';
type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIdentifier(value: unknown): value is string | number {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0;
  }
  return typeof value === 'string' && /^\d+$/.test(value.trim());
}

function isMillisecondTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isIdLike(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function hasRoomBaseInfo(value: unknown): boolean {
  // IDs arrive as int64 and may be numbers or digit strings depending on the
  // push path; require a present identifier rather than a specific JSON type.
  return isRecord(value) && isIdLike(value.room_id);
}

function hasChannelBaseInfo(value: unknown): boolean {
  return isRecord(value) && isIdLike(value.channel_id);
}

function hasUserInfo(value: unknown): boolean {
  return isRecord(value) && isIdentifier(value.user_id);
}

/**
 * Type 5 pushes two shapes: the nested one (room_base_info/channel_base_info/
 * sender_info) and the flat one (notify_type=USER_IM_MESSAGE) where
 * room_id/channel_id/user_id and the text live directly on data. Pick the
 * first usable representation so both paths validate and normalize alike.
 */
function pickRoomInfo(data: UnknownRecord): UnknownRecord | undefined {
  for (const key of ['room_base_info', 'room_info', 'guild_info']) {
    const candidate = data[key];
    if (isRecord(candidate) && isIdLike(candidate.room_id)) return candidate;
  }
  if (isIdLike(data.room_id)) {
    return { room_id: data.room_id, room_name: data.room_name };
  }
  return undefined;
}

function pickChannelInfo(data: UnknownRecord): UnknownRecord | undefined {
  for (const key of ['channel_base_info', 'channel_info']) {
    const candidate = data[key];
    if (isRecord(candidate) && isIdLike(candidate.channel_id)) return candidate;
  }
  if (isIdLike(data.channel_id)) {
    return { channel_id: data.channel_id, channel_name: data.channel_name, channel_type: data.channel_type };
  }
  return undefined;
}

function pickSenderInfo(data: UnknownRecord): UnknownRecord | undefined {
  for (const key of ['sender_info', 'author_info']) {
    const candidate = data[key];
    if (isRecord(candidate) && isIdentifier(candidate.user_id)) return candidate;
  }
  const nested = data.user_info;
  if (isRecord(nested)) {
    if (isIdentifier(nested.user_id)) return nested;
    if (isRecord(nested.user_base_info) && isIdentifier(nested.user_base_info.user_id)) {
      return nested.user_base_info;
    }
  }
  if (isIdentifier(data.user_id)) {
    return { user_id: data.user_id, nickname: isNonEmptyString(data.nickname) ? data.nickname : '' };
  }
  return undefined;
}

function isCommandOption(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.name)
    && typeof value.type === 'number'
    && Number.isInteger(value.type)
    && typeof value.value === 'string';
}

@Injectable()
export class HeychatEventRouter {
  private readonly logger = new Logger(HeychatEventRouter.name);
  private readonly sequences = new Set<string>();
  private readonly maxSequences = 10_000;
  private processingTail: Promise<void> = Promise.resolve();

  constructor(private readonly service: HeychatService) {}

  route(envelope: HeychatEventEnvelope): Promise<boolean> {
    // Freshness is measured when the gateway hands us the event, not after it
    // has waited behind earlier work in the serial queue.
    const receivedAt = Date.now();
    const processing = this.processingTail.then(() => this.process(envelope, receivedAt));
    this.processingTail = processing.then(() => undefined, () => undefined);
    return processing;
  }

  private async process(envelope: unknown, receivedAt: number): Promise<boolean> {
    if (!isRecord(envelope)) return false;
    const type = this.normalizeEventType(envelope.type);
    this.logger.debug(`Heychat event received: type=${type || 'unknown'} ${this.trimmedEnvelope(envelope)}`);
    if (!this.isKnownEventType(type)) {
      this.logger.debug(`Heychat event ignored: type=${type || 'unknown'}`);
      return false;
    }
    if (
      !isMillisecondTimestamp(envelope.timestamp)
      || Math.abs(receivedAt - envelope.timestamp) > EVENT_FRESHNESS_WINDOW_MS
    ) {
      this.logger.warn(`Heychat event rejected: type=${type}; invalid or stale timestamp`);
      return false;
    }

    const sequence = this.normalizeSequence(envelope.sequence);
    if (!sequence) {
      this.logger.warn(`Heychat event rejected: type=${type}; invalid sequence`);
      return false;
    }
    if (this.sequences.has(sequence)) return false;

    let handled: boolean;
    switch (type) {
      case '5':
        if (!this.isTextMessageEventData(envelope.data)) {
          this.logger.warn('Heychat event rejected: type=5; invalid data');
          this.logger.debug(`Heychat rejected type=5 envelope: ${this.trimmedEnvelope(envelope)}`);
          return false;
        }
        handled = await this.service.handleTextMessage(envelope.data);
        break;
      case '50':
        if (!this.isCommandEventData(envelope.data)) {
          this.logger.warn('Heychat event rejected: type=50; invalid data');
          return false;
        }
        handled = await this.service.handleCommand(envelope.data);
        break;
      case 'card_message_btn_click':
        if (!this.isCardButtonEventData(envelope.data)) {
          this.logger.warn('Heychat event rejected: type=card_message_btn_click; invalid data');
          return false;
        }
        handled = await this.service.handleCardButton(envelope.data);
        break;
      case '3001':
        if (!this.isRoomMembershipEventData(envelope.data)) {
          this.logger.warn('Heychat event rejected: type=3001; invalid data');
          return false;
        }
        handled = await this.service.handleRoomMembership(envelope.data);
        break;
    }

    // Commit only after the handler fulfils. If it throws, the queue remains
    // usable and a redelivery with the same sequence may retry the operation.
    this.commitSequence(sequence);
    return handled;
  }

  private commitSequence(sequence: string): void {
    if (this.sequences.size >= this.maxSequences) {
      const first = this.sequences.values().next().value;
      if (first !== undefined) this.sequences.delete(first);
    }
    this.sequences.add(sequence);
  }

  private trimmedEnvelope(envelope: HeychatEventEnvelope): string {
    try {
      const raw = JSON.stringify(envelope);
      return raw.length > 2_000 ? `${raw.slice(0, 2_000)}…(truncated)` : raw;
    } catch {
      return 'unserializable envelope';
    }
  }

  private normalizeEventType(value: unknown): string {
    if (typeof value !== 'string' && typeof value !== 'number') return '';
    return String(value).trim();
  }

  private isKnownEventType(type: string): type is KnownEventType {
    return type === '5' || type === '50' || type === 'card_message_btn_click' || type === '3001';
  }

  private normalizeSequence(value: unknown): string | null {
    if (typeof value === 'number') {
      return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
    }
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    return trimmed.replace(/^0+(?=\d)/, '');
  }

  private isCommandEventData(data: unknown): data is HeychatCommandEventData {
    if (!isRecord(data) || !isRecord(data.command_info)) return false;
    const options = data.command_info.options;
    return isIdentifier(data.bot_id)
      && hasRoomBaseInfo(data.room_base_info)
      && hasChannelBaseInfo(data.channel_base_info)
      && isNonEmptyString(data.command_info.name)
      && (options === undefined || (Array.isArray(options) && options.every(isCommandOption)))
      && isNonEmptyString(data.msg_id)
      && hasUserInfo(data.sender_info)
      && isMillisecondTimestamp(data.send_time);
  }

  private isTextMessageEventData(data: unknown): data is HeychatTextMessageEventData {
    if (!isRecord(data)) return false;
    const room = pickRoomInfo(data);
    const channel = pickChannelInfo(data);
    const sender = pickSenderInfo(data);
    return !!room && !!channel && !!sender
      && [data.text, data.content, data.message, data.msg, data.content_text].some(isNonEmptyString);
  }

  private isCardButtonEventData(data: unknown): data is HeychatCardButtonEventData {
    return isRecord(data)
      && hasRoomBaseInfo(data.room_base_info)
      && hasChannelBaseInfo(data.channel_base_info)
      && hasUserInfo(data.sender_info)
      && isNonEmptyString(data.event)
      && isNonEmptyString(data.msg_id)
      && typeof data.text === 'string'
      && typeof data.value === 'string'
      && isMillisecondTimestamp(data.send_time);
  }

  private isRoomMembershipEventData(data: unknown): data is HeychatRoomMembershipEventData {
    return isRecord(data)
      && hasRoomBaseInfo(data.room_base_info)
      && isRecord(data.user_info)
      && hasUserInfo(data.user_info)
      && typeof data.user_info.bot === 'boolean'
      && (data.state === 0 || data.state === 1);
  }
}
