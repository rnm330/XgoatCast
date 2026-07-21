import { Module } from '@nestjs/common';
import { ShareController } from './share.controller';
import { KookModule } from '../kook/kook.module';

@Module({
  imports: [KookModule],
  controllers: [ShareController],
})
export class ShareModule {}
