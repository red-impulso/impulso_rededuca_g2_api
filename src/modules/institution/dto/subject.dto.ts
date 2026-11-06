export interface CreateSubjectDto {
  name: string;
  courseId: string;
  teacherMembershipId?: string;
}

export interface UpdateSubjectDto {
  name?: string;
  courseId?: string;
  // null unassigns the teacher; omitted leaves it untouched.
  teacherMembershipId?: string | null;
}
