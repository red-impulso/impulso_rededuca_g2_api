import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { vi } from 'vitest';
import { AuthGuard } from '../../auth/auth.guard.js';
import { SupabaseModule } from '../../supabase/supabase.module.js';
import { SupabaseService } from '../../supabase/supabase.service.js';
import { GradesModule } from '../grades/grades.module.js';
import { GuardiansModule } from './guardians.module.js';

interface QueryResult {
  data: unknown;
  error: unknown;
}

interface WriteCall {
  table: string;
  method: 'insert' | 'update' | 'delete';
  rows: unknown;
}

const STUDENT_ID = '11111111-1111-4111-8111-111111111111';
const GUARDIAN_MEMBERSHIP_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_MEMBERSHIP_ID = '66666666-6666-4666-8666-666666666666';

const enrolledRow = () => ({
  course_id: 'course-1',
  courses: { school_id: 'school-1' },
});

const guardianMembershipRow = (over: Record<string, unknown> = {}) => ({
  id: GUARDIAN_MEMBERSHIP_ID,
  user_id: 'guardian-user-1',
  role: 'guardian',
  profiles: { full_name: 'María Fernández' },
  ...over,
});

describe('GuardiansService', () => {
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
    ] as const) {
      chain[method].mockReturnValue(chain);
    }
    for (const method of ['insert', 'update', 'delete'] as const) {
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
      imports: [
        EventEmitterModule.forRoot(),
        SupabaseModule,
        GuardiansModule,
        GradesModule,
      ],
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

  describe('GET /guardians', () => {
    it.each(['admin', 'director'])(
      'lists the guardians of the institution for %s, by name',
      async (role) => {
        authAs('user-1');
        memberAs(role);
        queues.memberships.push({
          data: [
            guardianMembershipRow({
              id: 'g-2',
              profiles: { full_name: 'Zulema Ruiz' },
            }),
            guardianMembershipRow({
              id: 'g-1',
              profiles: { full_name: 'Ana Díaz' },
            }),
          ],
          error: null,
        });

        const response = await authed(
          request(app.getHttpServer()).get('/guardians'),
        ).expect(200);

        expect(response.body).toEqual([
          { id: 'g-1', fullName: 'Ana Díaz' },
          { id: 'g-2', fullName: 'Zulema Ruiz' },
        ]);
      },
    );

    it('returns 500 when the query fails', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.memberships.push({ data: null, error: { message: 'boom' } });

      await authed(request(app.getHttpServer()).get('/guardians')).expect(500);
    });

    it.each(['teacher', 'guardian', 'student'])(
      'returns 403 for the %s role',
      async (role) => {
        authAs('user-1');
        memberAs(role);

        await authed(request(app.getHttpServer()).get('/guardians')).expect(403);
      },
    );
  });

  describe('GET /students/:id/guardians', () => {
    it('lists the guardians linked to the student', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.enrollments = [{ data: [enrolledRow()], error: null }];
      queues.guardian_links = [
        { data: [{ guardian_id: 'guardian-user-1' }], error: null },
      ];
      queues.memberships.push({
        data: [guardianMembershipRow()],
        error: null,
      });

      const response = await authed(
        request(app.getHttpServer()).get(`/students/${STUDENT_ID}/guardians`),
      ).expect(200);

      expect(response.body).toEqual([
        { id: GUARDIAN_MEMBERSHIP_ID, fullName: 'María Fernández' },
      ]);
    });

    it('returns an empty list when the student has no guardians', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.enrollments = [{ data: [enrolledRow()], error: null }];
      queues.guardian_links = [{ data: [], error: null }];

      const response = await authed(
        request(app.getHttpServer()).get(`/students/${STUDENT_ID}/guardians`),
      ).expect(200);

      expect(response.body).toEqual([]);
    });

    it('returns 404 for a student of another institution', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.enrollments = [{ data: [], error: null }];

      await authed(
        request(app.getHttpServer()).get(`/students/${STUDENT_ID}/guardians`),
      ).expect(404);
    });

    it.each(['teacher', 'guardian'])('returns 403 for a %s', async (role) => {
      authAs(`${role}-1`);
      memberAs(role);

      await authed(
        request(app.getHttpServer()).get(`/students/${STUDENT_ID}/guardians`),
      ).expect(403);
    });
  });

  describe('POST /students/:id/guardians', () => {
    it('links a guardian to the student', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.enrollments = [{ data: [enrolledRow()], error: null }];
      queues.memberships.push({
        data: guardianMembershipRow(),
        error: null,
      });
      queues.guardian_links = [{ data: null, error: null }];

      const response = await authed(
        request(app.getHttpServer())
          .post(`/students/${STUDENT_ID}/guardians`)
          .send({ guardianMembershipId: GUARDIAN_MEMBERSHIP_ID }),
      ).expect(201);

      expect(writes[0]).toMatchObject({
        table: 'guardian_links',
        method: 'insert',
        rows: { guardian_id: 'guardian-user-1', student_id: STUDENT_ID },
      });
      expect(response.body).toMatchObject({
        id: GUARDIAN_MEMBERSHIP_ID,
        fullName: 'María Fernández',
      });
    });

    it('returns 409 when the guardian is already linked', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.enrollments = [{ data: [enrolledRow()], error: null }];
      queues.memberships.push({
        data: guardianMembershipRow(),
        error: null,
      });
      queues.guardian_links = [
        { data: null, error: { code: '23505', message: 'duplicate key' } },
      ];

      await authed(
        request(app.getHttpServer())
          .post(`/students/${STUDENT_ID}/guardians`)
          .send({ guardianMembershipId: GUARDIAN_MEMBERSHIP_ID }),
      ).expect(409);
    });

    it('returns 400 when the membership is not a guardian', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.enrollments = [{ data: [enrolledRow()], error: null }];
      queues.memberships.push({
        data: guardianMembershipRow({
          id: OTHER_MEMBERSHIP_ID,
          role: 'teacher',
        }),
        error: null,
      });

      const response = await authed(
        request(app.getHttpServer())
          .post(`/students/${STUDENT_ID}/guardians`)
          .send({ guardianMembershipId: OTHER_MEMBERSHIP_ID }),
      ).expect(400);

      expect(response.body.message).toContain('no corresponde a un tutor');
      expect(writes).toHaveLength(0);
    });

    it('returns 400 when the membership belongs to another institution', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.enrollments = [{ data: [enrolledRow()], error: null }];
      queues.memberships.push({ data: null, error: null });

      await authed(
        request(app.getHttpServer())
          .post(`/students/${STUDENT_ID}/guardians`)
          .send({ guardianMembershipId: OTHER_MEMBERSHIP_ID }),
      ).expect(400);

      expect(writes).toHaveLength(0);
    });

    it('returns 400 when guardianMembershipId is missing', async () => {
      authAs('admin-1');
      memberAs('admin');

      await authed(
        request(app.getHttpServer())
          .post(`/students/${STUDENT_ID}/guardians`)
          .send({}),
      ).expect(400);

      expect(writes).toHaveLength(0);
    });

    it('returns 404 for a student of another institution', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.enrollments = [{ data: [], error: null }];

      await authed(
        request(app.getHttpServer())
          .post(`/students/${STUDENT_ID}/guardians`)
          .send({ guardianMembershipId: GUARDIAN_MEMBERSHIP_ID }),
      ).expect(404);
    });
  });

  describe('DELETE /students/:id/guardians/:guardianMembershipId', () => {
    it('unlinks the guardian from the student', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.enrollments = [{ data: [enrolledRow()], error: null }];
      queues.memberships.push({
        data: guardianMembershipRow(),
        error: null,
      });
      queues.guardian_links = [
        { data: [{ guardian_id: 'guardian-user-1' }], error: null },
      ];

      const response = await authed(
        request(app.getHttpServer()).delete(
          `/students/${STUDENT_ID}/guardians/${GUARDIAN_MEMBERSHIP_ID}`,
        ),
      ).expect(200);

      expect(response.body).toEqual({ deleted: true });
      expect(writes[0]).toMatchObject({
        table: 'guardian_links',
        method: 'delete',
      });
    });

    it('returns 404 when the link does not exist', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.enrollments = [{ data: [enrolledRow()], error: null }];
      queues.memberships.push({
        data: guardianMembershipRow(),
        error: null,
      });
      queues.guardian_links = [{ data: [], error: null }];

      await authed(
        request(app.getHttpServer()).delete(
          `/students/${STUDENT_ID}/guardians/${GUARDIAN_MEMBERSHIP_ID}`,
        ),
      ).expect(404);
    });

    it('after unlinking, the guardian can no longer see the student grades', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.enrollments = [{ data: [enrolledRow()], error: null }];
      queues.memberships.push({
        data: guardianMembershipRow(),
        error: null,
      });
      queues.guardian_links = [
        { data: [{ guardian_id: 'guardian-user-1' }], error: null },
      ];

      await authed(
        request(app.getHttpServer()).delete(
          `/students/${STUDENT_ID}/guardians/${GUARDIAN_MEMBERSHIP_ID}`,
        ),
      ).expect(200);

      // The deleted row is gone, so the grades check finds no link.
      authAs('guardian-user-1');
      memberAs('guardian');
      queues.enrollments = [{ data: [enrolledRow()], error: null }];
      queues.guardian_links = [{ data: null, error: null }];

      await authed(
        request(app.getHttpServer()).get(`/students/${STUDENT_ID}/grades`),
      ).expect(403);
    });
  });

  it('returns 401 without a token', () => {
    return request(app.getHttpServer())
      .get(`/students/${STUDENT_ID}/guardians`)
      .expect(401);
  });
});
