import { Module } from '@nestjs/common';
import { QqApiService } from './qq-api.service';
import { QqRepository } from './qq.repository';
import { QqService } from './qq.service';
import { QqBindingController, QqStatusController, QqWebhookController } from './qq.controller';

@Module({ providers: [QqApiService, QqRepository, QqService],
  controllers: [QqWebhookController, QqBindingController, QqStatusController] })
export class QqModule {}
