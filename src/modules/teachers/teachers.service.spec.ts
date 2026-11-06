import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { vi } from 'vitest';
import { AuthGuard } from '../../auth/auth.guard.js';
import { SupabaseModule } from '../../supabase/supabase.module.js';
import { SupabaseService } from '../../supabase/supabase.service.js';
import { TeachersModule } from './teachers.module.js';

interface QueryResult {
  data: unknown;
  error: unknown;
}

interface WriteCall {
  table: string;
  method: 'insert' | 'update';
  rows: unknown;
}

const SUBJECT_ID = '33333333-3333-4333-8333-333333333333';
const TEACHER_MEMBERSHIP_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_MEMBERSHIP_ID = '55555555-5555-4555-8555-555555555555';

describe('TeachersService', () => {
  let app: INestApplication<App>;

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
      limit: vi.fn(),
      maybeSingle: vi.fn(),
      single: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
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
      'limit',
      'maybeSingle',
      'single',
      'delete',
    ] as const) {
      chain[method].mockReturnValue(chain);
    }
    for (const method of ['insert', 'update'] as const) {
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

  beforeEach(async () => {
    vi.clearAllMocks();
    queues = {};
    writes = [];
    const module: TestingModule = await Test.createTestingModule({
      imports: [SupabaseModule, TeachersModule],
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

  describe('GET /teachers', () => {
    it('lists teacher memberships with their subjects', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.memberships.push({
        data: [
          {
            id: TEACHER_MEMBERSHIP_ID,
            user_id: 'teacher-user-1',
            profiles: { full_name: 'Laura Gómez' },
          },
        ],
        error: null,
      });
      queues.subjects = [
        {
          data: [
            {
              id: SUBJECT_ID,
              name: 'Matemática',
              teacher_id: 'teacher-user-1',
              courses: {
                id: 'course-1',
                year: 1,
                division: 'A',
                shift: 'morning',
              },
            },
          ],
          error: null,
        },
      ];

      const response = await authed(
        request(app.getHttpServer()).get('/teachers'),
      ).expect(200);

      expect(response.body).toEqual([
        {
          id: TEACHER_MEMBERSHIP_ID,
          fullName: 'Laura Gómez',
          subjects: [
            {
              id: SUBJECT_ID,
              name: 'Matemática',
              course: {
                id: 'course-1',
                year: 1,
                division: 'A',
                shift: 'morning',
              },
            },
          ],
        },
      ]);
    });

    it('returns an empty list when there are no teachers', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.memberships.push({ data: [], error: null });

      const response = await authed(
        request(app.getHttpServer()).get('/teachers'),
      ).expect(200);

      expect(response.body).toEqual([]);
    });

    it.each(['teacher', 'guardian'])('returns 403 for a %s', async (role) => {
      authAs(`${role}-1`);
      memberAs(role);

      await authed(request(app.getHttpServer()).get('/teachers')).expect(403);
    });
  });

  describe('PUT /subjects/:id/teacher', () => {
    it('assigns a teacher membership to the subject', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.subjects = [
        { data: { id: SUBJECT_ID }, error: null },
        {
          data: {
            id: SUBJECT_ID,
            name: 'Matemática',
            course_id: 'course-1',
            teacher_id: 'teacher-user-1',
          },
          error: null,
        },
      ];
      queues.memberships.push(
        {
          data: {
            id: TEACHER_MEMBERSHIP_ID,
            user_id: 'teacher-user-1',
            role: 'teacher',
          },
          error: null,
        },
        {
          data: { id: TEACHER_MEMBERSHIP_ID },
          error: null,
        },
      );

      const response = await authed(
        request(app.getHttpServer())
          .put(`/subjects/${SUBJECT_ID}/teacher`)
          .send({ teacherMembershipId: TEACHER_MEMBERSHIP_ID }),
      ).expect(200);

      expect(writes[0]).toMatchObject({
        table: 'subjects',
        method: 'update',
        rows: { teacher_id: 'teacher-user-1' },
      });
      expect(response.body).toMatchObject({
        id: SUBJECT_ID,
        teacherMembershipId: TEACHER_MEMBERSHIP_ID,
      });
    });

    it('unassigns the teacher when teacherMembershipId is null', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.subjects = [
        { data: { id: SUBJECT_ID }, error: null },
        {
          data: {
            id: SUBJECT_ID,
            name: 'Matemática',
            course_id: 'course-1',
            teacher_id: null,
          },
          error: null,
        },
      ];

      const response = await authed(
        request(app.getHttpServer())
          .put(`/subjects/${SUBJECT_ID}/teacher`)
          .send({ teacherMembershipId: null }),
      ).expect(200);

      expect(writes[0].rows).toEqual({ teacher_id: null });
      expect(response.body.teacherMembershipId).toBeNull();
    });

    it('returns 400 when the membership is not a teacher', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.subjects = [{ data: { id: SUBJECT_ID }, error: null }];
      queues.memberships.push({
        data: {
          id: OTHER_MEMBERSHIP_ID,
          user_id: 'guardian-1',
          role: 'guardian',
        },
        error: null,
      });

      const response = await authed(
        request(app.getHttpServer())
          .put(`/subjects/${SUBJECT_ID}/teacher`)
          .send({ teacherMembershipId: OTHER_MEMBERSHIP_ID }),
      ).expect(400);

      expect(response.body.message).toContain('no corresponde a un docente');
      expect(writes).toHaveLength(0);
    });

    it('returns 400 when the membership belongs to another institution', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.subjects = [{ data: { id: SUBJECT_ID }, error: null }];
      queues.memberships.push({ data: null, error: null });

      await authed(
        request(app.getHttpServer())
          .put(`/subjects/${SUBJECT_ID}/teacher`)
          .send({ teacherMembershipId: OTHER_MEMBERSHIP_ID }),
      ).expect(400);

      expect(writes).toHaveLength(0);
    });

    it('returns 400 when teacherMembershipId is missing', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.subjects = [{ data: { id: SUBJECT_ID }, error: null }];

      await authed(
        request(app.getHttpServer())
          .put(`/subjects/${SUBJECT_ID}/teacher`)
          .send({}),
      ).expect(400);

      expect(writes).toHaveLength(0);
    });

    it('returns 404 for a subject of another institution', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.subjects = [{ data: null, error: null }];

      await authed(
        request(app.getHttpServer())
          .put(`/subjects/${SUBJECT_ID}/teacher`)
          .send({ teacherMembershipId: TEACHER_MEMBERSHIP_ID }),
      ).expect(404);
    });
  });

  it('returns 401 without a token', () => {
    return request(app.getHttpServer()).get('/teachers').expect(401);
  });
});
