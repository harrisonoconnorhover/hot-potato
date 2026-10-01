import { describe, expect, it, vi } from "vitest";
import nodemailer from "nodemailer";
import { DevelopmentEmailAdapter, SmtpEmailAdapter } from "../src/index.js";

describe("development email delivery", () => {
  it("accepts lifecycle messages without logging their body", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const adapter = new DevelopmentEmailAdapter();

    await expect(
      adapter.send({
        to: "lead@example.com",
        subject: "Confirmed: Product tour",
        text: "Private booking details",
        html: "<p>Private booking details</p>",
      }),
    ).resolves.toMatchObject({
      messageId: expect.stringMatching(/^development:/),
    });

    const entry = JSON.parse(String(log.mock.calls[0]?.[0])) as {
      event: string;
      subject: string;
      text?: string;
      html?: string;
    };
    expect(entry).toMatchObject({
      event: "email.development.completed",
      subject: "Confirmed: Product tour",
    });
    expect(entry.text).toBeUndefined();
    expect(entry.html).toBeUndefined();
    log.mockRestore();
  });

  it("does not deliver after its worker deadline aborts", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const controller = new AbortController();
    controller.abort();

    await expect(
      new DevelopmentEmailAdapter().send(
        {
          to: "lead@example.com",
          subject: "Confirmed: Product tour",
          text: "Private booking details",
          html: "<p>Private booking details</p>",
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});

describe("SMTP email delivery", () => {
  it("bounds every SMTP network phase below the worker operation budget", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "smtp-message" });
    const createTransport = vi
      .spyOn(nodemailer, "createTransport")
      .mockReturnValue({ sendMail } as never);
    const adapter = new SmtpEmailAdapter({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      from: "meetings@example.com",
      operationTimeoutMs: 60_000,
    });

    await expect(
      adapter.send({
        to: "lead@example.com",
        subject: "Confirmed: Product tour",
        text: "Private booking details",
        html: "<p>Private booking details</p>",
      }),
    ).resolves.toEqual({ messageId: "smtp-message" });
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        dnsTimeout: 10_000,
        socketTimeout: 30_000,
      }),
    );
    createTransport.mockRestore();
  });
});
