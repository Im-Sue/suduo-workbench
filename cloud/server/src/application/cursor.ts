import { ApplicationError } from "./errors.js";

export interface CursorPosition {
  timestamp: string;
  id: string;
}

export function encodeCursor(position: CursorPosition): string {
  return Buffer.from(JSON.stringify(position), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | undefined): CursorPosition | null {
  if (cursor === undefined) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Partial<CursorPosition>;
    if (
      typeof parsed.timestamp !== "string" ||
      Number.isNaN(Date.parse(parsed.timestamp)) ||
      typeof parsed.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        parsed.id,
      )
    ) {
      throw new Error("invalid cursor payload");
    }
    return { timestamp: parsed.timestamp, id: parsed.id };
  } catch (error) {
    throw new ApplicationError(400, "VALIDATION_ERROR", "Invalid pagination cursor", undefined, {
      cause: error,
    });
  }
}

export function pageLimit(limit: number | undefined): number {
  return limit ?? 50;
}
