import { describe, expect, it } from "vitest";
import {
  hashOperatorPassword,
  validateOperatorPassword,
  verifyOperatorPassword,
} from "../src/operator-auth.js";

describe("operator password hashing", () => {
  it("round-trips a valid password without storing it", async () => {
    const password = "a correctly long operator password";
    const encoded = await hashOperatorPassword(password);

    expect(encoded).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(encoded).not.toContain(password);
    expect(await verifyOperatorPassword(password, encoded)).toBe(true);
    expect(await verifyOperatorPassword("wrong password", encoded)).toBe(false);
  });

  it("rejects weak or malformed credentials", async () => {
    expect(() => validateOperatorPassword("too short")).toThrow(/12/);
    expect(
      await verifyOperatorPassword("anything", "not-a-password-hash"),
    ).toBe(false);
  });
});
