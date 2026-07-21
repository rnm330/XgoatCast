import { Global, Module } from '@nestjs/common';
import { AgoraService } from './agora.service';

@Global()
@Module({
  providers: [AgoraService],
  exports: [AgoraService],
})
export class AgoraModule {}
