import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
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
import { AttendanceService } from './attendance.service.js';
import type { SaveAttendanceDto } from './dto/save-attendance.dto.js';

@Controller()
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @Get('attendance')
  @UseGuards(MembershipGuard)
  @Roles('teacher', 'admin', 'director')
  getAttendance(
    @Req() request: AuthedRequest,
    @CurrentMembership() membership: ActiveMembership,
    @Query('courseId') courseId?: string,
    @Query('date') date?: string,
  ) {
    if (!courseId || !date) {
      throw new BadRequestException(
        'courseId and date query params are required',
      );
    }
    return this.attendance.getSheet(request.user, membership, courseId, date);
  }

  @Put('attendance')
  @UseGuards(MembershipGuard)
  @Roles('teacher', 'admin', 'director')
  saveAttendance(
    @Req() request: AuthedRequest,
    @CurrentMembership() membership: ActiveMembership,
    @Body() body: SaveAttendanceDto,
  ) {
    return this.attendance.saveSheet(request.user, membership, body);
  }

  @Get('students/:studentId/attendance')
  @UseGuards(MembershipGuard)
  getStudentAttendance(
    @Req() request: AuthedRequest,
    @CurrentMembership() membership: ActiveMembership,
    @Param('studentId') studentId: string,
  ) {
    return this.attendance.getStudentAttendance(
      request.user,
      membership,
      studentId,
    );
  }
}
