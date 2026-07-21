import { Global, Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { ShareTokenGuard } from './guards/share-token.guard';

@Global()
@Module({
  providers: [AuthService, ShareTokenGuard],
  exports: [AuthService, ShareTokenGuard],
})
export class AuthModule {}
