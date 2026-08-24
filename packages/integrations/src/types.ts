export type CrmOwnerWriteback = {
  decisionId: string;
  leadEmail: string;
  ownerEmail: string;
};

export type CrmWritebackResult = {
  externalReference: string;
};

export interface CrmAdapter {
  readonly key: string;
  writeOwner(input: CrmOwnerWriteback): Promise<CrmWritebackResult>;
}

export type AvailabilityQuery = {
  repEmails: string[];
  startsAt: Date;
  endsAt: Date;
};

export interface CalendarAdapter {
  readonly key: string;
  busyRepEmails(input: AvailabilityQuery): Promise<string[]>;
}
