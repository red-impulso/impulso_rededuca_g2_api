// Las instancias de nota de cada período (prototipo de calificaciones).
export const GRADE_ITEM_KINDS = [
  'tp1',
  'tp2',
  'parcial1',
  'parcial2',
  'final',
] as const;
export type GradeItemKind = (typeof GRADE_ITEM_KINDS)[number];

// Cada alumno manda `value` (la nota del período, formato anterior) o
// `items` (solo las instancias que cambian; null borra una). Con items,
// la nota del período pasa a ser el promedio de las instancias cargadas.
export interface SaveGradeEntryDto {
  studentId: string;
  value?: number | null;
  items?: Partial<Record<GradeItemKind, number | null>>;
}

export interface SaveGradesDto {
  subjectId: string;
  periodId: string;
  entries: SaveGradeEntryDto[];
}
