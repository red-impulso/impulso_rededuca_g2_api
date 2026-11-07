import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module.js';
import { GuardiansController } from './guardians.controller.js';
import { GuardiansService } from './guardians.service.js';

@Module({
  imports: [UsersModule],
  controllers: [GuardiansController],
  providers: [GuardiansService],
})
export class GuardiansModule {}
