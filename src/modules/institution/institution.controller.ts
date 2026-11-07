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
import type { CreateCourseDto, UpdateCourseDto } from './dto/course.dto.js';
import type { CreateSubjectDto, UpdateSubjectDto } from './dto/subject.dto.js';
import type { UpdateInstitutionDto } from './dto/update-institution.dto.js';
import { InstitutionService } from './institution.service.js';

@Controller()
@UseGuards(MembershipGuard)
@Roles('admin', 'director')
export class InstitutionController {
  constructor(private readonly institution: InstitutionService) {}

  @Get('institution')
  getInstitution(@CurrentMembership() membership: ActiveMembership) {
    return this.institution.getInstitution(membership);
  }

  @Patch('institution')
  updateInstitution(
    @CurrentMembership() membership: ActiveMembership,
    @Body() body: UpdateInstitutionDto,
  ) {
    return this.institution.updateInstitution(membership, body);
  }

  @Get('courses')
  listCourses(@CurrentMembership() membership: ActiveMembership) {
    return this.institution.listCourses(membership);
  }

  @Post('courses')
  createCourse(
    @CurrentMembership() membership: ActiveMembership,
    @Body() body: CreateCourseDto,
  ) {
    return this.institution.createCourse(membership, body);
  }

  @Patch('courses/:id')
  updateCourse(
    @CurrentMembership() membership: ActiveMembership,
    @Param('id') id: string,
    @Body() body: UpdateCourseDto,
  ) {
    return this.institution.updateCourse(membership, id, body);
  }

  @Delete('courses/:id')
  deleteCourse(
    @CurrentMembership() membership: ActiveMembership,
    @Param('id') id: string,
  ) {
    return this.institution.deleteCourse(membership, id);
  }

  @Get('subjects')
  listSubjects(@CurrentMembership() membership: ActiveMembership) {
    return this.institution.listSubjects(membership);
  }

  @Post('subjects')
  createSubject(
    @CurrentMembership() membership: ActiveMembership,
    @Body() body: CreateSubjectDto,
  ) {
    return this.institution.createSubject(membership, body);
  }

  @Patch('subjects/:id')
  updateSubject(
    @CurrentMembership() membership: ActiveMembership,
    @Param('id') id: string,
    @Body() body: UpdateSubjectDto,
  ) {
    return this.institution.updateSubject(membership, id, body);
  }

  @Delete('subjects/:id')
  deleteSubject(
    @CurrentMembership() membership: ActiveMembership,
    @Param('id') id: string,
  ) {
    return this.institution.deleteSubject(membership, id);
  }
}
