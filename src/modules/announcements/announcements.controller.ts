import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import type { AuthedRequest } from '../../auth/auth.guard.js';
import { CurrentMembership } from '../../auth/current-membership.decorator.js';
import { MembershipGuard } from '../../auth/membership.guard.js';
import type { Membership as ActiveMembership } from '../../auth/membership.guard.js';
import { Roles } from '../../auth/roles.decorator.js';
import { AnnouncementsService } from './announcements.service.js';
import type { CreateAnnouncementDto } from './dto/create-announcement.dto.js';

@Controller('announcements')
export class AnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Post()
  @UseGuards(MembershipGuard)
  @Roles('admin', 'director', 'teacher')
  create(
    @Req() request: AuthedRequest,
    @CurrentMembership() membership: ActiveMembership,
    @Body() body: CreateAnnouncementDto,
  ) {
    return this.announcements.create(request.user, membership, body);
  }

  @Get()
  @UseGuards(MembershipGuard)
  list(
    @Req() request: AuthedRequest,
    @CurrentMembership() membership: ActiveMembership,
  ) {
    return this.announcements.list(request.user, membership);
  }
}
