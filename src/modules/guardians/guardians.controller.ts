import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentMembership } from '../../auth/current-membership.decorator.js';
import { MembershipGuard } from '../../auth/membership.guard.js';
import type { Membership as ActiveMembership } from '../../auth/membership.guard.js';
import { Roles } from '../../auth/roles.decorator.js';
import type {
  GuardianContactDto,
  LinkGuardianDto,
} from './dto/link-guardian.dto.js';
import { GuardiansService } from './guardians.service.js';

@Controller()
@UseGuards(MembershipGuard)
@Roles('admin', 'director')
export class GuardiansController {
  constructor(private readonly guardians: GuardiansService) {}

  @Get('guardians')
  listSchoolGuardians(@CurrentMembership() membership: ActiveMembership) {
    return this.guardians.listSchoolGuardians(membership);
  }

  @Get('students/:id/guardians')
  listGuardians(
    @CurrentMembership() membership: ActiveMembership,
    @Param('id') studentId: string,
  ) {
    return this.guardians.listGuardians(membership, studentId);
  }

  @Post('students/:id/guardians')
  linkGuardian(
    @CurrentMembership() membership: ActiveMembership,
    @Param('id') studentId: string,
    @Body() body: LinkGuardianDto,
  ) {
    return this.guardians.linkGuardian(membership, studentId, body);
  }

  @Patch('students/:id/guardians/:guardianMembershipId')
  updateGuardian(
    @CurrentMembership() membership: ActiveMembership,
    @Param('id') studentId: string,
    @Param('guardianMembershipId') guardianMembershipId: string,
    @Body() body: GuardianContactDto,
  ) {
    return this.guardians.updateGuardian(
      membership,
      studentId,
      guardianMembershipId,
      body,
    );
  }

  @Delete('students/:id/guardians/:guardianMembershipId')
  unlinkGuardian(
    @CurrentMembership() membership: ActiveMembership,
    @Param('id') studentId: string,
    @Param('guardianMembershipId') guardianMembershipId: string,
  ) {
    return this.guardians.unlinkGuardian(
      membership,
      studentId,
      guardianMembershipId,
    );
  }
}
