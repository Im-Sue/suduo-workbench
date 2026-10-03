import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 64;
const COST = 16_384;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
const MAX_MEMORY = 32 * 1024 * 1024;

export const DUMMY_PASSWORD_HASH =
  "scrypt$16384$8$1$emp3b3JrLXYyLWR1bW15IQ$smBeyWJsR3lxwzqoFlkH4HlUCUfTtYY3sIiMlldGFcFl_PcrD6Z3bIXSwyd4beqKqwa4ti_pend352D-ILDf5w";

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await derive(password, salt);
  return [
    "scrypt",
    COST,
    BLOCK_SIZE,
    PARALLELIZATION,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const parts = encoded.split("$");
  if (
    parts.length !== 6 ||
    parts[0] !== "scrypt" ||
    Number(parts[1]) !== COST ||
    Number(parts[2]) !== BLOCK_SIZE ||
    Number(parts[3]) !== PARALLELIZATION ||
    parts[4] === undefined ||
    parts[5] === undefined
  ) {
    return false;
  }
  try {
    const salt = Buffer.from(parts[4], "base64url");
    const expected = Buffer.from(parts[5], "base64url");
    const actual = await derive(password, salt);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_LENGTH,
      {
        N: COST,
        r: BLOCK_SIZE,
        p: PARALLELIZATION,
        maxmem: MAX_MEMORY,
      },
      (error, key) => {
        if (error) reject(error);
        else resolve(key);
      },
    );
  });
}
