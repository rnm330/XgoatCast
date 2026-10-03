import {
  IsString,
  IsOptional,
  IsArray,
  IsNumber,
  IsObject,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import type { QualityBitrateConfig } from '../session/session.types';

export class SuperAdminLoginDto {
  @IsString()
  password!: string;
}

export class UpdateGlobalConfigDto {
  @IsOptional()
  @IsString()
  kookBotToken?: string;

  @IsOptional()
  @IsString()
  kookVerifyToken?: string;

  @IsOptional()
  @IsString()
  kookEncryptKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Matches(/^\d*$/)
  heychatBotId?: string;

  @IsOptional()
  @IsString()
  heychatBotToken?: string;

  @IsOptional()
  @IsString()
  publicDomain?: string;

  @IsOptional()
  @IsObject()
  qualityBitrates?: QualityBitrateConfig;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  triggerWordLabels?: string[];
}

export class UpdateServerDto {
  @IsOptional()
  @IsString()
  agoraAppId?: string;

  @IsOptional()
  @IsString()
  agoraAppCertificate?: string;

  @IsOptional()
  @IsNumber()
  agoraTokenExpireSec?: number;

  @IsOptional()
  @IsArray()
  allowedQualities?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  enabledTriggerWords?: string[];

  // 数值字段在控制器中钳制到合理边界（令牌 60～86400，心跳 2～60，超时 10～600）。
  @IsOptional()
  @IsNumber()
  idleTimeoutSec?: number;

  @IsOptional()
  @IsNumber()
  heartbeatIntervalSec?: number;

  @IsOptional()
  @IsNumber()
  noViewerTimeoutSec?: number;

  /** 是否允许共享者开启低延迟模式（1=允许，0=不允许） */
  @IsOptional()
  @IsNumber()
  @Min(0)
  allowLowLatency?: number;
}
