import { Injectable, InternalServerErrorException } from '@nestjs/common';
import type { AuthUser } from '../../auth/auth.guard.js';
import type { Membership as ActiveMembership } from '../../auth/membership.guard.js';
import { fetchAllRows } from '../../supabase/fetch-all-rows.js';
import { SupabaseService } from '../../supabase/supabase.service.js';

// Early-warning rules (alertas tempranas). A student is at risk when:
// - their attendance is below 75 % with at least 3 countable days, or
// - a subject's average (over every period) is below 6.
export const ATTENDANCE_RISK_THRESHOLD = 75;
export const MIN_ATTENDANCE_RECORDS = 3;
export const GRADE_RISK_THRESHOLD = 6;

export type RiskReason =
  | { type: 'attendance'; percentage: number }
  | {
      type: 'grade';
      subject: { id: string; name: string };
      average: number;
    };

export interface AtRiskStudent {
  student: { id: string; firstName: string | null; lastName: string | null };
  course: { id: string; year: number; division: string };
  reasons: RiskReason[];
}

interface EnrollmentRow {
  student_id: string;
  course_id: string;
  profiles: Profile | Profile[] | null;
  courses: CourseRow | CourseRow[] | null;
}

interface Profile {
  first_name: string | null;
  last_name: string | null;
  status?: string;
}

interface CourseRow {
  id: string;
  year: number;
  division: string;
}

interface GradeRow {
  student_id: string;
  value: number | string;
  subjects:
    { id: string; name: string } | { id: string; name: string }[] | null;
}

function firstRow<T>(value: T | T[] | null | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : (value ?? undefined);
}

function oneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

function withComma(value: number): string {
  return String(value).replace('.', ',');
}

export function reasonsText(reasons: RiskReason[]): string {
  return reasons
    .map((reason) =>
      reason.type === 'attendance'
        ? `Asistencia ${withComma(reason.percentage)} %`
        : `${reason.subject.name}: promedio ${withComma(reason.average)}`,
    )
    .join(' · ');
}

function fullName(student: AtRiskStudent['student']): string {
  return (
    [student.firstName, student.lastName].filter(Boolean).join(' ') ||
    'El alumno'
  );
}

@Injectable()
export class AlertsService {
  constructor(private readonly supabase: SupabaseService) {}

  // GET /alerts: admin/director see the whole school, a teacher only the
  // courses where they have a subject.
  async list(
    user: AuthUser,
    membership: ActiveMembership,
  ): Promise<AtRiskStudent[]> {
    let courseIds: Set<string> | null = null;
    if (membership.role === 'teacher') {
      const { data, error } = await this.supabase.admin
        .from('subjects')
        .select('course_id, courses!inner(school_id)')
        .eq('teacher_id', user.id)
        .eq('courses.school_id', membership.institutionId);
      if (error) {
        throw new InternalServerErrorException();
      }
      courseIds = new Set(
        ((data ?? []) as { course_id: string }[]).map((row) => row.course_id),
      );
      if (courseIds.size === 0) {
        return [];
      }
    }

    const atRisk = await this.evaluate(membership.institutionId);
    return courseIds
      ? atRisk.filter((row) => courseIds.has(row.course.id))
      : atRisk;
  }

  // After attendance or grades are saved: warn guardians and the school's
  // admins/directors the first time a student becomes at risk, and forget the
  // alert once they are fine again (so a later relapse warns again).
  async syncAlerts(schoolId: string, studentIds: string[]): Promise<void> {
    const ids = [...new Set(studentIds)];
    if (ids.length === 0) {
      return;
    }

    const atRisk = await this.evaluate(schoolId, ids);

    const { data: existing, error: existingError } = await this.supabase.admin
      .from('risk_alerts')
      .select('student_id')
      .eq('school_id', schoolId)
      .in('student_id', ids);
    if (existingError) {
      throw new InternalServerErrorException();
    }
    const alreadyFlagged = new Set(
      ((existing ?? []) as { student_id: string }[]).map(
        (row) => row.student_id,
      ),
    );
    const atRiskIds = new Set(atRisk.map((row) => row.student.id));

    const resolved = [...alreadyFlagged].filter((id) => !atRiskIds.has(id));
    if (resolved.length > 0) {
      const { error } = await this.supabase.admin
        .from('risk_alerts')
        .delete()
        .eq('school_id', schoolId)
        .in('student_id', resolved);
      if (error) {
        throw new InternalServerErrorException();
      }
    }

    const fresh = atRisk.filter((row) => !alreadyFlagged.has(row.student.id));
    if (fresh.length === 0) {
      return;
    }

    const { error: insertError } = await this.supabase.admin
      .from('risk_alerts')
      .insert(
        fresh.map((row) => ({
          school_id: schoolId,
          student_id: row.student.id,
        })),
      );
    if (insertError) {
      throw new InternalServerErrorException();
    }

    const [links, staff] = await Promise.all([
      this.supabase.admin
        .from('guardian_links')
        .select('guardian_id, student_id')
        .in(
          'student_id',
          fresh.map((row) => row.student.id),
        ),
      this.supabase.admin
        .from('memberships')
        .select('user_id')
        .eq('school_id', schoolId)
        .in('role', ['admin', 'director']),
    ]);
    if (links.error || staff.error) {
      throw new InternalServerErrorException();
    }

    const rows: {
      school_id: string;
      user_id: string;
      type: 'risk';
      title: string;
      body: string;
    }[] = [];
    for (const row of fresh) {
      const name = fullName(row.student);
      const body = reasonsText(row.reasons);
      for (const link of (links.data ?? []) as {
        guardian_id: string;
        student_id: string;
      }[]) {
        if (link.student_id === row.student.id) {
          rows.push({
            school_id: schoolId,
            user_id: link.guardian_id,
            type: 'risk',
            title: `Alerta: ${name} necesita acompañamiento`,
            body,
          });
        }
      }
      for (const member of (staff.data ?? []) as { user_id: string }[]) {
        rows.push({
          school_id: schoolId,
          user_id: member.user_id,
          type: 'risk',
          title: `Alumno en riesgo: ${name} (${row.course.year}°${row.course.division})`,
          body,
        });
      }
    }

    if (rows.length > 0) {
      const { error } = await this.supabase.admin
        .from('notifications')
        .insert(rows);
      if (error) {
        throw new InternalServerErrorException();
      }
    }
  }

  // Applies the rules to every active student of the school (or only to
  // `studentIds`). Most worrying first: more reasons, then by last name.
  async evaluate(
    schoolId: string,
    studentIds?: string[],
  ): Promise<AtRiskStudent[]> {
    const only = studentIds ? new Set(studentIds) : null;
    // Whole school (GET /alerts) or only some students (after a save).
    const readAll = (
      table: string,
      columns: string,
      schoolColumn: string,
      orderBy: string[],
    ) =>
      fetchAllRows((from, to) => {
        let query = this.supabase.admin
          .from(table)
          .select(columns)
          .eq(schoolColumn, schoolId);
        if (studentIds) {
          query = query.in('student_id', studentIds);
        }
        for (const column of orderBy) {
          query = query.order(column);
        }
        return query.range(from, to);
      });

    const [enrollments, attendance, grades] = await Promise.all([
      readAll(
        'enrollments',
        'student_id, course_id, profiles!inner(first_name, last_name, status), courses!inner(id, year, division, school_id)',
        'courses.school_id',
        ['student_id', 'course_id'],
      ),
      readAll(
        'attendance_records',
        'student_id, status, courses!inner(school_id)',
        'courses.school_id',
        ['id'],
      ),
      readAll(
        'grades',
        'student_id, value, subjects!inner(id, name, courses!inner(school_id))',
        'subjects.courses.school_id',
        ['id'],
      ),
    ]);
    for (const result of [enrollments, attendance, grades]) {
      if (result.error) {
        throw new InternalServerErrorException();
      }
    }

    const counts = new Map<string, { attended: number; absent: number }>();
    for (const row of attendance.data as {
      student_id: string;
      status: string;
    }[]) {
      const count = counts.get(row.student_id) ?? { attended: 0, absent: 0 };
      if (row.status === 'present' || row.status === 'late') {
        count.attended += 1;
      } else if (row.status === 'absent') {
        count.absent += 1;
      }
      counts.set(row.student_id, count);
    }

    const subjectValues = new Map<
      string,
      Map<string, { name: string; values: number[] }>
    >();
    for (const row of grades.data as GradeRow[]) {
      const subject = firstRow(row.subjects);
      if (!subject) continue;
      const bySubject = subjectValues.get(row.student_id) ?? new Map();
      const entry = bySubject.get(subject.id) ?? {
        name: subject.name,
        values: [],
      };
      entry.values.push(Number(row.value));
      bySubject.set(subject.id, entry);
      subjectValues.set(row.student_id, bySubject);
    }

    const result: AtRiskStudent[] = [];
    const seen = new Set<string>();
    for (const row of enrollments.data as EnrollmentRow[]) {
      const profile = firstRow(row.profiles);
      const course = firstRow(row.courses);
      if (
        !profile ||
        !course ||
        profile.status === 'inactive' ||
        seen.has(row.student_id) ||
        (only && !only.has(row.student_id))
      ) {
        continue;
      }
      seen.add(row.student_id);

      const reasons: RiskReason[] = [];
      const count = counts.get(row.student_id);
      const countable = count ? count.attended + count.absent : 0;
      if (count && countable >= MIN_ATTENDANCE_RECORDS) {
        const percentage = oneDecimal((count.attended / countable) * 100);
        if (percentage < ATTENDANCE_RISK_THRESHOLD) {
          reasons.push({ type: 'attendance', percentage });
        }
      }
      for (const [subjectId, entry] of subjectValues.get(row.student_id) ??
        []) {
        const average =
          Math.round(
            (entry.values.reduce((sum, value) => sum + value, 0) /
              entry.values.length) *
              100,
          ) / 100;
        if (average < GRADE_RISK_THRESHOLD) {
          reasons.push({
            type: 'grade',
            subject: { id: subjectId, name: entry.name },
            average,
          });
        }
      }

      if (reasons.length > 0) {
        result.push({
          student: {
            id: row.student_id,
            firstName: profile.first_name,
            lastName: profile.last_name,
          },
          course: {
            id: course.id,
            year: course.year,
            division: course.division,
          },
          reasons,
        });
      }
    }

    return result.sort(
      (a, b) =>
        b.reasons.length - a.reasons.length ||
        `${a.student.lastName ?? ''}${a.student.firstName ?? ''}`.localeCompare(
          `${b.student.lastName ?? ''}${b.student.firstName ?? ''}`,
        ),
    );
  }
}
