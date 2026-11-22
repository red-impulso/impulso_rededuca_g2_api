import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { AuthedRequest } from '../../auth/auth.guard.js';
import { CurrentMembership } from '../../auth/current-membership.decorator.js';
import { MembershipGuard } from '../../auth/membership.guard.js';
import type { Membership as ActiveMembership } from '../../auth/membership.guard.js';
import { Roles } from '../../auth/roles.decorator.js';
import { AlertsService } from './alerts.service.js';

@Controller('alerts')
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  @UseGuards(MembershipGuard)
  @Roles('admin', 'director', 'teacher')
  getAlerts(
    @Req() request: AuthedRequest,
    @CurrentMembership() membership: ActiveMembership,
  ) {
    return this.alerts.list(request.user, membership);
  }
}
