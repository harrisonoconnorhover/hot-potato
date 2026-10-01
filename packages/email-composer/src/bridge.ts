import type {
  EmailComposerContent,
  EmailComposerInsertMessage,
} from "./types.js";

export const emailComposerMessageType =
  "hot-potato.email-composer.insert" as const;
export const maximumEmailComposerContentLength = 250_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createEmailComposerInsertMessage(
  requestId: string,
  content: EmailComposerContent,
): EmailComposerInsertMessage {
  const message: EmailComposerInsertMessage = {
    type: emailComposerMessageType,
    version: 1,
    requestId,
    content,
  };
  if (!isEmailComposerInsertMessage(message)) {
    throw new Error("The email content is too large or invalid.");
  }
  return message;
}

export function isEmailComposerInsertMessage(
  value: unknown,
): value is EmailComposerInsertMessage {
  if (!isRecord(value) || !isRecord(value.content)) return false;
  if (
    value.type !== emailComposerMessageType ||
    value.version !== 1 ||
    typeof value.requestId !== "string" ||
    value.requestId.length < 1 ||
    value.requestId.length > 128 ||
    typeof value.content.html !== "string" ||
    typeof value.content.text !== "string"
  ) {
    return false;
  }
  return (
    value.content.html.length <= maximumEmailComposerContentLength &&
    value.content.text.length <= maximumEmailComposerContentLength
  );
}
