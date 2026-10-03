import { Module } from '@nestjs/common';
import { HeychatApiService } from './heychat-api.service';
import { HeychatEventRouter } from './heychat-event.router';
import { HeychatGatewayService } from './heychat-gateway.service';
import { HeychatService } from './heychat.service';
import { HeychatStatusController } from './heychat-status.controller';

@Module({
  controllers: [HeychatStatusController],
  providers: [
    HeychatApiService,
    HeychatService,
    HeychatEventRouter,
    HeychatGatewayService,
  ],
})
export class HeychatModule {}
