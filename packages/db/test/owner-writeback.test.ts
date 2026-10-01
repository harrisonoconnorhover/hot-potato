import { describe, expect, it, vi } from "vitest";
import type { Sql, TransactionSql } from "postgres";
import { HotPotatoRepository } from "../src/repository.js";

const claimToken = "b54f470c-cd6c-435c-a17c-45e21c381742";

function fixture(currentClaim: boolean, latestJobId = 17) {
  const query = vi
    .fn()
    .mockResolvedValueOnce([
      { organizationId: "organization", leadEmail: "buyer@example.com" },
    ])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce(currentClaim ? [{ id: 17 }] : [])
    .mockResolvedValueOnce([{ id: latestJobId }]);
  const sql = {
    begin: (run: (transaction: TransactionSql) => Promise<unknown>) =>
      run(query as unknown as TransactionSql),
  };
  return { repository: new HotPotatoRepository(sql as unknown as Sql), query };
}

describe("owner writeback claim guard", () => {
  it("rejects a claim lost while waiting for the contact lock", async () => {
    const { repository, query } = fixture(false);
    const write = vi.fn();
    await expect(
      repository.applyCurrentOwnerWriteback(17, claimToken, write),
    ).rejects.toThrow("claim is no longer current");
    expect(write).not.toHaveBeenCalled();
    expect(query.mock.calls[1]?.[0].join("")).toContain(
      "pg_advisory_xact_lock",
    );
    expect(query.mock.calls[2]?.[0].join("")).toContain("claim_token");
    expect(query.mock.calls[2]?.slice(1)).toEqual([17, claimToken]);
  });

  it("skips an older job even when its worker claim remains current", async () => {
    const { repository } = fixture(true, 18);
    const write = vi.fn();
    expect(
      await repository.applyCurrentOwnerWriteback(17, claimToken, write),
    ).toEqual({ status: "superseded" });
    expect(write).not.toHaveBeenCalled();
  });

  it("allows the latest assignment with a current claim", async () => {
    const { repository } = fixture(true);
    const write = vi.fn(async () => ({ externalReference: "test:latest" }));
    expect(
      await repository.applyCurrentOwnerWriteback(17, claimToken, write),
    ).toEqual({ status: "completed", externalReference: "test:latest" });
    expect(write).toHaveBeenCalledOnce();
  });
});
