import { Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { AuthedRequest } from '../../auth/auth.guard.js';
import { CurrentMembership } from '../../auth/current-membership.decorator.js';
import { MembershipGuard } from '../../auth/membership.guard.js';
import type { Membership as ActiveMembership } from '../../auth/membership.guard.js';
import { NotificationsService } from './notifications.service.js';

@Controller('notifications')
@UseGuards(MembershipGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(
    @Req() request: AuthedRequest,
    @CurrentMembership() membership: ActiveMembership,
  ) {
    return this.notifications.list(request.user, membership);
  }

  @Get('unread-count')
  unreadCount(
    @Req() request: AuthedRequest,
    @CurrentMembership() membership: ActiveMembership,
  ) {
    return this.notifications.unreadCount(request.user, membership);
  }

  @Post('read-all')
  markAllRead(
    @Req() request: AuthedRequest,
    @CurrentMembership() membership: ActiveMembership,
  ) {
    return this.notifications.markAllRead(request.user, membership);
  }

  @Post(':id/read')
  markRead(
    @Req() request: AuthedRequest,
    @CurrentMembership() membership: ActiveMembership,
    @Param('id') notificationId: string,
  ) {
    return this.notifications.markRead(
      request.user,
      membership,
      notificationId,
    );
  }
}
