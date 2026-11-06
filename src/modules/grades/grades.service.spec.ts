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
import { GRADES_SAVED_EVENT } from './grades.service.js';
import { GradesModule } from './grades.module.js';

interface QueryResult {
  data: unknown;
  error: unknown;
}

interface WriteCall {
  table: string;
  method: 'upsert' | 'insert';
  rows: unknown;
}

describe('GradesService', () => {
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

  const teacherSubject = () => {
    queues.subjects = [
      {
        data: {
          id: 'subject-1',
          teacher_id: 'teacher-1',
          course_id: 'course-1',
          courses: { id: 'course-1', school_id: 'school-1' },
        },
        error: null,
      },
    ];
  };

  const periodExists = () => {
    queues.periods = [{ data: { id: 'period-1' }, error: null }];
  };

  const enrolled = (...studentIds: string[]) => {
    queues.enrollments = [
      { data: studentIds.map((student_id) => ({ student_id })), error: null },
    ];
  };

  const sheet = (entries: { studentId: string; value: number | null }[]) => ({
    subjectId: 'subject-1',
    periodId: 'period-1',
    entries,
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    queues = {};
    writes = [];
    const module: TestingModule = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot(), SupabaseModule, GradesModule],
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

  describe('GET /grading-periods', () => {
    it('returns the school periods for any member', async () => {
      authAs('teacher-1');
      memberAs('teacher');
      queues.periods = [
        {
          data: [
            {
              id: 'period-1',
              name: '1.er trimestre',
              start_date: '2026-03-02',
              end_date: '2026-06-12',
            },
          ],
          error: null,
        },
      ];

      const response = await authed(
        request(app.getHttpServer()).get('/grading-periods'),
      ).expect(200);

      expect(response.body).toEqual([
        {
          id: 'period-1',
          name: '1.er trimestre',
          startDate: '2026-03-02',
          endDate: '2026-06-12',
        },
      ]);
    });

    it('returns 401 without a token and 400 without the institution header', async () => {
      await request(app.getHttpServer()).get('/grading-periods').expect(401);

      authAs('teacher-1');
      await request(app.getHttpServer())
        .get('/grading-periods')
        .set('Authorization', 'Bearer valid-token')
        .expect(400);
    });
  });

  describe('GET /grades', () => {
    it('returns every student of the course with their grade or null', async () => {
      authAs('teacher-1');
      memberAs('teacher');
      teacherSubject();
      periodExists();
      queues.enrollments = [
        {
          data: [
            {
              student_id: 'stu-1',
              profiles: {
                id: 'stu-1',
                first_name: 'Ana',
                last_name: 'García',
              },
            },
            {
              student_id: 'stu-2',
              profiles: {
                id: 'stu-2',
                first_name: 'Bruno',
                last_name: 'Díaz',
              },
            },
          ],
          error: null,
        },
      ];
      queues.grades = [
        { data: [{ id: 'g-1', student_id: 'stu-1', value: 8.5 }], error: null },
      ];

      const response = await authed(
        request(app.getHttpServer()).get(
          '/grades?subjectId=subject-1&periodId=period-1',
        ),
      ).expect(200);

      expect(response.body).toEqual([
        {
          student: { id: 'stu-2', firstName: 'Bruno', lastName: 'Díaz' },
          value: null,
        },
        {
          student: { id: 'stu-1', firstName: 'Ana', lastName: 'García' },
          value: 8.5,
        },
      ]);
    });

    it('returns 403 for a teacher of another subject', async () => {
      authAs('teacher-1');
      memberAs('teacher');
      queues.subjects = [
        {
          data: {
            id: 'subject-1',
            teacher_id: 'teacher-2',
            course_id: 'course-1',
            courses: { id: 'course-1', school_id: 'school-1' },
          },
          error: null,
        },
      ];

      await authed(
        request(app.getHttpServer()).get(
          '/grades?subjectId=subject-1&periodId=period-1',
        ),
      ).expect(403);
    });

    it('returns 404 for a subject of another school', async () => {
      authAs('teacher-1');
      memberAs('teacher');
      queues.subjects = [{ data: null, error: null }];

      await authed(
        request(app.getHttpServer()).get(
          '/grades?subjectId=subject-9&periodId=period-1',
        ),
      ).expect(404);
    });

    it('returns 403 for a non-teacher membership', async () => {
      authAs('guardian-1');
      memberAs('guardian');

      await authed(
        request(app.getHttpServer()).get(
          '/grades?subjectId=subject-1&periodId=period-1',
        ),
      ).expect(403);
    });

    it('returns 400 without subjectId and periodId', async () => {
      authAs('teacher-1');
      memberAs('teacher');

      await authed(request(app.getHttpServer()).get('/grades')).expect(400);
    });
  });

  describe('PUT /grades', () => {
    it('saves valid grades, logs the changes and emits grades.saved', async () => {
      authAs('teacher-1');
      memberAs('teacher');
      teacherSubject();
      periodExists();
      enrolled('stu-1', 'stu-2');
      queues.grades = [
        // Existing grades: stu-1 keeps 7 (unchanged), stu-2 has none.
        {
          data: [{ id: 'g-1', student_id: 'stu-1', value: 7 }],
          error: null,
        },
        // Upsert result for the new grade.
        { data: [{ id: 'g-2', student_id: 'stu-2' }], error: null },
      ];
      queues.grade_changes = [{ data: null, error: null }];
      const emit = vi.spyOn(events, 'emit');

      const response = await authed(
        request(app.getHttpServer())
          .put('/grades')
          .send(
            sheet([
              { studentId: 'stu-1', value: 7 },
              { studentId: 'stu-2', value: 9 },
            ]),
          ),
      ).expect(200);

      expect(response.body).toEqual({ saved: 1 });
      expect(writes).toHaveLength(2);
      expect(writes[0]).toMatchObject({
        table: 'grades',
        method: 'upsert',
        rows: [
          {
            student_id: 'stu-2',
            subject_id: 'subject-1',
            period_id: 'period-1',
            value: 9,
            updated_by: 'teacher-1',
          },
        ],
      });
      expect(writes[1]).toMatchObject({
        table: 'grade_changes',
        method: 'insert',
        rows: [
          {
            grade_id: 'g-2',
            previous_value: null,
            new_value: 9,
            changed_by: 'teacher-1',
          },
        ],
      });
      expect(emit).toHaveBeenCalledWith(
        GRADES_SAVED_EVENT,
        expect.objectContaining({
          subjectId: 'subject-1',
          periodId: 'period-1',
          saved: 1,
          updatedBy: 'teacher-1',
        }),
      );
    });

    it('saving the same sheet twice writes nothing and logs no changes', async () => {
      authAs('teacher-1');
      memberAs('teacher');
      teacherSubject();
      periodExists();
      enrolled('stu-1');
      queues.grades = [
        { data: [{ id: 'g-1', student_id: 'stu-1', value: 7 }], error: null },
      ];

      const response = await authed(
        request(app.getHttpServer())
          .put('/grades')
          .send(sheet([{ studentId: 'stu-1', value: 7 }])),
      ).expect(200);

      expect(response.body).toEqual({ saved: 0 });
      expect(writes).toHaveLength(0);
    });

    it('logs a grade change only for the grade that changed', async () => {
      authAs('teacher-1');
      memberAs('teacher');
      teacherSubject();
      periodExists();
      enrolled('stu-1', 'stu-2');
      queues.grades = [
        {
          data: [
            { id: 'g-1', student_id: 'stu-1', value: 7 },
            { id: 'g-2', student_id: 'stu-2', value: 6 },
          ],
          error: null,
        },
        { data: [{ id: 'g-2', student_id: 'stu-2' }], error: null },
      ];
      queues.grade_changes = [{ data: null, error: null }];

      const response = await authed(
        request(app.getHttpServer())
          .put('/grades')
          .send(
            sheet([
              { studentId: 'stu-1', value: 7 },
              { studentId: 'stu-2', value: 8 },
            ]),
          ),
      ).expect(200);

      expect(response.body).toEqual({ saved: 1 });
      expect(writes[1]).toMatchObject({
        table: 'grade_changes',
        method: 'insert',
        rows: [
          {
            grade_id: 'g-2',
            previous_value: 6,
            new_value: 8,
            changed_by: 'teacher-1',
          },
        ],
      });
    });

    it.each([0, 11, 'abc', 7.123])(
      'returns 400 and saves nothing when a value is %s',
      async (value) => {
        authAs('teacher-1');
        memberAs('teacher');
        teacherSubject();
        periodExists();
        enrolled('stu-1', 'stu-2');
        queues.grades = [{ data: [], error: null }];

        await authed(
          request(app.getHttpServer())
            .put('/grades')
            .send(
              sheet([
                { studentId: 'stu-1', value: 8 },
                { studentId: 'stu-2', value: value as number },
              ]),
            ),
        ).expect(400);

        expect(writes).toHaveLength(0);
      },
    );

    it('value null does not save or delete anything', async () => {
      authAs('teacher-1');
      memberAs('teacher');
      teacherSubject();
      periodExists();
      enrolled('stu-1');
      queues.grades = [{ data: [], error: null }];

      const response = await authed(
        request(app.getHttpServer())
          .put('/grades')
          .send(sheet([{ studentId: 'stu-1', value: null }])),
      ).expect(200);

      expect(response.body).toEqual({ saved: 0 });
      expect(writes).toHaveLength(0);
    });

    it('returns 400 for a student of another course and saves nothing', async () => {
      authAs('teacher-1');
      memberAs('teacher');
      teacherSubject();
      periodExists();
      enrolled('stu-1');
      queues.grades = [{ data: [], error: null }];

      await authed(
        request(app.getHttpServer())
          .put('/grades')
          .send(
            sheet([
              { studentId: 'stu-1', value: 8 },
              { studentId: 'stu-other-course', value: 9 },
            ]),
          ),
      ).expect(400);

      expect(writes).toHaveLength(0);
    });

    it('returns 403 for a teacher of another subject', async () => {
      authAs('teacher-1');
      memberAs('teacher');
      queues.subjects = [
        {
          data: {
            id: 'subject-1',
            teacher_id: 'teacher-2',
            course_id: 'course-1',
            courses: { id: 'course-1', school_id: 'school-1' },
          },
          error: null,
        },
      ];

      await authed(
        request(app.getHttpServer())
          .put('/grades')
          .send(sheet([{ studentId: 'stu-1', value: 8 }])),
      ).expect(403);

      expect(writes).toHaveLength(0);
    });

    it('returns 403 for a non-teacher membership', async () => {
      authAs('admin-1');
      memberAs('admin');

      await authed(
        request(app.getHttpServer())
          .put('/grades')
          .send(sheet([{ studentId: 'stu-1', value: 8 }])),
      ).expect(403);
    });

    it('returns 400 for a malformed body', async () => {
      authAs('teacher-1');
      memberAs('teacher');

      await authed(
        request(app.getHttpServer())
          .put('/grades')
          .send({ subjectId: 'subject-1' }),
      ).expect(400);
    });
  });
});
