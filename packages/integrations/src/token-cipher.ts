import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const VERSION = "v1";

export class TokenCipher {
  private constructor(private readonly key: Buffer) {}

  static fromBase64(value: string): TokenCipher {
    const key = Buffer.from(value, "base64");
    if (key.length !== 32) {
      throw new Error(
        "OAUTH_ENCRYPTION_KEY must be a base64-encoded 32-byte key.",
      );
    }
    return new TokenCipher(key);
  }

  encrypt(value: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    const encrypted = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return [
      VERSION,
      nonce.toString("base64url"),
      tag.toString("base64url"),
      encrypted.toString("base64url"),
    ].join(".");
  }

  decrypt(value: string): string {
    const [version, nonceValue, tagValue, encryptedValue] = value.split(".");
    if (
      version !== VERSION ||
      !nonceValue ||
      !tagValue ||
      encryptedValue === undefined
    ) {
      throw new Error("Encrypted token has an unsupported format.");
    }

    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(nonceValue, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }
}

export function createOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

export function createOAuthPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

export function oauthStatesEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}
