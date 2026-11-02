import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SupabaseService } from '../supabase/supabase.service.js';
import { AuthedRequest } from './auth.guard.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';
import { ROLES_KEY } from './roles.decorator.js';

export interface Membership {
  id: string;
  userId: string;
  institutionId: string;
  role: string;
}

export type MembershipRequest = AuthedRequest & { membership: Membership };

const ROLE_RANK: Record<string, number> = {
  admin: 4,
  director: 3,
  teacher: 2,
  guardian: 1,
};

interface MembershipRow {
  id: string;
  school_id: string;
  role: string;
}

@Injectable()
export class MembershipGuard implements CanActivate {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<MembershipRequest>();
    if (!request.user) {
      throw new UnauthorizedException();
    }

    const header = request.headers['x-institution-id'];
    const institutionId = typeof header === 'string' ? header.trim() : undefined;
    if (!institutionId) {
      throw new BadRequestException('Missing X-Institution-Id header');
    }

    const { data, error } = await this.supabase.admin
      .from('memberships')
      .select('id, school_id, role')
      .eq('user_id', request.user.id)
      .eq('school_id', institutionId);

    if (error) {
      throw new InternalServerErrorException();
    }

    const row = this.pickHighestRank(data ?? []);
    if (!row) {
      throw new ForbiddenException();
    }

    const allowed = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (allowed?.length && !allowed.includes(row.role)) {
      throw new ForbiddenException();
    }

    request.membership = {
      id: row.id,
      userId: request.user.id,
      institutionId: row.school_id,
      role: row.role,
    };
    return true;
  }

  private pickHighestRank(rows: MembershipRow[]): MembershipRow | undefined {
    return rows.reduce<MembershipRow | undefined>(
      (best, row) =>
        best && (ROLE_RANK[best.role] ?? -1) >= (ROLE_RANK[row.role] ?? -1)
          ? best
          : row,
      undefined,
    );
  }
}
