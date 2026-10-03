import { Injectable, Logger } from '@nestjs/common';
import type { SessionEndedEvent, SessionStartedEvent } from '../events/events.service';
import type { PlatformSessionAdapter } from './platform-session.adapter';
import type { PlatformKey } from './platform.types';

@Injectable()
export class PlatformRegistryService {
  private readonly logger = new Logger(PlatformRegistryService.name);
  private readonly adapters = new Map<PlatformKey, PlatformSessionAdapter>();

  register(adapter: PlatformSessionAdapter): void {
    const existing = this.adapters.get(adapter.platform);
    if (existing && existing !== adapter) {
      throw new Error(`Platform adapter already registered: ${adapter.platform}`);
    }
    this.adapters.set(adapter.platform, adapter);
    this.logger.log(`Platform adapter registered: ${adapter.platform}`);
  }

  unregister(adapter: PlatformSessionAdapter): void {
    if (this.adapters.get(adapter.platform) !== adapter) return;
    this.adapters.delete(adapter.platform);
    this.logger.log(`Platform adapter unregistered: ${adapter.platform}`);
  }

  get(platform: PlatformKey): PlatformSessionAdapter | undefined {
    return this.adapters.get(platform);
  }

  listPlatforms(): PlatformKey[] {
    return [...this.adapters.keys()];
  }

  async dispatchSessionStarted(event: SessionStartedEvent): Promise<boolean> {
    const adapter = this.adapters.get(event.platform);
    if (!adapter) return false;
    await adapter.onSessionStarted(event);
    return true;
  }

  async dispatchSessionEnded(event: SessionEndedEvent): Promise<boolean> {
    const adapter = this.adapters.get(event.platform);
    if (!adapter) return false;
    await adapter.onSessionEnded(event);
    return true;
  }
}
