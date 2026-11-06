export type AnnouncementScope = 'institution' | 'course' | 'student';

export interface CreateAnnouncementDto {
  scope: AnnouncementScope;
  courseId?: string;
  studentId?: string;
  title: string;
  body: string;
}
