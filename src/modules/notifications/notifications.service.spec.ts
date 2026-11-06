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
import { GRADES_SAVED_EVENT } from '../grades/grades.service.js';
import { NotificationsModule } from './notifications.module.js';
import { NotificationsService } from './notifications.service.js';

interface QueryResult {
  data: unknown;
  error: unknown;
}

interface WriteCall {
  table: string;
  method: 'upsert' | 'insert' | 'update';
  rows: unknown;
}

describe('NotificationsService', () => {
  let app: INestApplication<App>;
  let events: EventEmitter2;
  let service: NotificationsService;

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
      is: vi.fn(),
      order: vi.fn(),
      limit: vi.fn(),
      maybeSingle: vi.fn(),
      single: vi.fn(),
      upsert: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
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
      'is',
      'order',
      'limit',
      'maybeSingle',
      'single',
    ] as const) {
      chain[method].mockReturnValue(chain);
    }
    for (const method of ['upsert', 'insert', 'update'] as const) {
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

  const notificationRows = () =>
    writes.filter((w) => w.table === 'notifications');

  beforeEach(async () => {
    vi.clearAllMocks();
    queues = {};
    writes = [];
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        EventEmitterModule.forRoot(),
        SupabaseModule,
        NotificationsModule,
      ],
      providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
    })
      .overrideProvider(SupabaseService)
      .useValue(supabase)
      .compile();

    app = module.createNestApplication();
    await app.init();
    events = module.get(EventEmitter2);
    service = module.get(NotificationsService);
  });

  afterEach(async () => {
    await app.close();
  });

  describe('grades.saved listener', () => {
    const gradesPayload = (students: string[]) => ({
      schoolId: 'school-1',
      subjectId: 'subject-1',
      periodId: 'period-1',
      saved: students.length,
      updatedBy: 'teacher-1',
      students,
    });

    it('creates a notification for each tutor of the students with new grades', async () => {
      queues.subjects = [{ data: { name: 'Matemática' }, error: null }];
      queues.guardian_links = [
        {
          data: [{ guardian_id: 'guardian-1' }, { guardian_id: 'guardian-2' }],
          error: null,
        },
      ];
      queues.notifications = [{ data: null, error: null }];

      await service.notifyGradesSaved(gradesPayload(['stu-1', 'stu-2']));

      expect(notificationRows()).toHaveLength(1);
      expect(notificationRows()[0]).toMatchObject({
        method: 'insert',
        rows: [
          {
            school_id: 'school-1',
            user_id: 'guardian-1',
            type: 'grade',
            title: 'Nueva nota en Matemática',
          },
          {
            school_id: 'school-1',
            user_id: 'guardian-2',
            type: 'grade',
            title: 'Nueva nota en Matemática',
          },
        ],
      });
    });

    it('notifies each tutor once even if several of their kids got grades', async () => {
      queues.subjects = [{ data: { name: 'Lengua' }, error: null }];
      queues.guardian_links = [
        {
          data: [{ guardian_id: 'guardian-1' }, { guardian_id: 'guardian-1' }],
          error: null,
        },
      ];
      queues.notifications = [{ data: null, error: null }];

      await service.notifyGradesSaved(gradesPayload(['stu-1', 'stu-2']));

      expect((notificationRows()[0].rows as unknown[]).length).toBe(1);
    });

    it('writes nothing when no student changed and when there are no tutors', async () => {
      await service.notifyGradesSaved(gradesPayload([]));

      queues.subjects = [{ data: { name: 'X' }, error: null }];
      queues.guardian_links = [{ data: [], error: null }];
      await service.notifyGradesSaved(gradesPayload(['stu-1']));

      expect(notificationRows()).toHaveLength(0);
    });

    it('is wired to the grades.saved event', async () => {
      queues.subjects = [{ data: { name: 'Matemática' }, error: null }];
      queues.guardian_links = [
        { data: [{ guardian_id: 'guardian-1' }], error: null },
      ];
      queues.notifications = [{ data: null, error: null }];

      events.emit(GRADES_SAVED_EVENT, gradesPayload(['stu-1']));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(notificationRows()).toHaveLength(1);
    });
  });

  describe('attendance.saved listener', () => {
    it('notifies the tutors of each absent student', async () => {
      queues.profiles = [
        {
          data: [
            { id: 'stu-1', first_name: 'Ana', last_name: 'García' },
            { id: 'stu-2', first_name: 'Bruno', last_name: 'Díaz' },
          ],
          error: null,
        },
      ];
      queues.guardian_links = [
        {
          data: [
            { guardian_id: 'guardian-1', student_id: 'stu-1' },
            { guardian_id: 'guardian-2', student_id: 'stu-2' },
          ],
          error: null,
        },
      ];
      queues.notifications = [{ data: null, error: null }];

      await service.notifyAttendanceSaved({
        schoolId: 'school-1',
        courseId: 'course-1',
        date: '2020-01-15',
        recordedBy: 'teacher-1',
        absent: ['stu-1', 'stu-2'],
      });

      expect(notificationRows()[0]).toMatchObject({
        method: 'insert',
        rows: [
          {
            user_id: 'guardian-1',
            type: 'attendance',
            title: 'Ana García estuvo ausente el 2020-01-15',
          },
          {
            user_id: 'guardian-2',
            type: 'attendance',
            title: 'Bruno Díaz estuvo ausente el 2020-01-15',
          },
        ],
      });
    });
  });

  describe('announcement.created listener', () => {
    const announcementPayload = (over: Record<string, unknown>) => ({
      schoolId: 'school-1',
      announcementId: 'ann-1',
      scope: 'institution',
      courseId: null,
      studentId: null,
      title: 'Reunión general',
      createdBy: 'admin-1',
      ...over,
    });

    it('notifies every guardian of the school for institution scope', async () => {
      queues.memberships = [
        {
          data: [{ user_id: 'guardian-1' }, { user_id: 'guardian-2' }],
          error: null,
        },
      ];
      queues.notifications = [{ data: null, error: null }];

      await service.notifyAnnouncementCreated(announcementPayload({}));

      expect(notificationRows()[0]).toMatchObject({
        method: 'insert',
        rows: [
          {
            user_id: 'guardian-1',
            type: 'announcement',
            title: 'Nuevo comunicado: Reunión general',
          },
          {
            user_id: 'guardian-2',
            type: 'announcement',
            title: 'Nuevo comunicado: Reunión general',
          },
        ],
      });
    });

    it('notifies only the tutors of the course students for course scope', async () => {
      queues.enrollments = [{ data: [{ student_id: 'stu-1' }], error: null }];
      queues.guardian_links = [
        { data: [{ guardian_id: 'guardian-1' }], error: null },
      ];
      queues.notifications = [{ data: null, error: null }];

      await service.notifyAnnouncementCreated(
        announcementPayload({ scope: 'course', courseId: 'course-1' }),
      );

      expect((notificationRows()[0].rows as unknown[]).length).toBe(1);
      expect(
        (notificationRows()[0].rows as { user_id: string }[])[0].user_id,
      ).toBe('guardian-1');
    });

    it('notifies only the tutors of the student for student scope', async () => {
      queues.guardian_links = [
        { data: [{ guardian_id: 'guardian-1' }], error: null },
      ];
      queues.notifications = [{ data: null, error: null }];

      await service.notifyAnnouncementCreated(
        announcementPayload({ scope: 'student', studentId: 'stu-1' }),
      );

      expect((notificationRows()[0].rows as unknown[]).length).toBe(1);
    });
  });

  describe('GET /notifications', () => {
    it('returns the caller notifications in the school', async () => {
      authAs('guardian-1');
      memberAs('guardian');
      queues.notifications = [
        {
          data: [
            {
              id: 'notif-1',
              type: 'grade',
              title: 'Nueva nota en Matemática',
              body: null,
              read_at: null,
              created_at: '2026-11-05T10:00:00Z',
            },
          ],
          error: null,
        },
      ];

      const response = await authed(
        request(app.getHttpServer()).get('/notifications'),
      ).expect(200);

      expect(response.body).toEqual([
        {
          id: 'notif-1',
          type: 'grade',
          title: 'Nueva nota en Matemática',
          body: null,
          readAt: null,
          createdAt: '2026-11-05T10:00:00Z',
        },
      ]);
    });

    it('returns the unread count', async () => {
      authAs('guardian-1');
      memberAs('guardian');
      queues.notifications = [
        { data: [{ id: 'n-1' }, { id: 'n-2' }], error: null },
      ];

      const response = await authed(
        request(app.getHttpServer()).get('/notifications/unread-count'),
      ).expect(200);

      expect(response.body).toEqual({ count: 2 });
    });
  });

  describe('POST /notifications/:id/read', () => {
    it('marks the notification as read when it belongs to the caller', async () => {
      authAs('guardian-1');
      memberAs('guardian');
      queues.notifications = [
        {
          data: {
            id: 'notif-1',
            type: 'grade',
            title: 'Nueva nota en Matemática',
            body: null,
            read_at: null,
            created_at: '2026-11-05T10:00:00Z',
          },
          error: null,
        },
        {
          data: {
            id: 'notif-1',
            type: 'grade',
            title: 'Nueva nota en Matemática',
            body: null,
            read_at: '2026-11-05T11:00:00Z',
            created_at: '2026-11-05T10:00:00Z',
          },
          error: null,
        },
      ];

      const response = await authed(
        request(app.getHttpServer()).post('/notifications/notif-1/read'),
      ).expect(201);

      expect(response.body.readAt).toBe('2026-11-05T11:00:00Z');
      expect(writes[0]).toMatchObject({
        table: 'notifications',
        method: 'update',
      });
    });

    it('returns 404 for a notification of another user', async () => {
      authAs('guardian-1');
      memberAs('guardian');
      queues.notifications = [{ data: null, error: null }];

      await authed(
        request(app.getHttpServer()).post('/notifications/notif-other/read'),
      ).expect(404);

      expect(writes).toHaveLength(0);
    });
  });

  describe('POST /notifications/read-all', () => {
    it('marks every unread notification of the caller as read', async () => {
      authAs('guardian-1');
      memberAs('guardian');
      queues.notifications = [
        { data: [{ id: 'n-1' }, { id: 'n-2' }], error: null },
      ];

      const response = await authed(
        request(app.getHttpServer()).post('/notifications/read-all'),
      ).expect(201);

      expect(response.body).toEqual({ read: 2 });
      expect(writes[0]).toMatchObject({
        table: 'notifications',
        method: 'update',
      });
    });
  });
});
