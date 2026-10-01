import { describe, expect, it, vi } from "vitest";
import type { Job } from "@hot-potato/db";
import { writeOwnerJob } from "../src/owner-writeback.js";

const job: Job = {
  id: 17,
  type: "crm.owner.writeback",
  attempts: 2,
  claimToken: "b54f470c-cd6c-435c-a17c-45e21c381742",
  payload: {
    decisionId: "older-decision",
    leadEmail: "buyer@example.com",
    ownerEmail: "ada@example.com",
  },
};

describe("owner writeback", () => {
  it("preserves the claim and skips provider calls for an obsolete assignment", async () => {
    const crm = { writeOwner: vi.fn() };
    const repository = {
      applyCurrentOwnerWriteback: vi.fn(async () => ({
        status: "superseded" as const,
      })),
    };

    expect(
      await writeOwnerJob(job, repository, crm, new AbortController().signal),
    ).toEqual({ status: "superseded" });
    expect(repository.applyCurrentOwnerWriteback).toHaveBeenCalledWith(
      job.id,
      job.claimToken,
      expect.any(Function),
    );
    expect(crm.writeOwner).not.toHaveBeenCalled();
  });

  it("writes the queued assignment inside the guard with its cancellation signal", async () => {
    const signal = new AbortController().signal;
    const crm = {
      writeOwner: vi.fn(async () => ({ externalReference: "test:owner" })),
    };
    const repository = {
      applyCurrentOwnerWriteback: async (
        _id: number,
        _claim: string,
        write: () => Promise<{ externalReference: string }>,
      ) => {
        expect(crm.writeOwner).not.toHaveBeenCalled();
        return { status: "completed" as const, ...(await write()) };
      },
    };

    expect(await writeOwnerJob(job, repository, crm, signal)).toEqual({
      status: "completed",
      externalReference: "test:owner",
    });
    expect(crm.writeOwner).toHaveBeenCalledExactlyOnceWith({
      decisionId: "older-decision",
      leadEmail: "buyer@example.com",
      ownerEmail: "ada@example.com",
      signal,
    });
  });

  it("does not write when its deadline expires while waiting for the guard", async () => {
    const controller = new AbortController();
    const crm = { writeOwner: vi.fn() };
    const repository = {
      applyCurrentOwnerWriteback: async (
        _id: number,
        _claim: string,
        write: () => Promise<{ externalReference: string }>,
      ) => {
        controller.abort(new Error("Operation deadline exceeded"));
        return { status: "completed" as const, ...(await write()) };
      },
    };

    await expect(
      writeOwnerJob(job, repository, crm, controller.signal),
    ).rejects.toThrow("Operation deadline exceeded");
    expect(crm.writeOwner).not.toHaveBeenCalled();
  });
});
