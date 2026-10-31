import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/public.decorator.js';

@Public()
@Controller('health')
export class HealthController {
  @Get()
  checkHealth(): { status: string } {
    return { status: 'ok' };
  }
}
