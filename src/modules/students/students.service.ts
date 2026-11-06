import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import type { Membership as ActiveMembership } from '../../auth/membership.guard.js';
import { SupabaseService } from '../../supabase/supabase.service.js';
import type {
  CreateStudentDto,
  ListStudentsQuery,
  UpdateStudentDto,
} from './dto/student.dto.js';

const UNIQUE_VIOLATION = '23505';
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STUDENT_STATUSES = ['active', 'inactive'] as const;

export interface CourseSummary {
  id: string;
  year: number;
  division: string;
  shift: string;
}

export interface StudentResponse {
  id: string;
  firstName: string | null;
  lastName: string | null;
  dni: string | null;
  status: 'active' | 'inactive';
  course: CourseSummary | null;
}

interface ProfileRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  dni: string | null;
  status: string;
}

interface EnrollmentRow {
  student_id: string;
  created_at: string;
  profiles: ProfileRow | ProfileRow[] | null;
  courses:
    | (CourseSummary & { school_id: string })
    | (CourseSummary & { school_id: string })[]
    | null;
}

function firstRow<T>(value: T | T[] | null | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : (value ?? undefined);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === UNIQUE_VIOLATION
  );
}

function isEmailTaken(error: unknown): boolean {
  const err = error as { code?: string; message?: string } | null;
  return (
    err?.code === 'email_exists' ||
    (err?.message ?? '').toLowerCase().includes('already registered')
  );
}

const ENROLLMENT_SELECT =
  'student_id, created_at, profiles!inner(id, first_name, last_name, dni, status), courses!inner(id, year, division, shift, school_id)';

@Injectable()
export class StudentsService {
  constructor(private readonly supabase: SupabaseService) {}

  async listStudents(
    membership: ActiveMembership,
    query: ListStudentsQuery,
  ): Promise<StudentResponse[]> {
    if (query?.courseId !== undefined) {
      await this.loadCourse(membership, query.courseId);
    }

    let builder = this.supabase.admin
      .from('enrollments')
      .select(ENROLLMENT_SELECT)
      .eq('courses.school_id', membership.institutionId);
    if (query?.courseId) {
      builder = builder.eq('course_id', query.courseId);
    }
    const q = query?.q?.trim();
    if (q) {
      builder = builder.or(
        `first_name.ilike.%${q}%,last_name.ilike.%${q}%,dni.ilike.%${q}%`,
        { referencedTable: 'profiles' },
      );
    }

    const { data, error } = await builder;
    if (error) {
      throw new InternalServerErrorException();
    }

    // One row per enrollment; a student enrolled twice keeps the latest one.
    const byStudent = new Map<string, StudentResponse>();
    const rows = (data ?? []) as EnrollmentRow[];
    rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
    for (const row of rows) {
      if (byStudent.has(row.student_id)) {
        continue;
      }
      const profile = firstRow(row.profiles);
      if (!profile) {
        continue;
      }
      byStudent.set(
        row.student_id,
        this.toStudent(profile, firstRow(row.courses) ?? null),
      );
    }
    return [...byStudent.values()].sort(
      (a, b) =>
        `${a.lastName ?? ''}${a.firstName ?? ''}`.localeCompare(
          `${b.lastName ?? ''}${b.firstName ?? ''}`,
          'es',
        ),
    );
  }

  async createStudent(
    membership: ActiveMembership,
    dto: CreateStudentDto | undefined,
  ): Promise<StudentResponse> {
    for (const field of ['firstName', 'lastName', 'dni', 'email'] as const) {
      if (typeof dto?.[field] !== 'string' || !dto[field].trim()) {
        throw new BadRequestException(
          `El alumno necesita ${field === 'dni' ? 'DNI' : field}`,
        );
      }
    }
    if (typeof dto?.courseId !== 'string' || !dto.courseId) {
      throw new BadRequestException('El alumno necesita un curso');
    }

    const dni = dto.dni.trim();
    const firstName = dto.firstName.trim();
    const lastName = dto.lastName.trim();
    const email = dto.email.trim();

    const course = await this.loadCourse(membership, dto.courseId);
    await this.assertDniAvailable(membership, dni);

    const { data: created, error: createError } =
      await this.supabase.admin.auth.admin.createUser({
        email,
        password: dto.password ?? crypto.randomUUID(),
        email_confirm: true,
        user_metadata: { full_name: `${firstName} ${lastName}` },
      });
    if (createError || !created.user) {
      if (isEmailTaken(createError)) {
        throw new ConflictException('Ya existe un usuario con ese email');
      }
      throw new InternalServerErrorException();
    }
    const userId = created.user.id;

    // The auth user is created first; if any later step fails, remove it so a
    // retry does not collide with a leftover user.
    try {
      const { data: profile, error: profileError } =
        await this.supabase.admin
          .from('profiles')
          .insert({
            id: userId,
            school_id: membership.institutionId,
            full_name: `${firstName} ${lastName}`,
            first_name: firstName,
            last_name: lastName,
            dni,
            role: 'student',
            status: 'active',
          })
          .select('id, first_name, last_name, dni, status')
          .single();
      if (isUniqueViolation(profileError)) {
        throw new ConflictException('Ya existe un alumno con ese DNI');
      }
      if (profileError || !profile) {
        throw new InternalServerErrorException();
      }

      const { error: membershipError } = await this.supabase.admin
        .from('memberships')
        .insert({
          user_id: userId,
          school_id: membership.institutionId,
          role: 'student',
        });
      if (membershipError) {
        throw new InternalServerErrorException();
      }

      const { error: enrollmentError } = await this.supabase.admin
        .from('enrollments')
        .insert({ student_id: userId, course_id: dto.courseId });
      if (enrollmentError) {
        throw new InternalServerErrorException();
      }

      return this.toStudent(profile as ProfileRow, course);
    } catch (error) {
      await this.supabase.admin.auth.admin.deleteUser(userId).catch(() => {});
      throw error;
    }
  }

  async updateStudent(
    membership: ActiveMembership,
    studentId: string,
    dto: UpdateStudentDto | undefined,
  ): Promise<StudentResponse> {
    const current = await this.loadStudent(membership, studentId);

    const profileUpdate: Record<string, unknown> = {};
    let firstName = current.first_name;
    let lastName = current.last_name;
    if (dto?.firstName !== undefined) {
      if (typeof dto.firstName !== 'string' || !dto.firstName.trim()) {
        throw new BadRequestException('El nombre no puede estar vacío');
      }
      firstName = dto.firstName.trim();
      profileUpdate.first_name = firstName;
    }
    if (dto?.lastName !== undefined) {
      if (typeof dto.lastName !== 'string' || !dto.lastName.trim()) {
        throw new BadRequestException('El apellido no puede estar vacío');
      }
      lastName = dto.lastName.trim();
      profileUpdate.last_name = lastName;
    }
    if (dto?.firstName !== undefined || dto?.lastName !== undefined) {
      profileUpdate.full_name = `${firstName ?? ''} ${lastName ?? ''}`.trim();
    }
    if (dto?.dni !== undefined) {
      if (typeof dto.dni !== 'string' || !dto.dni.trim()) {
        throw new BadRequestException('El DNI no puede estar vacío');
      }
      await this.assertDniAvailable(membership, dto.dni.trim(), studentId);
      profileUpdate.dni = dto.dni.trim();
    }
    if (dto?.status !== undefined) {
      if (
        !STUDENT_STATUSES.includes(
          dto.status as (typeof STUDENT_STATUSES)[number],
        )
      ) {
        throw new BadRequestException("El estado debe ser 'active' o 'inactive'");
      }
      profileUpdate.status = dto.status;
    }

    if (dto?.courseId !== undefined) {
      await this.loadCourse(membership, dto.courseId);
      const { error } = await this.supabase.admin
        .from('enrollments')
        .update({ course_id: dto.courseId })
        .eq('student_id', studentId);
      if (error) {
        throw new InternalServerErrorException();
      }
    }

    if (Object.keys(profileUpdate).length > 0) {
      const { error } = await this.supabase.admin
        .from('profiles')
        .update(profileUpdate)
        .eq('id', studentId);
      if (isUniqueViolation(error)) {
        throw new ConflictException('Ya existe un alumno con ese DNI');
      }
      if (error) {
        throw new InternalServerErrorException();
      }
    }

    if (Object.keys(profileUpdate).length === 0 && dto?.courseId === undefined) {
      throw new BadRequestException('No hay cambios para guardar');
    }

    return this.loadStudent(membership, studentId).then((row) =>
      this.toStudent(row, row.courses),
    );
  }

  private toStudent(
    profile: ProfileRow,
    course: CourseSummary | null,
  ): StudentResponse {
    return {
      id: profile.id,
      firstName: profile.first_name,
      lastName: profile.last_name,
      dni: profile.dni,
      status: profile.status === 'inactive' ? 'inactive' : 'active',
      course: course
        ? {
            id: course.id,
            year: course.year,
            division: course.division,
            shift: course.shift,
          }
        : null,
    };
  }

  private async loadCourse(
    membership: ActiveMembership,
    courseId: string,
  ): Promise<CourseSummary> {
    if (!UUID_RE.test(courseId)) {
      throw new NotFoundException('No se encontró el curso');
    }
    const { data, error } = await this.supabase.admin
      .from('courses')
      .select('id, year, division, shift')
      .eq('id', courseId)
      .eq('school_id', membership.institutionId)
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException();
    }
    if (!data) {
      throw new NotFoundException('No se encontró el curso');
    }
    return data as CourseSummary;
  }

  // A student counts as belonging to the institution when it has at least one
  // enrollment in a course of the school; returns its latest enrollment row.
  private async loadStudent(
    membership: ActiveMembership,
    studentId: string,
  ): Promise<ProfileRow & { courses: CourseSummary | null }> {
    if (!UUID_RE.test(studentId)) {
      throw new NotFoundException('No se encontró el alumno');
    }
    const { data, error } = await this.supabase.admin
      .from('enrollments')
      .select(ENROLLMENT_SELECT)
      .eq('student_id', studentId)
      .eq('courses.school_id', membership.institutionId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException();
    }
    const row = data as EnrollmentRow | null;
    const profile = firstRow(row?.profiles);
    if (!row || !profile) {
      throw new NotFoundException('No se encontró el alumno');
    }
    return { ...profile, courses: firstRow(row.courses) ?? null };
  }

  private async assertDniAvailable(
    membership: ActiveMembership,
    dni: string,
    excludeProfileId?: string,
  ): Promise<void> {
    let builder = this.supabase.admin
      .from('profiles')
      .select('id')
      .eq('school_id', membership.institutionId)
      .eq('dni', dni)
      .limit(1);
    if (excludeProfileId) {
      builder = builder.neq('id', excludeProfileId);
    }
    const { data, error } = await builder;
    if (error) {
      throw new InternalServerErrorException();
    }
    if (data?.length) {
      throw new ConflictException('Ya existe un alumno con ese DNI');
    }
  }
}
