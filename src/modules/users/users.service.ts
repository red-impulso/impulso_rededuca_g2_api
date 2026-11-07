import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import type { Membership as ActiveMembership } from '../../auth/membership.guard.js';
import { SupabaseService } from '../../supabase/supabase.service.js';
import type {
  CreateUserDto,
  UpdateMembershipDto,
} from './dto/user.dto.js';

const UNIQUE_VIOLATION = '23505';
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Roles a user can be given through this module. Students are enrolled via
// POST /students, not here.
const ASSIGNABLE_ROLES = ['admin', 'director', 'teacher', 'guardian'];
const STATUSES = ['active', 'inactive'];
const AUTH_PAGE_SIZE = 1000;

// profiles.role is a legacy column whose check constraint predates
// 'director' and 'guardian'; they are stored as 'student' there.
const LEGACY_ROLE: Record<string, string> = {
  admin: 'admin',
  teacher: 'teacher',
  director: 'student',
  guardian: 'student',
  student: 'student',
};

export interface UserResponse {
  id: string;
  userId: string;
  email: string | null;
  fullName: string | null;
  role: string;
  status: string;
}

// Columns of member_details, already validated by whoever calls saveDetails.
export interface MemberDetails {
  dni?: string | null;
  phone?: string | null;
  training?: string | null;
  start_year?: number | null;
  notes?: string | null;
}

interface MembershipRow {
  id: string;
  user_id: string;
  role: string;
  status?: string;
  profiles:
    | { full_name: string | null }
    | { full_name: string | null }[]
    | null;
}

interface TargetMembership {
  id: string;
  user_id: string;
  role: string;
  status?: string;
}

function isActiveAdmin(target: TargetMembership): boolean {
  return target.role === 'admin' && target.status !== 'inactive';
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

function isEmailTaken(error: unknown): boolean {
  const err = error as { code?: string; message?: string } | null;
  return (
    err?.code === 'email_exists' ||
    (err?.message ?? '').toLowerCase().includes('already registered')
  );
}

@Injectable()
export class UsersService {
  constructor(private readonly supabase: SupabaseService) {}

  async listUsers(membership: ActiveMembership): Promise<UserResponse[]> {
    const { data, error } = await this.supabase.admin
      .from('memberships')
      .select('id, user_id, role, status, profiles(full_name)')
      .eq('school_id', membership.institutionId);

    if (error) {
      throw new InternalServerErrorException();
    }

    const emailById = await this.emailMap();
    return ((data ?? []) as MembershipRow[])
      .map((row) => ({
        id: row.id,
        userId: row.user_id,
        email: emailById.get(row.user_id) ?? null,
        fullName: firstRow(row.profiles)?.full_name ?? null,
        role: row.role,
        status: row.status ?? 'active',
      }))
      .sort((a, b) =>
        (a.fullName ?? '').localeCompare(b.fullName ?? '', 'es'),
      );
  }

  // Creates the auth user when the email is new; an email already registered
  // (even in another institution) reuses that user and only gets a new
  // membership here.
  async createUser(
    membership: ActiveMembership,
    dto: CreateUserDto | undefined,
  ): Promise<UserResponse> {
    if (typeof dto?.email !== 'string' || !dto.email.trim()) {
      throw new BadRequestException('El usuario necesita un email');
    }
    if (typeof dto?.fullName !== 'string' || !dto.fullName.trim()) {
      throw new BadRequestException('El usuario necesita un nombre');
    }
    if (
      !ASSIGNABLE_ROLES.includes(
        dto?.role as (typeof ASSIGNABLE_ROLES)[number],
      )
    ) {
      throw new BadRequestException(
        "El rol debe ser 'admin', 'director', 'teacher' o 'guardian'",
      );
    }
    if (
      typeof dto?.temporaryPassword !== 'string' ||
      dto.temporaryPassword.length < 6
    ) {
      throw new BadRequestException(
        'La contraseña temporal necesita al menos 6 caracteres',
      );
    }

    const email = dto.email.trim();
    const fullName = dto.fullName.trim();
    const userId = await this.findOrCreateAuthUser(
      email,
      fullName,
      dto.temporaryPassword,
    );

    await this.ensureProfile(membership, userId, fullName, dto.role);

    const { data: inserted, error } = await this.supabase.admin
      .from('memberships')
      .insert({
        user_id: userId,
        school_id: membership.institutionId,
        role: dto.role,
      })
      .select('id')
      .single();

    if (isUniqueViolation(error)) {
      throw new ConflictException(
        'El usuario ya tiene ese rol en la institución',
      );
    }
    if (error || !inserted) {
      throw new InternalServerErrorException();
    }

    return {
      id: (inserted as { id: string }).id,
      userId,
      email,
      fullName,
      role: dto.role,
      status: 'active',
    };
  }

  async updateMembership(
    membership: ActiveMembership,
    membershipId: string,
    dto: UpdateMembershipDto | undefined,
  ): Promise<UserResponse> {
    const { role, status, fullName } = dto ?? {};
    if (role === undefined && status === undefined && fullName === undefined) {
      throw new BadRequestException('No hay cambios para guardar');
    }
    if (
      role !== undefined &&
      !ASSIGNABLE_ROLES.includes(role) &&
      role !== 'student'
    ) {
      throw new BadRequestException('El rol indicado no es válido');
    }
    if (status !== undefined && !STATUSES.includes(status)) {
      throw new BadRequestException('El estado indicado no es válido');
    }
    if (
      fullName !== undefined &&
      (typeof fullName !== 'string' || !fullName.trim())
    ) {
      throw new BadRequestException('El usuario necesita un nombre');
    }

    const target = await this.loadMembership(membership, membershipId);
    const nextRole = role ?? target.role;
    const nextStatus = status ?? target.status ?? 'active';
    const stopsBeingAdmin = nextRole !== 'admin' || nextStatus === 'inactive';
    if (isActiveAdmin(target) && stopsBeingAdmin) {
      await this.assertOtherAdmins(membership, target);
    }

    if (fullName !== undefined) {
      await this.saveName(target.user_id, fullName.trim());
    }
    if (role !== undefined || status !== undefined) {
      const { error } = await this.supabase.admin
        .from('memberships')
        .update({
          ...(role !== undefined && { role }),
          ...(status !== undefined && { status }),
        })
        .eq('id', membershipId);

      if (error) {
        throw new InternalServerErrorException();
      }
    }

    const emailById = await this.emailMap();
    const { data: refreshed } = await this.supabase.admin
      .from('memberships')
      .select('id, user_id, role, status, profiles(full_name)')
      .eq('id', membershipId)
      .maybeSingle();
    const row = refreshed as MembershipRow | null;
    return {
      id: membershipId,
      userId: row?.user_id ?? target.user_id,
      email: emailById.get(row?.user_id ?? target.user_id) ?? null,
      fullName: firstRow(row?.profiles)?.full_name ?? null,
      role: nextRole,
      status: nextStatus,
    };
  }

  async saveName(userId: string, fullName: string): Promise<void> {
    const { error } = await this.supabase.admin
      .from('profiles')
      .update({ full_name: fullName })
      .eq('id', userId);

    if (error) {
      throw new InternalServerErrorException();
    }
  }

  // Only the columns received change: the upsert leaves the others as they are.
  async saveDetails(
    membership: ActiveMembership,
    userId: string,
    details: MemberDetails,
  ): Promise<void> {
    const { error } = await this.supabase.admin.from('member_details').upsert(
      {
        user_id: userId,
        school_id: membership.institutionId,
        ...details,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,school_id' },
    );

    if (isUniqueViolation(error)) {
      throw new ConflictException('Ya existe una persona con ese DNI');
    }
    if (error) {
      throw new InternalServerErrorException();
    }
  }

  async deleteMembership(
    membership: ActiveMembership,
    membershipId: string,
  ): Promise<{ deleted: true }> {
    const target = await this.loadMembership(membership, membershipId);
    if (isActiveAdmin(target)) {
      await this.assertOtherAdmins(membership, target);
    }

    const { error } = await this.supabase.admin
      .from('memberships')
      .delete()
      .eq('id', membershipId);

    if (error) {
      throw new InternalServerErrorException();
    }

    await this.forgetDetails(membership, target.user_id);
    return { deleted: true };
  }

  // Whoever has no role left in the school takes their personal data along.
  private async forgetDetails(
    membership: ActiveMembership,
    userId: string,
  ): Promise<void> {
    const { data, error } = await this.supabase.admin
      .from('memberships')
      .select('id')
      .eq('school_id', membership.institutionId)
      .eq('user_id', userId);

    if (error) {
      throw new InternalServerErrorException();
    }
    if (data?.length) {
      return;
    }

    const { error: deleteError } = await this.supabase.admin
      .from('member_details')
      .delete()
      .eq('school_id', membership.institutionId)
      .eq('user_id', userId);

    if (deleteError) {
      throw new InternalServerErrorException();
    }
  }

  private async loadMembership(
    membership: ActiveMembership,
    membershipId: string,
  ): Promise<TargetMembership> {
    if (!UUID_RE.test(membershipId)) {
      throw new NotFoundException('No se encontró la membresía');
    }
    const { data, error } = await this.supabase.admin
      .from('memberships')
      .select('id, user_id, role, status')
      .eq('id', membershipId)
      .eq('school_id', membership.institutionId)
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException();
    }
    if (!data) {
      throw new NotFoundException('No se encontró la membresía');
    }
    return data as TargetMembership;
  }

  // The institution must always keep at least one active admin; demoting,
  // deactivating or deleting the last one is refused.
  private async assertOtherAdmins(
    membership: ActiveMembership,
    target: { id: string },
  ): Promise<void> {
    const { data, error } = await this.supabase.admin
      .from('memberships')
      .select('id')
      .eq('school_id', membership.institutionId)
      .eq('role', 'admin')
      .eq('status', 'active')
      .neq('id', target.id);

    if (error) {
      throw new InternalServerErrorException();
    }
    if (!data?.length) {
      throw new ConflictException(
        'No podés dejar la institución sin administradores',
      );
    }
  }

  private async findOrCreateAuthUser(
    email: string,
    fullName: string,
    temporaryPassword: string,
  ): Promise<string> {
    const { data: created, error: createError } =
      await this.supabase.admin.auth.admin.createUser({
        email,
        password: temporaryPassword,
        email_confirm: true,
        user_metadata: { full_name: fullName },
      });
    if (!createError && created.user) {
      return created.user.id;
    }
    if (!isEmailTaken(createError)) {
      throw new InternalServerErrorException();
    }

    const emailById = await this.emailMap();
    for (const [id, existing] of emailById) {
      if (existing.toLowerCase() === email.toLowerCase()) {
        return id;
      }
    }
    throw new InternalServerErrorException();
  }

  // The profile row is global (one per user), so it is only created when
  // missing; a user from another institution keeps theirs.
  private async ensureProfile(
    membership: ActiveMembership,
    userId: string,
    fullName: string,
    role: string,
  ): Promise<void> {
    const { data: existing, error: lookupError } = await this.supabase.admin
      .from('profiles')
      .select('id')
      .eq('id', userId)
      .maybeSingle();

    if (lookupError) {
      throw new InternalServerErrorException();
    }
    if (existing) {
      return;
    }

    const { error } = await this.supabase.admin
      .from('profiles')
      .insert({
        id: userId,
        school_id: membership.institutionId,
        full_name: fullName,
        role: LEGACY_ROLE[role] ?? 'student',
      });
    if (error) {
      throw new InternalServerErrorException();
    }
  }

  // Auth users are shared by every school, so the list is read page by page
  // instead of doing an auth lookup per membership row.
  private async emailMap(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    for (let page = 1; ; page += 1) {
      const { data, error } = await this.supabase.admin.auth.admin.listUsers({
        page,
        perPage: AUTH_PAGE_SIZE,
      });
      if (error) {
        throw new InternalServerErrorException();
      }
      const users = (data?.users ?? []) as { id: string; email?: string }[];
      for (const u of users) {
        if (u.email) {
          map.set(u.id, u.email);
        }
      }
      if (users.length < AUTH_PAGE_SIZE) {
        return map;
      }
    }
  }
}
