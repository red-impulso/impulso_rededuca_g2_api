export interface UpdateInstitutionDto {
  name?: string;
  address?: string | null;
  levels?: string[];
  code?: string | null;
  phone?: string | null;
  email?: string | null;
  shift?: string | null;
  modality?: string | null;
}
