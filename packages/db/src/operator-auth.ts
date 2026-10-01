import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const scryptCost = 16_384;
const scryptBlockSize = 8;
const scryptParallelization = 1;
const scryptKeyLength = 64;
const maximumPasswordBytes = 1_024;

function derivePasswordKey(
  password: string,
  salt: Buffer,
  keyLength = scryptKeyLength,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      keyLength,
      {
        N: scryptCost,
        r: scryptBlockSize,
        p: scryptParallelization,
        maxmem: 64 * 1024 * 1024,
      },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey as Buffer);
      },
    );
  });
}

export function validateOperatorPassword(password: string): void {
  const byteLength = Buffer.byteLength(password, "utf8");
  if (byteLength < 12 || byteLength > maximumPasswordBytes) {
    throw new Error("Operator passwords must be 12–1,024 bytes.");
  }
}

export async function hashOperatorPassword(password: string): Promise<string> {
  validateOperatorPassword(password);
  const salt = randomBytes(16);
  const derivedKey = await derivePasswordKey(password, salt);
  return [
    "scrypt",
    scryptCost,
    scryptBlockSize,
    scryptParallelization,
    salt.toString("base64url"),
    derivedKey.toString("base64url"),
  ].join("$");
}

export async function verifyOperatorPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  if (Buffer.byteLength(password, "utf8") > maximumPasswordBytes) return false;
  const [algorithm, cost, blockSize, parallelization, saltValue, keyValue] =
    encoded.split("$");
  if (
    algorithm !== "scrypt" ||
    Number(cost) !== scryptCost ||
    Number(blockSize) !== scryptBlockSize ||
    Number(parallelization) !== scryptParallelization ||
    !saltValue ||
    !keyValue
  ) {
    return false;
  }
  try {
    const salt = Buffer.from(saltValue, "base64url");
    const expected = Buffer.from(keyValue, "base64url");
    if (salt.length !== 16 || expected.length !== scryptKeyLength) return false;
    const actual = await derivePasswordKey(password, salt, expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
