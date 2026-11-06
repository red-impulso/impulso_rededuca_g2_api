export interface AssignTeacherDto {
  // null unassigns the teacher; the key itself is required.
  teacherMembershipId: string | null;
}
