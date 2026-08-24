import type {
  CalendarAdapter,
  CrmAdapter,
  CrmOwnerWriteback,
  CrmWritebackResult,
} from "./types.js";

export class DevelopmentCrmAdapter implements CrmAdapter {
  readonly key = "development";

  async writeOwner(input: CrmOwnerWriteback): Promise<CrmWritebackResult> {
    return { externalReference: `development:${input.decisionId}` };
  }
}

export class DevelopmentCalendarAdapter implements CalendarAdapter {
  readonly key = "development";

  async busyRepEmails(): Promise<string[]> {
    return [];
  }
}
