import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import type { Membership as ActiveMembership } from '../../auth/membership.guard.js';
import { SupabaseService } from '../../supabase/supabase.service.js';
import type { LinkGuardianDto } from './dto/link-guardian.dto.js';

const UNIQUE_VIOLATION = '23505';
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface GuardianResponse {
  id: string;
  fullName: string | null;
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

function toGuardians(rows: MembershipRow[]): GuardianResponse[] {
  return rows
    .map((row) => ({
      id: row.id,
      fullName: firstRow(row.profiles)?.full_name ?? null,
    }))
    .sort((a, b) => (a.fullName ?? '').localeCompare(b.fullName ?? '', 'es'));
}

@Injectable()
export class GuardiansService {
  constructor(private readonly supabase: SupabaseService) {}

  // Everyone who can be linked to a student of the institution.
  async listSchoolGuardians(
    membership: ActiveMembership,
  ): Promise<GuardianResponse[]> {
    const { data, error } = await this.supabase.admin
      .from('memberships')
      .select('id, user_id, profiles(full_name)')
      .eq('school_id', membership.institutionId)
      .eq('role', 'guardian');

    if (error) {
      throw new InternalServerErrorException();
    }
    return toGuardians((data ?? []) as MembershipRow[]);
  }

  async listGuardians(
    membership: ActiveMembership,
    studentId: string,
  ): Promise<GuardianResponse[]> {
    await this.loadStudent(membership, studentId);

    const { data: links, error: linksError } = await this.supabase.admin
      .from('guardian_links')
      .select('guardian_id')
      .eq('student_id', studentId);

    if (linksError) {
      throw new InternalServerErrorException();
    }

    const guardianIds = (links ?? []).map(
      (row: { guardian_id: string }) => row.guardian_id,
    );
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

    return toGuardians((data ?? []) as MembershipRow[]);
  }

  async linkGuardian(
    membership: ActiveMembership,
    studentId: string,
    dto: LinkGuardianDto | undefined,
  ): Promise<GuardianResponse> {
    if (!dto || typeof dto.guardianMembershipId !== 'string') {
      throw new BadRequestException('Falta indicar el tutor');
    }
    await this.loadStudent(membership, studentId);
    const guardian = await this.resolveGuardian(
      membership,
      dto.guardianMembershipId,
    );

    const { error } = await this.supabase.admin
      .from('guardian_links')
      .insert({ guardian_id: guardian.userId, student_id: studentId });

    if (isUniqueViolation(error)) {
      throw new ConflictException('El tutor ya está vinculado a este alumno');
    }
    if (error) {
      throw new InternalServerErrorException();
    }

    return { id: guardian.id, fullName: guardian.fullName };
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
