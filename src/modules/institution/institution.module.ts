import { Module } from '@nestjs/common';
import { InstitutionController } from './institution.controller.js';
import { InstitutionService } from './institution.service.js';

@Module({
  controllers: [InstitutionController],
  providers: [InstitutionService],
})
export class InstitutionModule {}
