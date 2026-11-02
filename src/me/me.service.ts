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

interface MembershipRow {
  id: string;
  school_id: string;
  role: string;
  schools: { id: string; name: string } | { id: string; name: string }[] | null;
}

@Injectable()
export class MeService {
  constructor(private readonly supabase: SupabaseService) {}

  async getMe(user: AuthUser): Promise<MeResponse> {
    const [profileResult, membershipsResult] = await Promise.all([
      this.supabase.admin
        .from('profiles')
        .select('id, full_name')
        .eq('id', user.id)
        .maybeSingle(),
      this.supabase.admin
        .from('memberships')
        .select('id, school_id, role, schools(id, name)')
        .eq('user_id', user.id),
    ]);

    if (profileResult.error || membershipsResult.error) {
      throw new InternalServerErrorException();
    }

    const profile = profileResult.data;
    const memberships = (membershipsResult.data ?? []).flatMap(
      (row: MembershipRow) => {
        const school = Array.isArray(row.schools)
          ? row.schools[0]
          : row.schools;
        return school
          ? [
              {
                id: row.id,
                institutionId: row.school_id,
                institutionName: school.name,
                role: row.role,
              },
            ]
          : [];
      },
    );

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
