import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import type { Membership as ActiveMembership } from '../../auth/membership.guard.js';
import { SupabaseService } from '../../supabase/supabase.service.js';
import type { CreateCourseDto, UpdateCourseDto } from './dto/course.dto.js';
import type { CreateSubjectDto, UpdateSubjectDto } from './dto/subject.dto.js';
import type { UpdateInstitutionDto } from './dto/update-institution.dto.js';

const SHIFTS = ['morning', 'afternoon', 'evening'] as const;
const UNIQUE_VIOLATION = '23505';
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface InstitutionResponse {
  id: string;
  name: string;
  address: string | null;
  levels: string[];
}

export interface CourseResponse {
  id: string;
  year: number;
  division: string;
  shift: string;
  schoolYear: number;
}

export interface SubjectResponse {
  id: string;
  name: string;
  courseId: string;
  teacherMembershipId: string | null;
}

interface CourseRow {
  id: string;
  year: number;
  division: string;
  shift: string;
  school_year: number;
}

interface SubjectRow {
  id: string;
  name: string;
  course_id: string;
  teacher_id: string | null;
}

function toCourse(row: CourseRow): CourseResponse {
  return {
    id: row.id,
    year: row.year,
    division: row.division,
    shift: row.shift,
    schoolYear: row.school_year,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === UNIQUE_VIOLATION
  );
}

@Injectable()
export class InstitutionService {
  constructor(private readonly supabase: SupabaseService) {}

  async updateInstitution(
    membership: ActiveMembership,
    dto: UpdateInstitutionDto,
  ): Promise<InstitutionResponse> {
    const update: Record<string, unknown> = {};
    if (dto?.name !== undefined) {
      if (typeof dto.name !== 'string' || !dto.name.trim()) {
        throw new BadRequestException(
          'El nombre de la institución no puede estar vacío',
        );
      }
      update.name = dto.name.trim();
    }
    if (dto?.address !== undefined) {
      if (dto.address !== null && typeof dto.address !== 'string') {
        throw new BadRequestException('La dirección debe ser un texto');
      }
      update.address = dto.address?.trim() || null;
    }
    if (dto?.levels !== undefined) {
      if (
        !Array.isArray(dto.levels) ||
        dto.levels.some((level) => typeof level !== 'string' || !level.trim())
      ) {
        throw new BadRequestException(
          'Los niveles deben ser una lista de textos',
        );
      }
      update.levels = dto.levels.map((level) => level.trim());
    }
    if (Object.keys(update).length === 0) {
      throw new BadRequestException('No hay cambios para guardar');
    }

    const { data, error } = await this.supabase.admin
      .from('schools')
      .update(update)
      .eq('id', membership.institutionId)
      .select('id, name, address, levels')
      .single();

    if (error || !data) {
      throw new InternalServerErrorException();
    }

    const row = data as InstitutionResponse & { levels: string[] | null };
    return {
      id: row.id,
      name: row.name,
      address: row.address,
      levels: row.levels ?? [],
    };
  }

  async listCourses(membership: ActiveMembership): Promise<CourseResponse[]> {
    const { data, error } = await this.supabase.admin
      .from('courses')
      .select('id, year, division, shift, school_year')
      .eq('school_id', membership.institutionId)
      .order('school_year', { ascending: false })
      .order('year')
      .order('division');

    if (error) {
      throw new InternalServerErrorException();
    }
    return ((data ?? []) as CourseRow[]).map(toCourse);
  }

  async createCourse(
    membership: ActiveMembership,
    dto: CreateCourseDto,
  ): Promise<CourseResponse> {
    const values = this.courseValues(dto, true);
    const { data, error } = await this.supabase.admin
      .from('courses')
      .insert({ school_id: membership.institutionId, ...values })
      .select('id, year, division, shift, school_year')
      .single();

    if (isUniqueViolation(error)) {
      throw new ConflictException(
        'Ya existe un curso con ese año, división, turno y ciclo lectivo',
      );
    }
    if (error || !data) {
      throw new InternalServerErrorException();
    }
    return toCourse(data as CourseRow);
  }

  async updateCourse(
    membership: ActiveMembership,
    courseId: string,
    dto: UpdateCourseDto,
  ): Promise<CourseResponse> {
    await this.loadCourse(membership, courseId);
    const values = this.courseValues(dto, false);
    if (Object.keys(values).length === 0) {
      throw new BadRequestException('No hay cambios para guardar');
    }

    const { data, error } = await this.supabase.admin
      .from('courses')
      .update(values)
      .eq('id', courseId)
      .select('id, year, division, shift, school_year')
      .single();

    if (isUniqueViolation(error)) {
      throw new ConflictException(
        'Ya existe un curso con ese año, división, turno y ciclo lectivo',
      );
    }
    if (error || !data) {
      throw new InternalServerErrorException();
    }
    return toCourse(data as CourseRow);
  }

  // Deleting a course cascades to its enrollments, subjects, grades and
  // attendance, so it is refused while the course still holds students or
  // subjects instead of silently wiping that data.
  async deleteCourse(
    membership: ActiveMembership,
    courseId: string,
  ): Promise<{ deleted: true }> {
    await this.loadCourse(membership, courseId);

    const { data: enrolled, error: enrolledError } = await this.supabase.admin
      .from('enrollments')
      .select('student_id')
      .eq('course_id', courseId)
      .limit(1);

    if (enrolledError) {
      throw new InternalServerErrorException();
    }
    if (enrolled?.length) {
      throw new ConflictException(
        'No se puede borrar el curso porque tiene alumnos inscriptos',
      );
    }

    const { data: subjects, error: subjectsError } = await this.supabase.admin
      .from('subjects')
      .select('id')
      .eq('course_id', courseId)
      .limit(1);

    if (subjectsError) {
      throw new InternalServerErrorException();
    }
    if (subjects?.length) {
      throw new ConflictException(
        'No se puede borrar el curso porque tiene materias cargadas',
      );
    }

    const { error } = await this.supabase.admin
      .from('courses')
      .delete()
      .eq('id', courseId);

    if (error) {
      throw new InternalServerErrorException();
    }
    return { deleted: true };
  }

  async listSubjects(membership: ActiveMembership): Promise<SubjectResponse[]> {
    const { data, error } = await this.supabase.admin
      .from('subjects')
      .select('id, name, course_id, teacher_id, courses!inner(school_id)')
      .eq('courses.school_id', membership.institutionId)
      .order('name');

    if (error) {
      throw new InternalServerErrorException();
    }

    const rows = (data ?? []) as SubjectRow[];
    const membershipByUser = await this.teacherMembershipIds(
      membership,
      rows.map((row) => row.teacher_id).filter((id): id is string => !!id),
    );

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      courseId: row.course_id,
      teacherMembershipId: row.teacher_id
        ? (membershipByUser.get(row.teacher_id) ?? null)
        : null,
    }));
  }

  async createSubject(
    membership: ActiveMembership,
    dto: CreateSubjectDto,
  ): Promise<SubjectResponse> {
    if (typeof dto?.name !== 'string' || !dto.name.trim()) {
      throw new BadRequestException('La materia necesita un nombre');
    }
    if (typeof dto?.courseId !== 'string' || !dto.courseId) {
      throw new BadRequestException('La materia necesita un curso');
    }
    await this.loadCourse(membership, dto.courseId);
    const teacherId = await this.resolveTeacher(membership, dto);

    const { data, error } = await this.supabase.admin
      .from('subjects')
      .insert({
        course_id: dto.courseId,
        name: dto.name.trim(),
        teacher_id: teacherId,
      })
      .select('id, name, course_id, teacher_id')
      .single();

    if (isUniqueViolation(error)) {
      throw new ConflictException(
        'Ya existe una materia con ese nombre en este curso',
      );
    }
    if (error || !data) {
      throw new InternalServerErrorException();
    }
    return this.toSubject(membership, data as SubjectRow);
  }

  async updateSubject(
    membership: ActiveMembership,
    subjectId: string,
    dto: UpdateSubjectDto,
  ): Promise<SubjectResponse> {
    await this.loadSubject(membership, subjectId);

    const update: Record<string, unknown> = {};
    if (dto?.name !== undefined) {
      if (typeof dto.name !== 'string' || !dto.name.trim()) {
        throw new BadRequestException('La materia necesita un nombre');
      }
      update.name = dto.name.trim();
    }
    if (dto?.courseId !== undefined) {
      await this.loadCourse(membership, dto.courseId);
      update.course_id = dto.courseId;
    }
    if (dto && 'teacherMembershipId' in dto) {
      update.teacher_id = await this.resolveTeacher(membership, dto);
    }
    if (Object.keys(update).length === 0) {
      throw new BadRequestException('No hay cambios para guardar');
    }

    const { data, error } = await this.supabase.admin
      .from('subjects')
      .update(update)
      .eq('id', subjectId)
      .select('id, name, course_id, teacher_id')
      .single();

    if (isUniqueViolation(error)) {
      throw new ConflictException(
        'Ya existe una materia con ese nombre en este curso',
      );
    }
    if (error || !data) {
      throw new InternalServerErrorException();
    }
    return this.toSubject(membership, data as SubjectRow);
  }

  async deleteSubject(
    membership: ActiveMembership,
    subjectId: string,
  ): Promise<{ deleted: true }> {
    await this.loadSubject(membership, subjectId);

    const { error } = await this.supabase.admin
      .from('subjects')
      .delete()
      .eq('id', subjectId);

    if (error) {
      throw new InternalServerErrorException();
    }
    return { deleted: true };
  }

  // Maps a course create/update payload to DB columns, validating every field
  // that is present (or all of them when requireAll is set).
  private courseValues(
    dto: CreateCourseDto | UpdateCourseDto | undefined,
    requireAll: boolean,
  ): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    if (dto?.year !== undefined || requireAll) {
      if (!Number.isInteger(dto?.year) || (dto?.year ?? 0) < 1) {
        throw new BadRequestException(
          'El año del curso debe ser un entero mayor a 0',
        );
      }
      values.year = dto?.year;
    }
    if (dto?.division !== undefined || requireAll) {
      if (typeof dto?.division !== 'string' || !dto.division.trim()) {
        throw new BadRequestException('La división no puede estar vacía');
      }
      values.division = dto.division.trim();
    }
    if (dto?.shift !== undefined || requireAll) {
      if (!SHIFTS.includes(dto?.shift as (typeof SHIFTS)[number])) {
        throw new BadRequestException(
          "El turno debe ser 'morning', 'afternoon' o 'evening'",
        );
      }
      values.shift = dto?.shift;
    }
    if (dto?.schoolYear !== undefined || requireAll) {
      if (
        !Number.isInteger(dto?.schoolYear) ||
        (dto?.schoolYear ?? 0) < 2000 ||
        (dto?.schoolYear ?? 0) > 2100
      ) {
        throw new BadRequestException(
          'El ciclo lectivo debe ser un año entre 2000 y 2100',
        );
      }
      values.school_year = dto?.schoolYear;
    }
    return values;
  }

  private async loadCourse(
    membership: ActiveMembership,
    courseId: string,
  ): Promise<void> {
    if (!UUID_RE.test(courseId)) {
      throw new NotFoundException('No se encontró el curso');
    }
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
      throw new NotFoundException('No se encontró el curso');
    }
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

  // Resolves the optional teacherMembershipId from a subject payload to the
  // profile id stored in subjects.teacher_id. null (or absent) means no
  // teacher; a membership from another school or with a non-teacher role is
  // rejected.
  private async resolveTeacher(
    membership: ActiveMembership,
    dto: { teacherMembershipId?: string | null },
  ): Promise<string | null> {
    if (
      dto.teacherMembershipId === undefined ||
      dto.teacherMembershipId === null
    ) {
      return null;
    }
    const { data, error } = await this.supabase.admin
      .from('memberships')
      .select('id, user_id, role')
      .eq('id', dto.teacherMembershipId)
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

  private async toSubject(
    membership: ActiveMembership,
    row: SubjectRow,
  ): Promise<SubjectResponse> {
    const membershipByUser = row.teacher_id
      ? await this.teacherMembershipIds(membership, [row.teacher_id])
      : new Map<string, string>();
    return {
      id: row.id,
      name: row.name,
      courseId: row.course_id,
      teacherMembershipId: row.teacher_id
        ? (membershipByUser.get(row.teacher_id) ?? null)
        : null,
    };
  }

  // Maps teacher profile ids to their 'teacher' membership id in the school,
  // which is what the API exposes as teacherMembershipId.
  private async teacherMembershipIds(
    membership: ActiveMembership,
    userIds: string[],
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (userIds.length === 0) {
      return map;
    }
    const { data, error } = await this.supabase.admin
      .from('memberships')
      .select('id, user_id')
      .eq('school_id', membership.institutionId)
      .eq('role', 'teacher')
      .in('user_id', [...new Set(userIds)]);

    if (error) {
      throw new InternalServerErrorException();
    }
    for (const row of (data ?? []) as { id: string; user_id: string }[]) {
      map.set(row.user_id, row.id);
    }
    return map;
  }
}
