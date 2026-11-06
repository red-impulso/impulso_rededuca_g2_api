import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import type { Membership as ActiveMembership } from '../../auth/membership.guard.js';
import { SupabaseService } from '../../supabase/supabase.service.js';
import type { AssignTeacherDto } from './dto/assign-teacher.dto.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CourseSummary {
  id: string;
  year: number;
  division: string;
  shift: string;
}

export interface TeacherSubjectSummary {
  id: string;
  name: string;
  course: CourseSummary;
}

export interface TeacherResponse {
  id: string;
  fullName: string | null;
  subjects: TeacherSubjectSummary[];
}

export interface AssignedSubjectResponse {
  id: string;
  name: string;
  courseId: string;
  teacherMembershipId: string | null;
}

interface MembershipRow {
  id: string;
  user_id: string;
  profiles:
    | { full_name: string | null }
    | { full_name: string | null }[]
    | null;
}

interface SubjectRow {
  id: string;
  name: string;
  teacher_id: string | null;
  courses: CourseSummary | CourseSummary[] | null;
}

function firstRow<T>(value: T | T[] | null | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : (value ?? undefined);
}

@Injectable()
export class TeachersService {
  constructor(private readonly supabase: SupabaseService) {}

  async listTeachers(
    membership: ActiveMembership,
  ): Promise<TeacherResponse[]> {
    const { data, error } = await this.supabase.admin
      .from('memberships')
      .select('id, user_id, profiles(full_name)')
      .eq('school_id', membership.institutionId)
      .eq('role', 'teacher');

    if (error) {
      throw new InternalServerErrorException();
    }

    const rows = (data ?? []) as MembershipRow[];
    if (rows.length === 0) {
      return [];
    }

    const { data: subjects, error: subjectsError } =
      await this.supabase.admin
        .from('subjects')
        .select(
          'id, name, teacher_id, courses!inner(id, year, division, shift)',
        )
        .eq('courses.school_id', membership.institutionId)
        .in(
          'teacher_id',
          rows.map((row) => row.user_id),
        );

    if (subjectsError) {
      throw new InternalServerErrorException();
    }

    const subjectsByTeacher = new Map<string, TeacherSubjectSummary[]>();
    for (const row of (subjects ?? []) as SubjectRow[]) {
      const course = firstRow(row.courses);
      if (!row.teacher_id || !course) {
        continue;
      }
      const list = subjectsByTeacher.get(row.teacher_id) ?? [];
      list.push({
        id: row.id,
        name: row.name,
        course: {
          id: course.id,
          year: course.year,
          division: course.division,
          shift: course.shift,
        },
      });
      subjectsByTeacher.set(row.teacher_id, list);
    }

    return rows
      .map((row) => ({
        id: row.id,
        fullName: firstRow(row.profiles)?.full_name ?? null,
        subjects: subjectsByTeacher.get(row.user_id) ?? [],
      }))
      .sort((a, b) =>
        (a.fullName ?? '').localeCompare(b.fullName ?? '', 'es'),
      );
  }

  async assignTeacher(
    membership: ActiveMembership,
    subjectId: string,
    dto: AssignTeacherDto | undefined,
  ): Promise<AssignedSubjectResponse> {
    if (!dto || !('teacherMembershipId' in dto)) {
      throw new BadRequestException('Falta indicar el docente');
    }
    await this.loadSubject(membership, subjectId);
    const teacherId = await this.resolveTeacher(
      membership,
      dto.teacherMembershipId,
    );

    const { data, error } = await this.supabase.admin
      .from('subjects')
      .update({ teacher_id: teacherId })
      .eq('id', subjectId)
      .select('id, name, course_id, teacher_id')
      .single();

    if (error || !data) {
      throw new InternalServerErrorException();
    }

    const row = data as {
      id: string;
      name: string;
      course_id: string;
      teacher_id: string | null;
    };
    return {
      id: row.id,
      name: row.name,
      courseId: row.course_id,
      teacherMembershipId: row.teacher_id
        ? ((await this.teacherMembershipId(membership, row.teacher_id)) ??
          null)
        : null,
    };
  }

  private async loadSubject(
    membership: ActiveMembership,
    subjectId: string,
  ): Promise<void> {
    if (!UUID_RE.test(subjectId)) {
      throw new NotFoundException('No se encontró la materia');
    }
    const { data, error } = await this.supabase.admin
      .from('subjects')
      .select('id, courses!inner(school_id)')
      .eq('id', subjectId)
      .eq('courses.school_id', membership.institutionId)
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException();
    }
    if (!data) {
      throw new NotFoundException('No se encontró la materia');
    }
  }

  // Resolves teacherMembershipId to the profile id stored in
  // subjects.teacher_id. null unassigns; a membership from another school or
  // with a non-teacher role is rejected.
  private async resolveTeacher(
    membership: ActiveMembership,
    teacherMembershipId: string | null,
  ): Promise<string | null> {
    if (teacherMembershipId === null) {
      return null;
    }
    if (
      typeof teacherMembershipId !== 'string' ||
      !UUID_RE.test(teacherMembershipId)
    ) {
      throw new BadRequestException(
        'El docente indicado no pertenece a la institución',
      );
    }
    const { data, error } = await this.supabase.admin
      .from('memberships')
      .select('id, user_id, role')
      .eq('id', teacherMembershipId)
      .eq('school_id', membership.institutionId)
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException();
    }
    const row = data as { user_id: string; role: string } | null;
    if (!row) {
      throw new BadRequestException(
        'El docente indicado no pertenece a la institución',
      );
    }
    if (row.role !== 'teacher') {
      throw new BadRequestException(
        'La membresía indicada no corresponde a un docente',
      );
    }
    return row.user_id;
  }

  // Maps a teacher profile id back to its 'teacher' membership id in the
  // school, which is what the API exposes as teacherMembershipId.
  private async teacherMembershipId(
    membership: ActiveMembership,
    userId: string,
  ): Promise<string | undefined> {
    const { data, error } = await this.supabase.admin
      .from('memberships')
      .select('id')
      .eq('school_id', membership.institutionId)
      .eq('role', 'teacher')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException();
    }
    return (data as { id: string } | null)?.id;
  }
}
