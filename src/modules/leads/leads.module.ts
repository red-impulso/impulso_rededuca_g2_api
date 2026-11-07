import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { LeadsController } from './leads.controller.js';
import { LeadsService } from './leads.service.js';

@Module({
  // 5 submissions per minute per IP, only on POST /leads.
  imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 5 }])],
  controllers: [LeadsController],
  providers: [LeadsService],
})
export class LeadsModule {}
