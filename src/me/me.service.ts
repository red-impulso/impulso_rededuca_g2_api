import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { AuthUser } from '../auth/auth.guard.js';
import type { Membership as ActiveMembership } from '../auth/membership.guard.js';
import { SupabaseService } from '../supabase/supabase.service.js';

export interface Membership {
  id: string;
  institutionId: string;
  institutionName: string;
  role: string;
}

export interface MeResponse {
  profile: { id: string; fullName: string | null; phone: string | null };
  memberships: Membership[];
}

export interface CourseSummary {
  id: string;
  year: number;
  division: string;
  shift: string;
}

export interface SubjectSummary {
  id: string;
  name: string;
  course: CourseSummary;
}

export interface StudentSummary {
  id: string;
  firstName: string | null;
  lastName: string | null;
  course: { id: string; year: number; division: string };
}

interface MembershipRow {
  id: string;
  school_id: string;
  role: string;
  schools: { id: string; name: string } | { id: string; name: string }[] | null;
}

interface CourseRow {
  id: string;
  year: number;
  division: string;
  shift: string;
}

interface SubjectRow {
  id: string;
  name: string;
  courses: CourseRow | CourseRow[] | null;
}

interface EnrollmentRow {
  profiles:
    | { id: string; first_name: string | null; last_name: string | null }
    | { id: string; first_name: string | null; last_name: string | null }[]
    | null;
  courses:
    | { id: string; year: number; division: string }
    | { id: string; year: number; division: string }[]
    | null;
}

function firstRow<T>(value: T | T[] | null | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : (value ?? undefined);
}

@Injectable()
export class MeService {
  constructor(private readonly supabase: SupabaseService) {}

  async getMe(user: AuthUser): Promise<MeResponse> {
    const [profileResult, membershipsResult] = await Promise.all([
      this.supabase.admin
        .from('profiles')
        .select('id, full_name')
        .eq('id', user.id)
        .maybeSingle(),
      this.supabase.admin
        .from('memberships')
        .select('id, school_id, role, schools(id, name)')
        .eq('user_id', user.id),
    ]);

    if (profileResult.error || membershipsResult.error) {
      throw new InternalServerErrorException();
    }

    const profile = profileResult.data;
    const memberships = (membershipsResult.data ?? []).flatMap(
      (row: MembershipRow) => {
        const school = Array.isArray(row.schools)
          ? row.schools[0]
          : row.schools;
        return school
          ? [
              {
                id: row.id,
                institutionId: row.school_id,
                institutionName: school.name,
                role: row.role,
              },
            ]
          : [];
      },
    );

    return {
      profile: {
        id: user.id,
        fullName: profile?.full_name ?? null,
        phone: user.phone ?? null,
      },
      memberships,
    };
  }

  async getSubjects(
    user: AuthUser,
    membership: ActiveMembership,
  ): Promise<SubjectSummary[]> {
    const { data, error } = await this.supabase.admin
      .from('subjects')
      .select('id, name, courses!inner(id, year, division, shift)')
      .eq('teacher_id', user.id)
      .eq('courses.school_id', membership.institutionId);

    if (error) {
      throw new InternalServerErrorException();
    }

    return (data ?? []).flatMap((row: SubjectRow) => {
      const course = firstRow(row.courses);
      return course
        ? [
            {
              id: row.id,
              name: row.name,
              course: {
                id: course.id,
                year: course.year,
                division: course.division,
                shift: course.shift,
              },
            },
          ]
        : [];
    });
  }

  async getCourses(
    user: AuthUser,
    membership: ActiveMembership,
  ): Promise<CourseSummary[]> {
    const { data, error } = await this.supabase.admin
      .from('courses')
      .select('id, year, division, shift, subjects!inner(id)')
      .eq('school_id', membership.institutionId)
      .eq('subjects.teacher_id', user.id);

    if (error) {
      throw new InternalServerErrorException();
    }

    // The !inner join can repeat a course once per matching subject.
    const courses = new Map<string, CourseSummary>();
    for (const row of (data ?? []) as CourseRow[]) {
      if (!courses.has(row.id)) {
        courses.set(row.id, {
          id: row.id,
          year: row.year,
          division: row.division,
          shift: row.shift,
        });
      }
    }
    return [...courses.values()];
  }

  async getStudents(
    user: AuthUser,
    membership: ActiveMembership,
  ): Promise<StudentSummary[]> {
    const links = await this.supabase.admin
      .from('guardian_links')
      .select('student_id')
      .eq('guardian_id', user.id);

    if (links.error) {
      throw new InternalServerErrorException();
    }

    const studentIds = [
      ...new Set(
        (links.data ?? []).map(
          (link: { student_id: string }) => link.student_id,
        ),
      ),
    ];
    if (studentIds.length === 0) {
      return [];
    }

    const { data, error } = await this.supabase.admin
      .from('enrollments')
      .select(
        'profiles!inner(id, first_name, last_name), courses!inner(id, year, division)',
      )
      .in('student_id', studentIds)
      .eq('courses.school_id', membership.institutionId);

    if (error) {
      throw new InternalServerErrorException();
    }

    return (data ?? []).flatMap((row: EnrollmentRow) => {
      const profile = firstRow(row.profiles);
      const course = firstRow(row.courses);
      return profile && course
        ? [
            {
              id: profile.id,
              firstName: profile.first_name,
              lastName: profile.last_name,
              course: {
                id: course.id,
                year: course.year,
                division: course.division,
              },
            },
          ]
        : [];
    });
  }
}
