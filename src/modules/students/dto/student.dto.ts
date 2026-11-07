// Optional personal data of the student file. A blank value clears the field.
export interface StudentDetailsDto {
  birthDate?: string | null;
  address?: string | null;
  phone?: string | null;
}

export interface CreateStudentDto extends StudentDetailsDto {
  firstName: string;
  lastName: string;
  dni: string;
  email: string;
  courseId: string;
  password?: string;
}

export interface UpdateStudentDto extends StudentDetailsDto {
  firstName?: string;
  lastName?: string;
  dni?: string;
  courseId?: string;
  // 'inactive' gives the student de baja; the profile is never deleted.
  status?: 'active' | 'inactive';
}

export interface ListStudentsQuery {
  courseId?: string;
  q?: string;
}
