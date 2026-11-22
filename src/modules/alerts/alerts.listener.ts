import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  ATTENDANCE_SAVED_EVENT,
  type AttendanceSavedPayload,
} from '../attendance/attendance.service.js';
import {
  GRADES_SAVED_EVENT,
  type GradesSavedPayload,
} from '../grades/grades.service.js';
import { AlertsService } from './alerts.service.js';

// Re-checks the risk of the students touched by a save. Fire-and-forget: a
// failure must not break the request that saved, so it logs and swallows.
@Injectable()
export class AlertsListener {
  private readonly logger = new Logger(AlertsListener.name);

  constructor(private readonly alerts: AlertsService) {}

  @OnEvent(ATTENDANCE_SAVED_EVENT)
  async onAttendanceSaved(payload: AttendanceSavedPayload): Promise<void> {
    try {
      await this.alerts.syncAlerts(payload.schoolId, payload.absent ?? []);
    } catch (error) {
      this.logger.error('Failed to update risk alerts (attendance)', error);
    }
  }

  @OnEvent(GRADES_SAVED_EVENT)
  async onGradesSaved(payload: GradesSavedPayload): Promise<void> {
    try {
      await this.alerts.syncAlerts(payload.schoolId, payload.students ?? []);
    } catch (error) {
      this.logger.error('Failed to update risk alerts (grades)', error);
    }
  }
}
