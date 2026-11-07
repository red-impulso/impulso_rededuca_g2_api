// Fields of the group 2 landing form.
export interface CreateLeadDto {
  institutionName: string;
  institutionType: string;
  city: string;
  studentCount: number;
  contactName: string;
  phone: string;
  email: string;
  comment?: string | null;
  // Honeypot: hidden in the form; a real visitor never fills it.
  website?: string;
}
