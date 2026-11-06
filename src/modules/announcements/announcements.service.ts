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
  AnnouncementScope,
  CreateAnnouncementDto,
} from './dto/create-announcement.dto.js';

export const ANNOUNCEMENT_CREATED_EVENT = 'announcement.created';

const SCOPES: AnnouncementScope[] = ['institution', 'course', 'student'];
const MANAGER_ROLES = ['admin', 'director'];
const ANNOUNCEMENT_COLUMNS =
  'id, scope, course_id, student_id, title, body, created_at, profiles!announcements_created_by_fkey(full_name), courses(year, division)';

export interface AnnouncementCreatedPayload {
  schoolId: string;
  announcementId: string;
  scope: AnnouncementScope;
  courseId: string | null;
  studentId: string | null;
  title: string;
  createdBy: string;
}

export interface AnnouncementView {
  id: string;
  scope: AnnouncementScope;
  courseId: string | null;
  studentId: string | null;
  title: string;
  body: string;
  createdAt: string;
  authorName: string | null;
  courseLabel: string | null;
}

interface AnnouncementRow {
  id: string;
  scope: AnnouncementScope;
  course_id: string | null;
  student_id: string | null;
  title: string;
  body: string;
  created_at: string;
  profiles?:
    { full_name: string | null } | { full_name: string | null }[] | null;
  courses?:
    | { year: number; division: string }
    | { year: number; division: string }[]
    | null;
}

function firstRow<T>(value: T | T[] | null | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : (value ?? undefined);
}

function toView(row: AnnouncementRow): AnnouncementView {
  const course = firstRow(row.courses);
  return {
    id: row.id,
    scope: row.scope,
    courseId: row.course_id,
    studentId: row.student_id,
    title: row.title,
    body: row.body,
    createdAt: row.created_at,
    authorName: firstRow(row.profiles)?.full_name ?? null,
    courseLabel: course ? `${course.year}°${course.division}` : null,
  };
}

@Injectable()
export class AnnouncementsService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly events: EventEmitter2,
  ) {}

  // Managers (admin/director) can post any scope; teachers only 'course' for
  // a course they teach in. Guardians and students can't post.
  async create(
    user: AuthUser,
    membership: ActiveMembership,
    dto: CreateAnnouncementDto,
  ): Promise<AnnouncementView> {
    if (
      !dto ||
      !SCOPES.includes(dto.scope) ||
      typeof dto.title !== 'string' ||
      !dto.title.trim() ||
      typeof dto.body !== 'string' ||
      !dto.body.trim()
    ) {
      throw new BadRequestException(
        'El comunicado debe tener alcance, título y texto',
      );
    }
    if (dto.scope === 'course' && !dto.courseId) {
      throw new BadRequestException('Falta elegir el curso');
    }
    if (dto.scope === 'student' && !dto.studentId) {
      throw new BadRequestException('Falta elegir el alumno');
    }
    if (
      (dto.scope === 'institution' && (dto.courseId || dto.studentId)) ||
      (dto.scope === 'course' && dto.studentId) ||
      (dto.scope === 'student' && dto.courseId)
    ) {
      throw new BadRequestException(
        'El alcance no coincide con el curso o el alumno elegido',
      );
    }

    const isManager = MANAGER_ROLES.includes(membership.role);
    if (
      !isManager &&
      !(membership.role === 'teacher' && dto.scope === 'course')
    ) {
      throw new ForbiddenException('No podés publicar este comunicado');
    }

    let courseId: string | null = null;
    let studentId: string | null = null;
    if (dto.scope === 'course') {
      courseId = await this.loadCourseForPosting(
        user,
        membership,
        dto.courseId as string,
      );
    }
    if (dto.scope === 'student') {
      studentId = await this.loadStudent(membership, dto.studentId as string);
    }

    const { data, error } = await this.supabase.admin
      .from('announcements')
      .insert({
        school_id: membership.institutionId,
        scope: dto.scope,
        course_id: courseId,
        student_id: studentId,
        title: dto.title.trim(),
        body: dto.body.trim(),
        created_by: user.id,
      })
      .select(ANNOUNCEMENT_COLUMNS)
      .single();

    if (error || !data) {
      throw new InternalServerErrorException();
    }

    const row = data as AnnouncementRow;
    const payload: AnnouncementCreatedPayload = {
      schoolId: membership.institutionId,
      announcementId: row.id,
      scope: row.scope,
      courseId: row.course_id,
      studentId: row.student_id,
      title: row.title,
      createdBy: user.id,
    };
    this.events.emit(ANNOUNCEMENT_CREATED_EVENT, payload);

    return toView(row);
  }

  // The announcements that concern the caller: institution-wide plus the
  // courses they teach in / their children attend / they attend, plus
  // student-scoped ones addressed to them or their children. Managers see all.
  async list(
    user: AuthUser,
    membership: ActiveMembership,
  ): Promise<AnnouncementView[]> {
    const { data, error } = await this.supabase.admin
      .from('announcements')
      .select(ANNOUNCEMENT_COLUMNS)
      .eq('school_id', membership.institutionId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new InternalServerErrorException();
    }
    const rows = (data ?? []) as AnnouncementRow[];
    if (MANAGER_ROLES.includes(membership.role)) {
      return rows.map(toView);
    }

    const { courseIds, studentIds } = await this.visibleTargets(
      user,
      membership,
    );
    return rows
      .filter(
        (row) =>
          row.scope === 'institution' ||
          (row.scope === 'course' &&
            row.course_id !== null &&
            courseIds.has(row.course_id)) ||
          (row.scope === 'student' &&
            row.student_id !== null &&
            studentIds.has(row.student_id)),
      )
      .map(toView);
  }

  // Courses and students the caller is allowed to read announcements for.
  private async visibleTargets(
    user: AuthUser,
    membership: ActiveMembership,
  ): Promise<{ courseIds: Set<string>; studentIds: Set<string> }> {
    if (membership.role === 'teacher') {
      const { data, error } = await this.supabase.admin
        .from('subjects')
        .select('course_id, courses!inner(school_id)')
        .eq('teacher_id', user.id)
        .eq('courses.school_id', membership.institutionId);
      if (error) {
        throw new InternalServerErrorException();
      }
      return {
        courseIds: new Set(
          (data ?? []).map((row: { course_id: string }) => row.course_id),
        ),
        studentIds: new Set(),
      };
    }

    if (membership.role === 'guardian') {
      const { data: links, error: linksError } = await this.supabase.admin
        .from('guardian_links')
        .select('student_id')
        .eq('guardian_id', user.id);
      if (linksError) {
        throw new InternalServerErrorException();
      }
      const studentIds = new Set(
        (links ?? []).map((row: { student_id: string }) => row.student_id),
      );
      return {
        courseIds: await this.coursesOfStudents(
          studentIds,
          membership.institutionId,
        ),
        studentIds,
      };
    }

    if (membership.role === 'student') {
      return {
        courseIds: await this.coursesOfStudents(
          new Set([user.id]),
          membership.institutionId,
        ),
        studentIds: new Set([user.id]),
      };
    }

    return { courseIds: new Set(), studentIds: new Set() };
  }

  private async coursesOfStudents(
    studentIds: Set<string>,
    schoolId: string,
  ): Promise<Set<string>> {
    if (studentIds.size === 0) {
      return new Set();
    }
    const { data, error } = await this.supabase.admin
      .from('enrollments')
      .select('course_id, courses!inner(school_id)')
      .in('student_id', [...studentIds])
      .eq('courses.school_id', schoolId);
    if (error) {
      throw new InternalServerErrorException();
    }
    return new Set(
      (data ?? []).map((row: { course_id: string }) => row.course_id),
    );
  }

  // The course must exist in the school; a non-manager caller must teach a
  // subject in it.
  private async loadCourseForPosting(
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
      throw new NotFoundException('No se encontró el curso');
    }

    if (MANAGER_ROLES.includes(membership.role)) {
      return courseId;
    }
    const { data: subjects, error: subjectsError } = await this.supabase.admin
      .from('subjects')
      .select('id')
      .eq('course_id', courseId)
      .eq('teacher_id', user.id);
    if (subjectsError) {
      throw new InternalServerErrorException();
    }
    // A teacher can have several subjects in the same course.
    if (!subjects?.length) {
      throw new ForbiddenException('No das clases en este curso');
    }
    return courseId;
  }

  private async loadStudent(
    membership: ActiveMembership,
    studentId: string,
  ): Promise<string> {
    const { data, error } = await this.supabase.admin
      .from('enrollments')
      .select('student_id, courses!inner(school_id)')
      .eq('student_id', studentId)
      .eq('courses.school_id', membership.institutionId);
    if (error) {
      throw new InternalServerErrorException();
    }
    // A student can be enrolled in more than one course of the school.
    if (!data?.length) {
      throw new NotFoundException('No se encontró el alumno');
    }
    return studentId;
  }
}
