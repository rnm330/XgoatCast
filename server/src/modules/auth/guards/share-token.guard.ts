import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from '../auth.service';

@Injectable()
export class ShareTokenGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const req: any = context.switchToHttp().getRequest();
    const token = req.query['t'] || (req.body && req.body.token);
    if (!token) {
      throw new UnauthorizedException('missing token');
    }
    req.session = this.auth.verifyShareToken(token);
    req.shareToken = token;
    return true;
  }
}
