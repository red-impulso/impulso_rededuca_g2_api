import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module.js';
import { TeachersController } from './teachers.controller.js';
import { TeachersService } from './teachers.service.js';

@Module({
  imports: [UsersModule],
  controllers: [TeachersController],
  providers: [TeachersService],
})
export class TeachersModule {}
