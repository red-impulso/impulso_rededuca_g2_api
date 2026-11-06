import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AuthUser } from '../../auth/auth.guard.js';
import type { Membership as ActiveMembership } from '../../auth/membership.guard.js';
import { SupabaseService } from '../../supabase/supabase.service.js';
import type { SaveGradesDto } from './dto/save-grades.dto.js';

export const GRADES_SAVED_EVENT = 'grades.saved';

export interface GradesSavedPayload {
  schoolId: string;
  subjectId: string;
  periodId: string;
  saved: number;
  updatedBy: string;
}

export interface PeriodSummary {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
}

export interface GradeSheetRow {
  student: { id: string; firstName: string | null; lastName: string | null };
  value: number | null;
}

export interface StudentGradeRow {
  subject: { id: string; name: string };
  period: { id: string; name: string };
  value: number;
}

interface SubjectRow {
  id: string;
  teacher_id: string | null;
  course_id: string;
  courses:
    | { id: string; school_id: string }
    | { id: string; school_id: string }[]
    | null;
}

interface EnrollmentRow {
  student_id: string;
  profiles:
    | { id: string; first_name: string | null; last_name: string | null }
    | { id: string; first_name: string | null; last_name: string | null }[]
    | null;
}

interface GradeRow {
  id: string;
  student_id: string;
  value: number;
}

interface StudentGradeQueryRow {
  value: number;
  subjects:
    { id: string; name: string } | { id: string; name: string }[] | null;
  periods: { id: string; name: string } | { id: string; name: string }[] | null;
}

function firstRow<T>(value: T | T[] | null | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : (value ?? undefined);
}

// Grades run 1-10 with at most two decimals (numeric(4,2)).
function isGradeValue(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 1 &&
    value <= 10 &&
    Math.abs(value * 100 - Math.round(value * 100)) < 1e-9
  );
}

@Injectable()
export class GradesService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly events: EventEmitter2,
  ) {}

  async listPeriods(membership: ActiveMembership): Promise<PeriodSummary[]> {
    const { data, error } = await this.supabase.admin
      .from('periods')
      .select('id, name, start_date, end_date')
      .eq('school_id', membership.institutionId)
      .order('start_date');

    if (error) {
      throw new InternalServerErrorException();
    }

    return (data ?? []).map(
      (row: {
        id: string;
        name: string;
        start_date: string;
        end_date: string;
      }) => ({
        id: row.id,
        name: row.name,
        startDate: row.start_date,
        endDate: row.end_date,
      }),
    );
  }

  async getSheet(
    user: AuthUser,
    membership: ActiveMembership,
    subjectId: string,
    periodId: string,
  ): Promise<GradeSheetRow[]> {
    const subject = await this.loadTeacherSubject(user, membership, subjectId);
    await this.loadPeriod(membership, periodId);

    const { data: enrollments, error: enrollmentsError } =
      await this.supabase.admin
        .from('enrollments')
        .select('student_id, profiles!inner(id, first_name, last_name)')
        .eq('course_id', subject.course_id);

    if (enrollmentsError) {
      throw new InternalServerErrorException();
    }

    const grades = await this.loadGrades(subjectId, periodId);

    return ((enrollments ?? []) as EnrollmentRow[])
      .flatMap((row) => {
        const profile = firstRow(row.profiles);
        return profile
          ? [
              {
                student: {
                  id: row.student_id,
                  firstName: profile.first_name,
                  lastName: profile.last_name,
                },
                value: grades.get(row.student_id)?.value ?? null,
              },
            ]
          : [];
      })
      .sort((a, b) =>
        `${a.student.lastName ?? ''}${a.student.firstName ?? ''}`.localeCompare(
          `${b.student.lastName ?? ''}${b.student.firstName ?? ''}`,
        ),
      );
  }

  async saveSheet(
    user: AuthUser,
    membership: ActiveMembership,
    dto: SaveGradesDto,
  ): Promise<{ saved: number }> {
    if (
      !dto ||
      typeof dto.subjectId !== 'string' ||
      !dto.subjectId ||
      typeof dto.periodId !== 'string' ||
      !dto.periodId ||
      !Array.isArray(dto.entries)
    ) {
      throw new BadRequestException(
        'Body must be { subjectId, periodId, entries: [{ studentId, value }] }',
      );
    }

    const subject = await this.loadTeacherSubject(
      user,
      membership,
      dto.subjectId,
    );
    await this.loadPeriod(membership, dto.periodId);

    // Every entry must target a student enrolled in the subject's course and
    // carry a valid grade. The whole batch is validated before writing, so a
    // single bad entry rejects the request without persisting anything.
    const enrolledIds = await this.loadEnrolledStudentIds(subject.course_id);
    const entries = new Map<string, number | null>();
    for (const entry of dto.entries) {
      if (
        !entry ||
        typeof entry.studentId !== 'string' ||
        !enrolledIds.has(entry.studentId)
      ) {
        throw new BadRequestException(
          'Every entry must reference a student enrolled in the course',
        );
      }
      if (entry.value !== null && !isGradeValue(entry.value)) {
        throw new BadRequestException(
          'Grades must be a number between 1 and 10 with at most 2 decimals',
        );
      }
      entries.set(entry.studentId, entry.value);
    }

    const existing = await this.loadGrades(dto.subjectId, dto.periodId);
    const changed = [...entries].filter(
      ([studentId, value]) =>
        value !== null && Number(existing.get(studentId)?.value) !== value,
    );

    if (changed.length > 0) {
      const { data: upserted, error: upsertError } = await this.supabase.admin
        .from('grades')
        .upsert(
          changed.map(([studentId, value]) => ({
            student_id: studentId,
            subject_id: dto.subjectId,
            period_id: dto.periodId,
            value,
            updated_by: user.id,
          })),
          { onConflict: 'student_id,subject_id,period_id' },
        )
        .select('id, student_id');

      if (upsertError) {
        throw new InternalServerErrorException();
      }

      const gradeIdByStudent = new Map(
        ((upserted ?? []) as { id: string; student_id: string }[]).map(
          (row) => [row.student_id, row.id],
        ),
      );

      const { error: changesError } = await this.supabase.admin
        .from('grade_changes')
        .insert(
          changed.flatMap(([studentId, value]) => {
            const gradeId = gradeIdByStudent.get(studentId);
            return gradeId
              ? [
                  {
                    grade_id: gradeId,
                    previous_value: existing.get(studentId)?.value ?? null,
                    new_value: value,
                    changed_by: user.id,
                  },
                ]
              : [];
          }),
        );

      if (changesError) {
        throw new InternalServerErrorException();
      }

      const payload: GradesSavedPayload = {
        schoolId: membership.institutionId,
        subjectId: dto.subjectId,
        periodId: dto.periodId,
        saved: changed.length,
        updatedBy: user.id,
      };
      this.events.emit(GRADES_SAVED_EVENT, payload);
    }

    return { saved: changed.length };
  }

  // Every grade of a student, scoped to the member's school. Allowed for the
  // student's linked guardians, teachers with a subject in the student's
  // course, and admin/director memberships; anyone else gets 403 and a
  // student from another institution gets 404.
  async getStudentGrades(
    user: AuthUser,
    membership: ActiveMembership,
    studentId: string,
  ): Promise<StudentGradeRow[]> {
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

    const allowed = await this.canViewStudentGrades(
      user,
      membership,
      studentId,
      enrollments.map((row: { course_id: string }) => row.course_id),
    );
    if (!allowed) {
      throw new ForbiddenException();
    }

    const { data, error } = await this.supabase.admin
      .from('grades')
      .select(
        'value, subjects!inner(id, name, courses!inner(school_id)), periods!inner(id, name)',
      )
      .eq('student_id', studentId)
      .eq('subjects.courses.school_id', membership.institutionId);

    if (error) {
      throw new InternalServerErrorException();
    }

    return ((data ?? []) as StudentGradeQueryRow[])
      .flatMap((row) => {
        const subject = firstRow(row.subjects);
        const period = firstRow(row.periods);
        return subject && period
          ? [
              {
                subject: { id: subject.id, name: subject.name },
                period: { id: period.id, name: period.name },
                value: row.value,
              },
            ]
          : [];
      })
      .sort(
        (a, b) =>
          a.subject.name.localeCompare(b.subject.name) ||
          a.period.name.localeCompare(b.period.name),
      );
  }

  private async canViewStudentGrades(
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

  // Loads the subject scoped to the member's school. 404 when the subject is
  // missing or belongs to another school, 403 when it is taught by someone
  // else.
  private async loadTeacherSubject(
    user: AuthUser,
    membership: ActiveMembership,
    subjectId: string,
  ): Promise<{ id: string; course_id: string }> {
    const { data, error } = await this.supabase.admin
      .from('subjects')
      .select('id, teacher_id, course_id, courses!inner(id, school_id)')
      .eq('id', subjectId)
      .eq('courses.school_id', membership.institutionId)
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException();
    }

    const subject = firstRow(data as SubjectRow | SubjectRow[] | null);
    if (!subject) {
      throw new NotFoundException('Subject not found');
    }
    if (subject.teacher_id !== user.id) {
      throw new ForbiddenException('You do not teach this subject');
    }
    return { id: subject.id, course_id: subject.course_id };
  }

  private async loadPeriod(
    membership: ActiveMembership,
    periodId: string,
  ): Promise<void> {
    const { data, error } = await this.supabase.admin
      .from('periods')
      .select('id')
      .eq('id', periodId)
      .eq('school_id', membership.institutionId)
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException();
    }
    if (!data) {
      throw new NotFoundException('Period not found');
    }
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

  private async loadGrades(
    subjectId: string,
    periodId: string,
  ): Promise<Map<string, { id: string; value: number }>> {
    const { data, error } = await this.supabase.admin
      .from('grades')
      .select('id, student_id, value')
      .eq('subject_id', subjectId)
      .eq('period_id', periodId);

    if (error) {
      throw new InternalServerErrorException();
    }
    return new Map(
      ((data ?? []) as GradeRow[]).map((row) => [
        row.student_id,
        { id: row.id, value: row.value },
      ]),
    );
  }
}
