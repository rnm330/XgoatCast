import { IsString, IsOptional, IsArray, IsNumber, Min } from 'class-validator';

export class BindServerDto {
  @IsString()
  password!: string;

  @IsOptional()
  @IsString()
  token?: string;
}

export class ServerAdminLoginDto {
  @IsString()
  password!: string;
}

export class UpdateServerConfigDto {
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

  @IsOptional()
  @IsNumber()
  @Min(0)
  allowLowLatency?: number;
}
