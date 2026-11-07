import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { SupabaseService } from '../../supabase/supabase.service.js';
import type { CreateLeadDto } from './dto/create-lead.dto.js';
import type { LeadStatus, UpdateLeadDto } from './dto/update-lead.dto.js';

const LEVELS = ['Inicial', 'Primario', 'Secundario', 'Terciario / Superior'];
const STATUSES: LeadStatus[] = ['new', 'contacted', 'discarded'];
const LEAD_COLUMNS =
  'id, institution_name, contact_name, city, contact_role, level, contact_channel, student_count, comment, status, created_at';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+?[0-9 ()-]+$/;

function isText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maxLength
  );
}

// Either a well-formed email or a phone with 8 to 15 digits.
function isContactChannel(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 254) {
    return false;
  }
  const channel = value.trim();
  if (EMAIL_PATTERN.test(channel)) {
    return true;
  }
  if (!PHONE_PATTERN.test(channel)) {
    return false;
  }
  const digits = channel.replace(/\D/g, '').length;
  return digits >= 8 && digits <= 15;
}

export interface LeadView {
  id: string;
  institutionName: string;
  contactName: string;
  city: string;
  contactRole: string;
  level: string;
  contactChannel: string;
  studentCount: number;
  comment: string;
  status: LeadStatus;
  createdAt: string;
}

interface LeadRow {
  id: string;
  institution_name: string;
  contact_name: string;
  city: string;
  contact_role: string;
  level: string;
  contact_channel: string;
  student_count: number;
  comment: string;
  status: LeadStatus;
  created_at: string;
}

function toView(row: LeadRow): LeadView {
  return {
    id: row.id,
    institutionName: row.institution_name,
    contactName: row.contact_name,
    city: row.city,
    contactRole: row.contact_role,
    level: row.level,
    contactChannel: row.contact_channel,
    studentCount: row.student_count,
    comment: row.comment,
    status: row.status,
    createdAt: row.created_at,
  };
}

@Injectable()
export class LeadsService {
  constructor(private readonly supabase: SupabaseService) {}

  async create(dto: CreateLeadDto): Promise<{ id: string }> {
    // Honeypot: bots fill `website`, humans never see it. Answer 201 with a
    // made-up id so the bot can't tell it was ignored.
    if (typeof dto?.website === 'string' && dto.website.trim()) {
      return { id: randomUUID() };
    }

    if (
      !dto ||
      !isText(dto.institutionName, 120) ||
      !isText(dto.contactName, 100) ||
      !isText(dto.city, 100) ||
      !isText(dto.contactRole, 80) ||
      !LEVELS.includes(dto.level) ||
      !isContactChannel(dto.contactChannel) ||
      !Number.isInteger(dto.studentCount) ||
      dto.studentCount < 1 ||
      dto.studentCount > 100000 ||
      !isText(dto.comment, 600) ||
      dto.privacyAccepted !== true
    ) {
      throw new BadRequestException('Revisá los datos del formulario');
    }

    const { data, error } = await this.supabase.admin
      .from('leads')
      .insert({
        institution_name: dto.institutionName.trim(),
        contact_name: dto.contactName.trim(),
        city: dto.city.trim(),
        contact_role: dto.contactRole.trim(),
        level: dto.level,
        contact_channel: dto.contactChannel.trim(),
        student_count: dto.studentCount,
        comment: dto.comment.trim(),
        privacy_accepted_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (error || !data) {
      throw new InternalServerErrorException();
    }
    return { id: (data as { id: string }).id };
  }

  // Newest first; `status` narrows the list when given.
  async list(status?: string): Promise<LeadView[]> {
    let query = this.supabase.admin
      .from('leads')
      .select(LEAD_COLUMNS)
      .order('created_at', { ascending: false });
    if (status !== undefined) {
      if (!STATUSES.includes(status as LeadStatus)) {
        throw new BadRequestException('Estado inválido');
      }
      query = query.eq('status', status);
    }

    const { data, error } = await query;
    if (error) {
      throw new InternalServerErrorException();
    }
    return ((data ?? []) as LeadRow[]).map(toView);
  }

  async update(id: string, dto: UpdateLeadDto): Promise<LeadView> {
    if (!STATUSES.includes(dto?.status)) {
      throw new BadRequestException('Estado inválido');
    }
    if (!UUID_PATTERN.test(id)) {
      throw new NotFoundException('No se encontró la postulación');
    }

    const { data, error } = await this.supabase.admin
      .from('leads')
      .update({ status: dto.status })
      .eq('id', id)
      .select(LEAD_COLUMNS)
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException();
    }
    if (!data) {
      throw new NotFoundException('No se encontró la postulación');
    }
    return toView(data as LeadRow);
  }
}
