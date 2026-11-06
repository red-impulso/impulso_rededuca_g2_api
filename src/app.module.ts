import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AuthGuard } from './auth/auth.guard.js';
import { HealthModule } from './health/health.module.js';
import { MeModule } from './me/me.module.js';
import { AnnouncementsModule } from './modules/announcements/announcements.module.js';
import { AttendanceModule } from './modules/attendance/attendance.module.js';
import { GradesModule } from './modules/grades/grades.module.js';
import { SupabaseModule } from './supabase/supabase.module.js';

@Module({
  imports: [
    EventEmitterModule.forRoot(),
    SupabaseModule,
    HealthModule,
    MeModule,
    GradesModule,
    AttendanceModule,
    AnnouncementsModule,
  ],
  controllers: [AppController],
  providers: [AppService, { provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
