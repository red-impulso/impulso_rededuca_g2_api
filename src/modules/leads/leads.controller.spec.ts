import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { vi } from 'vitest';
import { AuthGuard } from '../../auth/auth.guard.js';
import { SupabaseModule } from '../../supabase/supabase.module.js';
import { SupabaseService } from '../../supabase/supabase.service.js';
import { LeadsModule } from './leads.module.js';

interface QueryResult {
  data: unknown;
  error: unknown;
}

interface WriteCall {
  table: string;
  method: 'insert' | 'update';
  rows: unknown;
}

interface EqCall {
  table: string;
  column: string;
  value: unknown;
}

const LEAD_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('LeadsController', () => {
  let app: INestApplication<App>;

  const getUser = vi.fn();
  // Each table keeps a FIFO queue of results; every awaited query consumes one.
  let queues: Record<string, QueryResult[]>;
  let writes: WriteCall[];
  let eqCalls: EqCall[];

  // A thenable stand-in for the supabase query builder: every method returns
  // the chain itself and awaiting it resolves to the next queued result.
  function makeChain(table: string) {
    const chain = {
      select: vi.fn(),
      eq: vi.fn(),
      order: vi.fn(),
      maybeSingle: vi.fn(),
      single: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      // oxlint-disable-next-line no-thenable -- supabase builders are thenable
      then: (onFulfilled: (value: QueryResult) => unknown) => {
        const result = queues[table]?.shift() ?? { data: null, error: null };
        return Promise.resolve(result).then(onFulfilled);
      },
    };
    for (const method of ['select', 'order', 'maybeSingle', 'single'] as const) {
      chain[method].mockReturnValue(chain);
    }
    chain.eq.mockImplementation((column: string, value: unknown) => {
      eqCalls.push({ table, column, value });
      return chain;
    });
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

  // Same fields as the group 2 landing form.
  const validBody = (over: Record<string, unknown> = {}) => ({
    institutionName: 'Escuela 12',
    institutionType: 'Institución educativa pública',
    city: 'La Plata',
    studentCount: 320,
    contactName: 'Ana López',
    phone: '+54 221 456-7890',
    email: 'ana@escuela.edu.ar',
    comment: 'Nos interesa la propuesta',
    ...over,
  });

  const leadRow = (over: Record<string, unknown> = {}) => ({
    id: LEAD_ID,
    institution_name: 'Escuela 12',
    institution_type: 'Institución educativa pública',
    city: 'La Plata',
    student_count: 320,
    contact_name: 'Ana López',
    phone: '+54 221 456-7890',
    email: 'ana@escuela.edu.ar',
    comment: 'Nos interesa la propuesta',
    status: 'new',
    created_at: '2026-11-07T12:00:00Z',
    ...over,
  });

  const postLead = (body: object) =>
    request(app.getHttpServer()).post('/leads').send(body);

  beforeEach(async () => {
    vi.clearAllMocks();
    queues = {};
    writes = [];
    eqCalls = [];
    const module: TestingModule = await Test.createTestingModule({
      imports: [SupabaseModule, LeadsModule],
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

  describe('POST /leads', () => {
    it('saves a valid submission without a token and answers 201 with the id', async () => {
      queues.leads = [{ data: { id: 'lead-1' }, error: null }];

      const response = await postLead(validBody()).expect(201);

      expect(response.body).toEqual({ id: 'lead-1' });
      expect(writes[0]).toMatchObject({
        table: 'leads',
        method: 'insert',
        rows: {
          institution_name: 'Escuela 12',
          institution_type: 'Institución educativa pública',
          city: 'La Plata',
          student_count: 320,
          contact_name: 'Ana López',
          phone: '+54 221 456-7890',
          email: 'ana@escuela.edu.ar',
          comment: 'Nos interesa la propuesta',
        },
      });
    });

    it('trims the text fields before saving', async () => {
      queues.leads = [{ data: { id: 'lead-2' }, error: null }];

      await postLead(
        validBody({ institutionName: '  Escuela 12  ', email: ' ana@escuela.edu.ar ' }),
      ).expect(201);

      expect(writes[0]).toMatchObject({
        rows: { institution_name: 'Escuela 12', email: 'ana@escuela.edu.ar' },
      });
    });

    it.each([undefined, '', '   '])(
      'saves a null comment when it comes as %j: the message is optional',
      async (comment) => {
        queues.leads = [{ data: { id: 'lead-3' }, error: null }];

        await postLead(validBody({ comment })).expect(201);

        expect(writes[0]).toMatchObject({ rows: { comment: null } });
      },
    );

    it('returns 400 for an institution type outside the list', async () => {
      await postLead(validBody({ institutionType: 'Club de fútbol' })).expect(
        400,
      );
      expect(writes).toHaveLength(0);
    });

    it('returns 400 for a comment longer than 600 characters', async () => {
      await postLead(validBody({ comment: 'a'.repeat(601) })).expect(400);
      expect(writes).toHaveLength(0);
    });

    it('returns 400 when a required field is missing', async () => {
      const { contactName: _omitted, ...body } = validBody();

      await postLead(body).expect(400);
      expect(writes).toHaveLength(0);
    });

    it.each([0, 'abc', 100001, 12.5])('returns 400 for studentCount %s', async (value) => {
      await postLead(validBody({ studentCount: value })).expect(400);
      expect(writes).toHaveLength(0);
    });

    it('returns 400 for a malformed email', async () => {
      await postLead(validBody({ email: 'no-es-correo' })).expect(400);
      expect(writes).toHaveLength(0);
    });

    it.each(['123', '+54 221 abc', '1234567890123456'])(
      'returns 400 for the phone %s',
      async (phone) => {
        await postLead(validBody({ phone })).expect(400);
        expect(writes).toHaveLength(0);
      },
    );

    it('answers 201 without saving when the honeypot is filled', async () => {
      const response = await postLead(
        validBody({ website: 'https://spam.example' }),
      ).expect(201);

      expect(response.body.id).toBeTruthy();
      expect(writes).toHaveLength(0);
    });

    it('throttles to 5 submissions per minute per IP', async () => {
      queues.leads = Array.from({ length: 5 }, (_, i) => ({
        data: { id: `lead-${i}` },
        error: null,
      }));

      for (let i = 0; i < 5; i++) {
        await postLead(validBody()).expect(201);
      }
      await postLead(validBody()).expect(429);
    });
  });

  describe('GET /leads', () => {
    it('returns 401 without a token', async () => {
      await request(app.getHttpServer()).get('/leads').expect(401);
      expect(writes).toHaveLength(0);
    });

    it.each(['teacher', 'guardian'])('returns 403 for a %s', async (role) => {
      authAs(`${role}-1`);
      memberAs(role);

      await authed(request(app.getHttpServer()).get('/leads')).expect(403);
    });

    it('lists the leads newest first to an admin', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.leads = [
        {
          data: [
            leadRow({ id: 'lead-new', created_at: '2026-11-07T12:00:00Z' }),
            leadRow({ id: 'lead-old', created_at: '2026-11-06T12:00:00Z' }),
          ],
          error: null,
        },
      ];

      const response = await authed(
        request(app.getHttpServer()).get('/leads'),
      ).expect(200);

      expect(response.body).toHaveLength(2);
      expect(response.body[0]).toEqual({
        id: 'lead-new',
        institutionName: 'Escuela 12',
        institutionType: 'Institución educativa pública',
        city: 'La Plata',
        studentCount: 320,
        contactName: 'Ana López',
        phone: '+54 221 456-7890',
        email: 'ana@escuela.edu.ar',
        comment: 'Nos interesa la propuesta',
        status: 'new',
        createdAt: '2026-11-07T12:00:00Z',
      });
    });

    it('filters by status when the query param is given', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.leads = [{ data: [leadRow({ status: 'contacted' })], error: null }];

      const response = await authed(
        request(app.getHttpServer()).get('/leads?status=contacted'),
      ).expect(200);

      expect(response.body[0].status).toBe('contacted');
      expect(eqCalls).toContainEqual({
        table: 'leads',
        column: 'status',
        value: 'contacted',
      });
    });
  });

  describe('PATCH /leads/:id', () => {
    it('returns 401 without a token', async () => {
      await request(app.getHttpServer())
        .patch(`/leads/${LEAD_ID}`)
        .send({ status: 'contacted' })
        .expect(401);
    });

    it.each(['teacher', 'guardian'])('returns 403 for a %s', async (role) => {
      authAs(`${role}-1`);
      memberAs(role);

      await authed(
        request(app.getHttpServer())
          .patch(`/leads/${LEAD_ID}`)
          .send({ status: 'contacted' }),
      ).expect(403);
    });

    it('updates the status and returns the lead to an admin', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.leads = [
        { data: leadRow({ status: 'contacted' }), error: null },
      ];

      const response = await authed(
        request(app.getHttpServer())
          .patch(`/leads/${LEAD_ID}`)
          .send({ status: 'contacted' }),
      ).expect(200);

      expect(response.body.status).toBe('contacted');
      expect(writes[0]).toMatchObject({
        table: 'leads',
        method: 'update',
        rows: { status: 'contacted' },
      });
    });

    it('returns 400 for an invalid status', async () => {
      authAs('admin-1');
      memberAs('admin');

      await authed(
        request(app.getHttpServer())
          .patch(`/leads/${LEAD_ID}`)
          .send({ status: 'pending' }),
      ).expect(400);

      expect(writes).toHaveLength(0);
    });

    it('returns 404 for an id that does not exist', async () => {
      authAs('admin-1');
      memberAs('admin');
      queues.leads = [{ data: null, error: null }];

      await authed(
        request(app.getHttpServer())
          .patch(`/leads/${LEAD_ID}`)
          .send({ status: 'contacted' }),
      ).expect(404);
    });
  });
});
