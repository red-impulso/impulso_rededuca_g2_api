import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { AuthUser } from '../auth/auth.guard.js';
import { SupabaseService } from '../supabase/supabase.service.js';

export interface Membership {
  id: string;
  institutionId: string;
  institutionName: string;
  role: string;
}

export interface MeResponse {
  profile: { id: string; fullName: string | null; phone: string | null };
  memberships: Membership[];
}

@Injectable()
export class MeService {
  constructor(private readonly supabase: SupabaseService) {}

  async getMe(user: AuthUser): Promise<MeResponse> {
    const { data: profile, error } = await this.supabase.admin
      .from('profiles')
      .select('id, full_name, role, school_id, schools(id, name)')
      .eq('id', user.id)
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException();
    }

    const embedded = profile?.schools;
    const school = Array.isArray(embedded) ? embedded[0] : embedded;

    const memberships: Membership[] =
      profile && school
        ? [
            {
              id: profile.id,
              institutionId: school.id,
              institutionName: school.name,
              role: profile.role,
            },
          ]
        : [];

    return {
      profile: {
        id: user.id,
        fullName: profile?.full_name ?? null,
        phone: user.phone ?? null,
      },
      memberships,
    };
  }
}
