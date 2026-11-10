import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule, ObserveInstrument } from './app.module.js';
import { configureApp } from './app.setup.js';

try {
  process.loadEnvFile();
} catch {
  // .env is optional; variables may come from the host environment
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    instrument: ObserveInstrument,
  });
  // Render puts a proxy in front; trust it so rate limiting sees real IPs.
  app.set('trust proxy', 1);
  configureApp(app);
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
