export type LeadStatus = 'new' | 'contacted' | 'discarded';

export interface UpdateLeadDto {
  status: LeadStatus;
}
