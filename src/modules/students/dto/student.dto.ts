export interface CreateStudentDto {
  firstName: string;
  lastName: string;
  dni: string;
  email: string;
  courseId: string;
  password?: string;
}

export interface UpdateStudentDto {
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
