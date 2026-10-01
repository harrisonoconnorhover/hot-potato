import type { PublicRouterFormBridgeConfig } from "@hot-potato/db";
import { describe, expect, it } from "vitest";
import {
  authorizedFormBridgeMode,
  requestedFormBridgeId,
} from "../app/form-bridge-authorization";

const bridgeId = "0f14c75a-b823-4a6e-bf28-7d33d4f6e238";
const config: PublicRouterFormBridgeConfig = {
  routerPath: "/r/acme/talk-to-sales",
  provider: "manual",
  formId: null,
  allowedOrigins: ["https://www.example.com"],
  mapping: {
    attendeeNameFields: ["name"],
    attendeeEmailField: "email",
    answerMappings: { company_size: "company_size" },
  },
};

describe("form bridge page authorization", () => {
  it("does not treat a boolean-style or repeated query value as a bridge ID", () => {
    expect(requestedFormBridgeId("1")).toBeNull();
    expect(requestedFormBridgeId([bridgeId])).toBeNull();
  });

  it("allows a saved bridge on its exact router and parent origin", () => {
    expect(
      authorizedFormBridgeMode({
        requestedBridgeId: requestedFormBridgeId(bridgeId),
        parentOrigin: "https://www.example.com",
        routerPath: "/r/acme/talk-to-sales",
        config,
      }),
    ).toBe(true);
  });

  it("rejects a parent origin outside the saved allowlist", () => {
    expect(
      authorizedFormBridgeMode({
        requestedBridgeId: requestedFormBridgeId(bridgeId),
        parentOrigin: "https://attacker.example",
        routerPath: "/r/acme/talk-to-sales",
        config,
      }),
    ).toBe(false);
  });

  it("rejects a bridge saved for a different Smart Router Link", () => {
    expect(
      authorizedFormBridgeMode({
        requestedBridgeId: requestedFormBridgeId(bridgeId),
        parentOrigin: "https://www.example.com",
        routerPath: "/r/acme/different-router",
        config,
      }),
    ).toBe(false);
  });

  it("rejects a missing, paused, or stale public bridge config", () => {
    expect(
      authorizedFormBridgeMode({
        requestedBridgeId: requestedFormBridgeId(bridgeId),
        parentOrigin: "https://www.example.com",
        routerPath: "/r/acme/talk-to-sales",
        config: null,
      }),
    ).toBe(false);
  });
});
