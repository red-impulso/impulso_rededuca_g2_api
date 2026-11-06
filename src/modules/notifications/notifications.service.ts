import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser } from '../../auth/auth.guard.js';
import type { Membership as ActiveMembership } from '../../auth/membership.guard.js';
import { SupabaseService } from '../../supabase/supabase.service.js';
import type { AnnouncementCreatedPayload } from '../announcements/announcements.service.js';
import type { AttendanceSavedPayload } from '../attendance/attendance.service.js';
import type { GradesSavedPayload } from '../grades/grades.service.js';

export type NotificationType = 'grade' | 'attendance' | 'announcement';

export interface NotificationView {
  id: string;
  type: NotificationType;
  title: string;
  body: string | null;
  readAt: string | null;
  createdAt: string;
}

interface NotificationRow {
  id: string;
  type: NotificationType;
  title: string;
  body: string | null;
  read_at: string | null;
  created_at: string;
}

interface NewNotification {
  school_id: string;
  user_id: string;
  type: NotificationType;
  title: string;
}

const INBOX_LIMIT = 50;

// "2026-11-06" -> "06/11/2026": the title is read as is by the guardians.
function displayDate(date: string): string {
  const [year, month, day] = date.split('-');
  return `${day}/${month}/${year}`;
}

function toView(row: NotificationRow): NotificationView {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

@Injectable()
export class NotificationsService {
  constructor(private readonly supabase: SupabaseService) {}

  async list(
    user: AuthUser,
    membership: ActiveMembership,
  ): Promise<NotificationView[]> {
    const { data, error } = await this.supabase.admin
      .from('notifications')
      .select('id, type, title, body, read_at, created_at')
      .eq('user_id', user.id)
      .eq('school_id', membership.institutionId)
      .order('created_at', { ascending: false })
      .limit(INBOX_LIMIT);

    if (error) {
      throw new InternalServerErrorException();
    }
    return ((data ?? []) as NotificationRow[]).map(toView);
  }

  async unreadCount(
    user: AuthUser,
    membership: ActiveMembership,
  ): Promise<{ count: number }> {
    const { data, error } = await this.supabase.admin
      .from('notifications')
      .select('id')
      .eq('user_id', user.id)
      .eq('school_id', membership.institutionId)
      .is('read_at', null);

    if (error) {
      throw new InternalServerErrorException();
    }
    return { count: data?.length ?? 0 };
  }

  async markRead(
    user: AuthUser,
    membership: ActiveMembership,
    notificationId: string,
  ): Promise<NotificationView> {
    const { data, error } = await this.supabase.admin
      .from('notifications')
      .select('id, type, title, body, read_at, created_at')
      .eq('id', notificationId)
      .eq('user_id', user.id)
      .eq('school_id', membership.institutionId)
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException();
    }
    if (!data) {
      throw new NotFoundException('No se encontró la notificación');
    }

    const row = data as NotificationRow;
    if (row.read_at) {
      return toView(row);
    }

    const { data: updated, error: updateError } = await this.supabase.admin
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('id', notificationId)
      .select('id, type, title, body, read_at, created_at')
      .single();

    if (updateError || !updated) {
      throw new InternalServerErrorException();
    }
    return toView(updated as NotificationRow);
  }

  async markAllRead(
    user: AuthUser,
    membership: ActiveMembership,
  ): Promise<{ read: number }> {
    const { data, error } = await this.supabase.admin
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('user_id', user.id)
      .eq('school_id', membership.institutionId)
      .is('read_at', null)
      .select('id');

    if (error) {
      throw new InternalServerErrorException();
    }
    return { read: data?.length ?? 0 };
  }

  // ---- Event-driven creation (called by NotificationsListener) ----

  // One "Nueva nota en {materia}" notification per guardian of the students
  // whose grades changed.
  async notifyGradesSaved(payload: GradesSavedPayload): Promise<void> {
    if (!payload.students?.length) {
      return;
    }
    const { data: subject, error: subjectError } = await this.supabase.admin
      .from('subjects')
      .select('name')
      .eq('id', payload.subjectId)
      .maybeSingle();
    if (subjectError) {
      throw new InternalServerErrorException();
    }

    const guardianIds = await this.guardiansOfStudents(payload.students);
    await this.insertMany(
      [...guardianIds].map((userId) => ({
        school_id: payload.schoolId,
        user_id: userId,
        type: 'grade',
        title: `Nueva nota en ${subject?.name ?? 'la materia'}`,
      })),
    );
  }

  // "{alumno} estuvo ausente el {fecha}" per guardian per absent student.
  async notifyAttendanceSaved(payload: AttendanceSavedPayload): Promise<void> {
    if (!payload.absent?.length) {
      return;
    }
    const { data: profiles, error: profilesError } = await this.supabase.admin
      .from('profiles')
      .select('id, first_name, last_name')
      .in('id', payload.absent);
    if (profilesError) {
      throw new InternalServerErrorException();
    }
    const nameOf = new Map(
      (
        (profiles ?? []) as {
          id: string;
          first_name: string | null;
          last_name: string | null;
        }[]
      ).map((p) => [
        p.id,
        [p.first_name, p.last_name].filter(Boolean).join(' ') || 'El alumno',
      ]),
    );

    const { data: links, error: linksError } = await this.supabase.admin
      .from('guardian_links')
      .select('guardian_id, student_id')
      .in('student_id', payload.absent);
    if (linksError) {
      throw new InternalServerErrorException();
    }

    await this.insertMany(
      ((links ?? []) as { guardian_id: string; student_id: string }[]).map(
        (link) => ({
          school_id: payload.schoolId,
          user_id: link.guardian_id,
          type: 'attendance',
          title: `${nameOf.get(link.student_id) ?? 'El alumno'} estuvo ausente el ${displayDate(payload.date)}`,
        }),
      ),
    );
  }

  // "Nuevo comunicado: {título}" per guardian affected by the announcement's
  // scope: every guardian in the school, of the course's students, or of the
  // targeted student.
  async notifyAnnouncementCreated(
    payload: AnnouncementCreatedPayload,
  ): Promise<void> {
    let guardianIds: Set<string>;
    if (payload.scope === 'institution') {
      const { data, error } = await this.supabase.admin
        .from('memberships')
        .select('user_id')
        .eq('school_id', payload.schoolId)
        .eq('role', 'guardian');
      if (error) {
        throw new InternalServerErrorException();
      }
      guardianIds = new Set(
        (data ?? []).map((row: { user_id: string }) => row.user_id),
      );
    } else if (payload.scope === 'course' && payload.courseId) {
      const { data: enrollments, error } = await this.supabase.admin
        .from('enrollments')
        .select('student_id')
        .eq('course_id', payload.courseId);
      if (error) {
        throw new InternalServerErrorException();
      }
      guardianIds = await this.guardiansOfStudents(
        (enrollments ?? []).map(
          (row: { student_id: string }) => row.student_id,
        ),
      );
    } else if (payload.scope === 'student' && payload.studentId) {
      guardianIds = await this.guardiansOfStudents([payload.studentId]);
    } else {
      return;
    }

    await this.insertMany(
      [...guardianIds].map((userId) => ({
        school_id: payload.schoolId,
        user_id: userId,
        type: 'announcement',
        title: `Nuevo comunicado: ${payload.title}`,
      })),
    );
  }

  private async guardiansOfStudents(
    studentIds: string[],
  ): Promise<Set<string>> {
    const { data, error } = await this.supabase.admin
      .from('guardian_links')
      .select('guardian_id')
      .in('student_id', studentIds);
    if (error) {
      throw new InternalServerErrorException();
    }
    return new Set(
      (data ?? []).map((row: { guardian_id: string }) => row.guardian_id),
    );
  }

  private async insertMany(rows: NewNotification[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    const { error } = await this.supabase.admin
      .from('notifications')
      .insert(rows);
    if (error) {
      throw new InternalServerErrorException();
    }
  }
}
