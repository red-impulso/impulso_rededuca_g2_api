import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import type { Membership as ActiveMembership } from '../../auth/membership.guard.js';
import { SupabaseService } from '../../supabase/supabase.service.js';
import { UsersService } from '../users/users.service.js';
import type { MemberDetails } from '../users/users.service.js';
import type { AssignTeacherDto } from './dto/assign-teacher.dto.js';
import type {
  CreateTeacherDto,
  TeacherDetailsDto,
  UpdateTeacherDto,
} from './dto/teacher.dto.js';

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
  status: string;
  dni: string | null;
  subjects: TeacherSubjectSummary[];
}

export interface TeacherFileResponse extends TeacherResponse {
  email: string | null;
  phone: string | null;
  training: string | null;
  startYear: number | null;
  notes: string | null;
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
  role?: string;
  status?: string;
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

interface DetailsRow {
  dni: string | null;
  phone: string | null;
  training: string | null;
  start_year: number | null;
  notes: string | null;
}

const TEXT_DETAILS = ['dni', 'phone', 'training', 'notes'] as const;
const STATUSES = ['active', 'inactive'];
const OLDEST_START_YEAR = 1950;

function firstRow<T>(value: T | T[] | null | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : (value ?? undefined);
}

function toSubject(row: SubjectRow): TeacherSubjectSummary | undefined {
  const course = firstRow(row.courses);
  return course
    ? {
        id: row.id,
        name: row.name,
        course: {
          id: course.id,
          year: course.year,
          division: course.division,
          shift: course.shift,
        },
      }
    : undefined;
}

// Keeps only the fields that came in the request; a blank text clears it.
function parseDetails(dto: TeacherDetailsDto | undefined): MemberDetails {
  const details: MemberDetails = {};
  for (const field of TEXT_DETAILS) {
    const value = dto?.[field];
    if (value === undefined) {
      continue;
    }
    if (value !== null && typeof value !== 'string') {
      throw new BadRequestException('Revisá los datos del docente');
    }
    details[field] = value?.trim() || null;
  }

  const startYear = dto?.startYear;
  if (startYear !== undefined) {
    const lastYear = new Date().getFullYear();
    if (
      startYear !== null &&
      (!Number.isInteger(startYear) ||
        startYear < OLDEST_START_YEAR ||
        startYear > lastYear)
    ) {
      throw new BadRequestException(
        `El año de ingreso debe estar entre ${OLDEST_START_YEAR} y ${lastYear}`,
      );
    }
    details.start_year = startYear;
  }
  return details;
}

@Injectable()
export class TeachersService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly users: UsersService,
  ) {}

  async listTeachers(
    membership: ActiveMembership,
  ): Promise<TeacherResponse[]> {
    const { data, error } = await this.supabase.admin
      .from('memberships')
      .select('id, user_id, status, profiles(full_name)')
      .eq('school_id', membership.institutionId)
      .eq('role', 'teacher');

    if (error) {
      throw new InternalServerErrorException();
    }

    const rows = (data ?? []) as MembershipRow[];
    if (rows.length === 0) {
      return [];
    }

    const userIds = rows.map((row) => row.user_id);
    const [subjects, details] = await Promise.all([
      this.subjectsOf(membership, userIds),
      this.supabase.admin
        .from('member_details')
        .select('user_id, dni')
        .eq('school_id', membership.institutionId)
        .in('user_id', userIds),
    ]);

    if (details.error) {
      throw new InternalServerErrorException();
    }

    const subjectsByTeacher = new Map<string, TeacherSubjectSummary[]>();
    for (const row of subjects) {
      const subject = toSubject(row);
      if (!row.teacher_id || !subject) {
        continue;
      }
      const list = subjectsByTeacher.get(row.teacher_id) ?? [];
      list.push(subject);
      subjectsByTeacher.set(row.teacher_id, list);
    }

    const dniByTeacher = new Map(
      ((details.data ?? []) as { user_id: string; dni: string | null }[]).map(
        (row) => [row.user_id, row.dni],
      ),
    );

    return rows
      .map((row) => ({
        id: row.id,
        fullName: firstRow(row.profiles)?.full_name ?? null,
        status: row.status ?? 'active',
        dni: dniByTeacher.get(row.user_id) ?? null,
        subjects: subjectsByTeacher.get(row.user_id) ?? [],
      }))
      .sort((a, b) =>
        (a.fullName ?? '').localeCompare(b.fullName ?? '', 'es'),
      );
  }

  async getTeacher(
    membership: ActiveMembership,
    teacherMembershipId: string,
  ): Promise<TeacherFileResponse> {
    const row = await this.loadTeacher(membership, teacherMembershipId);

    const [subjects, details, auth] = await Promise.all([
      this.subjectsOf(membership, [row.user_id]),
      this.supabase.admin
        .from('member_details')
        .select('dni, phone, training, start_year, notes')
        .eq('school_id', membership.institutionId)
        .eq('user_id', row.user_id)
        .maybeSingle(),
      this.supabase.admin.auth.admin.getUserById(row.user_id),
    ]);

    if (details.error || auth.error) {
      throw new InternalServerErrorException();
    }

    const file = details.data as Partial<DetailsRow> | null;
    return {
      id: row.id,
      fullName: firstRow(row.profiles)?.full_name ?? null,
      status: row.status ?? 'active',
      dni: file?.dni ?? null,
      email: auth.data.user?.email ?? null,
      phone: file?.phone ?? null,
      training: file?.training ?? null,
      startYear: file?.start_year ?? null,
      notes: file?.notes ?? null,
      subjects: subjects.flatMap((subject) => toSubject(subject) ?? []),
    };
  }

  async createTeacher(
    membership: ActiveMembership,
    dto: CreateTeacherDto | undefined,
  ): Promise<TeacherResponse> {
    const details = parseDetails(dto);
    if (details.dni) {
      await this.assertDniAvailable(membership, details.dni);
    }

    const user = await this.users.createUser(membership, {
      email: dto?.email as string,
      fullName: dto?.fullName as string,
      temporaryPassword: dto?.temporaryPassword as string,
      role: 'teacher',
    });
    await this.users.saveDetails(membership, user.userId, details);

    return {
      id: user.id,
      fullName: user.fullName,
      status: user.status,
      dni: details.dni ?? null,
      subjects: [],
    };
  }

  async updateTeacher(
    membership: ActiveMembership,
    teacherMembershipId: string,
    dto: UpdateTeacherDto | undefined,
  ): Promise<TeacherFileResponse> {
    const details = parseDetails(dto);
    const { fullName, status } = dto ?? {};
    if (
      fullName === undefined &&
      status === undefined &&
      Object.keys(details).length === 0
    ) {
      throw new BadRequestException('No hay cambios para guardar');
    }
    if (
      fullName !== undefined &&
      (typeof fullName !== 'string' || !fullName.trim())
    ) {
      throw new BadRequestException('El docente necesita un nombre');
    }
    if (status !== undefined && !STATUSES.includes(status)) {
      throw new BadRequestException('El estado indicado no es válido');
    }

    const row = await this.loadTeacher(membership, teacherMembershipId);
    if (details.dni) {
      await this.assertDniAvailable(membership, details.dni, row.user_id);
    }

    if (fullName !== undefined) {
      await this.users.saveName(row.user_id, fullName.trim());
    }
    if (status !== undefined) {
      const { error } = await this.supabase.admin
        .from('memberships')
        .update({ status })
        .eq('id', row.id);

      if (error) {
        throw new InternalServerErrorException();
      }
    }
    if (Object.keys(details).length > 0) {
      await this.users.saveDetails(membership, row.user_id, details);
    }

    return this.getTeacher(membership, teacherMembershipId);
  }

  private async subjectsOf(
    membership: ActiveMembership,
    teacherIds: string[],
  ): Promise<SubjectRow[]> {
    const { data, error } = await this.supabase.admin
      .from('subjects')
      .select('id, name, teacher_id, courses!inner(id, year, division, shift)')
      .eq('courses.school_id', membership.institutionId)
      .in('teacher_id', teacherIds);

    if (error) {
      throw new InternalServerErrorException();
    }
    return (data ?? []) as SubjectRow[];
  }

  private async loadTeacher(
    membership: ActiveMembership,
    teacherMembershipId: string,
  ): Promise<MembershipRow> {
    if (!UUID_RE.test(teacherMembershipId)) {
      throw new NotFoundException('No se encontró el docente');
    }
    const { data, error } = await this.supabase.admin
      .from('memberships')
      .select('id, user_id, role, status, profiles(full_name)')
      .eq('id', teacherMembershipId)
      .eq('school_id', membership.institutionId)
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException();
    }
    const row = data as MembershipRow | null;
    if (row?.role !== 'teacher') {
      throw new NotFoundException('No se encontró el docente');
    }
    return row;
  }

  private async assertDniAvailable(
    membership: ActiveMembership,
    dni: string,
    exceptUserId?: string,
  ): Promise<void> {
    let query = this.supabase.admin
      .from('member_details')
      .select('user_id')
      .eq('school_id', membership.institutionId)
      .eq('dni', dni);
    if (exceptUserId) {
      query = query.neq('user_id', exceptUserId);
    }

    const { data, error } = await query;
    if (error) {
      throw new InternalServerErrorException();
    }
    if (data?.length) {
      throw new ConflictException('Ya existe una persona con ese DNI');
    }
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
