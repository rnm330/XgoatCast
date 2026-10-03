import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'events';
import { PlatformSessionContext } from '../platform/platform.types';

export interface SessionStartedEvent extends PlatformSessionContext {
  sessionId: string;
  token: string;
  sharerUsername: string;
}

export interface SessionEndedEvent extends PlatformSessionContext {
  sessionId: string;
  reason: string;
  platformMessageId?: string;
}

export interface SessionStateChangedEvent {
  sessionId: string;
  status: string;
  viewerCount: number;
}

@Injectable()
export class EventBusService extends EventEmitter {
  emitSessionStarted(event: SessionStartedEvent) {
    this.emit('session.started', event);
  }

  emitSessionEnded(event: SessionEndedEvent) {
    this.emit('session.ended', event);
  }

  emitSessionStateChanged(event: SessionStateChangedEvent) {
    this.emit('session.state_changed', event);
  }

  onSessionStarted(handler: (event: SessionStartedEvent) => void): () => void {
    this.on('session.started', handler);
    return () => this.off('session.started', handler);
  }

  onSessionEnded(handler: (event: SessionEndedEvent) => void): () => void {
    this.on('session.ended', handler);
    return () => this.off('session.ended', handler);
  }

  onSessionStateChanged(handler: (event: SessionStateChangedEvent) => void): () => void {
    this.on('session.state_changed', handler);
    return () => this.off('session.state_changed', handler);
  }
}
