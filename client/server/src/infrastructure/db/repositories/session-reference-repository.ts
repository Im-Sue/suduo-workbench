import { randomUUID } from "node:crypto";
import type { DatabasePort } from "../database-port.js";

/** 跨会话读取的留痕（迁移 022 `session_references`，多 Agent 协作 S7，需求 R8）。 */
export interface SessionReferenceRecord {
  id: string;
  readerSessionId: string;
  targetId: string;
  /** 读的哪一层：summary / conversation / turns / turn / changes。 */
  view: string;
  /** 读的时候被读会话的账本到了哪个序号（再读时据此说「之后又有 N 个新回合」）。 */
  targetSeq: number;
  createdAt: number;
}

interface SessionReferenceRow {
  id: string;
  reader_session_id: string;
  target_id: string;
  view: string;
  target_seq: number;
  created_at: number;
}

export class SessionReferenceRepository {
  constructor(private readonly database: DatabasePort) {}

  record(input: { readerSessionId: string; targetId: string; view: string; targetSeq: number; now?: number }): SessionReferenceRecord {
    const record: SessionReferenceRecord = {
      id: randomUUID(),
      readerSessionId: input.readerSessionId,
      targetId: input.targetId,
      view: input.view,
      targetSeq: input.targetSeq,
      createdAt: input.now ?? Date.now(),
    };
    this.database
      .prepare(
        [
          "INSERT INTO session_references (id, reader_session_id, target_kind, target_id, view, target_seq, created_at)",
          "VALUES (@id, @readerSessionId, 'session', @targetId, @view, @targetSeq, @createdAt)",
        ].join(" "),
      )
      .run({ ...record });
    return record;
  }

  /** 这个会话上一次读那个会话的记录；没读过为 null。 */
  lastRead(readerSessionId: string, targetId: string): SessionReferenceRecord | null {
    const row = this.database
      .prepare(
        [
          "SELECT * FROM session_references",
          "WHERE reader_session_id = @readerSessionId AND target_id = @targetId",
          "ORDER BY created_at DESC, rowid DESC LIMIT 1",
        ].join(" "),
      )
      .get<SessionReferenceRow>({ readerSessionId, targetId });
    return row ? mapRow(row) : null;
  }
}

function mapRow(row: SessionReferenceRow): SessionReferenceRecord {
  return {
    id: row.id,
    readerSessionId: row.reader_session_id,
    targetId: row.target_id,
    view: row.view,
    targetSeq: row.target_seq,
    createdAt: row.created_at,
  };
}
