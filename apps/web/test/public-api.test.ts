import { afterEach, describe, expect, it } from "vitest";
import { publicClientAddress } from "../app/public-api";

const previousHeader = process.env.TRUSTED_PROXY_CLIENT_IP_HEADER;

afterEach(() => {
  if (previousHeader === undefined) {
    delete process.env.TRUSTED_PROXY_CLIENT_IP_HEADER;
  } else {
    process.env.TRUSTED_PROXY_CLIENT_IP_HEADER = previousHeader;
  }
});

describe("public client address", () => {
  it("ignores caller-supplied forwarding headers unless one trusted proxy header is configured", () => {
    delete process.env.TRUSTED_PROXY_CLIENT_IP_HEADER;
    const request = new Request("https://schedule.example/api", {
      headers: {
        "cf-connecting-ip": "198.51.100.1",
        "x-real-ip": "198.51.100.2",
        "x-forwarded-for": "198.51.100.3",
      },
    });

    expect(publicClientAddress(request)).toBe("shared-origin");
  });

  it("uses only the configured header supplied by a trusted proxy", () => {
    process.env.TRUSTED_PROXY_CLIENT_IP_HEADER = "x-forwarded-for";
    const request = new Request("https://schedule.example/api", {
      headers: {
        "cf-connecting-ip": "198.51.100.1",
        "x-forwarded-for": "203.0.113.9, 10.0.0.2",
      },
    });

    expect(publicClientAddress(request)).toBe("203.0.113.9");
  });
});
