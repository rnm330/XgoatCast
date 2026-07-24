import { IsString, IsOptional, IsArray, IsNumber, IsObject, Min } from 'class-validator';
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
  @Min(60)
  agoraTokenExpireSec?: number;

  @IsOptional()
  @IsArray()
  allowedQualities?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  enabledTriggerWords?: string[];

  @IsOptional()
  @IsNumber()
  @Min(10)
  idleTimeoutSec?: number;

  @IsOptional()
  @IsNumber()
  @Min(2)
  heartbeatIntervalSec?: number;

  @IsOptional()
  @IsNumber()
  @Min(30)
  noViewerTimeoutSec?: number;

  /** 是否允许共享者开启低延迟模式（1=允许，0=不允许） */
  @IsOptional()
  @IsNumber()
  @Min(0)
  allowLowLatency?: number;
}
