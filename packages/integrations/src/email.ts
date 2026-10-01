import nodemailer from "nodemailer";

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

export type EmailSendResult = {
  messageId: string;
};

export interface EmailAdapter {
  readonly key: string;
  send(message: EmailMessage, signal?: AbortSignal): Promise<EmailSendResult>;
}

export class DevelopmentEmailAdapter implements EmailAdapter {
  readonly key = "development";

  async send(
    message: EmailMessage,
    signal?: AbortSignal,
  ): Promise<EmailSendResult> {
    signal?.throwIfAborted();
    const messageId = `development:${crypto.randomUUID()}`;
    console.log(
      JSON.stringify({
        event: "email.development.completed",
        messageId,
        to: message.to,
        subject: message.subject,
      }),
    );
    return { messageId };
  }
}

export class SmtpEmailAdapter implements EmailAdapter {
  readonly key = "smtp";
  private readonly transport;

  constructor(
    private readonly config: {
      host: string;
      port: number;
      secure: boolean;
      user?: string;
      password?: string;
      from: string;
      operationTimeoutMs?: number;
    },
  ) {
    const operationTimeoutMs = Math.max(
      1_000,
      Math.min(config.operationTimeoutMs ?? 60_000, 60_000),
    );
    const handshakeTimeoutMs = Math.max(
      1_000,
      Math.min(Math.floor(operationTimeoutMs / 6), 10_000),
    );
    const socketTimeoutMs = Math.max(1_000, Math.floor(operationTimeoutMs / 2));
    this.transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      ...(config.user && config.password
        ? { auth: { user: config.user, pass: config.password } }
        : {}),
      connectionTimeout: handshakeTimeoutMs,
      greetingTimeout: handshakeTimeoutMs,
      dnsTimeout: handshakeTimeoutMs,
      socketTimeout: socketTimeoutMs,
    });
  }

  async send(
    message: EmailMessage,
    signal?: AbortSignal,
  ): Promise<EmailSendResult> {
    signal?.throwIfAborted();
    const result = await this.transport.sendMail({
      from: this.config.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    signal?.throwIfAborted();
    return { messageId: result.messageId };
  }
}
