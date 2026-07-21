import { Module } from '@nestjs/common';
import { KookService } from './kook.service';

@Module({
  providers: [KookService],
  exports: [KookService],
})
export class KookModule {}
