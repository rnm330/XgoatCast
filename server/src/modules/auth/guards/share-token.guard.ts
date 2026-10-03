import { PanelAccessService } from '../../panels/panel-access.service';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from '../auth.service';

@Injectable()
export class ShareTokenGuard implements CanActivate {
  constructor(private readonly auth: AuthService, private readonly panels: PanelAccessService) {}

  canActivate(context: ExecutionContext): boolean {
    const req: any = context.switchToHttp().getRequest();
    const token = req.query['t'] || (req.body && req.body.token);
    if (typeof token !== 'string' || !token || token.length > 200) {
      throw new UnauthorizedException('missing token');
    }
    const publisher = req.query.role === 'publisher' || /\/(start|stop|heartbeat)\/*$/i.test(req.path);
    const resolved = this.panels.resolve(req, token, publisher);
    req.session = this.auth.verifyShareToken(resolved.token);
    if (req.session.platform === 'panel') this.panels.active(this.panels.panel(req.session.externalSpaceId).space);
    req.panelViewer = resolved.viewer;
    req.shareToken = token;
    return true;
  }
}
