import { describe, expect, it } from "vitest";
import { safeNextPath } from "../app/login/login-form";

describe("operator login return path", () => {
  it("keeps local paths and rejects absolute or backslash-normalized redirects", () => {
    expect(
      safeNextPath("/?section=reporting#activity", "https://schedule.example"),
    ).toBe("/?section=reporting#activity");
    expect(
      safeNextPath("https://attacker.example", "https://schedule.example"),
    ).toBe("/");
    expect(
      safeNextPath("/\\attacker.example", "https://schedule.example"),
    ).toBe("/");
  });
});
