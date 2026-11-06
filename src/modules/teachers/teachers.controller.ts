import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import { CurrentMembership } from '../../auth/current-membership.decorator.js';
import { MembershipGuard } from '../../auth/membership.guard.js';
import type { Membership as ActiveMembership } from '../../auth/membership.guard.js';
import { Roles } from '../../auth/roles.decorator.js';
import type { AssignTeacherDto } from './dto/assign-teacher.dto.js';
import { TeachersService } from './teachers.service.js';

@Controller()
@UseGuards(MembershipGuard)
@Roles('admin', 'director')
export class TeachersController {
  constructor(private readonly teachers: TeachersService) {}

  @Get('teachers')
  listTeachers(@CurrentMembership() membership: ActiveMembership) {
    return this.teachers.listTeachers(membership);
  }

  @Put('subjects/:id/teacher')
  assignTeacher(
    @CurrentMembership() membership: ActiveMembership,
    @Param('id') id: string,
    @Body() body: AssignTeacherDto,
  ) {
    return this.teachers.assignTeacher(membership, id, body);
  }
}
