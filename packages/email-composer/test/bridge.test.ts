import { describe, expect, it } from "vitest";
import {
  createEmailComposerInsertMessage,
  isEmailComposerInsertMessage,
  maximumEmailComposerContentLength,
} from "../src/index.js";

describe("email composer insertion bridge", () => {
  it("creates and recognizes the versioned minimal insertion message", () => {
    const message = createEmailComposerInsertMessage("request-1", {
      html: "<p>Hello</p>",
      text: "Hello",
    });
    expect(isEmailComposerInsertMessage(message)).toBe(true);
    expect(Object.keys(message)).toEqual([
      "type",
      "version",
      "requestId",
      "content",
    ]);
  });

  it("rejects wrong versions, missing text, and oversized content", () => {
    expect(
      isEmailComposerInsertMessage({
        type: "hot-potato.email-composer.insert",
        version: 2,
        requestId: "request-1",
        content: { html: "<p>Hello</p>", text: "Hello" },
      }),
    ).toBe(false);
    expect(
      isEmailComposerInsertMessage({
        type: "hot-potato.email-composer.insert",
        version: 1,
        requestId: "request-1",
        content: { html: "<p>Hello</p>" },
      }),
    ).toBe(false);
    expect(
      isEmailComposerInsertMessage({
        type: "hot-potato.email-composer.insert",
        version: 1,
        requestId: "request-1",
        content: {
          html: "x".repeat(maximumEmailComposerContentLength + 1),
          text: "Hello",
        },
      }),
    ).toBe(false);
  });
});
