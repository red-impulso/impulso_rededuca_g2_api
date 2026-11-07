import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { vi } from 'vitest';
import { AuthGuard } from '../../auth/auth.guard.js';
import { SupabaseModule } from '../../supabase/supabase.module.js';
import { SupabaseService } from '../../supabase/supabase.service.js';
import { UsersModule } from './users.module.js';

interface QueryResult {
  data: unknown;
  error: unknown;
}

interface WriteCall {
  table: string;
  method: 'insert' | 'update' | 'delete';
  rows: unknown;
}

const MEMBERSHIP_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_MEMBERSHIP_ID = '55555555-5555-4555-8555-555555555555';
const NEW_USER_ID = '99999999-9999-4999-8999-999999999999';
const EXISTING_USER_ID = '88888888-8888-4888-8888-888888888888';

describe('UsersService', () => {
  let app: INestApplication<App>;

  const getUser = vi.fn();
  const createUser = vi.fn();
  const listUsers = vi.fn();
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
      range: vi.fn(),
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
      'neq',
      'in',
      'or',
      'order',
      'range',
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
      auth: { getUser, admin: { createUser, listUsers } },
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
    listUsers.mockResolvedValue({
      data: { users: [] },
      error: null,
    });
    const module: TestingModule = await Test.createTestingModule({
      imports: [SupabaseModule, UsersModule],
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

  describe('GET /users', () => {
    it('lists every member past the 1000 rows of a single query', async () => {
      authAs('admin-1');
      memberAs('admin');
      const member = (index: number) => ({
        id: `m-${index}`,
        user_id: `user-${index}`,
        role: 'guardian',
        status: 'active',
        profiles: { full_name: `Persona ${index}` },
      });
      queues.memberships.push(
        {
          data: Array.from({ length: 1000 }, (_, index) => member(index)),
          error: null,
        },
        { data: [member(1000)], error: null },
      );

      const response = await authed(
        request(app.getHttpServer()).get('/users'),
      ).expect(200);

      expect(response.body).toHaveLength(1001);
    });

    it('lists memberships with email, name and role', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.memberships.push({
        data: [
          {
            id: MEMBERSHIP_ID,
            user_id: 'user-1',
            role: 'teacher',
            status: 'inactive',
            profiles: { full_name: 'Laura Gómez' },
          },
        ],
        error: null,
      });
      listUsers.mockResolvedValue({
        data: { users: [{ id: 'user-1', email: 'laura@demo.rededuca' }] },
        error: null,
      });

      const response = await authed(
        request(app.getHttpServer()).get('/users'),
      ).expect(200);

      expect(response.body).toEqual([
        {
          id: MEMBERSHIP_ID,
          userId: 'user-1',
          email: 'laura@demo.rededuca',
          fullName: 'Laura Gómez',
          role: 'teacher',
          status: 'inactive',
        },
      ]);
    });

    it('reads every page of auth users to find the emails', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.memberships.push({
        data: [
          {
            id: MEMBERSHIP_ID,
            user_id: 'user-1001',
            role: 'teacher',
            status: 'active',
            profiles: { full_name: 'Laura Gómez' },
          },
        ],
        error: null,
      });
      listUsers
        .mockResolvedValueOnce({
          data: {
            users: Array.from({ length: 1000 }, (_, i) => ({
              id: `user-${i}`,
              email: `u${i}@demo.rededuca`,
            })),
          },
          error: null,
        })
        .mockResolvedValueOnce({
          data: { users: [{ id: 'user-1001', email: 'laura@demo.rededuca' }] },
          error: null,
        });

      const response = await authed(
        request(app.getHttpServer()).get('/users'),
      ).expect(200);

      expect(response.body[0].email).toBe('laura@demo.rededuca');
      expect(listUsers).toHaveBeenCalledTimes(2);
    });

    it.each(['director', 'teacher', 'guardian'])(
      'returns 403 for a %s',
      async (role) => {
        authAs(`${role}-1`);
        memberAs(role);

        await authed(request(app.getHttpServer()).get('/users')).expect(403);
      },
    );
  });

  describe('POST /users', () => {
    const payload = {
      email: 'docente@demo.rededuca',
      fullName: 'Laura Gómez',
      role: 'teacher',
      temporaryPassword: 'temp1234',
    };

    it('creates the auth user, profile and membership', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.profiles = [{ data: null, error: null }];
      queues.profiles.push({ data: null, error: null });
      queues.memberships.push({ data: { id: MEMBERSHIP_ID }, error: null });

      const response = await authed(
        request(app.getHttpServer()).post('/users').send(payload),
      ).expect(201);

      expect(createUser).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'docente@demo.rededuca',
          password: 'temp1234',
        }),
      );
      expect(writes.map((w) => w.table)).toEqual([
        'profiles',
        'memberships',
      ]);
      expect(writes[1].rows).toMatchObject({
        user_id: NEW_USER_ID,
        school_id: 'school-1',
        role: 'teacher',
      });
      expect(response.body).toMatchObject({
        id: MEMBERSHIP_ID,
        userId: NEW_USER_ID,
        role: 'teacher',
      });
    });

    it('reuses the auth user when the email exists in another institution and only creates the membership', async () => {
      authAs('admin-1');
      memberAs('admin');
      createUser.mockResolvedValue({
        data: { user: null },
        error: { code: 'email_exists', message: 'already registered' },
      });
      listUsers.mockResolvedValue({
        data: {
          users: [{ id: EXISTING_USER_ID, email: 'docente@demo.rededuca' }],
        },
        error: null,
      });
      // The profile already exists (belongs to another school) so only the
      // membership insert is expected.
      queues.profiles = [{ data: { id: EXISTING_USER_ID }, error: null }];
      queues.memberships.push({ data: { id: MEMBERSHIP_ID }, error: null });

      const response = await authed(
        request(app.getHttpServer()).post('/users').send(payload),
      ).expect(201);

      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        table: 'memberships',
        method: 'insert',
        rows: {
          user_id: EXISTING_USER_ID,
          school_id: 'school-1',
          role: 'teacher',
        },
      });
      expect(response.body.userId).toBe(EXISTING_USER_ID);
    });

    it('returns 409 when the user already has that role in the school', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.profiles = [{ data: null, error: null }];
      queues.profiles.push({ data: null, error: null });
      queues.memberships.push({
        data: null,
        error: { code: '23505', message: 'duplicate key' },
      });

      await authed(
        request(app.getHttpServer()).post('/users').send(payload),
      ).expect(409);
    });

    it.each([
      [{ ...payload, email: '' }, 'email'],
      [{ ...payload, role: 'student' }, 'student role'],
      [{ ...payload, temporaryPassword: 'abc' }, 'short password'],
    ])('returns 400 for invalid %s', async (body) => {
      authAs('admin-1');
      memberAs('admin');

      await authed(
        request(app.getHttpServer()).post('/users').send(body),
      ).expect(400);

      expect(createUser).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /memberships/:id', () => {
    it('changes the role of the membership', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.memberships.push(
        {
          data: { id: MEMBERSHIP_ID, user_id: 'user-1', role: 'teacher' },
          error: null,
        },
        { data: null, error: null }, // update result
        {
          data: {
            id: MEMBERSHIP_ID,
            user_id: 'user-1',
            role: 'director',
            profiles: { full_name: 'Laura' },
          },
          error: null,
        },
      );

      const response = await authed(
        request(app.getHttpServer())
          .patch(`/memberships/${MEMBERSHIP_ID}`)
          .send({ role: 'director' }),
      ).expect(200);

      expect(writes[0].rows).toEqual({ role: 'director' });
      expect(response.body.role).toBe('director');
    });

    it('returns 409 when an admin removes their own role being the only admin', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.memberships.push(
        {
          data: { id: MEMBERSHIP_ID, user_id: 'admin-1', role: 'admin' },
          error: null,
        },
        { data: [], error: null }, // no other admins
      );

      const response = await authed(
        request(app.getHttpServer())
          .patch(`/memberships/${MEMBERSHIP_ID}`)
          .send({ role: 'director' }),
      ).expect(409);

      expect(response.body.message).toContain('sin administradores');
      expect(writes).toHaveLength(0);
    });

    it('lets an admin change role when another admin remains', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.memberships.push(
        {
          data: { id: MEMBERSHIP_ID, user_id: 'admin-1', role: 'admin' },
          error: null,
        },
        { data: [{ id: OTHER_MEMBERSHIP_ID }], error: null },
        { data: null, error: null }, // update result
        {
          data: {
            id: MEMBERSHIP_ID,
            user_id: 'admin-1',
            role: 'director',
            profiles: { full_name: 'Admin' },
          },
          error: null,
        },
      );

      await authed(
        request(app.getHttpServer())
          .patch(`/memberships/${MEMBERSHIP_ID}`)
          .send({ role: 'director' }),
      ).expect(200);
    });

    it('deactivates a user without changing the role', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.memberships.push(
        {
          data: { id: MEMBERSHIP_ID, user_id: 'user-1', role: 'teacher', status: 'active' },
          error: null,
        },
        { data: null, error: null },
        {
          data: {
            id: MEMBERSHIP_ID,
            user_id: 'user-1',
            role: 'teacher',
            status: 'inactive',
            profiles: { full_name: 'Laura Gómez' },
          },
          error: null,
        },
      );
      listUsers.mockResolvedValue({ data: { users: [] }, error: null });

      const response = await authed(
        request(app.getHttpServer())
          .patch(`/memberships/${MEMBERSHIP_ID}`)
          .send({ status: 'inactive' }),
      ).expect(200);

      expect(writes[0]).toMatchObject({
        table: 'memberships',
        rows: { status: 'inactive' },
      });
      expect(writes[0].rows).not.toHaveProperty('role');
      expect(response.body).toMatchObject({ role: 'teacher', status: 'inactive' });
    });

    it('changes the name shown for the user', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.memberships.push(
        {
          data: { id: MEMBERSHIP_ID, user_id: 'user-1', role: 'teacher', status: 'active' },
          error: null,
        },
        {
          data: {
            id: MEMBERSHIP_ID,
            user_id: 'user-1',
            role: 'teacher',
            status: 'active',
            profiles: { full_name: 'Laura Prueba' },
          },
          error: null,
        },
      );
      listUsers.mockResolvedValue({ data: { users: [] }, error: null });

      const response = await authed(
        request(app.getHttpServer())
          .patch(`/memberships/${MEMBERSHIP_ID}`)
          .send({ fullName: ' Laura Prueba ' }),
      ).expect(200);

      expect(writes[0]).toMatchObject({
        table: 'profiles',
        rows: { full_name: 'Laura Prueba' },
      });
      expect(response.body.fullName).toBe('Laura Prueba');
    });

    it('returns 409 when deactivating the last admin', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.memberships.push(
        {
          data: { id: MEMBERSHIP_ID, user_id: 'admin-1', role: 'admin', status: 'active' },
          error: null,
        },
        { data: [], error: null },
      );

      await authed(
        request(app.getHttpServer())
          .patch(`/memberships/${MEMBERSHIP_ID}`)
          .send({ status: 'inactive' }),
      ).expect(409);
      expect(writes).toHaveLength(0);
    });

    it('returns 400 for an unknown status or an empty body', async () => {
      authAs('admin-1');
      memberAs('admin');

      await authed(
        request(app.getHttpServer())
          .patch(`/memberships/${MEMBERSHIP_ID}`)
          .send({ status: 'deleted' }),
      ).expect(400);

      memberAs('admin');
      await authed(
        request(app.getHttpServer())
          .patch(`/memberships/${MEMBERSHIP_ID}`)
          .send({}),
      ).expect(400);
    });

    it('returns 404 for a membership of another institution', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.memberships.push({ data: null, error: null });

      await authed(
        request(app.getHttpServer())
          .patch(`/memberships/${OTHER_MEMBERSHIP_ID}`)
          .send({ role: 'teacher' }),
      ).expect(404);
    });
  });

  describe('DELETE /memberships/:id', () => {
    it('deletes the membership', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.memberships.push(
        {
          data: { id: MEMBERSHIP_ID, user_id: 'user-1', role: 'teacher' },
          error: null,
        },
        { data: null, error: null },
      );

      await authed(
        request(app.getHttpServer()).delete(
          `/memberships/${MEMBERSHIP_ID}`,
        ),
      ).expect(200);

      expect(writes[0]).toMatchObject({
        table: 'memberships',
        method: 'delete',
      });
    });

    it('removes the personal data when no role is left in the school', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.memberships.push(
        {
          data: { id: MEMBERSHIP_ID, user_id: 'user-1', role: 'teacher' },
          error: null,
        },
        { data: null, error: null },
        { data: [], error: null },
      );

      await authed(
        request(app.getHttpServer()).delete(
          `/memberships/${MEMBERSHIP_ID}`,
        ),
      ).expect(200);

      expect(writes.map((write) => write.table)).toEqual([
        'memberships',
        'member_details',
      ]);
    });

    it('keeps the personal data when another role remains in the school', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.memberships.push(
        {
          data: { id: MEMBERSHIP_ID, user_id: 'user-1', role: 'teacher' },
          error: null,
        },
        { data: null, error: null },
        { data: [{ id: 'other-role' }], error: null },
      );

      await authed(
        request(app.getHttpServer()).delete(
          `/memberships/${MEMBERSHIP_ID}`,
        ),
      ).expect(200);

      expect(writes.map((write) => write.table)).toEqual(['memberships']);
    });

    it('returns 409 when deleting the last admin', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.memberships.push(
        {
          data: { id: MEMBERSHIP_ID, user_id: 'admin-1', role: 'admin' },
          error: null,
        },
        { data: [], error: null },
      );

      await authed(
        request(app.getHttpServer()).delete(
          `/memberships/${MEMBERSHIP_ID}`,
        ),
      ).expect(409);

      expect(writes).toHaveLength(0);
    });
  });

  it('returns 401 without a token', () => {
    return request(app.getHttpServer()).get('/users').expect(401);
  });
});
