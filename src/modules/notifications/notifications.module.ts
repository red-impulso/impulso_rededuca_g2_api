import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsListener } from './notifications.listener.js';
import { NotificationsService } from './notifications.service.js';

@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationsListener],
})
export class NotificationsModule {}
