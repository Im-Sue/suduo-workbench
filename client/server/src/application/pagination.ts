import { ApiError } from "./api-error.js";

export function paginate<T>(
  items: readonly T[],
  cursor: string | undefined,
  limit: number | undefined,
): { items: T[]; nextCursor: string | null } {
  const pageSize = normalizeLimit(limit);
  const offset = decodeCursor(cursor);
  const page = items.slice(offset, offset + pageSize);
  const nextOffset = offset + page.length;
  return {
    items: page,
    nextCursor:
      nextOffset < items.length
        ? Buffer.from(String(nextOffset), "utf8").toString("base64url")
        : null,
  };
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return 50;
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      (t) => t.session.limitRange(200),
    );
  }
  return limit;
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) {
    return 0;
  }
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const offset = Number(decoded);
  if (!Number.isSafeInteger(offset) || offset < 0 || String(offset) !== decoded) {
    throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.cursorInvalid);
  }
  return offset;
}
