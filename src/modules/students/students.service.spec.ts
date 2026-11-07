import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { vi } from 'vitest';
import { AuthGuard } from '../../auth/auth.guard.js';
import { SupabaseModule } from '../../supabase/supabase.module.js';
import { SupabaseService } from '../../supabase/supabase.service.js';
import { StudentsModule } from './students.module.js';

interface QueryResult {
  data: unknown;
  error: unknown;
}

interface WriteCall {
  table: string;
  method: 'insert' | 'update' | 'upsert' | 'delete';
  rows: unknown;
}

const COURSE_ID = '22222222-2222-4222-8222-222222222222';
const COURSE2_ID = '77777777-7777-4777-8777-777777777777';
const STUDENT_ID = '11111111-1111-4111-8111-111111111111';
const NEW_USER_ID = '99999999-9999-4999-8999-999999999999';

const courseRow = (over: Record<string, unknown> = {}) => ({
  id: COURSE_ID,
  year: 1,
  division: 'A',
  shift: 'morning',
  school_id: 'school-1',
  ...over,
});

const profileRow = (over: Record<string, unknown> = {}) => ({
  id: STUDENT_ID,
  first_name: 'Ana',
  last_name: 'Pérez',
  status: 'active',
  student_details: { dni: '12345678' },
  ...over,
});

const enrollmentRow = (over: Record<string, unknown> = {}) => ({
  student_id: STUDENT_ID,
  created_at: '2026-01-01T00:00:00Z',
  profiles: profileRow(),
  courses: courseRow(),
  ...over,
});

describe('StudentsService', () => {
  let app: INestApplication<App>;

  const getUser = vi.fn();
  const createUser = vi.fn();
  const deleteUser = vi.fn();
  const getUserById = vi.fn();
  // Each table keeps a FIFO queue of results; every awaited query consumes one.
  let queues: Record<string, QueryResult[]>;
  let writes: WriteCall[];

  // A thenable stand-in for the supabase query builder: every method returns
  // the chain itself and awaiting it resolves to the next queued result.
  function makeChain(table: string) {
    const chain = {
      select: vi.fn(),
      eq: vi.fn(),
      neq: vi.fn(),
      in: vi.fn(),
      or: vi.fn(),
      order: vi.fn(),
      limit: vi.fn(),
      maybeSingle: vi.fn(),
      single: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
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
      'neq',
      'in',
      'or',
      'order',
      'limit',
      'maybeSingle',
      'single',
    ] as const) {
      chain[method].mockReturnValue(chain);
    }
    for (const method of ['insert', 'update', 'upsert', 'delete'] as const) {
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
      auth: { getUser, admin: { createUser, deleteUser, getUserById } },
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
    createUser.mockResolvedValue({
      data: { user: { id: NEW_USER_ID } },
      error: null,
    });
    deleteUser.mockResolvedValue({ data: {}, error: null });
    getUserById.mockResolvedValue({
      data: { user: { email: 'ana@demo.rededuca' } },
      error: null,
    });
    const module: TestingModule = await Test.createTestingModule({
      imports: [SupabaseModule, StudentsModule],
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

  describe('GET /students', () => {
    it('lists the students of the institution with their course', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.enrollments = [
        { data: [enrollmentRow()], error: null },
      ];

      const response = await authed(
        request(app.getHttpServer()).get('/students'),
      ).expect(200);

      expect(response.body).toEqual([
        {
          id: STUDENT_ID,
          firstName: 'Ana',
          lastName: 'Pérez',
          dni: '12345678',
          status: 'active',
          course: {
            id: COURSE_ID,
            year: 1,
            division: 'A',
            shift: 'morning',
          },
        },
      ]);
    });

    it.each([
      ['the DNI', '1234', 'Ana'],
      ['the last name', 'GÓMEZ', 'Luz'],
    ])('searches by %s', async (_, q, found) => {
      authAs('admin-1');
      memberAs('admin');
      queues.enrollments = [
        {
          data: [
            enrollmentRow(),
            enrollmentRow({
              student_id: 'other',
              profiles: profileRow({
                id: 'other',
                first_name: 'Luz',
                last_name: 'Gómez',
                student_details: { dni: '55555555' },
              }),
            }),
          ],
          error: null,
        },
      ];

      const response = await authed(
        request(app.getHttpServer()).get('/students').query({ q }),
      ).expect(200);

      expect(response.body.map((s: { firstName: string }) => s.firstName)).toEqual([
        found,
      ]);
    });

    it('lists a student without personal data with a null DNI', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.enrollments = [
        {
          data: [enrollmentRow({ profiles: profileRow({ student_details: null }) })],
          error: null,
        },
      ];

      const response = await authed(
        request(app.getHttpServer()).get('/students'),
      ).expect(200);

      expect(response.body[0].dni).toBeNull();
    });

    it('filters by courseId', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.courses = [{ data: courseRow(), error: null }];
      queues.enrollments = [
        { data: [enrollmentRow()], error: null },
      ];

      const response = await authed(
        request(app.getHttpServer()).get(`/students?courseId=${COURSE_ID}`),
      ).expect(200);

      expect(response.body).toHaveLength(1);
    });

    it('returns 404 when courseId belongs to another institution', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.courses = [{ data: null, error: null }];

      await authed(
        request(app.getHttpServer()).get(`/students?courseId=${COURSE_ID}`),
      ).expect(404);
    });

    it.each(['teacher', 'guardian'])('returns 403 for a %s', async (role) => {
      authAs(`${role}-1`);
      memberAs(role);

      await authed(request(app.getHttpServer()).get('/students')).expect(403);
    });
  });

  describe('GET /students/:id', () => {
    it('returns the student with its personal data and email', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.enrollments = [{ data: enrollmentRow(), error: null }];
      queues.student_details = [
        {
          data: {
            birth_date: '2010-03-12',
            address: 'Calle de Prueba 123',
            phone: '388 000 0000',
            updated_at: '2026-11-07T12:00:00Z',
          },
          error: null,
        },
      ];

      const response = await authed(
        request(app.getHttpServer()).get(`/students/${STUDENT_ID}`),
      ).expect(200);

      expect(getUserById).toHaveBeenCalledWith(STUDENT_ID);
      expect(response.body).toMatchObject({
        id: STUDENT_ID,
        firstName: 'Ana',
        course: { id: COURSE_ID, year: 1 },
        birthDate: '2010-03-12',
        address: 'Calle de Prueba 123',
        phone: '388 000 0000',
        email: 'ana@demo.rededuca',
        updatedAt: '2026-11-07T12:00:00Z',
      });
    });

    it('returns nulls when the student has no personal data yet', async () => {
      authAs('admin-1');
      memberAs('director');
      queues.enrollments = [{ data: enrollmentRow(), error: null }];
      queues.student_details = [{ data: null, error: null }];

      const response = await authed(
        request(app.getHttpServer()).get(`/students/${STUDENT_ID}`),
      ).expect(200);

      expect(response.body).toMatchObject({
        birthDate: null,
        address: null,
        phone: null,
        updatedAt: null,
      });
    });

    it('returns 404 for a student of another institution', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.enrollments = [{ data: null, error: null }];

      await authed(
        request(app.getHttpServer()).get(`/students/${STUDENT_ID}`),
      ).expect(404);
      expect(getUserById).not.toHaveBeenCalled();
    });

    it.each(['teacher', 'guardian', 'student'])(
      'returns 403 for the %s role',
      async (role) => {
        authAs('user-1');
        memberAs(role);

        await authed(
          request(app.getHttpServer()).get(`/students/${STUDENT_ID}`),
        ).expect(403);
      },
    );
  });

  describe('POST /students', () => {
    const payload = {
      firstName: 'Ana',
      lastName: 'Pérez',
      dni: '12345678',
      email: 'ana@demo.rededuca',
      courseId: COURSE_ID,
    };

    it('creates the auth user, profile, membership and enrollment', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.courses = [{ data: courseRow(), error: null }];
      queues.profiles = [
        { data: profileRow({ id: NEW_USER_ID }), error: null },
      ];
      queues.enrollments = [{ data: null, error: null }];
      queues.memberships.push({ data: null, error: null });

      const response = await authed(
        request(app.getHttpServer()).post('/students').send(payload),
      ).expect(201);

      expect(createUser).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'ana@demo.rededuca' }),
      );
      expect(writes.map((w) => w.table)).toEqual([
        'profiles',
        'memberships',
        'enrollments',
        'student_details',
      ]);
      expect(writes[0].rows).toMatchObject({
        id: NEW_USER_ID,
        school_id: 'school-1',
        status: 'active',
      });
      expect(writes[0].rows).not.toHaveProperty('dni');
      expect(writes[3].rows).toMatchObject({
        student_id: NEW_USER_ID,
        school_id: 'school-1',
        dni: '12345678',
      });
      expect(writes[1].rows).toMatchObject({
        user_id: NEW_USER_ID,
        role: 'student',
      });
      expect(writes[2].rows).toMatchObject({
        student_id: NEW_USER_ID,
        course_id: COURSE_ID,
      });
      expect(response.body).toMatchObject({
        id: NEW_USER_ID,
        firstName: 'Ana',
        status: 'active',
      });
    });

    it('saves the personal data when it comes in the body', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.courses = [{ data: courseRow(), error: null }];
      queues.profiles = [
        { data: profileRow({ id: NEW_USER_ID }), error: null },
      ];
      queues.enrollments = [{ data: null, error: null }];
      queues.memberships.push({ data: null, error: null });

      await authed(
        request(app.getHttpServer())
          .post('/students')
          .send({ ...payload, birthDate: '2010-03-12', address: ' Calle 1 ' }),
      ).expect(201);

      const details = writes.find((w) => w.table === 'student_details');
      expect(details).toMatchObject({
        method: 'upsert',
        rows: {
          student_id: NEW_USER_ID,
          birth_date: '2010-03-12',
          address: 'Calle 1',
        },
      });
    });

    it('returns 400 for an impossible birth date, before creating the user', async () => {
      authAs('admin-1');
      memberAs('admin');

      await authed(
        request(app.getHttpServer())
          .post('/students')
          .send({ ...payload, birthDate: '2010-02-31' }),
      ).expect(400);
      expect(createUser).not.toHaveBeenCalled();
    });

    it('returns 409 when the DNI is already used in the institution', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.courses = [{ data: courseRow(), error: null }];
      queues.student_details = [{ data: [{ student_id: 'other' }], error: null }];

      await authed(
        request(app.getHttpServer()).post('/students').send(payload),
      ).expect(409);

      expect(createUser).not.toHaveBeenCalled();
      expect(writes).toHaveLength(0);
    });

    it('returns 409 and removes the user when two requests race for a DNI', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.courses = [{ data: courseRow(), error: null }];
      queues.profiles = [{ data: profileRow({ id: NEW_USER_ID }), error: null }];
      queues.enrollments = [{ data: null, error: null }];
      queues.memberships.push({ data: null, error: null });
      queues.student_details = [
        { data: [], error: null },
        { data: null, error: { code: '23505' } },
      ];

      await authed(
        request(app.getHttpServer()).post('/students').send(payload),
      ).expect(409);

      expect(deleteUser).toHaveBeenCalledWith(NEW_USER_ID);
    });

    it('returns 404 when the course belongs to another institution', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.courses = [{ data: null, error: null }];

      await authed(
        request(app.getHttpServer()).post('/students').send(payload),
      ).expect(404);

      expect(createUser).not.toHaveBeenCalled();
    });

    it('cleans up the auth user when the profile insert fails', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.courses = [{ data: courseRow(), error: null }];
      queues.profiles = [
        { data: null, error: { message: 'db exploded' } },
      ];

      await authed(
        request(app.getHttpServer()).post('/students').send(payload),
      ).expect(500);

      expect(deleteUser).toHaveBeenCalledWith(NEW_USER_ID);
    });

    it('returns 400 when a required field is missing', async () => {
      authAs('admin-1');
      memberAs('admin');

      await authed(
        request(app.getHttpServer())
          .post('/students')
          .send({ ...payload, dni: '' }),
      ).expect(400);
    });
  });

  describe('PATCH /students/:id', () => {
    it('edits the name and recomputes full_name', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.enrollments = [
        { data: enrollmentRow(), error: null },
        { data: enrollmentRow(), error: null },
      ];
      queues.profiles = [{ data: null, error: null }];

      await authed(
        request(app.getHttpServer())
          .patch(`/students/${STUDENT_ID}`)
          .send({ firstName: 'Anita' }),
      ).expect(200);

      expect(writes[0].rows).toMatchObject({
        first_name: 'Anita',
        full_name: 'Anita Pérez',
      });
    });

    it('changes the course', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.enrollments = [
        { data: enrollmentRow(), error: null },
        { data: null, error: null }, // update result
        {
          data: enrollmentRow({ courses: courseRow({ id: COURSE2_ID }) }),
          error: null,
        },
      ];
      queues.courses = [{ data: courseRow({ id: COURSE2_ID }), error: null }];

      await authed(
        request(app.getHttpServer())
          .patch(`/students/${STUDENT_ID}`)
          .send({ courseId: COURSE2_ID }),
      ).expect(200);

      expect(writes[0]).toMatchObject({
        table: 'enrollments',
        method: 'update',
        rows: { course_id: COURSE2_ID },
      });
    });

    it('deactivates the student without deleting it', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.enrollments = [
        { data: enrollmentRow(), error: null },
        {
          data: enrollmentRow({ profiles: profileRow({ status: 'inactive' }) }),
          error: null,
        },
      ];
      queues.profiles = [{ data: null, error: null }];

      const response = await authed(
        request(app.getHttpServer())
          .patch(`/students/${STUDENT_ID}`)
          .send({ status: 'inactive' }),
      ).expect(200);

      expect(writes[0].rows).toEqual({ status: 'inactive' });
      expect(response.body.status).toBe('inactive');
      expect(
        writes.some((w) => w.method === 'delete'),
      ).toBe(false);
    });

    it('saves personal data, clearing a blank field', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.enrollments = [
        { data: enrollmentRow(), error: null },
        { data: enrollmentRow(), error: null },
      ];

      await authed(
        request(app.getHttpServer())
          .patch(`/students/${STUDENT_ID}`)
          .send({ phone: '388 000 0000', address: '  ' }),
      ).expect(200);

      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        table: 'student_details',
        method: 'upsert',
        rows: { student_id: STUDENT_ID, phone: '388 000 0000', address: null },
      });
      expect((writes[0].rows as { updated_at: string }).updated_at).toBeTruthy();
    });

    it('marks the update time also when only the name changes', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.enrollments = [
        { data: enrollmentRow(), error: null },
        { data: enrollmentRow(), error: null },
      ];

      await authed(
        request(app.getHttpServer())
          .patch(`/students/${STUDENT_ID}`)
          .send({ firstName: 'Anita' }),
      ).expect(200);

      const details = writes.find((w) => w.table === 'student_details');
      expect(Object.keys(details?.rows as object).sort()).toEqual([
        'school_id',
        'student_id',
        'updated_at',
      ]);
    });

    it('returns 400 and writes nothing for a malformed birth date', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.enrollments = [{ data: enrollmentRow(), error: null }];

      await authed(
        request(app.getHttpServer())
          .patch(`/students/${STUDENT_ID}`)
          .send({ firstName: 'Anita', birthDate: '12/03/2010' }),
      ).expect(400);
      expect(writes).toHaveLength(0);
    });

    it('saves a new DNI in student_details, never in profiles', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.enrollments = [
        { data: enrollmentRow(), error: null },
        { data: enrollmentRow(), error: null },
      ];

      await authed(
        request(app.getHttpServer())
          .patch(`/students/${STUDENT_ID}`)
          .send({ dni: ' 99999999 ' }),
      ).expect(200);

      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        table: 'student_details',
        rows: { student_id: STUDENT_ID, dni: '99999999' },
      });
    });

    it('returns 409 when the new DNI is already used by another student', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.enrollments = [{ data: enrollmentRow(), error: null }];
      queues.student_details = [{ data: [{ student_id: 'other' }], error: null }];

      await authed(
        request(app.getHttpServer())
          .patch(`/students/${STUDENT_ID}`)
          .send({ dni: '99999999' }),
      ).expect(409);
    });

    it('returns 400 when the status is invalid', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.enrollments = [{ data: enrollmentRow(), error: null }];

      await authed(
        request(app.getHttpServer())
          .patch(`/students/${STUDENT_ID}`)
          .send({ status: 'deleted' }),
      ).expect(400);
    });

    it('returns 404 for a student of another institution', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.enrollments = [{ data: null, error: null }];

      await authed(
        request(app.getHttpServer())
          .patch(`/students/${STUDENT_ID}`)
          .send({ firstName: 'X' }),
      ).expect(404);
    });
  });

  it('returns 401 without a token', () => {
    return request(app.getHttpServer()).get('/students').expect(401);
  });
});
