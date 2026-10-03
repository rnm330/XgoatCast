import type {
  SessionEndedEvent,
  SessionStartedEvent,
} from '../events/events.service';
import type { PlatformKey } from './platform.types';

/**
 * Boundary implemented by each chat integration.
 *
 * Core session code emits platform-neutral lifecycle events. Rendering cards,
 * choosing message APIs, and retaining platform message identifiers stay in
 * the owning integration module.
 */
export interface PlatformSessionAdapter {
  readonly platform: PlatformKey;
  onSessionStarted(event: SessionStartedEvent): Promise<void>;
  onSessionEnded(event: SessionEndedEvent): Promise<void>;
}
