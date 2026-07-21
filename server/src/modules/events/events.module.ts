import { Global, Module } from '@nestjs/common';
import { EventBusService } from './events.service';

@Global()
@Module({
  providers: [EventBusService],
  exports: [EventBusService],
})
export class EventsModule {}
