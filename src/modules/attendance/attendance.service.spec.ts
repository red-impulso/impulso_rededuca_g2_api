import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { vi } from 'vitest';
import { AuthGuard } from '../../auth/auth.guard.js';
import { SupabaseModule } from '../../supabase/supabase.module.js';
import { SupabaseService } from '../../supabase/supabase.service.js';
import { ATTENDANCE_SAVED_EVENT } from './attendance.service.js';
import { AttendanceModule } from './attendance.module.js';

interface QueryResult {
  data: unknown;
  error: unknown;
}

interface WriteCall {
  table: string;
  method: 'upsert' | 'insert';
  rows: unknown;
}

const PAST_DATE = '2020-01-15';
const FUTURE_DATE = '2999-01-01';

describe('AttendanceService', () => {
  let app: INestApplication<App>;
  let events: EventEmitter2;

  const getUser = vi.fn();
  // Each table keeps a FIFO queue of results; every awaited query consumes one.
  let queues: Record<string, QueryResult[]>;
  let writes: WriteCall[];

  // A thenable stand-in for the supabase query builder: every method returns
  // the chain itself and awaiting it resolves to the next queued result.
  function makeChain(table: string) {
    const chain = {
      select: vi.fn(),
      eq: vi.fn(),
      in: vi.fn(),
      order: vi.fn(),
      maybeSingle: vi.fn(),
      upsert: vi.fn(),
      insert: vi.fn(),
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
      'order',
      'maybeSingle',
    ] as const) {
      chain[method].mockReturnValue(chain);
    }
    for (const method of ['upsert', 'insert'] as const) {
      chain[method].mockImplementation((rows: unknown) => {
        writes.push({ table, method, rows });
        return chain;
      });
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

  const authAs = (id: string, extra: Record<string, unknown> = {}) =>
    getUser.mockResolvedValue({
      data: { user: { id, ...extra } },
      error: null,
    });

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

  const courseExists = () => {
    queues.courses = [{ data: { id: 'course-1' }, error: null }];
  };

  const teacherInCourse = () => {
    queues.subjects = [{ data: { id: 'subject-1' }, error: null }];
  };

  const teacherOutsideCourse = () => {
    queues.subjects = [{ data: null, error: null }];
  };

  const enrolled = (...studentIds: string[]) => {
    queues.enrollments = [
      { data: studentIds.map((student_id) => ({ student_id })), error: null },
    ];
  };

  const takeSheet = (
    entries: { studentId: string; status: string }[],
    date = PAST_DATE,
  ) => ({ courseId: 'course-1', date, entries });

  beforeEach(async () => {
    vi.clearAllMocks();
    queues = {};
    writes = [];
    const module: TestingModule = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot(), SupabaseModule, AttendanceModule],
      providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
    })
      .overrideProvider(SupabaseService)
      .useValue(supabase)
      .compile();

    app = module.createNestApplication();
    await app.init();
    events = module.get(EventEmitter2);
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /attendance', () => {
    it('returns every student of the course with their status or null', async () => {
      authAs('teacher-1');
      memberAs('teacher');
      courseExists();
      teacherInCourse();
      queues.attendance_records = [
        { data: [{ student_id: 'stu-1', status: 'present' }], error: null },
      ];
      queues.enrollments = [
        {
          data: [
            {
              student_id: 'stu-1',
              profiles: { id: 'stu-1', first_name: 'Ana', last_name: 'García' },
            },
            {
              student_id: 'stu-2',
              profiles: { id: 'stu-2', first_name: 'Bruno', last_name: 'Díaz' },
            },
          ],
          error: null,
        },
      ];

      const response = await authed(
        request(app.getHttpServer()).get(
          `/attendance?courseId=course-1&date=${PAST_DATE}`,
        ),
      ).expect(200);

      expect(response.body).toEqual([
        {
          student: { id: 'stu-2', firstName: 'Bruno', lastName: 'Díaz' },
          status: null,
        },
        {
          student: { id: 'stu-1', firstName: 'Ana', lastName: 'García' },
          status: 'present',
        },
      ]);
    });

    it('returns 403 for a teacher without a subject in the course', async () => {
      authAs('teacher-1');
      memberAs('teacher');
      courseExists();
      teacherOutsideCourse();

      await authed(
        request(app.getHttpServer()).get(
          `/attendance?courseId=course-1&date=${PAST_DATE}`,
        ),
      ).expect(403);
    });

    it('returns 404 for a course of another school', async () => {
      authAs('teacher-1');
      memberAs('teacher');
      queues.courses = [{ data: null, error: null }];

      await authed(
        request(app.getHttpServer()).get(
          `/attendance?courseId=course-9&date=${PAST_DATE}`,
        ),
      ).expect(404);
    });

    it('returns 403 for a guardian membership', async () => {
      authAs('guardian-1');
      memberAs('guardian');

      await authed(
        request(app.getHttpServer()).get(
          `/attendance?courseId=course-1&date=${PAST_DATE}`,
        ),
      ).expect(403);
    });

    it('returns 400 for a future date', async () => {
      authAs('teacher-1');
      memberAs('teacher');

      await authed(
        request(app.getHttpServer()).get(
          `/attendance?courseId=course-1&date=${FUTURE_DATE}`,
        ),
      ).expect(400);
    });
  });

  describe('PUT /attendance', () => {
    it('saves the list with recorded_by and emits attendance.saved with the absent students', async () => {
      authAs('teacher-1');
      memberAs('teacher');
      courseExists();
      teacherInCourse();
      enrolled('stu-1', 'stu-2');
      queues.attendance_records = [{ data: null, error: null }];
      const emit = vi.spyOn(events, 'emit');

      const response = await authed(
        request(app.getHttpServer())
          .put('/attendance')
          .send(
            takeSheet([
              { studentId: 'stu-1', status: 'present' },
              { studentId: 'stu-2', status: 'absent' },
            ]),
          ),
      ).expect(200);

      expect(response.body).toEqual({ saved: 2 });
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        table: 'attendance_records',
        method: 'upsert',
        rows: [
          {
            student_id: 'stu-1',
            course_id: 'course-1',
            date: PAST_DATE,
            status: 'present',
            recorded_by: 'teacher-1',
          },
          {
            student_id: 'stu-2',
            course_id: 'course-1',
            date: PAST_DATE,
            status: 'absent',
            recorded_by: 'teacher-1',
          },
        ],
      });
      expect(emit).toHaveBeenCalledWith(
        ATTENDANCE_SAVED_EVENT,
        expect.objectContaining({
          schoolId: 'school-1',
          courseId: 'course-1',
          date: PAST_DATE,
          recordedBy: 'teacher-1',
          absent: ['stu-2'],
        }),
      );
    });

    it('lets an admin take the list without teaching in the course', async () => {
      authAs('admin-1');
      memberAs('admin');
      courseExists();
      enrolled('stu-1');
      queues.attendance_records = [{ data: null, error: null }];

      const response = await authed(
        request(app.getHttpServer())
          .put('/attendance')
          .send(takeSheet([{ studentId: 'stu-1', status: 'late' }])),
      ).expect(200);

      expect(response.body).toEqual({ saved: 1 });
      expect(writes).toHaveLength(1);
    });

    it('returns 403 for a teacher without a subject in the course and saves nothing', async () => {
      authAs('teacher-1');
      memberAs('teacher');
      courseExists();
      teacherOutsideCourse();

      await authed(
        request(app.getHttpServer())
          .put('/attendance')
          .send(takeSheet([{ studentId: 'stu-1', status: 'present' }])),
      ).expect(403);

      expect(writes).toHaveLength(0);
    });

    it('returns 400 for a future date and saves nothing', async () => {
      authAs('teacher-1');
      memberAs('teacher');

      await authed(
        request(app.getHttpServer())
          .put('/attendance')
          .send(
            takeSheet([{ studentId: 'stu-1', status: 'present' }], FUTURE_DATE),
          ),
      ).expect(400);

      expect(writes).toHaveLength(0);
    });

    it.each(['yesterday', '2020-13-40', '15/01/2020'])(
      'returns 400 for an invalid date %s',
      async (date) => {
        authAs('teacher-1');
        memberAs('teacher');

        await authed(
          request(app.getHttpServer())
            .put('/attendance')
            .send(takeSheet([{ studentId: 'stu-1', status: 'present' }], date)),
        ).expect(400);
      },
    );

    it('returns 400 for an unknown status and saves nothing', async () => {
      authAs('teacher-1');
      memberAs('teacher');
      courseExists();
      teacherInCourse();
      enrolled('stu-1');

      await authed(
        request(app.getHttpServer())
          .put('/attendance')
          .send(takeSheet([{ studentId: 'stu-1', status: 'sick' }])),
      ).expect(400);

      expect(writes).toHaveLength(0);
    });

    it('returns 400 for a student of another course and saves nothing', async () => {
      authAs('teacher-1');
      memberAs('teacher');
      courseExists();
      teacherInCourse();
      enrolled('stu-1');

      await authed(
        request(app.getHttpServer())
          .put('/attendance')
          .send(
            takeSheet([
              { studentId: 'stu-1', status: 'present' },
              { studentId: 'stu-other', status: 'absent' },
            ]),
          ),
      ).expect(400);

      expect(writes).toHaveLength(0);
    });

    it('returns 403 for a guardian membership', async () => {
      authAs('guardian-1');
      memberAs('guardian');

      await authed(
        request(app.getHttpServer())
          .put('/attendance')
          .send(takeSheet([{ studentId: 'stu-1', status: 'present' }])),
      ).expect(403);
    });
  });

  describe('GET /students/:studentId/attendance', () => {
    const studentInSchool = () => {
      queues.enrollments = [
        {
          data: [{ course_id: 'course-1', courses: { school_id: 'school-1' } }],
          error: null,
        },
      ];
    };

    const studentRecords = (statuses: string[]) => {
      queues.attendance_records = [
        {
          data: statuses.map((status, i) => ({
            date: `2020-01-${(i + 1).toString().padStart(2, '0')}`,
            status,
          })),
          error: null,
        },
      ];
    };

    it('returns the records and summary to a linked guardian', async () => {
      authAs('guardian-1');
      memberAs('guardian');
      studentInSchool();
      queues.guardian_links = [{ data: { student_id: 'stu-1' }, error: null }];
      studentRecords(['present', 'absent', 'late']);

      const response = await authed(
        request(app.getHttpServer()).get('/students/stu-1/attendance'),
      ).expect(200);

      expect(response.body).toEqual({
        records: [
          { date: '2020-01-01', status: 'present' },
          { date: '2020-01-02', status: 'absent' },
          { date: '2020-01-03', status: 'late' },
        ],
        summary: {
          present: 1,
          absent: 1,
          late: 1,
          justified: 0,
          percentage: 66.7,
        },
      });
    });

    it('returns 403 to a guardian not linked to the student', async () => {
      authAs('guardian-1');
      memberAs('guardian');
      studentInSchool();
      queues.guardian_links = [{ data: null, error: null }];

      await authed(
        request(app.getHttpServer()).get('/students/stu-1/attendance'),
      ).expect(403);
    });

    it('returns 404 for a student of another institution', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.enrollments = [{ data: [], error: null }];

      await authed(
        request(app.getHttpServer()).get('/students/stu-other/attendance'),
      ).expect(404);
    });

    it('returns the records to a teacher with a subject in the student course', async () => {
      authAs('teacher-1');
      memberAs('teacher');
      studentInSchool();
      queues.subjects = [{ data: [{ id: 'subject-1' }], error: null }];
      studentRecords(['present']);

      const response = await authed(
        request(app.getHttpServer()).get('/students/stu-1/attendance'),
      ).expect(200);

      expect(response.body.summary.percentage).toBe(100);
    });

    it.each([
      {
        statuses: ['present', 'present', 'late', 'absent', 'justified'],
        expected: 75,
      },
      { statuses: ['absent', 'absent'], expected: 0 },
      { statuses: ['present', 'present', 'absent'], expected: 66.7 },
      { statuses: ['late'], expected: 100 },
    ])(
      'computes percentage $expected for statuses $statuses',
      async ({ statuses, expected }) => {
        authAs('admin-1');
        memberAs('admin');
        studentInSchool();
        studentRecords(statuses);

        const response = await authed(
          request(app.getHttpServer()).get('/students/stu-1/attendance'),
        ).expect(200);

        expect(response.body.summary.percentage).toBe(expected);
      },
    );

    it('returns null percentage when only justified records exist', async () => {
      authAs('admin-1');
      memberAs('admin');
      studentInSchool();
      studentRecords(['justified', 'justified']);

      const response = await authed(
        request(app.getHttpServer()).get('/students/stu-1/attendance'),
      ).expect(200);

      expect(response.body.summary).toEqual({
        present: 0,
        absent: 0,
        late: 0,
        justified: 2,
        percentage: null,
      });
    });

    it('returns null percentage when the student has no records', async () => {
      authAs('admin-1');
      memberAs('admin');
      studentInSchool();
      studentRecords([]);

      const response = await authed(
        request(app.getHttpServer()).get('/students/stu-1/attendance'),
      ).expect(200);

      expect(response.body).toEqual({
        records: [],
        summary: {
          present: 0,
          absent: 0,
          late: 0,
          justified: 0,
          percentage: null,
        },
      });
    });
  });
});
