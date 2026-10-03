import { Global, Module } from '@nestjs/common';
import { PanelAccessService } from './panel-access.service';
import { PanelRegistrationService } from './panel-registration.service';
import { PanelsController } from './panels.controller';
import { SuperAdminGuard } from '../analytics/super-admin.guard';

@Global()
@Module({ providers: [PanelAccessService, PanelRegistrationService, SuperAdminGuard], controllers: [PanelsController], exports: [PanelAccessService] })
export class PanelsModule {}
