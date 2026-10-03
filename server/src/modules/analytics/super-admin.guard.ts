import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';

@Injectable()
export class SuperAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const header = String(request.headers?.authorization || '');
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const [body, signature, extra] = token.split('.');
    if (!body || !signature || extra) throw new UnauthorizedException('未登录');

    let payload: any;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      throw new UnauthorizedException('登录凭证无效');
    }
    if (
      payload?.role !== 'super_admin'
      || !Number.isFinite(Number(payload.exp))
      || Number(payload.exp) < Math.floor(Date.now() / 1000)
    ) {
      throw new UnauthorizedException('登录已过期');
    }

    const secret = process.env.SUPER_ADMIN_PASSWORD || '';
    if (!secret) throw new UnauthorizedException('超级管理员未配置');
    const expected = createHmac('sha256', secret).update(body).digest('base64url');
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (
      actualBuffer.length !== expectedBuffer.length
      || !timingSafeEqual(actualBuffer, expectedBuffer)
    ) {
      throw new UnauthorizedException('登录凭证无效');
    }
    return true;
  }
}
