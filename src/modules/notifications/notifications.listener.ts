import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  ANNOUNCEMENT_CREATED_EVENT,
  type AnnouncementCreatedPayload,
} from '../announcements/announcements.service.js';
import {
  ATTENDANCE_SAVED_EVENT,
  type AttendanceSavedPayload,
} from '../attendance/attendance.service.js';
import {
  GRADES_SAVED_EVENT,
  type GradesSavedPayload,
} from '../grades/grades.service.js';
import { NotificationsService } from './notifications.service.js';

// Event listeners run fire-and-forget: a failure must not break the request
// that emitted the event, so each handler logs and swallows errors.
@Injectable()
export class NotificationsListener {
  private readonly logger = new Logger(NotificationsListener.name);

  constructor(private readonly notifications: NotificationsService) {}

  @OnEvent(GRADES_SAVED_EVENT)
  async onGradesSaved(payload: GradesSavedPayload): Promise<void> {
    try {
      await this.notifications.notifyGradesSaved(payload);
    } catch (error) {
      this.logger.error('Failed to create grade notifications', error);
    }
  }

  @OnEvent(ATTENDANCE_SAVED_EVENT)
  async onAttendanceSaved(payload: AttendanceSavedPayload): Promise<void> {
    try {
      await this.notifications.notifyAttendanceSaved(payload);
    } catch (error) {
      this.logger.error('Failed to create attendance notifications', error);
    }
  }

  @OnEvent(ANNOUNCEMENT_CREATED_EVENT)
  async onAnnouncementCreated(
    payload: AnnouncementCreatedPayload,
  ): Promise<void> {
    try {
      await this.notifications.notifyAnnouncementCreated(payload);
    } catch (error) {
      this.logger.error('Failed to create announcement notifications', error);
    }
  }
}
