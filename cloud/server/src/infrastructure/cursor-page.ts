import type { RequirementsCursorPage } from "@suduo/cloud-contracts";
import { encodeCursor } from "../application/cursor.js";

/**
 * 游标分页的时间戳列：在 SQL 里把时间戳格式化成微秒精度的 UTC 字符串，选作 `cursor_at`。
 *
 * timestamptz 是微秒精度，node-pg 转成 JS Date 只剩毫秒。若用截断后的毫秒值做
 * `(ts, id) < ($ts, $id)` 比较，与游标行同一时间戳（同一事务的 now() 相同）或同一毫秒内
 * 的行都会被判成"不小于游标"而跨页漏掉；升序分页则会把游标行本身在下一页再返回一次。
 * 所以游标一律用这里选出的字符串编码，不从 JS Date 生成。
 */
export function cursorTimestampColumn(expression: string): string {
  return `to_char(${expression} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at`;
}

/** 选出了 `cursorTimestampColumn` 的查询行。按优先级排序的需求列表另选出 `cursor_rank`。 */
export interface CursorRow {
  id: string;
  cursor_at: string;
  cursor_rank?: number;
}

/** 查询多取一行判断是否还有下一页；游标取本页最后一行的 (cursor_at, id)，有 cursor_rank 时一并带上。 */
export function cursorPage<TRow extends CursorRow, TDto>(
  rows: TRow[],
  limit: number,
  map: (row: TRow) => TDto,
): RequirementsCursorPage<TDto> {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows.at(-1);
  return {
    items: pageRows.map(map),
    nextCursor:
      hasMore && last !== undefined
        ? encodeCursor({
            timestamp: last.cursor_at,
            id: last.id,
            ...(last.cursor_rank === undefined ? {} : { rank: last.cursor_rank }),
          })
        : null,
  };
}
