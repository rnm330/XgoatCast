import { Module } from '@nestjs/common';
import { ServerAdminController } from './server-admin.controller';

@Module({
  controllers: [ServerAdminController],
})
export class ServerAdminModule {}
