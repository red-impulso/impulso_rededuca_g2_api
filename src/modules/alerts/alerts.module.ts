import { Module } from '@nestjs/common';
import { AlertsController } from './alerts.controller.js';
import { AlertsListener } from './alerts.listener.js';
import { AlertsService } from './alerts.service.js';

@Module({
  controllers: [AlertsController],
  providers: [AlertsService, AlertsListener],
})
export class AlertsModule {}
