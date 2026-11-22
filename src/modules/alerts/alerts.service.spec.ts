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
import { AlertsModule } from './alerts.module.js';
import { AlertsService } from './alerts.service.js';

interface QueryResult {
  data: unknown;
  error: unknown;
}

interface WriteCall {
  table: string;
  method: 'insert' | 'delete';
  rows: unknown;
}

describe('AlertsService', () => {
  let app: INestApplication<App>;
  let alerts: AlertsService;

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
      range: vi.fn(),
      maybeSingle: vi.fn(),
      insert: vi.fn(),
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
      'range',
      'maybeSingle',
    ] as const) {
      chain[method].mockReturnValue(chain);
    }
    chain.insert.mockImplementation((rows: unknown) => {
      writes.push({ table, method: 'insert', rows });
      return chain;
    });
    chain.delete.mockImplementation(() => {
      writes.push({ table, method: 'delete', rows: null });
      return chain;
    });
    return chain;
  }

  const from = vi.fn((table: string) => makeChain(table));
  const supabase = { admin: { auth: { getUser }, from } };

  const authAs = (id: string) =>
    getUser.mockResolvedValue({ data: { user: { id } }, error: null });

  const memberAs = (role: string) => {
    queues.memberships = [
      { data: [{ id: 'm-1', school_id: 'school-1', role }], error: null },
    ];
  };

  const authed = (test: request.Test) =>
    test
      .set('Authorization', 'Bearer valid-token')
      .set('X-Institution-Id', 'school-1');

  const course1 = { id: 'course-1', year: 1, division: 'A' };
  const course2 = { id: 'course-2', year: 2, division: 'B' };

  const enrollment = (
    id: string,
    firstName: string,
    lastName: string,
    course = course1,
    status = 'active',
  ) => ({
    student_id: id,
    course_id: course.id,
    profiles: { first_name: firstName, last_name: lastName, status },
    courses: { ...course, school_id: 'school-1' },
  });

  const att = (student_id: string, ...statuses: string[]) =>
    statuses.map((status) => ({ student_id, status }));

  const grade = (
    student_id: string,
    subject: { id: string; name: string },
    value: number,
  ) => ({ student_id, value, subjects: subject });

  const mate = { id: 'sub-1', name: 'Matemática' };
  const lengua = { id: 'sub-2', name: 'Lengua' };

  // A school where:
  // - Ana: 1 present + 2 absent (33,3 %) and Matemática 4 and 5 (4,5) -> 2 reasons
  // - Beto: 3 present + 1 absent (75 %) and Lengua 8 -> fine (75 is not below)
  // - Caro: only 2 absences (too few records) and Lengua 5 -> grade only
  // - Dani: 3 absences but inactive -> left out
  // - Eli (course 2): 3 absences + 1 justified -> 0 % attendance
  const school = () => {
    queues.enrollments = [
      {
        data: [
          enrollment('ana', 'Ana', 'Pérez'),
          enrollment('beto', 'Beto', 'Ruiz'),
          enrollment('caro', 'Caro', 'Sosa'),
          enrollment('dani', 'Dani', 'Vera', course1, 'inactive'),
          enrollment('eli', 'Eli', 'Acosta', course2),
        ],
        error: null,
      },
    ];
    queues.attendance_records = [
      {
        data: [
          ...att('ana', 'present', 'absent', 'absent'),
          ...att('beto', 'present', 'late', 'present', 'absent'),
          ...att('caro', 'absent', 'absent'),
          ...att('dani', 'absent', 'absent', 'absent'),
          ...att('eli', 'absent', 'absent', 'absent', 'justified'),
        ],
        error: null,
      },
    ];
    queues.grades = [
      {
        data: [
          grade('ana', mate, 4),
          grade('ana', mate, 5),
          grade('beto', lengua, 8),
          grade('caro', lengua, 5),
          grade('dani', lengua, 2),
        ],
        error: null,
      },
    ];
  };

  const ana = {
    student: { id: 'ana', firstName: 'Ana', lastName: 'Pérez' },
    course: course1,
    reasons: [
      { type: 'attendance', percentage: 33.3 },
      { type: 'grade', subject: mate, average: 4.5 },
    ],
  };
  const eli = {
    student: { id: 'eli', firstName: 'Eli', lastName: 'Acosta' },
    course: course2,
    reasons: [{ type: 'attendance', percentage: 0 }],
  };
  const caro = {
    student: { id: 'caro', firstName: 'Caro', lastName: 'Sosa' },
    course: course1,
    reasons: [{ type: 'grade', subject: lengua, average: 5 }],
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    queues = {};
    writes = [];
    const module: TestingModule = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot(), SupabaseModule, AlertsModule],
      providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
    })
      .overrideProvider(SupabaseService)
      .useValue(supabase)
      .compile();

    app = module.createNestApplication();
    await app.init();
    alerts = module.get(AlertsService);
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /alerts', () => {
    it.each(['admin', 'director'])(
      'gives a %s every student at risk with the reasons, the most worrying first',
      async (role) => {
        authAs(`${role}-1`);
        memberAs(role);
        school();

        const response = await authed(
          request(app.getHttpServer()).get('/alerts'),
        ).expect(200);

        expect(response.body).toEqual([ana, eli, caro]);
      },
    );

    it('gives a teacher only the students of the courses they teach', async () => {
      authAs('teacher-1');
      memberAs('teacher');
      queues.subjects = [{ data: [{ course_id: 'course-2' }], error: null }];
      school();

      const response = await authed(
        request(app.getHttpServer()).get('/alerts'),
      ).expect(200);

      expect(response.body).toEqual([eli]);
    });

    it('gives an empty list to a teacher without subjects', async () => {
      authAs('teacher-1');
      memberAs('teacher');
      queues.subjects = [{ data: [], error: null }];

      const response = await authed(
        request(app.getHttpServer()).get('/alerts'),
      ).expect(200);

      expect(response.body).toEqual([]);
    });

    it.each(['guardian', 'student'])('returns 403 to a %s', async (role) => {
      authAs(`${role}-1`);
      memberAs(role);

      await authed(request(app.getHttpServer()).get('/alerts')).expect(403);
    });

    it('returns 500 when a query fails', async () => {
      authAs('admin-1');
      memberAs('admin');
      school();
      queues.grades = [{ data: null, error: { message: 'boom' } }];

      await authed(request(app.getHttpServer()).get('/alerts')).expect(500);
    });
  });

  describe('syncAlerts (after saving attendance or grades)', () => {
    it('notifies guardians and directivos only for students that just became at risk', async () => {
      school();
      // Ana was already flagged; Eli is new; Beto is fine.
      queues.risk_alerts = [{ data: [{ student_id: 'ana' }], error: null }];
      queues.guardian_links = [
        {
          data: [
            { guardian_id: 'tutor-eli', student_id: 'eli' },
            { guardian_id: 'tutor-eli-2', student_id: 'eli' },
          ],
          error: null,
        },
      ];
      queues.memberships = [
        {
          data: [{ user_id: 'admin-1' }, { user_id: 'director-1' }],
          error: null,
        },
      ];

      await alerts.syncAlerts('school-1', ['ana', 'eli', 'beto']);

      expect(writes).toEqual([
        {
          table: 'risk_alerts',
          method: 'insert',
          rows: [{ school_id: 'school-1', student_id: 'eli' }],
        },
        {
          table: 'notifications',
          method: 'insert',
          rows: [
            {
              school_id: 'school-1',
              user_id: 'tutor-eli',
              type: 'risk',
              title: 'Alerta: Eli Acosta necesita acompañamiento',
              body: 'Asistencia 0 %',
            },
            {
              school_id: 'school-1',
              user_id: 'tutor-eli-2',
              type: 'risk',
              title: 'Alerta: Eli Acosta necesita acompañamiento',
              body: 'Asistencia 0 %',
            },
            {
              school_id: 'school-1',
              user_id: 'admin-1',
              type: 'risk',
              title: 'Alumno en riesgo: Eli Acosta (2°B)',
              body: 'Asistencia 0 %',
            },
            {
              school_id: 'school-1',
              user_id: 'director-1',
              type: 'risk',
              title: 'Alumno en riesgo: Eli Acosta (2°B)',
              body: 'Asistencia 0 %',
            },
          ],
        },
      ]);
    });

    it('forgets the alert of a student that is no longer at risk, so it can warn again later', async () => {
      school();
      queues.risk_alerts = [
        { data: [{ student_id: 'ana' }, { student_id: 'beto' }], error: null },
      ];

      await alerts.syncAlerts('school-1', ['ana', 'beto']);

      expect(writes).toEqual([
        { table: 'risk_alerts', method: 'delete', rows: null },
      ]);
    });

    it('joins several reasons in the notification text', async () => {
      school();
      queues.risk_alerts = [{ data: [], error: null }];
      queues.guardian_links = [
        {
          data: [{ guardian_id: 'tutor-ana', student_id: 'ana' }],
          error: null,
        },
      ];
      queues.memberships = [{ data: [], error: null }];

      await alerts.syncAlerts('school-1', ['ana']);

      expect(writes[1].rows).toEqual([
        {
          school_id: 'school-1',
          user_id: 'tutor-ana',
          type: 'risk',
          title: 'Alerta: Ana Pérez necesita acompañamiento',
          body: 'Asistencia 33,3 % · Matemática: promedio 4,5',
        },
      ]);
    });

    it('does nothing without students', async () => {
      await alerts.syncAlerts('school-1', []);

      expect(from).not.toHaveBeenCalled();
    });
  });
});
