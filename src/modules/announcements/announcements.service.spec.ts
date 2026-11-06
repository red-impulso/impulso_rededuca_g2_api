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
import { ANNOUNCEMENT_CREATED_EVENT } from './announcements.service.js';
import { AnnouncementsModule } from './announcements.module.js';

interface QueryResult {
  data: unknown;
  error: unknown;
}

interface WriteCall {
  table: string;
  method: 'upsert' | 'insert';
  rows: unknown;
}

describe('AnnouncementsService', () => {
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
      single: vi.fn(),
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
      'single',
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

  const announcementRow = (over: Record<string, unknown>) => ({
    id: 'ann-1',
    scope: 'institution',
    course_id: null,
    student_id: null,
    title: 'Título',
    body: 'Cuerpo',
    created_at: '2026-11-01T00:00:00Z',
    ...over,
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    queues = {};
    writes = [];
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        EventEmitterModule.forRoot(),
        SupabaseModule,
        AnnouncementsModule,
      ],
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

  describe('POST /announcements', () => {
    it('lets an admin post an institution announcement and emits announcement.created', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.announcements = [
        {
          data: announcementRow({ id: 'ann-new' }),
          error: null,
        },
      ];
      const emit = vi.spyOn(events, 'emit');

      const response = await authed(
        request(app.getHttpServer()).post('/announcements').send({
          scope: 'institution',
          title: 'Reunión general',
          body: 'Viernes 18hs',
        }),
      ).expect(201);

      expect(response.body).toMatchObject({
        id: 'ann-new',
        scope: 'institution',
      });
      expect(writes[0]).toMatchObject({
        table: 'announcements',
        method: 'insert',
        rows: {
          school_id: 'school-1',
          scope: 'institution',
          course_id: null,
          student_id: null,
          title: 'Reunión general',
          body: 'Viernes 18hs',
          created_by: 'admin-1',
        },
      });
      expect(emit).toHaveBeenCalledWith(
        ANNOUNCEMENT_CREATED_EVENT,
        expect.objectContaining({
          schoolId: 'school-1',
          announcementId: 'ann-new',
          scope: 'institution',
          createdBy: 'admin-1',
        }),
      );
    });

    it('lets a teacher post to a course they teach in', async () => {
      authAs('teacher-1');
      memberAs('teacher');
      queues.courses = [{ data: { id: 'course-1' }, error: null }];
      queues.subjects = [{ data: { id: 'subject-1' }, error: null }];
      queues.announcements = [
        {
          data: announcementRow({ scope: 'course', course_id: 'course-1' }),
          error: null,
        },
      ];

      await authed(
        request(app.getHttpServer()).post('/announcements').send({
          scope: 'course',
          courseId: 'course-1',
          title: 'Entrega de notas',
          body: 'La semana que viene',
        }),
      ).expect(201);

      expect(writes[0]).toMatchObject({
        rows: expect.objectContaining({
          scope: 'course',
          course_id: 'course-1',
          created_by: 'teacher-1',
        }),
      });
    });

    it('returns 403 for a teacher posting to a course they do not teach', async () => {
      authAs('teacher-1');
      memberAs('teacher');
      queues.courses = [{ data: { id: 'course-1' }, error: null }];
      queues.subjects = [{ data: null, error: null }];

      await authed(
        request(app.getHttpServer()).post('/announcements').send({
          scope: 'course',
          courseId: 'course-1',
          title: 'X',
          body: 'Y',
        }),
      ).expect(403);

      expect(writes).toHaveLength(0);
    });

    it('returns 403 for a teacher posting institution scope', async () => {
      authAs('teacher-1');
      memberAs('teacher');

      await authed(
        request(app.getHttpServer()).post('/announcements').send({
          scope: 'institution',
          title: 'X',
          body: 'Y',
        }),
      ).expect(403);
    });

    it('returns 403 for a guardian', async () => {
      authAs('guardian-1');
      memberAs('guardian');

      await authed(
        request(app.getHttpServer()).post('/announcements').send({
          scope: 'student',
          studentId: 'stu-1',
          title: 'X',
          body: 'Y',
        }),
      ).expect(403);
    });

    it("returns 400 for scope 'course' without courseId", async () => {
      authAs('admin-1');
      memberAs('admin');

      await authed(
        request(app.getHttpServer()).post('/announcements').send({
          scope: 'course',
          title: 'X',
          body: 'Y',
        }),
      ).expect(400);

      expect(writes).toHaveLength(0);
    });

    it('returns 400 for an empty title', async () => {
      authAs('admin-1');
      memberAs('admin');

      await authed(
        request(app.getHttpServer()).post('/announcements').send({
          scope: 'institution',
          title: '   ',
          body: 'Y',
        }),
      ).expect(400);

      expect(writes).toHaveLength(0);
    });

    it('returns 400 for an invalid scope', async () => {
      authAs('admin-1');
      memberAs('admin');

      await authed(
        request(app.getHttpServer()).post('/announcements').send({
          scope: 'everyone',
          title: 'X',
          body: 'Y',
        }),
      ).expect(400);
    });

    it('lets a director post a student announcement', async () => {
      authAs('director-1');
      memberAs('director');
      queues.enrollments = [
        {
          data: {
            student_id: 'stu-1',
            courses: { school_id: 'school-1' },
          },
          error: null,
        },
      ];
      queues.announcements = [
        {
          data: announcementRow({ scope: 'student', student_id: 'stu-1' }),
          error: null,
        },
      ];

      await authed(
        request(app.getHttpServer()).post('/announcements').send({
          scope: 'student',
          studentId: 'stu-1',
          title: 'Citación',
          body: 'Pasar por dirección',
        }),
      ).expect(201);

      expect(writes[0]).toMatchObject({
        rows: expect.objectContaining({
          scope: 'student',
          student_id: 'stu-1',
        }),
      });
    });

    it('returns 404 for a student of another institution', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.enrollments = [{ data: null, error: null }];

      await authed(
        request(app.getHttpServer()).post('/announcements').send({
          scope: 'student',
          studentId: 'stu-other',
          title: 'X',
          body: 'Y',
        }),
      ).expect(404);
    });
  });

  describe('GET /announcements', () => {
    const allAnnouncements = () => {
      queues.announcements = [
        {
          data: [
            announcementRow({ id: 'a-inst', scope: 'institution' }),
            announcementRow({
              id: 'a-course-own',
              scope: 'course',
              course_id: 'course-1',
            }),
            announcementRow({
              id: 'a-course-other',
              scope: 'course',
              course_id: 'course-9',
            }),
            announcementRow({
              id: 'a-student-own',
              scope: 'student',
              student_id: 'stu-1',
            }),
            announcementRow({
              id: 'a-student-other',
              scope: 'student',
              student_id: 'stu-9',
            }),
          ],
          error: null,
        },
      ];
    };

    it('shows a guardian institution, their kids courses and their kids announcements only', async () => {
      authAs('guardian-1');
      memberAs('guardian');
      allAnnouncements();
      queues.guardian_links = [
        { data: [{ student_id: 'stu-1' }], error: null },
      ];
      queues.enrollments = [{ data: [{ course_id: 'course-1' }], error: null }];

      const response = await authed(
        request(app.getHttpServer()).get('/announcements'),
      ).expect(200);

      expect(response.body.map((a: { id: string }) => a.id)).toEqual([
        'a-inst',
        'a-course-own',
        'a-student-own',
      ]);
    });

    it('shows a teacher institution and the courses they teach only', async () => {
      authAs('teacher-1');
      memberAs('teacher');
      allAnnouncements();
      queues.subjects = [{ data: [{ course_id: 'course-1' }], error: null }];

      const response = await authed(
        request(app.getHttpServer()).get('/announcements'),
      ).expect(200);

      expect(response.body.map((a: { id: string }) => a.id)).toEqual([
        'a-inst',
        'a-course-own',
      ]);
    });

    it('shows a student institution, their course and announcements for them', async () => {
      authAs('stu-1');
      memberAs('student');
      allAnnouncements();
      queues.enrollments = [{ data: [{ course_id: 'course-1' }], error: null }];

      const response = await authed(
        request(app.getHttpServer()).get('/announcements'),
      ).expect(200);

      expect(response.body.map((a: { id: string }) => a.id)).toEqual([
        'a-inst',
        'a-course-own',
        'a-student-own',
      ]);
    });

    it.each(['admin', 'director'])('shows everything to a %s', async (role) => {
      authAs(`${role}-1`);
      memberAs(role);
      allAnnouncements();

      const response = await authed(
        request(app.getHttpServer()).get('/announcements'),
      ).expect(200);

      expect(response.body).toHaveLength(5);
    });

    it('returns 401 without a token', () => {
      return request(app.getHttpServer()).get('/announcements').expect(401);
    });
  });
});
