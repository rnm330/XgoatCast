import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'events';

export interface SessionStartedEvent {
  sessionId: string;
  token: string;
  sharerUsername: string;
  targetChannelId: string;
  guildId: string;
}

export interface SessionEndedEvent {
  sessionId: string;
  reason: string;
  targetChannelId?: string;
  cardMessageId?: string;
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

  onSessionStarted(handler: (event: SessionStartedEvent) => void) {
    this.on('session.started', handler);
  }

  onSessionEnded(handler: (event: SessionEndedEvent) => void) {
    this.on('session.ended', handler);
  }

  onSessionStateChanged(handler: (event: SessionStateChangedEvent) => void) {
    this.on('session.state_changed', handler);
  }
}
