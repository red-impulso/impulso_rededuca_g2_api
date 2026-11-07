export interface CreateLeadDto {
  institutionName: string;
  contactName: string;
  city: string;
  contactRole: string;
  level: string;
  contactChannel: string;
  studentCount: number;
  comment: string;
  privacyAccepted: boolean;
  // Honeypot: hidden in the form; a real visitor never fills it.
  website?: string;
}
