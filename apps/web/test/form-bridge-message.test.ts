import type { RouterLinkQuestion } from "@hot-potato/db";
import { describe, expect, it } from "vitest";
import { parseBridgeMessage } from "../components/smart-router-client";

const questions: RouterLinkQuestion[] = [
  {
    field: "company_size",
    label: "Company size",
    type: "number",
    required: true,
    placeholder: "",
    helpText: "",
    options: [],
  },
  {
    field: "use_case",
    label: "Use case",
    type: "select",
    required: false,
    placeholder: "",
    helpText: "",
    options: ["Sales", "Support"],
  },
];

function message(overrides: Record<string, unknown> = {}) {
  return {
    source: "hot-potato-host",
    version: 1,
    command: "submit",
    submissionId: "hubspot:conversion-123",
    submission: {
      attendeeName: "  Ada Lovelace  ",
      attendeeEmail: "  ada@example.com  ",
      answers: { company_size: "250", use_case: "Sales" },
    },
    ...overrides,
  };
}

describe("form bridge message parsing", () => {
  it("accepts the exact protocol and trims attendee identity", () => {
    expect(parseBridgeMessage(message(), questions)).toEqual({
      source: "hot-potato-host",
      version: 1,
      command: "submit",
      submissionId: "hubspot:conversion-123",
      submission: {
        attendeeName: "Ada Lovelace",
        attendeeEmail: "ada@example.com",
        answers: { company_size: "250", use_case: "Sales" },
      },
    });
  });

  it.each([
    ["wrong source", { source: "another-widget" }],
    ["wrong version", { version: 2 }],
    ["wrong command", { command: "open" }],
    ["extra top-level key", { bridgeId: "bridge-123" }],
    ["empty submission id", { submissionId: "" }],
    ["control character", { submissionId: "bad\nidentifier" }],
  ])("rejects %s", (_label, overrides) => {
    expect(parseBridgeMessage(message(overrides), questions)).toBeNull();
  });

  it("requires the exact configured answer fields", () => {
    const missing = message({
      submission: {
        attendeeName: "Ada Lovelace",
        attendeeEmail: "ada@example.com",
        answers: { company_size: "250" },
      },
    });
    const extra = message({
      submission: {
        attendeeName: "Ada Lovelace",
        attendeeEmail: "ada@example.com",
        answers: {
          company_size: "250",
          use_case: "Sales",
          private_note: "do not forward",
        },
      },
    });

    expect(parseBridgeMessage(missing, questions)).toBeNull();
    expect(parseBridgeMessage(extra, questions)).toBeNull();
  });

  it("rejects malformed, oversized, or non-plain submissions", () => {
    const malformedIdentity = message({
      submission: {
        attendeeName: "A",
        attendeeEmail: "ada@example.com",
        answers: { company_size: "250", use_case: "Sales" },
      },
    });
    const oversizedAnswer = message({
      submission: {
        attendeeName: "Ada Lovelace",
        attendeeEmail: "ada@example.com",
        answers: { company_size: "1".repeat(501), use_case: "Sales" },
      },
    });
    const inheritedAnswers = Object.create({ company_size: "250" }) as Record<
      string,
      string
    >;
    inheritedAnswers.use_case = "Sales";
    const nonPlain = message({
      submission: {
        attendeeName: "Ada Lovelace",
        attendeeEmail: "ada@example.com",
        answers: inheritedAnswers,
      },
    });

    expect(parseBridgeMessage(malformedIdentity, questions)).toBeNull();
    expect(parseBridgeMessage(oversizedAnswer, questions)).toBeNull();
    expect(parseBridgeMessage(nonPlain, questions)).toBeNull();
  });
});
