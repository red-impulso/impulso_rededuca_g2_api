import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentMembership } from '../../auth/current-membership.decorator.js';
import { MembershipGuard } from '../../auth/membership.guard.js';
import type { Membership as ActiveMembership } from '../../auth/membership.guard.js';
import { Roles } from '../../auth/roles.decorator.js';
import type { LinkGuardianDto } from './dto/link-guardian.dto.js';
import { GuardiansService } from './guardians.service.js';

@Controller('students')
@UseGuards(MembershipGuard)
@Roles('admin', 'director')
export class GuardiansController {
  constructor(private readonly guardians: GuardiansService) {}

  @Get(':id/guardians')
  listGuardians(
    @CurrentMembership() membership: ActiveMembership,
    @Param('id') studentId: string,
  ) {
    return this.guardians.listGuardians(membership, studentId);
  }

  @Post(':id/guardians')
  linkGuardian(
    @CurrentMembership() membership: ActiveMembership,
    @Param('id') studentId: string,
    @Body() body: LinkGuardianDto,
  ) {
    return this.guardians.linkGuardian(membership, studentId, body);
  }

  @Delete(':id/guardians/:guardianMembershipId')
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
