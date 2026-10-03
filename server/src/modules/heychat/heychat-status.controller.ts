import { Controller, Get, Post } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { HeychatApiService } from './heychat-api.service';
import { HeychatGatewayService } from './heychat-gateway.service';
import { HeychatService } from './heychat.service';

@Controller('api/super/heychat')
export class HeychatStatusController {
  constructor(
    private readonly db: DatabaseService,
    private readonly api: HeychatApiService,
    private readonly gateway: HeychatGatewayService,
    private readonly service: HeychatService,
  ) {}

  @Get('status')
  status() {
    const spaces = this.db.listSpaces('heychat');
    return {
      mode: 'websocket',
      configured: !!this.db.getGlobalConfig().heychatBotToken,
      apiReady: this.api.isReady,
      botId: this.api.botId,
      websocket: this.gateway.status,
      rooms: spaces.filter((space) => space.status === 'active').length,
      totalRooms: spaces.length,
      sync: this.service.syncStatus,
      cardDelivery: this.db.getCardJobSummary(),
      commands: ['/屏幕共享', '/xc', '/xchelp'],
    };
  }

  @Post('sync')
  async sync() {
    const credentialReloaded = this.gateway.reloadCredential();
    const sync = await this.service.syncRooms(true);
    const spaces = this.db.listSpaces('heychat');
    return {
      ok: sync.ok,
      credentialReloaded,
      rooms: spaces.filter((space) => space.status === 'active').length,
      sync,
      websocket: this.gateway.status,
    };
  }
}
