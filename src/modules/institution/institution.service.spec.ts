import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { vi } from 'vitest';
import { AuthGuard } from '../../auth/auth.guard.js';
import { SupabaseModule } from '../../supabase/supabase.module.js';
import { SupabaseService } from '../../supabase/supabase.service.js';
import { InstitutionModule } from './institution.module.js';

interface QueryResult {
  data: unknown;
  error: unknown;
}

interface WriteCall {
  table: string;
  method: 'insert' | 'update';
  rows: unknown;
}

const COURSE_ID = '22222222-2222-4222-8222-222222222222';
const SUBJECT_ID = '33333333-3333-4333-8333-333333333333';
const TEACHER_MEMBERSHIP_ID = '44444444-4444-4444-8444-444444444444';

const courseRow = (over: Record<string, unknown> = {}) => ({
  id: COURSE_ID,
  year: 1,
  division: 'A',
  shift: 'morning',
  school_year: 2026,
  ...over,
});

const subjectRow = (over: Record<string, unknown> = {}) => ({
  id: SUBJECT_ID,
  name: 'Matemática',
  course_id: COURSE_ID,
  teacher_id: null,
  ...over,
});

describe('InstitutionService', () => {
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
      imports: [SupabaseModule, InstitutionModule],
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

  describe('GET /institution', () => {
    it('returns the institution data', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.schools = [
        {
          data: {
            id: 'school-1',
            name: 'Escuela Demo',
            address: null,
            levels: null,
          },
          error: null,
        },
      ];

      const response = await authed(
        request(app.getHttpServer()).get('/institution'),
      ).expect(200);

      expect(response.body).toEqual({
        id: 'school-1',
        name: 'Escuela Demo',
        address: null,
        levels: [],
        code: null,
        phone: null,
        email: null,
        shift: null,
        modality: null,
      });
    });

    it.each(['teacher', 'guardian'])('returns 403 for a %s', async (role) => {
      authAs('user-1');
      memberAs(role);

      await authed(request(app.getHttpServer()).get('/institution')).expect(
        403,
      );
    });
  });

  describe('POST /subjects with a malformed teacher', () => {
    it('returns 400 instead of a database error', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.courses = [{ data: { id: 'course-1' }, error: null }];

      const response = await authed(
        request(app.getHttpServer()).post('/subjects').send({
          name: 'Arte',
          courseId: '11111111-1111-4111-8111-111111111111',
          teacherMembershipId: 'no-es-un-id',
        }),
      ).expect(400);

      expect(response.body.message).toBe(
        'El docente indicado no pertenece a la institución',
      );
    });
  });

  describe('PATCH /institution with contact data', () => {
    it('saves code, phone, email, shift and modality, trimmed', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.schools = [
        {
          data: {
            id: 'school-1',
            name: 'Escuela',
            address: null,
            levels: [],
            code: 'ITSM-001',
            phone: '388 123 4567',
            email: 'instituto@rededuca.edu.ar',
            shift: 'Vespertino',
            modality: 'Presencial',
          },
          error: null,
        },
      ];

      const response = await authed(
        request(app.getHttpServer()).patch('/institution').send({
          code: ' ITSM-001 ',
          phone: '388 123 4567',
          email: 'instituto@rededuca.edu.ar',
          shift: 'Vespertino',
          modality: 'Presencial',
        }),
      ).expect(200);

      expect(writes[0]).toMatchObject({
        table: 'schools',
        rows: { code: 'ITSM-001', shift: 'Vespertino' },
      });
      expect(response.body.modality).toBe('Presencial');
    });

    it('an empty value clears the field', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.schools = [
        { data: { id: 'school-1', name: 'E', phone: null }, error: null },
      ];

      await authed(
        request(app.getHttpServer())
          .patch('/institution')
          .send({ phone: '  ' }),
      ).expect(200);

      expect(writes[0]).toMatchObject({ rows: { phone: null } });
    });

    it('rejects an invalid email', async () => {
      authAs('admin-1');
      memberAs('admin');

      const response = await authed(
        request(app.getHttpServer())
          .patch('/institution')
          .send({ email: 'sin-arroba' }),
      ).expect(400);

      expect(response.body.message).toBe('El correo electrónico no es válido');
    });

    it('rejects a field that is not text', async () => {
      authAs('admin-1');
      memberAs('admin');

      await authed(
        request(app.getHttpServer()).patch('/institution').send({ phone: 123 }),
      ).expect(400);
    });
  });

  describe('PATCH /institution', () => {
    it('lets an admin update name, address and levels', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.schools = [
        {
          data: {
            id: 'school-1',
            name: 'Escuela Nueva',
            address: 'San Martín 123',
            levels: ['primaria'],
          },
          error: null,
        },
      ];

      const response = await authed(
        request(app.getHttpServer())
          .patch('/institution')
          .send({
            name: '  Escuela Nueva  ',
            address: 'San Martín 123',
            levels: ['primaria'],
          }),
      ).expect(200);

      expect(response.body).toMatchObject({
        name: 'Escuela Nueva',
        address: 'San Martín 123',
        levels: ['primaria'],
      });
      expect(writes[0]).toMatchObject({
        table: 'schools',
        method: 'update',
        rows: {
          name: 'Escuela Nueva',
          address: 'San Martín 123',
          levels: ['primaria'],
        },
      });
    });

    it.each(['teacher', 'guardian'])('returns 403 for a %s', async (role) => {
      authAs(`${role}-1`);
      memberAs(role);

      await authed(
        request(app.getHttpServer()).patch('/institution').send({ name: 'X' }),
      ).expect(403);

      expect(writes).toHaveLength(0);
    });

    it('returns 400 when there is nothing to update', async () => {
      authAs('admin-1');
      memberAs('admin');

      await authed(
        request(app.getHttpServer()).patch('/institution').send({}),
      ).expect(400);
    });
  });

  describe('GET /courses', () => {
    it('lists the institution courses', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.courses = [
        { data: [courseRow(), courseRow({ id: 'c-2', year: 2 })], error: null },
      ];

      const response = await authed(
        request(app.getHttpServer()).get('/courses'),
      ).expect(200);

      expect(response.body).toHaveLength(2);
      expect(response.body[0]).toMatchObject({
        id: COURSE_ID,
        year: 1,
        division: 'A',
        shift: 'morning',
        schoolYear: 2026,
      });
    });
  });

  describe('POST /courses', () => {
    it('creates a course', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.courses = [{ data: courseRow(), error: null }];

      const response = await authed(
        request(app.getHttpServer()).post('/courses').send({
          year: 1,
          division: 'A',
          shift: 'morning',
          schoolYear: 2026,
        }),
      ).expect(201);

      expect(response.body).toMatchObject({ id: COURSE_ID, schoolYear: 2026 });
      expect(writes[0]).toMatchObject({
        table: 'courses',
        method: 'insert',
        rows: {
          school_id: 'school-1',
          year: 1,
          division: 'A',
          shift: 'morning',
          school_year: 2026,
        },
      });
    });

    it('returns 409 when the same year, division, shift and cycle already exist', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.courses = [
        { data: null, error: { code: '23505', message: 'duplicate key' } },
      ];

      const response = await authed(
        request(app.getHttpServer()).post('/courses').send({
          year: 1,
          division: 'A',
          shift: 'morning',
          schoolYear: 2026,
        }),
      ).expect(409);

      expect(response.body.message).toContain(
        'año, división, turno y ciclo lectivo',
      );
    });

    it('returns 400 for an invalid shift', async () => {
      authAs('admin-1');
      memberAs('admin');

      await authed(
        request(app.getHttpServer()).post('/courses').send({
          year: 1,
          division: 'A',
          shift: 'noche',
          schoolYear: 2026,
        }),
      ).expect(400);

      expect(writes).toHaveLength(0);
    });
  });

  describe('PATCH /courses/:id', () => {
    it('updates the division', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.courses = [
        { data: { id: COURSE_ID }, error: null },
        { data: courseRow({ division: 'B' }), error: null },
      ];

      const response = await authed(
        request(app.getHttpServer())
          .patch(`/courses/${COURSE_ID}`)
          .send({ division: 'B' }),
      ).expect(200);

      expect(response.body.division).toBe('B');
      expect(writes[0].rows).toEqual({ division: 'B' });
    });

    it('returns 404 for a course of another institution', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.courses = [{ data: null, error: null }];

      await authed(
        request(app.getHttpServer())
          .patch(`/courses/${COURSE_ID}`)
          .send({ division: 'B' }),
      ).expect(404);
    });
  });

  describe('DELETE /courses/:id', () => {
    it('returns 409 when the course has students enrolled', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.courses = [{ data: { id: COURSE_ID }, error: null }];
      queues.enrollments = [{ data: [{ student_id: 'stu-1' }], error: null }];

      const response = await authed(
        request(app.getHttpServer()).delete(`/courses/${COURSE_ID}`),
      ).expect(409);

      expect(response.body.message).toContain('alumnos');
    });

    it('returns 409 when the course still has subjects', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.courses = [{ data: { id: COURSE_ID }, error: null }];
      queues.enrollments = [{ data: [], error: null }];
      queues.subjects = [{ data: [{ id: SUBJECT_ID }], error: null }];

      const response = await authed(
        request(app.getHttpServer()).delete(`/courses/${COURSE_ID}`),
      ).expect(409);

      expect(response.body.message).toContain('materias');
    });

    it('deletes an empty course', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.courses = [{ data: { id: COURSE_ID }, error: null }];
      queues.enrollments = [{ data: [], error: null }];
      queues.subjects = [{ data: [], error: null }];

      await authed(
        request(app.getHttpServer()).delete(`/courses/${COURSE_ID}`),
      ).expect(200);
    });
  });

  describe('GET /subjects', () => {
    it('lists subjects exposing the teacher membership id', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.subjects = [
        { data: [subjectRow({ teacher_id: 'teacher-user-1' })], error: null },
      ];
      queues.memberships.push({
        data: [{ id: TEACHER_MEMBERSHIP_ID, user_id: 'teacher-user-1' }],
        error: null,
      });

      const response = await authed(
        request(app.getHttpServer()).get('/subjects'),
      ).expect(200);

      expect(response.body[0]).toEqual({
        id: SUBJECT_ID,
        name: 'Matemática',
        courseId: COURSE_ID,
        teacherMembershipId: TEACHER_MEMBERSHIP_ID,
      });
    });
  });

  describe('POST /subjects', () => {
    it('creates a subject and resolves teacherMembershipId to the profile id', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.courses = [{ data: { id: COURSE_ID }, error: null }];
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
          data: [{ id: TEACHER_MEMBERSHIP_ID, user_id: 'teacher-user-1' }],
          error: null,
        },
      );
      queues.subjects = [
        {
          data: subjectRow({ teacher_id: 'teacher-user-1' }),
          error: null,
        },
      ];

      const response = await authed(
        request(app.getHttpServer()).post('/subjects').send({
          name: 'Matemática',
          courseId: COURSE_ID,
          teacherMembershipId: TEACHER_MEMBERSHIP_ID,
        }),
      ).expect(201);

      expect(writes[0].rows).toMatchObject({
        course_id: COURSE_ID,
        name: 'Matemática',
        teacher_id: 'teacher-user-1',
      });
      expect(response.body.teacherMembershipId).toBe(TEACHER_MEMBERSHIP_ID);
    });

    it('returns 400 when the teacher membership has another role', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.courses = [{ data: { id: COURSE_ID }, error: null }];
      queues.memberships.push({
        data: { id: 'm-x', user_id: 'guardian-1', role: 'guardian' },
        error: null,
      });

      await authed(
        request(app.getHttpServer()).post('/subjects').send({
          name: 'Matemática',
          courseId: COURSE_ID,
          teacherMembershipId: 'm-x',
        }),
      ).expect(400);

      expect(writes).toHaveLength(0);
    });

    it('returns 409 when the course already has a subject with that name', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.courses = [{ data: { id: COURSE_ID }, error: null }];
      queues.subjects = [
        { data: null, error: { code: '23505', message: 'duplicate key' } },
      ];

      const response = await authed(
        request(app.getHttpServer())
          .post('/subjects')
          .send({ name: 'Matemática', courseId: COURSE_ID }),
      ).expect(409);

      expect(response.body.message).toContain('materia con ese nombre');
    });
  });

  describe('PATCH /subjects/:id', () => {
    it('unassigns the teacher when teacherMembershipId is null', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.subjects = [
        { data: { id: SUBJECT_ID }, error: null },
        { data: subjectRow(), error: null },
      ];

      await authed(
        request(app.getHttpServer())
          .patch(`/subjects/${SUBJECT_ID}`)
          .send({ teacherMembershipId: null }),
      ).expect(200);

      expect(writes[0].rows).toEqual({ teacher_id: null });
    });

    it('returns 404 for a subject of another institution', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.subjects = [{ data: null, error: null }];

      await authed(
        request(app.getHttpServer())
          .patch(`/subjects/${SUBJECT_ID}`)
          .send({ name: 'Lengua' }),
      ).expect(404);
    });
  });

  describe('DELETE /subjects/:id', () => {
    it('deletes the subject', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.subjects = [{ data: { id: SUBJECT_ID }, error: null }];

      await authed(
        request(app.getHttpServer()).delete(`/subjects/${SUBJECT_ID}`),
      ).expect(200);
    });
  });

  it('returns 401 without a token', () => {
    return request(app.getHttpServer()).get('/courses').expect(401);
  });
});
