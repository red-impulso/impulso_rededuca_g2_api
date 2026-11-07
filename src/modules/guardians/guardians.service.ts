import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import type { Membership as ActiveMembership } from '../../auth/membership.guard.js';
import { SupabaseService } from '../../supabase/supabase.service.js';
import { UsersService } from '../users/users.service.js';
import type {
  GuardianContactDto,
  LinkGuardianDto,
} from './dto/link-guardian.dto.js';

const UNIQUE_VIOLATION = '23505';
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RELATIONSHIPS = ['madre', 'padre', 'tutor', 'otro'];

export interface GuardianResponse {
  id: string;
  fullName: string | null;
}

// What the student file shows about a linked guardian.
export interface LinkedGuardianResponse extends GuardianResponse {
  relationship: string | null;
  phone: string | null;
  email: string | null;
}

interface MembershipRow {
  id: string;
  user_id: string;
  role: string;
  profiles:
    | { full_name: string | null }
    | { full_name: string | null }[]
    | null;
}

interface LinkRow {
  guardian_id: string;
  relationship?: string | null;
}

function firstRow<T>(value: T | T[] | null | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : (value ?? undefined);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === UNIQUE_VIOLATION
  );
}

function byName(a: GuardianResponse, b: GuardianResponse): number {
  return (a.fullName ?? '').localeCompare(b.fullName ?? '', 'es');
}

function toGuardians(rows: MembershipRow[]): GuardianResponse[] {
  return rows
    .map((row) => ({
      id: row.id,
      fullName: firstRow(row.profiles)?.full_name ?? null,
    }))
    .sort(byName);
}

// Keeps only what came in the request; a blank value clears it.
function parseContact(dto: GuardianContactDto | undefined): {
  relationship?: string | null;
  phone?: string | null;
} {
  const contact: { relationship?: string | null; phone?: string | null } = {};
  if (dto?.relationship !== undefined) {
    if (
      dto.relationship !== null &&
      !RELATIONSHIPS.includes(dto.relationship)
    ) {
      throw new BadRequestException('El parentesco indicado no es válido');
    }
    contact.relationship = dto.relationship;
  }
  if (dto?.phone !== undefined) {
    if (dto.phone !== null && typeof dto.phone !== 'string') {
      throw new BadRequestException('El teléfono indicado no es válido');
    }
    contact.phone = dto.phone?.trim() || null;
  }
  return contact;
}

@Injectable()
export class GuardiansService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly users: UsersService,
  ) {}

  // Everyone who can be linked to a student of the institution.
  async listSchoolGuardians(
    membership: ActiveMembership,
  ): Promise<GuardianResponse[]> {
    const { data, error } = await this.supabase.admin
      .from('memberships')
      .select('id, user_id, profiles(full_name)')
      .eq('school_id', membership.institutionId)
      .eq('role', 'guardian')
      .eq('status', 'active');

    if (error) {
      throw new InternalServerErrorException();
    }
    return toGuardians((data ?? []) as MembershipRow[]);
  }

  async listGuardians(
    membership: ActiveMembership,
    studentId: string,
  ): Promise<LinkedGuardianResponse[]> {
    await this.loadStudent(membership, studentId);

    const { data: links, error: linksError } = await this.supabase.admin
      .from('guardian_links')
      .select('guardian_id, relationship')
      .eq('student_id', studentId);

    if (linksError) {
      throw new InternalServerErrorException();
    }

    const relationshipById = new Map(
      ((links ?? []) as LinkRow[]).map((row) => [
        row.guardian_id,
        row.relationship ?? null,
      ]),
    );
    const guardianIds = [...relationshipById.keys()];
    if (guardianIds.length === 0) {
      return [];
    }

    const { data, error } = await this.supabase.admin
      .from('memberships')
      .select('id, user_id, profiles(full_name)')
      .eq('school_id', membership.institutionId)
      .eq('role', 'guardian')
      .in('user_id', guardianIds);

    if (error) {
      throw new InternalServerErrorException();
    }

    const { data: details, error: detailsError } = await this.supabase.admin
      .from('member_details')
      .select('user_id, phone')
      .eq('school_id', membership.institutionId)
      .in('user_id', guardianIds);

    if (detailsError) {
      throw new InternalServerErrorException();
    }

    const phoneById = new Map(
      ((details ?? []) as { user_id: string; phone: string | null }[]).map(
        (row) => [row.user_id, row.phone],
      ),
    );
    const guardians = await Promise.all(
      ((data ?? []) as MembershipRow[]).map(async (row) => ({
        id: row.id,
        fullName: firstRow(row.profiles)?.full_name ?? null,
        relationship: relationshipById.get(row.user_id) ?? null,
        phone: phoneById.get(row.user_id) ?? null,
        email: await this.emailOf(row.user_id),
      })),
    );
    return guardians.sort(byName);
  }

  async linkGuardian(
    membership: ActiveMembership,
    studentId: string,
    dto: LinkGuardianDto | undefined,
  ): Promise<LinkedGuardianResponse> {
    if (!dto || typeof dto.guardianMembershipId !== 'string') {
      throw new BadRequestException('Falta indicar el tutor');
    }
    const contact = parseContact(dto);
    await this.loadStudent(membership, studentId);
    const guardian = await this.resolveGuardian(
      membership,
      dto.guardianMembershipId,
    );

    const { error } = await this.supabase.admin
      .from('guardian_links')
      .insert({
        guardian_id: guardian.userId,
        student_id: studentId,
        relationship: contact.relationship ?? null,
      });

    if (isUniqueViolation(error)) {
      throw new ConflictException('El tutor ya está vinculado a este alumno');
    }
    if (error) {
      throw new InternalServerErrorException();
    }

    if (contact.phone !== undefined) {
      await this.users.saveDetails(membership, guardian.userId, {
        phone: contact.phone,
      });
    }

    return {
      id: guardian.id,
      fullName: guardian.fullName,
      relationship: contact.relationship ?? null,
      phone:
        contact.phone !== undefined
          ? contact.phone
          : await this.phoneOf(membership, guardian.userId),
      email: await this.emailOf(guardian.userId),
    };
  }

  async updateGuardian(
    membership: ActiveMembership,
    studentId: string,
    guardianMembershipId: string,
    dto: GuardianContactDto | undefined,
  ): Promise<LinkedGuardianResponse> {
    const contact = parseContact(dto);
    if (Object.keys(contact).length === 0) {
      throw new BadRequestException('No hay cambios para guardar');
    }

    await this.loadStudent(membership, studentId);
    const guardian = await this.resolveGuardian(
      membership,
      guardianMembershipId,
    );

    const { data: links, error: linkError } = await this.supabase.admin
      .from('guardian_links')
      .select('guardian_id, relationship')
      .eq('guardian_id', guardian.userId)
      .eq('student_id', studentId);

    if (linkError) {
      throw new InternalServerErrorException();
    }
    const link = (links as LinkRow[] | null)?.[0];
    if (!link) {
      throw new NotFoundException('El tutor no está vinculado a este alumno');
    }

    if (contact.relationship !== undefined) {
      const { error } = await this.supabase.admin
        .from('guardian_links')
        .update({ relationship: contact.relationship })
        .eq('guardian_id', guardian.userId)
        .eq('student_id', studentId);

      if (error) {
        throw new InternalServerErrorException();
      }
    }
    if (contact.phone !== undefined) {
      await this.users.saveDetails(membership, guardian.userId, {
        phone: contact.phone,
      });
    }

    return {
      id: guardian.id,
      fullName: guardian.fullName,
      relationship:
        contact.relationship !== undefined
          ? contact.relationship
          : (link.relationship ?? null),
      phone:
        contact.phone !== undefined
          ? contact.phone
          : await this.phoneOf(membership, guardian.userId),
      email: await this.emailOf(guardian.userId),
    };
  }

  async unlinkGuardian(
    membership: ActiveMembership,
    studentId: string,
    guardianMembershipId: string,
  ): Promise<{ deleted: true }> {
    await this.loadStudent(membership, studentId);
    const guardian = await this.resolveGuardian(
      membership,
      guardianMembershipId,
    );

    const { data, error } = await this.supabase.admin
      .from('guardian_links')
      .delete()
      .eq('guardian_id', guardian.userId)
      .eq('student_id', studentId)
      .select('guardian_id');

    if (error) {
      throw new InternalServerErrorException();
    }
    if (!data?.length) {
      throw new NotFoundException('El tutor no está vinculado a este alumno');
    }
    return { deleted: true };
  }

  private async emailOf(userId: string): Promise<string | null> {
    const { data, error } =
      await this.supabase.admin.auth.admin.getUserById(userId);
    if (error) {
      throw new InternalServerErrorException();
    }
    return data.user?.email ?? null;
  }

  private async phoneOf(
    membership: ActiveMembership,
    userId: string,
  ): Promise<string | null> {
    const { data, error } = await this.supabase.admin
      .from('member_details')
      .select('phone')
      .eq('school_id', membership.institutionId)
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException();
    }
    return (data as { phone: string | null } | null)?.phone ?? null;
  }

  // A student counts as belonging to the institution when it has at least one
  // enrollment in a course of the school.
  private async loadStudent(
    membership: ActiveMembership,
    studentId: string,
  ): Promise<void> {
    if (!UUID_RE.test(studentId)) {
      throw new NotFoundException('No se encontró el alumno');
    }
    const { data, error } = await this.supabase.admin
      .from('enrollments')
      .select('course_id, courses!inner(school_id)')
      .eq('student_id', studentId)
      .eq('courses.school_id', membership.institutionId)
      .limit(1);

    if (error) {
      throw new InternalServerErrorException();
    }
    if (!data?.length) {
      throw new NotFoundException('No se encontró el alumno');
    }
  }

  // Resolves guardianMembershipId to the membership row and its profile id,
  // which is what guardian_links stores. A membership from another school or
  // with a non-guardian role is rejected.
  private async resolveGuardian(
    membership: ActiveMembership,
    guardianMembershipId: string,
  ): Promise<{ id: string; userId: string; fullName: string | null }> {
    if (!UUID_RE.test(guardianMembershipId)) {
      throw new BadRequestException(
        'El tutor indicado no pertenece a la institución',
      );
    }
    const { data, error } = await this.supabase.admin
      .from('memberships')
      .select('id, user_id, role, profiles(full_name)')
      .eq('id', guardianMembershipId)
      .eq('school_id', membership.institutionId)
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException();
    }
    const row = data as MembershipRow | null;
    if (!row) {
      throw new BadRequestException(
        'El tutor indicado no pertenece a la institución',
      );
    }
    if (row.role !== 'guardian') {
      throw new BadRequestException(
        'La membresía indicada no corresponde a un tutor',
      );
    }
    return {
      id: row.id,
      userId: row.user_id,
      fullName: firstRow(row.profiles)?.full_name ?? null,
    };
  }
}
