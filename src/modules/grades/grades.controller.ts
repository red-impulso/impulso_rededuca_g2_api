import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { AuthedRequest } from '../../auth/auth.guard.js';
import { CurrentMembership } from '../../auth/current-membership.decorator.js';
import { MembershipGuard } from '../../auth/membership.guard.js';
import type { Membership as ActiveMembership } from '../../auth/membership.guard.js';
import { Roles } from '../../auth/roles.decorator.js';
import type { SaveGradesDto } from './dto/save-grades.dto.js';
import { GradesService } from './grades.service.js';

@Controller()
export class GradesController {
  constructor(private readonly grades: GradesService) {}

  @Get('grading-periods')
  @UseGuards(MembershipGuard)
  getGradingPeriods(@CurrentMembership() membership: ActiveMembership) {
    return this.grades.listPeriods(membership);
  }

  @Get('grades')
  @UseGuards(MembershipGuard)
  @Roles('teacher')
  getGrades(
    @Req() request: AuthedRequest,
    @CurrentMembership() membership: ActiveMembership,
    @Query('subjectId') subjectId?: string,
    @Query('periodId') periodId?: string,
  ) {
    if (!subjectId || !periodId) {
      throw new BadRequestException('Falta elegir la materia y el período');
    }
    return this.grades.getSheet(request.user, membership, subjectId, periodId);
  }

  @Put('grades')
  @UseGuards(MembershipGuard)
  @Roles('teacher')
  saveGrades(
    @Req() request: AuthedRequest,
    @CurrentMembership() membership: ActiveMembership,
    @Body() body: SaveGradesDto,
  ) {
    return this.grades.saveSheet(request.user, membership, body);
  }
}
