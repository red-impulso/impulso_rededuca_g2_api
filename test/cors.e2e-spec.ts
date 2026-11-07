import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';

const VERCEL = 'https://impulso-rededuca-g2-app.vercel.app';

describe('CORS (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app, { CORS_ORIGINS: VERCEL });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('permite http://localhost:3000', async () => {
    const response = await request(app.getHttpServer())
      .get('/health')
      .set('Origin', 'http://localhost:3000')
      .expect(200);
    expect(response.headers['access-control-allow-origin']).toBe(
      'http://localhost:3000',
    );
  });

  it('permite el dominio de Vercel cargado en CORS_ORIGINS', async () => {
    const response = await request(app.getHttpServer())
      .get('/health')
      .set('Origin', VERCEL)
      .expect(200);
    expect(response.headers['access-control-allow-origin']).toBe(VERCEL);
  });

  it('la landing publicada puede mandar postulaciones a /leads', async () => {
    const landing = 'https://proyecto-red-educa-grupo-2.vercel.app';
    const response = await request(app.getHttpServer())
      .options('/leads')
      .set('Origin', landing)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type')
      .expect(204);
    expect(response.headers['access-control-allow-origin']).toBe(landing);
    expect(
      String(response.headers['access-control-allow-headers']).toLowerCase(),
    ).toContain('content-type');
  });

  it('no permite otros sitios', async () => {
    const response = await request(app.getHttpServer())
      .get('/health')
      .set('Origin', 'https://otro-sitio.com');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('la consulta previa (preflight) deja mandar Authorization y X-Institution-Id', async () => {
    const response = await request(app.getHttpServer())
      .options('/me')
      .set('Origin', 'http://localhost:3000')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'authorization,x-institution-id')
      .expect(204);
    const allowed = String(
      response.headers['access-control-allow-headers'],
    ).toLowerCase();
    expect(allowed).toContain('authorization');
    expect(allowed).toContain('x-institution-id');
  });
});
