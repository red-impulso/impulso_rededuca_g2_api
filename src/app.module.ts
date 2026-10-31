import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AuthGuard } from './auth/auth.guard.js';
import { HealthModule } from './health/health.module.js';
import { MeModule } from './me/me.module.js';
import { SupabaseModule } from './supabase/supabase.module.js';

@Module({
  imports: [
    EventEmitterModule.forRoot(),
    SupabaseModule,
    HealthModule,
    MeModule,
  ],
  controllers: [AppController],
  providers: [AppService, { provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
