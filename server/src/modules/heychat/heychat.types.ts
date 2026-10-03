export interface HeychatUserInfo {
  user_id?: number | string;
  nickname?: string;
  room_nickname?: string;
  bot?: boolean;
}

export interface HeychatRoomBaseInfo {
  room_id?: string;
  room_name?: string;
  room_avatar?: string;
}

export interface HeychatChannelBaseInfo {
  channel_id?: string;
  channel_name?: string;
  channel_type?: number;
}

export interface HeychatCommandOption {
  name?: string;
  type?: number;
  value?: string;
}

export interface HeychatEventEnvelope {
  sequence?: string | number;
  type?: string | number;
  notify_type?: string;
  data?: unknown;
  timestamp?: number;
}

export interface HeychatCommandEventData {
  bot_id?: number | string;
  room_base_info?: HeychatRoomBaseInfo;
  channel_base_info?: HeychatChannelBaseInfo;
  command_info?: {
    id?: string;
    name?: string;
    type?: number;
    options?: HeychatCommandOption[];
  };
  msg_id?: string;
  sender_info?: HeychatUserInfo;
  send_time?: number;
}

/** Legacy/plain channel message pushed as type 5 by Heychat. */
export interface HeychatTextMessageEventData {
  bot_id?: number | string;
  room_base_info?: HeychatRoomBaseInfo;
  channel_base_info?: HeychatChannelBaseInfo;
  sender_info?: HeychatUserInfo;
  msg_id?: string;
  text?: string;
  content?: string;
  message?: string;
  msg?: string;
  send_time?: number;
  /**
   * Flat push shape (notify_type=USER_IM_MESSAGE): identifiers and the text
   * live directly on data instead of *_base_info/sender_info. user_info is a
   * full profile whose identity may sit at user_info.user_base_info.user_id.
   */
  room_id?: string | number;
  room_name?: string;
  channel_id?: string | number;
  channel_name?: string;
  channel_type?: number;
  user_id?: number | string;
  nickname?: string;
  user_info?: HeychatUserInfo & { user_base_info?: HeychatUserInfo };
}

export interface HeychatCardButtonEventData {
  room_base_info?: HeychatRoomBaseInfo;
  channel_base_info?: HeychatChannelBaseInfo;
  sender_info?: HeychatUserInfo;
  event?: string;
  msg_id?: string;
  text?: string;
  value?: string;
  send_time?: number;
}

export interface HeychatRoomMembershipEventData {
  room_base_info?: HeychatRoomBaseInfo;
  user_info?: HeychatUserInfo;
  state?: number;
}

export interface HeychatJoinedRoom {
  room_id: string;
  room_name?: string;
  room_avatar?: string;
  create_by?: number | string;
  public_id?: string;
  join_time?: number;
}

export interface HeychatRoomChannel {
  channel_id?: string;
  channel_name?: string;
  channel_type?: number;
  channel_list?: HeychatRoomChannel[];
}

export interface HeychatRoomDetail {
  memberCount?: number;
  roomId: string;
  roomName: string;
  ownerId: string;
  publicId: string;
  textChannels: HeychatRoomChannel[];
}

export interface HeychatCardMessage {
  data: Array<{
    type: 'card';
    modules: any[];
  }>;
}
