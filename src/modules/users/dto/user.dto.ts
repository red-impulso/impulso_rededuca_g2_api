export interface CreateUserDto {
  email: string;
  fullName: string;
  role: string;
  temporaryPassword: string;
}

export interface UpdateMembershipDto {
  fullName?: string;
  role?: string;
  status?: string;
}
