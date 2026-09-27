import { describe, expect, it, vi } from "vitest";
import type { Job } from "@hot-potato/db";
import { writeOwnerJob } from "../src/owner-writeback.js";

const job: Job = {
  id: 17,
  type: "crm.owner.writeback",
  attempts: 2,
  payload: {
    decisionId: "older-decision",
    leadEmail: "buyer@example.com",
    ownerEmail: "ada@example.com",
  },
};

describe("owner writeback", () => {
  it("does not call the CRM for a superseded assignment", async () => {
    const crm = { key: "test", writeOwner: vi.fn() };
    const repository = {
      applyCurrentOwnerWriteback: vi.fn(async () => ({
        status: "superseded" as const,
      })),
    };

    expect(await writeOwnerJob(job, repository, crm)).toEqual({
      status: "superseded",
    });
    expect(repository.applyCurrentOwnerWriteback).toHaveBeenCalledWith(
      job.id,
      expect.any(Function),
    );
    expect(crm.writeOwner).not.toHaveBeenCalled();
  });

  it("writes the queued assignment only inside the repository guard", async () => {
    const crm = {
      key: "test",
      writeOwner: vi.fn(async () => ({ externalReference: "test:owner" })),
    };
    const repository = {
      applyCurrentOwnerWriteback: async (
        _id: number,
        write: () => Promise<{ externalReference: string }>,
      ) => {
        expect(crm.writeOwner).not.toHaveBeenCalled();
        return { status: "completed" as const, ...(await write()) };
      },
    };

    expect(await writeOwnerJob(job, repository, crm)).toEqual({
      status: "completed",
      externalReference: "test:owner",
    });
    expect(crm.writeOwner).toHaveBeenCalledExactlyOnceWith({
      decisionId: "older-decision",
      leadEmail: "buyer@example.com",
      ownerEmail: "ada@example.com",
    });
  });
});
