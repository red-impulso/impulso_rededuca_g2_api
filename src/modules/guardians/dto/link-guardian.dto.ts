export interface GuardianContactDto {
  relationship?: string | null;
  phone?: string | null;
}

export interface LinkGuardianDto extends GuardianContactDto {
  guardianMembershipId: string;
}
