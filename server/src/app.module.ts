import { Module } from '@nestjs/common';
import { EventsModule } from './modules/events/events.module';
import { DatabaseModule } from './modules/database/database.module';
import { AgoraModule } from './modules/agora/agora.module';
import { SessionModule } from './modules/session/session.module';
import { AuthModule } from './modules/auth/auth.module';
import { KookModule } from './modules/kook/kook.module';
import { ShareModule } from './modules/share/share.module';
import { SuperAdminModule } from './modules/super-admin/super-admin.module';
import { ServerAdminModule } from './modules/server-admin/server-admin.module';

@Module({
  imports: [
    EventsModule,
    DatabaseModule,
    AgoraModule,
    SessionModule,
    AuthModule,
    KookModule,
    ShareModule,
    SuperAdminModule,
    ServerAdminModule,
  ],
})
export class AppModule {}
