import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { AuthedRequest } from '../../auth/auth.guard.js';
import { CurrentMembership } from '../../auth/current-membership.decorator.js';
import { MembershipGuard } from '../../auth/membership.guard.js';
import type { Membership as ActiveMembership } from '../../auth/membership.guard.js';
import { Roles } from '../../auth/roles.decorator.js';
import { AnnouncementsService } from './announcements.service.js';
import type { CreateAnnouncementDto } from './dto/create-announcement.dto.js';
import type { UpdateAnnouncementDto } from './dto/update-announcement.dto.js';

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

  // No @Roles: any member can try; the service allows only the announcement's
  // author or a school manager (admin/director).
  @Patch(':id')
  @UseGuards(MembershipGuard)
  update(
    @Req() request: AuthedRequest,
    @CurrentMembership() membership: ActiveMembership,
    @Param('id') announcementId: string,
    @Body() body: UpdateAnnouncementDto,
  ) {
    return this.announcements.update(
      request.user,
      membership,
      announcementId,
      body,
    );
  }

  @Delete(':id')
  @UseGuards(MembershipGuard)
  remove(
    @Req() request: AuthedRequest,
    @CurrentMembership() membership: ActiveMembership,
    @Param('id') announcementId: string,
  ) {
    return this.announcements.remove(request.user, membership, announcementId);
  }
}
