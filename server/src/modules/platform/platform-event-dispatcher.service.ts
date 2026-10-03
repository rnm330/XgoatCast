import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  EventBusService,
  SessionEndedEvent,
  SessionStartedEvent,
} from '../events/events.service';
import { PlatformRegistryService } from './platform-registry.service';

@Injectable()
export class PlatformEventDispatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PlatformEventDispatcherService.name);
  private unsubscribeStarted: (() => void) | null = null;
  private unsubscribeEnded: (() => void) | null = null;

  constructor(
    private readonly bus: EventBusService,
    private readonly registry: PlatformRegistryService,
  ) {}

  onModuleInit(): void {
    this.unsubscribeStarted = this.bus.onSessionStarted((event) => {
      void this.dispatchStarted(event);
    });
    this.unsubscribeEnded = this.bus.onSessionEnded((event) => {
      void this.dispatchEnded(event);
    });
  }

  onModuleDestroy(): void {
    this.unsubscribeStarted?.();
    this.unsubscribeEnded?.();
    this.unsubscribeStarted = null;
    this.unsubscribeEnded = null;
  }

  private async dispatchStarted(event: SessionStartedEvent): Promise<void> {
    if (event.platform === 'panel') return;
    try {
      const handled = await this.registry.dispatchSessionStarted(event);
      if (!handled) {
        this.logger.warn(
          `No adapter for session.started: platform=${event.platform} session=${event.sessionId}`,
        );
      }
    } catch (error: any) {
      this.logger.error(
        `Platform session.started failed: platform=${event.platform} session=${event.sessionId}: ${error?.message || error}`,
      );
    }
  }

  private async dispatchEnded(event: SessionEndedEvent): Promise<void> {
    if (event.platform === 'panel') return;
    try {
      const handled = await this.registry.dispatchSessionEnded(event);
      if (!handled) {
        this.logger.warn(
          `No adapter for session.ended: platform=${event.platform} session=${event.sessionId}`,
        );
      }
    } catch (error: any) {
      this.logger.error(
        `Platform session.ended failed: platform=${event.platform} session=${event.sessionId}: ${error?.message || error}`,
      );
    }
  }
}
