import type { INestApplication } from '@nestjs/common';

// Local front-end dev server; always allowed.
const LOCAL_ORIGIN = 'http://localhost:3000';

// Landing page that posts to the public /leads endpoint.
const LANDING_ORIGIN = 'https://proyecto-red-educa-grupo-2.vercel.app';

// CORS_ORIGINS: comma-separated extra origins (the group's Vercel domain),
// e.g. "https://impulso-rededuca-g2-app.vercel.app".
export function corsOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);
  return [LOCAL_ORIGIN, LANDING_ORIGIN, ...extra];
}

// Shared by main.ts and the e2e tests so both run the same configuration.
export function configureApp(
  app: INestApplication,
  env: NodeJS.ProcessEnv = process.env,
): void {
  app.enableCors({
    origin: corsOrigins(env),
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Institution-Id'],
  });
}
