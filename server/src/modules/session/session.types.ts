export enum SessionStatus {
  PENDING = 'pending',
  ACTIVE = 'active',
  GRACE = 'grace',
  ENDED = 'ended',
}

/** GRACE 状态的原因：心跳丢失 / 主动停止共享 */
export type GraceReason = 'heartbeat' | 'stopped' | null;

export interface ShareSession {
  id: string;
  token: string;
  channel: string;
  sharerUserId: string;
  sharerUsername: string;
  guildId: string;
  targetChannelId: string;
  status: SessionStatus;
  viewerCount: number;
  peakViewers: number;
  totalViewerJoins: number;
  quality: string;
  cardMessageId?: string;
  manualCreated: boolean;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  lastHeartbeat: number;
  /** 进入 GRACE 状态的时间戳（用于计算恢复宽限） */
  graceStartedAt: number | null;
  /** GRACE 状态的原因 */
  graceReason: GraceReason;
  /** 最后一次有观众的时间戳（用于无人观看自动结束，null 表示暂不计时） */
  lastViewerAt: number | null;
  /** 第一个点击开始共享的客户端 ID（只有此人可恢复共享） */
  publisherClientId?: string;
  /** true=低延迟模式(rtc/互动直播)，false=极速直播(默认) */
  lowLatency: boolean;
}

// ===== 声网新版计费模型（2024年7月起）标准时长折算系数 =====
// 标准时长 = 实际用量(秒) × 折算系数，费用 = 标准时长(分钟) × 0.007 元
// 参考: https://doc.shengwang.cn/doc/rtc/android/billing/billing-strategy

/** 互动直播（主播 + rtc 模式观众）折算系数 */
export const INTERACTIVE_LIVE_COEFFICIENTS: Record<string, number> = {
  '音频': 1,
  'SD 标清': 4,            // SD 分辨率映射到 HD 档
  'HD 高清': 4,
  'Full HD 全高清': 9,
  '2K': 16,
  '2K+ 超高清': 36,
};

/** 极速直播观众（live 模式，audience+level:1）折算系数 */
export const ULTRA_LOW_LATENCY_COEFFICIENTS: Record<string, number> = {
  '音频': 0.57,
  'SD 标清': 2,
  'HD 高清': 2,
  'Full HD 全高清': 4.57,
  '2K': 8,
  '2K+ 超高清': 18,
};

/** 后付费标准单价：7 元 / 1000 标准分钟 */
export const STANDARD_MINUTE_PRICE = 0.007;

/**
 * 获取音频订阅的标准时长折算系数
 * 主播不订阅自己的视频流，始终按音频计费（互动直播音频系数=1）
 */
export function getAudioCoefficient(_lowLatency: boolean, isBroadcaster: boolean): number {
  // 主播始终按互动直播音频系数；观众按模式区分
  if (isBroadcaster) return 1;
  // 观众：lowLatency=true → 互动直播(1), false → 极速直播(0.57)
  return _lowLatency ? 1 : 0.57;
}

/**
 * 获取视频订阅的标准时长折算系数（观众端，主播不订阅视频）
 * @param tier 集合分辨率档位（来自 QualityInfo.tier）
 * @param lowLatency 是否低延迟模式（rtc/互动直播）
 * @returns 折算系数
 */
export function getVideoCoefficient(tier: string, lowLatency: boolean): number {
  if (lowLatency) {
    // lowLatency=true → rtc 模式 → 互动直播观众价
    return INTERACTIVE_LIVE_COEFFICIENTS[tier] ?? 4;
  }
  // lowLatency=false → live 模式 → 极速直播观众价
  return ULTRA_LOW_LATENCY_COEFFICIENTS[tier] ?? 2;
}

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
  /** 声网标准计费分钟数 */
  billingMinutes: number;
  /** 计费明细 */
  billingDetail: string;
  /** 标准时长（分钟），用于展示 */
  standardMinutes: number;
  /** 预估费用（元），约 standardMinutes × 0.007 */
  estimatedCost: number;
  /** 已锁定的共享者客户端 ID */
  publisherClientId?: string;
  /** 未共享屏幕倒计时剩余秒数（PENDING / GRACE 状态） */
  idleRemainingSec?: number;
  /** 无人观看自动结束剩余秒数 */
  noViewerRemainingSec?: number;
  /** true=低延迟模式(rtc)，false=极速直播(默认) */
  lowLatency: boolean;
  /** 服务器是否允许开启低延迟模式 */
  allowLowLatency: boolean;
}

export interface StoredSessions {
  sessions: ShareSession[];
}

// ===== Quality presets（从旧 config.types.ts 移入） =====

export interface QualityInfo {
  key: string;
  label: string;
  width: number;
  height: number;
  frameRate: number;
  bitrateMin: number;
  bitrateMax: number;
  resolution: number;
  tier: string;
  coefficient: number;
}

export const QUALITY_PRESETS: QualityInfo[] = [
  {
    key: '480p_2',
    label: '480P 30fps',
    width: 640, height: 480, frameRate: 30, bitrateMin: 400, bitrateMax: 1000,
    resolution: 640 * 480, tier: 'SD 标清', coefficient: 2,
  },
  {
    key: '720p30',
    label: '720P 30fps',
    width: 1280, height: 720, frameRate: 30, bitrateMin: 1000, bitrateMax: 3000,
    resolution: 1280 * 720, tier: 'HD 高清', coefficient: 4,
  },
  {
    key: '1080p_2',
    label: '1080P 30fps',
    width: 1920, height: 1080, frameRate: 30, bitrateMin: 2000, bitrateMax: 5000,
    resolution: 1920 * 1080, tier: 'Full HD 全高清', coefficient: 9,
  },
  {
    key: '1080p60',
    label: '1080P 60fps',
    width: 1920, height: 1080, frameRate: 60, bitrateMin: 4000, bitrateMax: 8000,
    resolution: 1920 * 1080, tier: 'Full HD 全高清', coefficient: 9,
  },
  {
    key: '1440p30',
    label: '2K 30fps',
    width: 2560, height: 1440, frameRate: 30, bitrateMin: 4000, bitrateMax: 10000,
    resolution: 2560 * 1440, tier: '2K', coefficient: 16,
  },
  {
    key: '1440p60',
    label: '2K 60fps',
    width: 2560, height: 1440, frameRate: 60, bitrateMin: 6000, bitrateMax: 15000,
    resolution: 2560 * 1440, tier: '2K', coefficient: 16,
  },
  {
    key: '4k30',
    label: '4K 30fps',
    width: 3840, height: 2160, frameRate: 30, bitrateMin: 8000, bitrateMax: 20000,
    resolution: 3840 * 2160, tier: '2K+ 超高清', coefficient: 36,
  },
];

export function getQualityInfo(key: string): QualityInfo {
  return QUALITY_PRESETS.find((q) => q.key === key) || QUALITY_PRESETS[2];
}
