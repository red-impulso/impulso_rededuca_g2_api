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

const INSTITUTION_TYPES = [
  'Institución educativa pública',
  'Institución educativa privada',
  'Institución de gestión social o cooperativa',
  'Otra',
];
const STATUSES: LeadStatus[] = ['new', 'contacted', 'discarded'];
const LEAD_COLUMNS =
  'id, institution_name, institution_type, city, student_count, contact_name, phone, email, comment, status, created_at';
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

function isEmail(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 254 &&
    EMAIL_PATTERN.test(value.trim())
  );
}

// Digits, spaces, dashes and parentheses, with 8 to 15 digits.
function isPhone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 30) {
    return false;
  }
  const phone = value.trim();
  const digits = phone.replace(/\D/g, '').length;
  return PHONE_PATTERN.test(phone) && digits >= 8 && digits <= 15;
}

// The message is optional: missing or blank is saved as null.
function optionalComment(value: unknown): string | null | undefined {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string' || value.length > 600) {
    return undefined;
  }
  return value.trim() || null;
}

export interface LeadView {
  id: string;
  institutionName: string;
  institutionType: string;
  city: string;
  studentCount: number;
  contactName: string;
  phone: string;
  email: string;
  comment: string | null;
  status: LeadStatus;
  createdAt: string;
}

interface LeadRow {
  id: string;
  institution_name: string;
  institution_type: string;
  city: string;
  student_count: number;
  contact_name: string;
  phone: string;
  email: string;
  comment: string | null;
  status: LeadStatus;
  created_at: string;
}

function toView(row: LeadRow): LeadView {
  return {
    id: row.id,
    institutionName: row.institution_name,
    institutionType: row.institution_type,
    city: row.city,
    studentCount: row.student_count,
    contactName: row.contact_name,
    phone: row.phone,
    email: row.email,
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

    const comment = optionalComment(dto?.comment);
    if (
      !dto ||
      !isText(dto.institutionName, 120) ||
      !INSTITUTION_TYPES.includes(dto.institutionType) ||
      !isText(dto.city, 100) ||
      !Number.isInteger(dto.studentCount) ||
      dto.studentCount < 1 ||
      dto.studentCount > 100000 ||
      !isText(dto.contactName, 100) ||
      !isPhone(dto.phone) ||
      !isEmail(dto.email) ||
      comment === undefined
    ) {
      throw new BadRequestException('Revisá los datos del formulario');
    }

    const { data, error } = await this.supabase.admin
      .from('leads')
      .insert({
        institution_name: dto.institutionName.trim(),
        institution_type: dto.institutionType,
        city: dto.city.trim(),
        student_count: dto.studentCount,
        contact_name: dto.contactName.trim(),
        phone: dto.phone.trim(),
        email: dto.email.trim(),
        comment,
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
