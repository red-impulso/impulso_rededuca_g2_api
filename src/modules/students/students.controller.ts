import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentMembership } from '../../auth/current-membership.decorator.js';
import { MembershipGuard } from '../../auth/membership.guard.js';
import type { Membership as ActiveMembership } from '../../auth/membership.guard.js';
import { Roles } from '../../auth/roles.decorator.js';
import type {
  CreateStudentDto,
  UpdateStudentDto,
} from './dto/student.dto.js';
import { StudentsService } from './students.service.js';

@Controller('students')
@UseGuards(MembershipGuard)
@Roles('admin', 'director')
export class StudentsController {
  constructor(private readonly students: StudentsService) {}

  @Get()
  listStudents(
    @CurrentMembership() membership: ActiveMembership,
    @Query('courseId') courseId?: string,
    @Query('q') q?: string,
  ) {
    return this.students.listStudents(membership, { courseId, q });
  }

  @Get(':id')
  getStudent(
    @CurrentMembership() membership: ActiveMembership,
    @Param('id') studentId: string,
  ) {
    return this.students.getStudent(membership, studentId);
  }

  @Post()
  createStudent(
    @CurrentMembership() membership: ActiveMembership,
    @Body() body: CreateStudentDto,
  ) {
    return this.students.createStudent(membership, body);
  }

  @Patch(':id')
  updateStudent(
    @CurrentMembership() membership: ActiveMembership,
    @Param('id') studentId: string,
    @Body() body: UpdateStudentDto,
  ) {
    return this.students.updateStudent(membership, studentId, body);
  }
}
