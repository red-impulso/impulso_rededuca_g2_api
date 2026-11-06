import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { AuthUser } from '../../auth/auth.guard.js';
import type { Membership as ActiveMembership } from '../../auth/membership.guard.js';
import { SupabaseService } from '../../supabase/supabase.service.js';
import type {
  AttendanceStatus,
  SaveAttendanceDto,
} from './dto/save-attendance.dto.js';

export const ATTENDANCE_SAVED_EVENT = 'attendance.saved';

const ATTENDANCE_STATUSES: AttendanceStatus[] = [
  'present',
  'absent',
  'late',
  'justified',
];

export interface AttendanceSavedPayload {
  schoolId: string;
  courseId: string;
  date: string;
  recordedBy: string;
  absent: string[];
}

export interface AttendanceSheetRow {
  student: { id: string; firstName: string | null; lastName: string | null };
  status: AttendanceStatus | null;
}

export interface StudentAttendanceSummary {
  present: number;
  absent: number;
  late: number;
  justified: number;
  percentage: number | null;
}

export interface StudentAttendanceResponse {
  records: { date: string; status: AttendanceStatus }[];
  summary: StudentAttendanceSummary;
}

interface EnrollmentRow {
  student_id: string;
  profiles:
    | { id: string; first_name: string | null; last_name: string | null }
    | { id: string; first_name: string | null; last_name: string | null }[]
    | null;
}

function firstRow<T>(value: T | T[] | null | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : (value ?? undefined);
}

function todayString(): string {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

// A strict YYYY-MM-DD that is a real calendar date and not in the future.
function isValidAttendanceDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return false;
  }
  const parsed = new Date(`${date}T00:00:00Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== date
  ) {
    return false;
  }
  return date <= todayString();
}

@Injectable()
export class AttendanceService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly events: EventEmitter2,
  ) {}

  async getSheet(
    user: AuthUser,
    membership: ActiveMembership,
    courseId: string,
    date: string,
  ): Promise<AttendanceSheetRow[]> {
    if (!isValidAttendanceDate(date)) {
      throw new BadRequestException(
        'date must be a valid YYYY-MM-DD, not in the future',
      );
    }
    await this.loadCourseForTaker(user, membership, courseId);
    const records = await this.loadRecords(courseId, date);
    const students = await this.loadCourseStudents(courseId);

    return students
      .map((student) => ({
        student,
        status: records.get(student.id) ?? null,
      }))
      .sort((a, b) =>
        `${a.student.lastName ?? ''}${a.student.firstName ?? ''}`.localeCompare(
          `${b.student.lastName ?? ''}${b.student.firstName ?? ''}`,
        ),
      );
  }

  async saveSheet(
    user: AuthUser,
    membership: ActiveMembership,
    dto: SaveAttendanceDto,
  ): Promise<{ saved: number }> {
    if (
      !dto ||
      typeof dto.courseId !== 'string' ||
      !dto.courseId ||
      typeof dto.date !== 'string' ||
      !Array.isArray(dto.entries)
    ) {
      throw new BadRequestException(
        'Body must be { courseId, date, entries: [{ studentId, status }] }',
      );
    }
    if (!isValidAttendanceDate(dto.date)) {
      throw new BadRequestException(
        'date must be a valid YYYY-MM-DD, not in the future',
      );
    }

    const courseId = await this.loadCourseForTaker(
      user,
      membership,
      dto.courseId,
    );

    const enrolledIds = await this.loadEnrolledStudentIds(courseId);
    const entries = new Map<string, AttendanceStatus>();
    for (const entry of dto.entries) {
      if (
        !entry ||
        typeof entry.studentId !== 'string' ||
        !enrolledIds.has(entry.studentId) ||
        !ATTENDANCE_STATUSES.includes(entry.status)
      ) {
        throw new BadRequestException(
          'Every entry needs a student enrolled in the course and a status of present, absent, late or justified',
        );
      }
      entries.set(entry.studentId, entry.status);
    }

    if (entries.size > 0) {
      const { error } = await this.supabase.admin
        .from('attendance_records')
        .upsert(
          [...entries].map(([studentId, status]) => ({
            student_id: studentId,
            course_id: courseId,
            date: dto.date,
            status,
            recorded_by: user.id,
          })),
          { onConflict: 'student_id,date' },
        );

      if (error) {
        throw new InternalServerErrorException();
      }

      const payload: AttendanceSavedPayload = {
        schoolId: membership.institutionId,
        courseId,
        date: dto.date,
        recordedBy: user.id,
        absent: [...entries]
          .filter(([, status]) => status === 'absent')
          .map(([studentId]) => studentId),
      };
      this.events.emit(ATTENDANCE_SAVED_EVENT, payload);
    }

    return { saved: entries.size };
  }

  // Every attendance record of a student, scoped to the member's school.
  // Allowed for linked guardians, teachers with a subject in the student's
  // course and admin/director memberships.
  async getStudentAttendance(
    user: AuthUser,
    membership: ActiveMembership,
    studentId: string,
  ): Promise<StudentAttendanceResponse> {
    const { data: enrollments, error: enrollmentsError } =
      await this.supabase.admin
        .from('enrollments')
        .select('course_id, courses!inner(school_id)')
        .eq('student_id', studentId)
        .eq('courses.school_id', membership.institutionId);

    if (enrollmentsError) {
      throw new InternalServerErrorException();
    }
    if (!enrollments?.length) {
      throw new NotFoundException('Student not found');
    }

    const allowed = await this.canViewStudentAttendance(
      user,
      membership,
      studentId,
      enrollments.map((row: { course_id: string }) => row.course_id),
    );
    if (!allowed) {
      throw new ForbiddenException();
    }

    const { data, error } = await this.supabase.admin
      .from('attendance_records')
      .select('date, status, courses!inner(school_id)')
      .eq('student_id', studentId)
      .eq('courses.school_id', membership.institutionId)
      .order('date', { ascending: false });

    if (error) {
      throw new InternalServerErrorException();
    }

    const records = (
      (data ?? []) as { date: string; status: AttendanceStatus }[]
    ).map((row) => ({ date: row.date, status: row.status }));

    const summary: StudentAttendanceSummary = {
      present: 0,
      absent: 0,
      late: 0,
      justified: 0,
      percentage: null,
    };
    for (const record of records) {
      summary[record.status] += 1;
    }
    // (present + late) / (present + late + absent) — justified doesn't count.
    const attended = summary.present + summary.late;
    const countable = attended + summary.absent;
    if (countable > 0) {
      summary.percentage = Math.round((attended / countable) * 1000) / 10;
    }

    return { records, summary };
  }

  // Loads the course scoped to the school and checks the caller can take the
  // list: admin/director always, a teacher only with a subject in the course.
  private async loadCourseForTaker(
    user: AuthUser,
    membership: ActiveMembership,
    courseId: string,
  ): Promise<string> {
    const { data, error } = await this.supabase.admin
      .from('courses')
      .select('id')
      .eq('id', courseId)
      .eq('school_id', membership.institutionId)
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException();
    }
    if (!data) {
      throw new NotFoundException('Course not found');
    }

    if (membership.role === 'admin' || membership.role === 'director') {
      return courseId;
    }

    const { data: subjects, error: subjectsError } = await this.supabase.admin
      .from('subjects')
      .select('id')
      .eq('course_id', courseId)
      .eq('teacher_id', user.id)
      .maybeSingle();

    if (subjectsError) {
      throw new InternalServerErrorException();
    }
    if (!subjects) {
      throw new ForbiddenException('You do not teach in this course');
    }
    return courseId;
  }

  private async canViewStudentAttendance(
    user: AuthUser,
    membership: ActiveMembership,
    studentId: string,
    courseIds: string[],
  ): Promise<boolean> {
    if (membership.role === 'admin' || membership.role === 'director') {
      return true;
    }
    if (membership.role === 'guardian') {
      const { data, error } = await this.supabase.admin
        .from('guardian_links')
        .select('student_id')
        .eq('guardian_id', user.id)
        .eq('student_id', studentId)
        .maybeSingle();
      if (error) {
        throw new InternalServerErrorException();
      }
      return !!data;
    }
    if (membership.role === 'teacher') {
      const { data, error } = await this.supabase.admin
        .from('subjects')
        .select('id')
        .eq('teacher_id', user.id)
        .in('course_id', courseIds);
      if (error) {
        throw new InternalServerErrorException();
      }
      return (data?.length ?? 0) > 0;
    }
    return false;
  }

  private async loadCourseStudents(courseId: string) {
    const { data, error } = await this.supabase.admin
      .from('enrollments')
      .select('student_id, profiles!inner(id, first_name, last_name)')
      .eq('course_id', courseId);

    if (error) {
      throw new InternalServerErrorException();
    }
    return ((data ?? []) as EnrollmentRow[]).flatMap((row) => {
      const profile = firstRow(row.profiles);
      return profile
        ? [
            {
              id: row.student_id,
              firstName: profile.first_name,
              lastName: profile.last_name,
            },
          ]
        : [];
    });
  }

  private async loadEnrolledStudentIds(courseId: string): Promise<Set<string>> {
    const { data, error } = await this.supabase.admin
      .from('enrollments')
      .select('student_id')
      .eq('course_id', courseId);

    if (error) {
      throw new InternalServerErrorException();
    }
    return new Set(
      (data ?? []).map((row: { student_id: string }) => row.student_id),
    );
  }

  private async loadRecords(
    courseId: string,
    date: string,
  ): Promise<Map<string, AttendanceStatus>> {
    const { data, error } = await this.supabase.admin
      .from('attendance_records')
      .select('student_id, status')
      .eq('course_id', courseId)
      .eq('date', date);

    if (error) {
      throw new InternalServerErrorException();
    }
    return new Map(
      ((data ?? []) as { student_id: string; status: AttendanceStatus }[]).map(
        (row) => [row.student_id, row.status],
      ),
    );
  }
}
