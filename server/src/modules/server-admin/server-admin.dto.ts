import {
  IsString,
  IsIn,
  IsOptional,
  IsArray,
  IsNumber,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class BindServerDto {
  @IsString()
  @MinLength(8)
  @MaxLength(128)
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
  @IsIn([0, 1])
  allowQualityPreference?: number;

  @IsOptional()
  @IsString()
  agoraAppId?: string;

  @IsOptional()
  @IsString()
  agoraAppCertificate?: string;

  @IsOptional()
  @IsArray()
  allowedQualities?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  enabledTriggerWords?: string[];

  // 心跳间隔与声网令牌有效期由超管设置，不接受空间管理员提交。
  // 超时数值在控制器中钳制到 10～600 秒，不做拒绝式校验。
  @IsOptional()
  @IsNumber()
  idleTimeoutSec?: number;

  @IsOptional()
  @IsNumber()
  noViewerTimeoutSec?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  allowLowLatency?: number;
}
