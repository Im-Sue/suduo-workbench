import { ApplicationError } from "./errors.js";

export interface CursorPosition {
  timestamp: string;
  id: string;
  /** 只有按优先级排序的需求列表带：本页最后一行的优先级权重（0..4）。 */
  rank?: number;
}

export function encodeCursor(position: CursorPosition): string {
  return Buffer.from(JSON.stringify(position), "utf8").toString("base64url");
}

/**
 * 解析游标。`withRank` 表示这个列表按优先级排序、游标必须带 rank；不按优先级排序的列表不认带 rank 的游标。
 * 换了排序方式还沿用旧游标会落到这里报格式错误，而不是悄悄翻错页。
 */
export function decodeCursor(
  cursor: string | undefined,
  options: { withRank?: boolean } = {},
): CursorPosition | null {
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
    const withRank = options.withRank ?? false;
    if (withRank !== (parsed.rank !== undefined)) {
      throw new Error("cursor does not match the sort order");
    }
    if (!withRank) {
      return { timestamp: parsed.timestamp, id: parsed.id };
    }
    if (typeof parsed.rank !== "number" || !Number.isInteger(parsed.rank) || parsed.rank < 0 || parsed.rank > 32767) {
      throw new Error("invalid cursor rank");
    }
    return { timestamp: parsed.timestamp, id: parsed.id, rank: parsed.rank };
  } catch (error) {
    throw new ApplicationError(400, "VALIDATION_ERROR", "Invalid pagination cursor", undefined, {
      cause: error,
    });
  }
}

export function pageLimit(limit: number | undefined): number {
  return limit ?? 50;
}
