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
  CreateUserDto,
  UpdateMembershipDto,
} from './dto/user.dto.js';
import { UsersService } from './users.service.js';

@Controller()
@UseGuards(MembershipGuard)
@Roles('admin')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('users')
  listUsers(@CurrentMembership() membership: ActiveMembership) {
    return this.users.listUsers(membership);
  }

  @Post('users')
  createUser(
    @CurrentMembership() membership: ActiveMembership,
    @Body() body: CreateUserDto,
  ) {
    return this.users.createUser(membership, body);
  }

  @Patch('memberships/:id')
  updateMembership(
    @CurrentMembership() membership: ActiveMembership,
    @Param('id') membershipId: string,
    @Body() body: UpdateMembershipDto,
  ) {
    return this.users.updateMembership(membership, membershipId, body);
  }

  @Delete('memberships/:id')
  deleteMembership(
    @CurrentMembership() membership: ActiveMembership,
    @Param('id') membershipId: string,
  ) {
    return this.users.deleteMembership(membership, membershipId);
  }
}
