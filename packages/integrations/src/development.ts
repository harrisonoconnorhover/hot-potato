import type {
  CalendarAdapter,
  CrmAdapter,
  CrmOwnerWriteback,
  CrmRoleWriteback,
  CrmWritebackResult,
} from "./types.js";

export class DevelopmentCrmAdapter implements CrmAdapter {
  readonly key = "development";

  async writeOwner(input: CrmOwnerWriteback): Promise<CrmWritebackResult> {
    input.signal?.throwIfAborted();
    return { externalReference: `development:${input.decisionId}` };
  }

  async writeRoles(input: CrmRoleWriteback): Promise<CrmWritebackResult> {
    input.signal?.throwIfAborted();
    return { externalReference: `development:${input.bookingId}:roles` };
  }
}

export class DevelopmentCalendarAdapter implements CalendarAdapter {
  readonly key = "development";

  async busyRepEmails(): Promise<string[]> {
    return [];
  }
}
