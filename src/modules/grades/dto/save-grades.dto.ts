export interface SaveGradeEntryDto {
  studentId: string;
  value: number | null;
}

export interface SaveGradesDto {
  subjectId: string;
  periodId: string;
  entries: SaveGradeEntryDto[];
}
