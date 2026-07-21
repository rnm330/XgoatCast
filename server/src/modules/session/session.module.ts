import { Global, Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SessionService } from './session.service';
import { SessionSseController } from './session-sse.controller';

@Global()
@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [SessionService],
  controllers: [SessionSseController],
  exports: [SessionService],
})
export class SessionModule {}
