import { Global, Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { PlatformEventDispatcherService } from './platform-event-dispatcher.service';
import { PlatformRegistryService } from './platform-registry.service';

@Global()
@Module({
  imports: [EventsModule],
  providers: [PlatformRegistryService, PlatformEventDispatcherService],
  exports: [PlatformRegistryService],
})
export class PlatformModule {}
