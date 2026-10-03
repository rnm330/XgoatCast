export type PlatformKey = 'kook' | 'heychat' | 'qq' | 'discord' | 'panel';

export interface PlatformSessionContext {
  platform: PlatformKey;
  /** Internal stable space identifier used by XgoatCast. */
  spaceId: string;
  /** Identifier assigned by the chat platform (guild_id, room_id, ...). */
  externalSpaceId: string;
  /** Identifier assigned by the chat platform for the target text channel. */
  externalChannelId: string;
}
