import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { KookApiError } from './kook-api.client';
import { KookEventRouter } from './kook-event.router';
import { KookService } from './kook.service';
import { KookQueuedEvent, KookWebhookEnvelope } from './kook-event.types';
import { KookWebhookRepository } from './kook-webhook.repository';

@Injectable()
export class KookWebhookWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KookWebhookWorker.name);
  private readonly batchMaxEvents = 100;
  private readonly batchTimeBudgetMs = 100;
  private timer: NodeJS.Timeout | null = null;
  private continuation: NodeJS.Immediate | null = null;
  private processing = false;
  private stopping = false;
  private cleanupCounter = 0;

  constructor(
    private readonly repository: KookWebhookRepository,
    private readonly router: KookEventRouter,
    private readonly service: KookService,
  ) {}

  onModuleInit(): void {
    const recovered = this.repository.recoverStale();
    if (recovered) this.logger.warn(`Recovered ${recovered} stale KOOK webhook event(s)`);
    this.timer = setInterval(() => void this.tick(), 100);
    this.logger.log('KOOK webhook worker started');
  }

  onModuleDestroy(): void {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.continuation) clearImmediate(this.continuation);
    this.timer = null;
    this.continuation = null;
  }

  private async tick(): Promise<void> {
    if (this.processing || this.stopping || !this.service.isReady) return;
    this.processing = true;
    const startedAt = Date.now();
    let processed = 0;
    let continueImmediately = false;
    try {
      while (
        !this.stopping &&
        processed < this.batchMaxEvents &&
        Date.now() - startedAt < this.batchTimeBudgetMs
      ) {
        const event = this.repository.claim();
        if (!event) break;
        await this.processEvent(event);
        processed++;
        this.maybeCleanup();
      }

      continueImmediately =
        !this.stopping &&
        processed > 0 &&
        (processed >= this.batchMaxEvents ||
          Date.now() - startedAt >= this.batchTimeBudgetMs);
    } finally {
      this.processing = false;
      if (continueImmediately && !this.continuation) {
        this.continuation = setImmediate(() => {
          this.continuation = null;
          void this.tick();
        });
      }
    }
  }

  private async processEvent(event: KookQueuedEvent): Promise<void> {
    let effectStarted = false;
    try {
      const envelope = JSON.parse(event.payload) as KookWebhookEnvelope;
      const effect = this.repository.beginBusinessEffect(event.eventKey);
      if (effect !== 'execute') {
        const log = effect === 'uncertain' ? this.logger.warn.bind(this.logger) : this.logger.log.bind(this.logger);
        log(`KOOK webhook business effect reconciled: key=${event.eventKey} result=${effect}`);
        return;
      }
      effectStarted = true;
      const handled = await this.router.route(envelope, event.receivedAt);
      this.repository.completeBusinessEffect(event.eventKey, !handled);
      this.logger.log(
        `KOOK webhook processed: key=${event.eventKey} type=${event.eventType} result=${handled ? 'done' : 'ignored'}`,
      );
    } catch (error: any) {
      const errorCode = error instanceof KookApiError
        ? `kook_api_${error.status || 'network'}_${error.kookCode || 'unknown'}`
        : 'processing_error';
      if (effectStarted) {
        // Once business execution has started, a thrown error cannot prove that
        // external side effects did not happen. Preserve the uncertainty instead
        // of blindly retrying and creating duplicate cards/sessions.
        this.repository.markBusinessEffectUncertain(event.eventKey, errorCode);
        this.logger.error(`KOOK webhook uncertain: key=${event.eventKey} error=${errorCode}`);
      } else if (event.attempts < 5) {
        this.repository.retry(event.eventKey, event.attempts, errorCode);
        this.logger.warn(`KOOK webhook retry scheduled: key=${event.eventKey} attempt=${event.attempts}`);
      } else {
        this.repository.dead(event.eventKey, errorCode);
        this.logger.error(`KOOK webhook dead: key=${event.eventKey} error=${errorCode}`);
      }
    }
  }

  private maybeCleanup(): void {
    if (++this.cleanupCounter >= 10000) {
      this.cleanupCounter = 0;
      const removed = this.repository.cleanup();
      if (removed) this.logger.log(`Cleaned ${removed} old KOOK webhook event(s)`);
    }
  }
}
