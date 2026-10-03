export interface KookMessageEvent {
  /** Server-recorded inbox arrival time, not the queued event's processing time. */
  receivedAt?: number;
  id?: string;
  msg_id?: string;
  type?: number;
  content: string;
  target_id: string;
  channel_id?: string;
  guild_id?: string;
  author_id?: string;
  extra?: {
    type?: unknown;
    body?: Record<string, unknown>;
    guild_id?: string;
    author?: { id?: string; username?: string; bot?: boolean };
    channel_id?: string;
  };
}

export interface KookButtonClickEvent {
  receivedAt?: number;
  msgId: string;
  userId: string;
  username: string;
  targetId: string;
  guildId: string;
  value: string;
}

export interface KookWebhookEnvelope {
  s: number;
  sn?: number;
  d: Record<string, unknown>;
}

export interface KookQueuedEvent {
  receivedAt?: number;
  eventKey: string;
  sn: number | null;
  eventType: string;
  payload: string;
  attempts: number;
}
