import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { AuthedRequest } from '../auth/auth.guard.js';
import { CurrentMembership } from '../auth/current-membership.decorator.js';
import { MembershipGuard } from '../auth/membership.guard.js';
import type { Membership as ActiveMembership } from '../auth/membership.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { MeService } from './me.service.js';

@Controller('me')
export class MeController {
  constructor(private readonly meService: MeService) {}

  @Get()
  getMe(@Req() request: AuthedRequest) {
    return this.meService.getMe(request.user);
  }

  @Get('subjects')
  @UseGuards(MembershipGuard)
  @Roles('teacher')
  getSubjects(
    @Req() request: AuthedRequest,
    @CurrentMembership() membership: ActiveMembership,
  ) {
    return this.meService.getSubjects(request.user, membership);
  }

  @Get('courses')
  @UseGuards(MembershipGuard)
  @Roles('teacher', 'admin', 'director')
  getCourses(
    @Req() request: AuthedRequest,
    @CurrentMembership() membership: ActiveMembership,
  ) {
    return this.meService.getCourses(request.user, membership);
  }

  @Get('students')
  @UseGuards(MembershipGuard)
  @Roles('guardian')
  getStudents(
    @Req() request: AuthedRequest,
    @CurrentMembership() membership: ActiveMembership,
  ) {
    return this.meService.getStudents(request.user, membership);
  }
}
