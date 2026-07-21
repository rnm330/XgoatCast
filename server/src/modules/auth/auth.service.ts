import { Injectable, UnauthorizedException } from '@nestjs/common';
import { SessionService } from '../session/session.service';
import { ShareSession } from '../session/session.types';

@Injectable()
export class AuthService {
  constructor(
    private readonly sessionService: SessionService,
  ) {}

  verifyShareToken(token: string): ShareSession {
    const session = this.sessionService.getByToken(token);
    if (!session) {
      throw new UnauthorizedException('invalid share link');
    }
    if (session.status === 'ended') {
      throw new UnauthorizedException('share ended');
    }
    return session;
  }
}
