import {
  Controller,
  Get,
  INestApplication,
  UseGuards,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { vi } from 'vitest';
import { SupabaseModule } from '../supabase/supabase.module.js';
import { SupabaseService } from '../supabase/supabase.service.js';
import { AuthGuard } from './auth.guard.js';
import { CurrentMembership } from './current-membership.decorator.js';
import { MembershipGuard } from './membership.guard.js';
import type { Membership } from './membership.guard.js';
import { Roles } from './roles.decorator.js';

@Controller('staff')
@UseGuards(MembershipGuard)
class StaffController {
  @Get()
  @Roles('admin', 'teacher')
  list(@CurrentMembership() membership: Membership) {
    return { membership };
  }

  @Get('open')
  open(@CurrentMembership() membership: Membership) {
    return { membership };
  }
}

describe('MembershipGuard', () => {
  let app: INestApplication<App>;

  const getUser = vi.fn();
  const eqSchool = vi.fn();
  const eqUser = vi.fn(() => ({ eq: eqSchool }));
  const select = vi.fn(() => ({ eq: eqUser }));
  const from = vi.fn(() => ({ select }));
  const supabase = { admin: { auth: { getUser }, from } };

  beforeEach(async () => {
    vi.clearAllMocks();
    getUser.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'ana@example.com' } },
      error: null,
    });

    const module = await Test.createTestingModule({
      imports: [SupabaseModule],
      controllers: [StaffController],
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

  it('returns 401 without a token', async () => {
    await request(app.getHttpServer())
      .get('/staff')
      .set('X-Institution-Id', 'school-1')
      .expect(401);

    expect(from).not.toHaveBeenCalled();
  });

  it('returns 400 without the X-Institution-Id header', () => {
    return request(app.getHttpServer())
      .get('/staff')
      .set('Authorization', 'Bearer valid-token')
      .expect(400);
  });

  it('returns 403 when the user has no membership in the institution', async () => {
    eqSchool.mockResolvedValue({ data: [], error: null });

    await request(app.getHttpServer())
      .get('/staff')
      .set('Authorization', 'Bearer valid-token')
      .set('X-Institution-Id', 'school-1')
      .expect(403);

    expect(from).toHaveBeenCalledWith('memberships');
    expect(eqUser).toHaveBeenCalledWith('user_id', 'user-1');
    expect(eqSchool).toHaveBeenCalledWith('school_id', 'school-1');
  });

  it('returns 403 when the membership role is not allowed by @Roles', () => {
    eqSchool.mockResolvedValue({
      data: [{ id: 'm-1', school_id: 'school-1', role: 'guardian' }],
      error: null,
    });

    return request(app.getHttpServer())
      .get('/staff')
      .set('Authorization', 'Bearer valid-token')
      .set('X-Institution-Id', 'school-1')
      .expect(403);
  });

  it('passes the membership to the handler when it is valid', async () => {
    eqSchool.mockResolvedValue({
      data: [{ id: 'm-1', school_id: 'school-1', role: 'teacher' }],
      error: null,
    });

    const response = await request(app.getHttpServer())
      .get('/staff')
      .set('Authorization', 'Bearer valid-token')
      .set('X-Institution-Id', 'school-1')
      .expect(200);

    expect(response.body).toEqual({
      membership: {
        id: 'm-1',
        userId: 'user-1',
        institutionId: 'school-1',
        role: 'teacher',
      },
    });
  });

  it('uses the highest-rank membership when the user has several in the institution', async () => {
    eqSchool.mockResolvedValue({
      data: [
        { id: 'm-1', school_id: 'school-1', role: 'guardian' },
        { id: 'm-2', school_id: 'school-1', role: 'admin' },
        { id: 'm-3', school_id: 'school-1', role: 'teacher' },
      ],
      error: null,
    });

    const response = await request(app.getHttpServer())
      .get('/staff')
      .set('Authorization', 'Bearer valid-token')
      .set('X-Institution-Id', 'school-1')
      .expect(200);

    expect(response.body.membership).toMatchObject({
      id: 'm-2',
      role: 'admin',
    });
  });

  it('returns 403 when the only membership is inactive', async () => {
    eqSchool.mockResolvedValue({
      data: [{ id: 'm-1', school_id: 'school-1', role: 'admin', status: 'inactive' }],
      error: null,
    });

    const response = await request(app.getHttpServer())
      .get('/staff')
      .set('Authorization', 'Bearer valid-token')
      .set('X-Institution-Id', 'school-1')
      .expect(403);

    expect(response.body.message).toBe('Tu usuario está inactivo en esta institución');
  });

  it('ignores an inactive membership when another one is active', async () => {
    eqSchool.mockResolvedValue({
      data: [
        { id: 'm-1', school_id: 'school-1', role: 'admin', status: 'inactive' },
        { id: 'm-2', school_id: 'school-1', role: 'teacher', status: 'active' },
      ],
      error: null,
    });

    const response = await request(app.getHttpServer())
      .get('/staff')
      .set('Authorization', 'Bearer valid-token')
      .set('X-Institution-Id', 'school-1')
      .expect(200);

    expect(response.body.membership).toMatchObject({ id: 'm-2', role: 'teacher' });
  });

  it('accepts any membership on routes without @Roles', () => {
    eqSchool.mockResolvedValue({
      data: [{ id: 'm-1', school_id: 'school-1', role: 'guardian' }],
      error: null,
    });

    return request(app.getHttpServer())
      .get('/staff/open')
      .set('Authorization', 'Bearer valid-token')
      .set('X-Institution-Id', 'school-1')
      .expect(200);
  });
});
