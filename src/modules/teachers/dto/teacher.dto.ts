export interface TeacherDetailsDto {
  dni?: string | null;
  phone?: string | null;
  training?: string | null;
  startYear?: number | null;
  notes?: string | null;
}

export interface CreateTeacherDto extends TeacherDetailsDto {
  email: string;
  fullName: string;
  temporaryPassword: string;
}

export interface UpdateTeacherDto extends TeacherDetailsDto {
  fullName?: string;
  status?: string;
}
