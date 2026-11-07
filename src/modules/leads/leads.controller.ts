import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { MembershipGuard } from '../../auth/membership.guard.js';
import { Public } from '../../auth/public.decorator.js';
import { Roles } from '../../auth/roles.decorator.js';
import type { CreateLeadDto } from './dto/create-lead.dto.js';
import type { UpdateLeadDto } from './dto/update-lead.dto.js';
import { LeadsService } from './leads.service.js';

@Controller('leads')
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

  // Public form endpoint; the throttler is scoped to this route only.
  @Public()
  @Post()
  @UseGuards(ThrottlerGuard)
  create(@Body() body: CreateLeadDto) {
    return this.leads.create(body);
  }

  @Get()
  @UseGuards(MembershipGuard)
  @Roles('admin')
  list(@Query('status') status?: string) {
    return this.leads.list(status);
  }

  @Patch(':id')
  @UseGuards(MembershipGuard)
  @Roles('admin')
  update(@Param('id') id: string, @Body() body: UpdateLeadDto) {
    return this.leads.update(id, body);
  }
}
