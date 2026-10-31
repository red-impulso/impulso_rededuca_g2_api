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

describe('MeController', () => {
  let app: INestApplication<App>;

  const getUser = vi.fn();
  const maybeSingle = vi.fn();
  const eqMemberships = vi.fn();
  const from = vi.fn((table: string) => ({
    select: vi.fn(() => ({
      eq: vi.fn(() =>
        table === 'profiles' ? { maybeSingle } : eqMemberships(),
      ),
    })),
  }));
  const supabase = {
    admin: {
      auth: { getUser },
      from,
    },
  };

  beforeEach(async () => {
    vi.clearAllMocks();
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
    getUser.mockResolvedValue({
      data: {
        user: {
          id: 'user-1',
          email: 'ana@example.com',
          phone: '+5491100000000',
        },
      },
      error: null,
    });
    maybeSingle.mockResolvedValue({
      data: { id: 'user-1', full_name: 'Ana García' },
      error: null,
    });
    eqMemberships.mockResolvedValue({
      data: [
        {
          id: 'm-1',
          school_id: 'school-1',
          role: 'teacher',
          schools: { id: 'school-1', name: 'Escuela N°1' },
        },
      ],
      error: null,
    });

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
    getUser.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'ana@example.com' } },
      error: null,
    });
    maybeSingle.mockResolvedValue({
      data: { id: 'user-1', full_name: 'Ana García' },
      error: null,
    });
    eqMemberships.mockResolvedValue({
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
    });

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

  it('returns empty memberships when the user has no school', async () => {
    getUser.mockResolvedValue({
      data: { user: { id: 'user-2', email: 'bob@example.com' } },
      error: null,
    });
    maybeSingle.mockResolvedValue({
      data: { id: 'user-2', full_name: 'Bob' },
      error: null,
    });
    eqMemberships.mockResolvedValue({ data: [], error: null });

    const response = await request(app.getHttpServer())
      .get('/me')
      .set('Authorization', 'Bearer valid-token')
      .expect(200);

    expect(response.body).toEqual({
      profile: { id: 'user-2', fullName: 'Bob', phone: null },
      memberships: [],
    });
  });
});
