import { Injectable, InternalServerErrorException } from '@nestjs/common';
import type { AuthUser } from '../../auth/auth.guard.js';
import type { Membership as ActiveMembership } from '../../auth/membership.guard.js';
import { SupabaseService } from '../../supabase/supabase.service.js';

export interface CourseSummary {
  id: string;
  year: number;
  division: string;
  shift: string;
}

export interface LowAttendanceRow {
  student: { id: string; firstName: string | null; lastName: string | null };
  course: CourseSummary;
  percentage: number;
}

export interface GradeAverageRow {
  subject: { id: string; name: string };
  course: CourseSummary;
  average: number | null;
}

export interface DashboardResponse {
  students: number;
  courses: number;
  teachers: number;
  attendanceAverage: number | null;
  lowAttendance: LowAttendanceRow[];
  gradeAverages: GradeAverageRow[];
}

interface SubjectRow {
  id: string;
  name: string;
  courses:
    | (CourseSummary & { school_id: string })
    | (CourseSummary & { school_id: string })[]
    | null;
}

interface AttendanceRow {
  student_id: string;
  status: 'present' | 'absent' | 'late' | 'justified';
  date: string;
}

interface DashboardEnrollmentRow {
  student_id: string;
  course_id: string;
  profiles:
    | { id: string; first_name: string | null; last_name: string | null }
    | { id: string; first_name: string | null; last_name: string | null }[]
    | null;
}

const LOW_ATTENDANCE_THRESHOLD = 85;
const LOW_ATTENDANCE_WINDOW_DAYS = 30;

function firstRow<T>(value: T | T[] | null | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : (value ?? undefined);
}

// (present + late) / (present + late + absent), 1 decimal; null when nothing
// counts. Justified records never count.
function attendancePercentage(
  statuses: { status: AttendanceRow['status'] }[],
): number | null {
  let attended = 0;
  let absent = 0;
  for (const { status } of statuses) {
    if (status === 'present' || status === 'late') {
      attended += 1;
    } else if (status === 'absent') {
      absent += 1;
    }
  }
  const countable = attended + absent;
  return countable === 0
    ? null
    : Math.round((attended / countable) * 1000) / 10;
}

@Injectable()
export class DashboardService {
  constructor(private readonly supabase: SupabaseService) {}

  async getDashboard(
    _user: AuthUser,
    membership: ActiveMembership,
  ): Promise<DashboardResponse> {
    const schoolId = membership.institutionId;
    const cutoff = new Date(
      Date.now() - LOW_ATTENDANCE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    )
      .toISOString()
      .slice(0, 10);

    const [memberships, courses, subjects, grades, attendance, enrollments] =
      await Promise.all([
        this.supabase.admin
          .from('memberships')
          .select('role')
          .eq('school_id', schoolId),
        this.supabase.admin
          .from('courses')
          .select('id, year, division, shift')
          .eq('school_id', schoolId),
        this.supabase.admin
          .from('subjects')
          .select(
            'id, name, courses!inner(id, year, division, shift, school_id)',
          )
          .eq('courses.school_id', schoolId),
        this.supabase.admin
          .from('grades')
          .select('value, subject_id, subjects!inner(courses!inner(school_id))')
          .eq('subjects.courses.school_id', schoolId),
        this.supabase.admin
          .from('attendance_records')
          .select('student_id, status, date, courses!inner(school_id)')
          .eq('courses.school_id', schoolId),
        this.supabase.admin
          .from('enrollments')
          .select(
            'student_id, course_id, profiles!inner(id, first_name, last_name), courses!inner(school_id)',
          )
          .eq('courses.school_id', schoolId),
      ]);

    for (const result of [
      memberships,
      courses,
      subjects,
      grades,
      attendance,
      enrollments,
    ]) {
      if (result.error) {
        throw new InternalServerErrorException();
      }
    }

    const roleCounts = new Map<string, number>();
    for (const row of (memberships.data ?? []) as { role: string }[]) {
      roleCounts.set(row.role, (roleCounts.get(row.role) ?? 0) + 1);
    }

    const courseById = new Map(
      ((courses.data ?? []) as CourseSummary[]).map((course) => [
        course.id,
        course,
      ]),
    );

    const attendanceRows = (attendance.data ?? []) as AttendanceRow[];
    const recentByStudent = new Map<string, AttendanceRow[]>();
    for (const row of attendanceRows) {
      if (row.date >= cutoff) {
        const list = recentByStudent.get(row.student_id) ?? [];
        list.push(row);
        recentByStudent.set(row.student_id, list);
      }
    }

    // Student profile and course for everyone enrolled in the school.
    const studentInfo = new Map<
      string,
      { firstName: string | null; lastName: string | null; courseId: string }
    >();
    for (const row of (enrollments.data ?? []) as DashboardEnrollmentRow[]) {
      const profile = firstRow(row.profiles);
      if (profile && !studentInfo.has(row.student_id)) {
        studentInfo.set(row.student_id, {
          firstName: profile.first_name,
          lastName: profile.last_name,
          courseId: row.course_id,
        });
      }
    }

    const lowAttendance: LowAttendanceRow[] = [...recentByStudent]
      .flatMap(([studentId, rows]) => {
        const percentage = attendancePercentage(rows);
        const info = studentInfo.get(studentId);
        const course = info ? courseById.get(info.courseId) : undefined;
        return percentage !== null &&
          percentage < LOW_ATTENDANCE_THRESHOLD &&
          info &&
          course
          ? [
              {
                student: {
                  id: studentId,
                  firstName: info.firstName,
                  lastName: info.lastName,
                },
                course,
                percentage,
              },
            ]
          : [];
      })
      .sort((a, b) => a.percentage - b.percentage);

    const gradesBySubject = new Map<string, number[]>();
    for (const row of (grades.data ?? []) as {
      subject_id: string;
      value: number;
    }[]) {
      const list = gradesBySubject.get(row.subject_id) ?? [];
      list.push(Number(row.value));
      gradesBySubject.set(row.subject_id, list);
    }

    const gradeAverages: GradeAverageRow[] = (
      (subjects.data ?? []) as SubjectRow[]
    )
      .flatMap((row) => {
        const course = firstRow(row.courses);
        if (!course) {
          return [];
        }
        const values = gradesBySubject.get(row.id) ?? [];
        return [
          {
            subject: { id: row.id, name: row.name },
            course: {
              id: course.id,
              year: course.year,
              division: course.division,
              shift: course.shift,
            },
            average:
              values.length === 0
                ? null
                : Math.round(
                    (values.reduce((sum, v) => sum + v, 0) / values.length) *
                      10,
                  ) / 10,
          },
        ];
      })
      .sort((a, b) => a.subject.name.localeCompare(b.subject.name));

    return {
      students: roleCounts.get('student') ?? 0,
      courses: courseById.size,
      teachers: roleCounts.get('teacher') ?? 0,
      attendanceAverage: attendancePercentage(attendanceRows),
      lowAttendance,
      gradeAverages,
    };
  }
}
