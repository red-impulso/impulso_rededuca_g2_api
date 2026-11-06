import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { vi } from 'vitest';
import { AuthGuard } from '../../auth/auth.guard.js';
import { SupabaseModule } from '../../supabase/supabase.module.js';
import { SupabaseService } from '../../supabase/supabase.service.js';
import { DashboardModule } from './dashboard.module.js';

interface QueryResult {
  data: unknown;
  error: unknown;
}

describe('DashboardService', () => {
  let app: INestApplication<App>;

  const getUser = vi.fn();
  // Each table keeps a FIFO queue of results; every awaited query consumes one.
  let queues: Record<string, QueryResult[]>;

  // A thenable stand-in for the supabase query builder: every method returns
  // the chain itself and awaiting it resolves to the next queued result.
  function makeChain(table: string) {
    const chain = {
      select: vi.fn(),
      eq: vi.fn(),
      in: vi.fn(),
      is: vi.fn(),
      order: vi.fn(),
      limit: vi.fn(),
      range: vi.fn(),
      maybeSingle: vi.fn(),
      single: vi.fn(),
      upsert: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      // oxlint-disable-next-line no-thenable -- supabase builders are thenable
      then: (onFulfilled: (value: QueryResult) => unknown) =>
        Promise.resolve(
          queues[table]?.shift() ?? { data: null, error: null },
        ).then(onFulfilled),
    };
    for (const method of [
      'select',
      'eq',
      'in',
      'is',
      'order',
      'limit',
      'range',
      'maybeSingle',
      'single',
      'upsert',
      'insert',
      'update',
    ] as const) {
      chain[method].mockReturnValue(chain);
    }
    return chain;
  }

  const from = vi.fn((table: string) => makeChain(table));

  const supabase = {
    admin: {
      auth: { getUser },
      from,
    },
  };

  const authAs = (id: string) =>
    getUser.mockResolvedValue({ data: { user: { id } }, error: null });

  const memberAs = (role: string) => {
    queues.memberships = [
      {
        data: [{ id: 'm-1', school_id: 'school-1', role }],
        error: null,
      },
    ];
  };

  const authed = (test: request.Test) =>
    test
      .set('Authorization', 'Bearer valid-token')
      .set('X-Institution-Id', 'school-1');

  const recentDate = () => new Date().toISOString().slice(0, 10);

  beforeEach(async () => {
    vi.clearAllMocks();
    queues = {};
    const module: TestingModule = await Test.createTestingModule({
      imports: [SupabaseModule, DashboardModule],
      providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
    })
      .overrideProvider(SupabaseService)
      .useValue(supabase)
      .compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /dashboard', () => {
    it('returns 403 for a teacher membership', async () => {
      authAs('teacher-1');
      memberAs('teacher');

      await authed(request(app.getHttpServer()).get('/dashboard')).expect(403);
    });

    it('returns 403 for a guardian membership', async () => {
      authAs('guardian-1');
      memberAs('guardian');

      await authed(request(app.getHttpServer()).get('/dashboard')).expect(403);
    });

    it('returns null averages and empty lists for an institution without records', async () => {
      authAs('admin-1');
      memberAs('admin');
      // Second memberships read: the dashboard's own count query.
      queues.memberships.push({ data: [], error: null });
      queues.courses = [{ data: [], error: null }];
      queues.subjects = [{ data: [], error: null }];
      queues.grades = [{ data: [], error: null }];
      queues.attendance_records = [{ data: [], error: null }];
      queues.enrollments = [{ data: [], error: null }];

      const response = await authed(
        request(app.getHttpServer()).get('/dashboard'),
      ).expect(200);

      expect(response.body).toEqual({
        students: 0,
        courses: 0,
        teachers: 0,
        attendanceAverage: null,
        lowAttendance: [],
        gradeAverages: [],
      });
    });

    it('reads every page: Supabase returns 1000 rows at most per query', async () => {
      authAs('admin-1');
      memberAs('admin');
      const rows = (count: number, status: string) =>
        Array.from({ length: count }, (_, i) => ({
          student_id: `stu-${i}`,
          status,
          date: recentDate(),
        }));
      queues.memberships.push({ data: [], error: null });
      queues.courses = [{ data: [], error: null }];
      queues.subjects = [{ data: [], error: null }];
      queues.grades = [{ data: [], error: null }];
      queues.attendance_records = [
        { data: rows(1000, 'present'), error: null },
        { data: rows(1000, 'absent'), error: null },
        { data: rows(0, 'absent'), error: null },
      ];
      queues.enrollments = [{ data: [], error: null }];

      const response = await authed(
        request(app.getHttpServer()).get('/dashboard'),
      ).expect(200);

      expect(response.body.attendanceAverage).toBe(50);
      expect(queues.attendance_records).toHaveLength(0);
    });

    it('computes counts, averages, low attendance and grade averages', async () => {
      authAs('director-1');
      memberAs('director');
      // First query consumed by the guard, second by the dashboard counts.
      queues.memberships = [
        {
          data: [{ id: 'm-1', school_id: 'school-1', role: 'director' }],
          error: null,
        },
        {
          data: [
            { role: 'admin' },
            { role: 'teacher' },
            { role: 'student' },
            { role: 'student' },
            { role: 'guardian' },
          ],
          error: null,
        },
      ];
      const course = {
        id: 'course-1',
        year: 1,
        division: 'A',
        shift: 'morning',
      };
      queues.courses = [{ data: [course], error: null }];
      queues.subjects = [
        {
          data: [
            { id: 'subject-2', name: 'Lengua', courses: course },
            { id: 'subject-1', name: 'Matemática', courses: course },
          ],
          error: null,
        },
      ];
      queues.grades = [
        {
          data: [
            { subject_id: 'subject-1', value: 8 },
            { subject_id: 'subject-1', value: 6 },
          ],
          error: null,
        },
      ];
      queues.attendance_records = [
        {
          data: [
            { student_id: 'stu-1', status: 'present', date: recentDate() },
            { student_id: 'stu-1', status: 'absent', date: recentDate() },
            { student_id: 'stu-2', status: 'present', date: recentDate() },
            { student_id: 'stu-2', status: 'present', date: recentDate() },
            // Too old for the 30-day window; still counts for the average.
            { student_id: 'stu-2', status: 'absent', date: '2000-01-01' },
            { student_id: 'stu-3', status: 'justified', date: recentDate() },
          ],
          error: null,
        },
      ];
      queues.enrollments = [
        {
          data: [
            {
              student_id: 'stu-1',
              course_id: 'course-1',
              profiles: {
                id: 'stu-1',
                first_name: 'Ana',
                last_name: 'García',
              },
            },
            {
              student_id: 'stu-2',
              course_id: 'course-1',
              profiles: {
                id: 'stu-2',
                first_name: 'Bruno',
                last_name: 'Díaz',
              },
            },
            {
              student_id: 'stu-3',
              course_id: 'course-1',
              profiles: {
                id: 'stu-3',
                first_name: 'Carla',
                last_name: 'López',
              },
            },
          ],
          error: null,
        },
      ];

      const response = await authed(
        request(app.getHttpServer()).get('/dashboard'),
      ).expect(200);

      expect(response.body).toEqual({
        students: 2,
        courses: 1,
        teachers: 1,
        // attended 3 (present/late) of 5 countable records.
        attendanceAverage: 60,
        lowAttendance: [
          {
            student: { id: 'stu-1', firstName: 'Ana', lastName: 'García' },
            course,
            percentage: 50,
          },
        ],
        gradeAverages: [
          {
            subject: { id: 'subject-2', name: 'Lengua' },
            course,
            average: null,
          },
          {
            subject: { id: 'subject-1', name: 'Matemática' },
            course,
            average: 7,
          },
        ],
      });
    });

    it('drops students at 85% or above and justified-only students from lowAttendance', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.memberships = [
        {
          data: [{ id: 'm-1', school_id: 'school-1', role: 'admin' }],
          error: null,
        },
        { data: [], error: null },
      ];
      const course = {
        id: 'course-1',
        year: 1,
        division: 'A',
        shift: 'morning',
      };
      queues.courses = [{ data: [course], error: null }];
      queues.subjects = [{ data: [], error: null }];
      queues.grades = [{ data: [], error: null }];
      queues.attendance_records = [
        {
          data: [
            // stu-1: 12 present + 1 late + 2 absent = 13/15 = 86.7 → excluded.
            ...Array.from({ length: 12 }, () => ({
              student_id: 'stu-1',
              status: 'present',
              date: recentDate(),
            })),
            { student_id: 'stu-1', status: 'late', date: recentDate() },
            { student_id: 'stu-1', status: 'absent', date: recentDate() },
            { student_id: 'stu-1', status: 'absent', date: recentDate() },
            // stu-2: justified only → no countable records → excluded.
            { student_id: 'stu-2', status: 'justified', date: recentDate() },
            // stu-3: exactly 85 → excluded (threshold is < 85).
            ...Array.from({ length: 17 }, () => ({
              student_id: 'stu-3',
              status: 'present',
              date: recentDate(),
            })),
            ...Array.from({ length: 3 }, () => ({
              student_id: 'stu-3',
              status: 'absent',
              date: recentDate(),
            })),
          ],
          error: null,
        },
      ];
      queues.enrollments = [
        {
          data: ['stu-1', 'stu-2', 'stu-3'].map((id) => ({
            student_id: id,
            course_id: 'course-1',
            profiles: { id, first_name: id, last_name: 'X' },
          })),
          error: null,
        },
      ];

      const response = await authed(
        request(app.getHttpServer()).get('/dashboard'),
      ).expect(200);

      expect(response.body.lowAttendance).toEqual([]);
    });
  });
});
