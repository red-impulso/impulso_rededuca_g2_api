import { Controller, Get, Req } from '@nestjs/common';
import type { AuthedRequest } from '../auth/auth.guard.js';
import { MeService } from './me.service.js';

@Controller('me')
export class MeController {
  constructor(private readonly meService: MeService) {}

  @Get()
  getMe(@Req() request: AuthedRequest) {
    return this.meService.getMe(request.user);
  }
}
