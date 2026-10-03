import { PanelsModule } from './modules/panels/panels.module';
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
import { NoticesModule } from './modules/notices/notices.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { PlatformModule } from './modules/platform/platform.module';
import { HeychatModule } from './modules/heychat/heychat.module';
import { QqModule } from './modules/qq/qq.module';

@Module({
  imports: [
    EventsModule,
    PlatformModule,
    DatabaseModule,
    AnalyticsModule,
    AgoraModule,
    SessionModule,
    AuthModule,
    KookModule,
    HeychatModule,
    QqModule,
    ShareModule,
    SuperAdminModule,
    ServerAdminModule,
    NoticesModule,
    PanelsModule,
  ],
})
export class AppModule {}
