export type CourseShift = 'morning' | 'afternoon' | 'evening';

export interface CreateCourseDto {
  year: number;
  division: string;
  shift: CourseShift;
  schoolYear: number;
}

export interface UpdateCourseDto {
  year?: number;
  division?: string;
  shift?: CourseShift;
  schoolYear?: number;
}
