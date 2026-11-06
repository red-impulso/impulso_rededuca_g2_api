export type AttendanceStatus = 'present' | 'absent' | 'late' | 'justified';

export interface SaveAttendanceEntryDto {
  studentId: string;
  status: AttendanceStatus;
}

export interface SaveAttendanceDto {
  courseId: string;
  date: string;
  entries: SaveAttendanceEntryDto[];
}
