import { IsString, IsOptional, IsArray, IsNumber, Min } from 'class-validator';

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
  @IsString()
  triggerWords?: string;

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

  @IsOptional()
  @IsString()
  publicDomain?: string;

  /** 是否允许共享者开启低延迟模式（1=允许，0=不允许） */
  @IsOptional()
  @IsNumber()
  @Min(0)
  allowLowLatency?: number;
}
