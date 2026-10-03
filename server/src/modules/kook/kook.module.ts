import { Module } from '@nestjs/common';
import { KookService } from './kook.service';
import { KookEventRouter } from './kook-event.router';
import { KookWebhookCodec } from './kook-webhook.codec';
import { KookWebhookController } from './kook-webhook.controller';
import { KookWebhookRepository } from './kook-webhook.repository';
import { KookWebhookStatusController } from './kook-webhook-status.controller';
import { KookWebhookWorker } from './kook-webhook.worker';

@Module({
  controllers: [KookWebhookController, KookWebhookStatusController],
  providers: [
    KookService,
    KookEventRouter,
    KookWebhookCodec,
    KookWebhookRepository,
    KookWebhookWorker,
  ],
})
export class KookModule {}
