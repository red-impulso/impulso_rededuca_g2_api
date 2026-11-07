import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { vi } from 'vitest';
import { AuthGuard } from '../auth/auth.guard.js';
import { SupabaseModule } from '../supabase/supabase.module.js';
import { SupabaseService } from '../supabase/supabase.service.js';
import { MeModule } from './me.module.js';

interface QueryResult {
  data: unknown;
  error: unknown;
}

describe('MeController', () => {
  let app: INestApplication<App>;

  const getUser = vi.fn();
  let results: Record<string, QueryResult>;
  let chains: Record<string, ReturnType<typeof makeChain>>;

  // A thenable stand-in for the supabase query builder: every method returns
  // the chain itself and awaiting it resolves to results[table].
  function makeChain(table: string) {
    const chain = {
      select: vi.fn(),
      eq: vi.fn(),
      in: vi.fn(),
      order: vi.fn(),
      maybeSingle: vi.fn(),
      // oxlint-disable-next-line no-thenable -- supabase builders are thenable
      then: (onFulfilled: (value: QueryResult) => unknown) =>
        Promise.resolve(results[table]).then(onFulfilled),
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
    return chain;
  }

  const from = vi.fn((table: string) => {
    const chain = makeChain(table);
    chains[table] = chain;
    return chain;
  });

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
    results.memberships = {
      data: [{ id: 'm-1', school_id: 'school-1', role }],
      error: null,
    };
  };

  const authed = (test: request.Test) =>
    test
      .set('Authorization', 'Bearer valid-token')
      .set('X-Institution-Id', 'school-1');

  beforeEach(async () => {
    vi.clearAllMocks();
    results = {};
    chains = {};
    const module: TestingModule = await Test.createTestingModule({
      imports: [SupabaseModule, MeModule],
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

  it('returns 401 without an Authorization header', () => {
    return request(app.getHttpServer()).get('/me').expect(401);
  });

  it('returns 401 with a non-Bearer Authorization header', () => {
    return request(app.getHttpServer())
      .get('/me')
      .set('Authorization', 'Token abc123')
      .expect(401);
  });

  it('returns 401 when the token is invalid', async () => {
    getUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'Invalid token' },
    });

    await request(app.getHttpServer())
      .get('/me')
      .set('Authorization', 'Bearer invalid-token')
      .expect(401);
  });

  it('returns the profile and memberships for a valid token', async () => {
    authAs('user-1', { email: 'ana@example.com', phone: '+5491100000000' });
    results.profiles = {
      data: { id: 'user-1', full_name: 'Ana García' },
      error: null,
    };
    results.memberships = {
      data: [
        {
          id: 'm-1',
          school_id: 'school-1',
          role: 'teacher',
          schools: { id: 'school-1', name: 'Escuela N°1' },
        },
      ],
      error: null,
    };

    const response = await request(app.getHttpServer())
      .get('/me')
      .set('Authorization', 'Bearer valid-token')
      .expect(200);

    expect(getUser).toHaveBeenCalledWith('valid-token');
    expect(response.body).toEqual({
      profile: {
        id: 'user-1',
        fullName: 'Ana García',
        phone: '+5491100000000',
      },
      memberships: [
        {
          id: 'm-1',
          institutionId: 'school-1',
          institutionName: 'Escuela N°1',
          role: 'teacher',
        },
      ],
    });
  });

  it('returns one entry per membership when the user has several schools', async () => {
    authAs('user-1', { email: 'ana@example.com' });
    results.profiles = {
      data: { id: 'user-1', full_name: 'Ana García' },
      error: null,
    };
    results.memberships = {
      data: [
        {
          id: 'm-1',
          school_id: 'school-1',
          role: 'teacher',
          schools: { id: 'school-1', name: 'Escuela N°1' },
        },
        {
          id: 'm-2',
          school_id: 'school-2',
          role: 'admin',
          schools: { id: 'school-2', name: 'Escuela N°2' },
        },
      ],
      error: null,
    };

    const response = await request(app.getHttpServer())
      .get('/me')
      .set('Authorization', 'Bearer valid-token')
      .expect(200);

    expect(response.body.memberships).toEqual([
      {
        id: 'm-1',
        institutionId: 'school-1',
        institutionName: 'Escuela N°1',
        role: 'teacher',
      },
      {
        id: 'm-2',
        institutionId: 'school-2',
        institutionName: 'Escuela N°2',
        role: 'admin',
      },
    ]);
  });

  it('leaves out the institutions where the user is inactive', async () => {
    authAs('user-1');
    results.profiles = { data: { id: 'user-1', full_name: 'Ana' }, error: null };
    results.memberships = {
      data: [
        {
          id: 'm-1',
          school_id: 'school-1',
          role: 'teacher',
          status: 'inactive',
          schools: { id: 'school-1', name: 'Escuela N°1' },
        },
        {
          id: 'm-2',
          school_id: 'school-2',
          role: 'admin',
          status: 'active',
          schools: { id: 'school-2', name: 'Escuela N°2' },
        },
      ],
      error: null,
    };

    const response = await request(app.getHttpServer())
      .get('/me')
      .set('Authorization', 'Bearer valid-token')
      .expect(200);

    expect(
      response.body.memberships.map(
        (m: { institutionId: string }) => m.institutionId,
      ),
    ).toEqual(['school-2']);
  });

  it('returns empty memberships when the user has no school', async () => {
    authAs('user-2', { email: 'bob@example.com' });
    results.profiles = {
      data: { id: 'user-2', full_name: 'Bob' },
      error: null,
    };
    results.memberships = { data: [], error: null };

    const response = await request(app.getHttpServer())
      .get('/me')
      .set('Authorization', 'Bearer valid-token')
      .expect(200);

    expect(response.body).toEqual({
      profile: { id: 'user-2', fullName: 'Bob', phone: null },
      memberships: [],
    });
  });

  describe('GET /me/subjects', () => {
    it('returns only the subjects the teacher gives, with their course', async () => {
      authAs('teacher-1');
      memberAs('teacher');
      results.subjects = {
        data: [
          {
            id: 'sub-1',
            name: 'Matemática',
            courses: { id: 'c-1', year: 3, division: 'A', shift: 'morning' },
          },
          {
            id: 'sub-2',
            name: 'Física',
            courses: { id: 'c-2', year: 5, division: 'B', shift: 'afternoon' },
          },
        ],
        error: null,
      };

      const response = await authed(
        request(app.getHttpServer()).get('/me/subjects'),
      ).expect(200);

      expect(chains.subjects.eq).toHaveBeenCalledWith(
        'teacher_id',
        'teacher-1',
      );
      expect(chains.subjects.eq).toHaveBeenCalledWith(
        'courses.school_id',
        'school-1',
      );
      expect(response.body).toEqual([
        {
          id: 'sub-1',
          name: 'Matemática',
          course: { id: 'c-1', year: 3, division: 'A', shift: 'morning' },
        },
        {
          id: 'sub-2',
          name: 'Física',
          course: { id: 'c-2', year: 5, division: 'B', shift: 'afternoon' },
        },
      ]);
    });

    it('returns 403 for a non-teacher membership', async () => {
      authAs('guardian-1');
      memberAs('guardian');

      await authed(request(app.getHttpServer()).get('/me/subjects')).expect(
        403,
      );
      expect(from).not.toHaveBeenCalledWith('subjects');
    });

    it('returns 400 without an X-Institution-Id header', async () => {
      authAs('teacher-1');

      await request(app.getHttpServer())
        .get('/me/subjects')
        .set('Authorization', 'Bearer valid-token')
        .expect(400);
    });
  });

  describe('GET /me/courses', () => {
    it('returns the courses where the teacher has at least one subject', async () => {
      authAs('teacher-1');
      memberAs('teacher');
      // A course repeats once per matching subject through the !inner join.
      results.courses = {
        data: [
          { id: 'c-1', year: 3, division: 'A', shift: 'morning' },
          { id: 'c-1', year: 3, division: 'A', shift: 'morning' },
          { id: 'c-2', year: 5, division: 'B', shift: 'afternoon' },
        ],
        error: null,
      };

      const response = await authed(
        request(app.getHttpServer()).get('/me/courses'),
      ).expect(200);

      expect(chains.courses.eq).toHaveBeenCalledWith('school_id', 'school-1');
      expect(chains.courses.eq).toHaveBeenCalledWith(
        'subjects.teacher_id',
        'teacher-1',
      );
      expect(response.body).toEqual([
        { id: 'c-1', year: 3, division: 'A', shift: 'morning' },
        { id: 'c-2', year: 5, division: 'B', shift: 'afternoon' },
      ]);
    });

    it.each(['admin', 'director'])(
      'returns every course of the school to a %s, sorted',
      async (role) => {
        authAs(`${role}-1`);
        memberAs(role);
        results.courses = {
          data: [
            { id: 'c-2', year: 2, division: 'A', shift: 'morning' },
            { id: 'c-1', year: 1, division: 'B', shift: 'morning' },
            { id: 'c-3', year: 1, division: 'A', shift: 'morning' },
          ],
          error: null,
        };

        const response = await authed(
          request(app.getHttpServer()).get('/me/courses'),
        ).expect(200);

        expect(chains.courses.eq).toHaveBeenCalledWith('school_id', 'school-1');
        expect(chains.courses.eq).not.toHaveBeenCalledWith(
          'subjects.teacher_id',
          expect.anything(),
        );
        expect(response.body.map((c: { id: string }) => c.id)).toEqual([
          'c-3',
          'c-1',
          'c-2',
        ]);
      },
    );

    it('returns 403 for a guardian membership', async () => {
      authAs('guardian-1');
      memberAs('guardian');

      await authed(request(app.getHttpServer()).get('/me/courses')).expect(403);
      expect(from).not.toHaveBeenCalledWith('courses');
    });
  });

  describe('GET /me/students', () => {
    it('returns only the students linked to the guardian, with their course', async () => {
      authAs('guardian-1');
      memberAs('guardian');
      results.guardian_links = {
        data: [{ student_id: 'stu-1' }, { student_id: 'stu-2' }],
        error: null,
      };
      results.enrollments = {
        data: [
          {
            profiles: { id: 'stu-1', first_name: 'Luna', last_name: 'Pérez' },
            courses: { id: 'c-1', year: 3, division: 'A' },
          },
          {
            profiles: { id: 'stu-2', first_name: 'Teo', last_name: 'Gómez' },
            courses: { id: 'c-2', year: 1, division: 'B' },
          },
        ],
        error: null,
      };

      const response = await authed(
        request(app.getHttpServer()).get('/me/students'),
      ).expect(200);

      expect(chains.guardian_links.eq).toHaveBeenCalledWith(
        'guardian_id',
        'guardian-1',
      );
      expect(chains.enrollments.in).toHaveBeenCalledWith('student_id', [
        'stu-1',
        'stu-2',
      ]);
      expect(chains.enrollments.eq).toHaveBeenCalledWith(
        'courses.school_id',
        'school-1',
      );
      expect(response.body).toEqual([
        {
          id: 'stu-1',
          firstName: 'Luna',
          lastName: 'Pérez',
          course: { id: 'c-1', year: 3, division: 'A' },
        },
        {
          id: 'stu-2',
          firstName: 'Teo',
          lastName: 'Gómez',
          course: { id: 'c-2', year: 1, division: 'B' },
        },
      ]);
    });

    it('returns an empty list when the guardian has no linked students', async () => {
      authAs('guardian-1');
      memberAs('guardian');
      results.guardian_links = { data: [], error: null };

      const response = await authed(
        request(app.getHttpServer()).get('/me/students'),
      ).expect(200);

      expect(response.body).toEqual([]);
      expect(from).not.toHaveBeenCalledWith('enrollments');
    });

    it('returns 403 for a non-guardian membership', async () => {
      authAs('teacher-1');
      memberAs('teacher');

      await authed(request(app.getHttpServer()).get('/me/students')).expect(
        403,
      );
      expect(from).not.toHaveBeenCalledWith('guardian_links');
    });
  });
});
