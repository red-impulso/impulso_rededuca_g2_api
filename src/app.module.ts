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
import { DashboardModule } from './modules/dashboard/dashboard.module.js';
import { GradesModule } from './modules/grades/grades.module.js';
import { GuardiansModule } from './modules/guardians/guardians.module.js';
import { InstitutionModule } from './modules/institution/institution.module.js';
import { LeadsModule } from './modules/leads/leads.module.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';
import { StudentsModule } from './modules/students/students.module.js';
import { TeachersModule } from './modules/teachers/teachers.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { SupabaseModule } from './supabase/supabase.module.js';
import { createObserveModule } from '@nestjs/observe';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: [
    ObserveModule.forRoot({
      appKey: process.env.OBSERVE_APP_KEY,
      appSecret: process.env.OBSERVE_APP_SECRET,
      serviceId: 'impulsorededucag2api',
    }),
    EventEmitterModule.forRoot(),
    SupabaseModule,
    HealthModule,
    MeModule,
    GradesModule,
    AttendanceModule,
    AnnouncementsModule,
    NotificationsModule,
    DashboardModule,
    InstitutionModule,
    LeadsModule,
    GuardiansModule,
    TeachersModule,
    StudentsModule,
    UsersModule,
  ],
  controllers: [AppController],
  providers: [AppService, { provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
