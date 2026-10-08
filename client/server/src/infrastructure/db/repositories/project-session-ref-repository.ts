import type { DatabasePort } from "../database-port.js";

/**
 * 项目会话的所属项目（迁移 018）：建会话时写入，之后不随目录关联或服务器变化。
 * 需求会话记在 v2_requirement_session_refs、房间任务会话记在 room_task_sessions，各自已带所属项目。
 */
export interface ProjectSessionRefRecord {
  sessionId: string;
  remoteProjectId: string;
  createdAt: number;
}

interface ProjectSessionRefRow {
  session_id: string;
  remote_project_id: string;
  created_at: number;
}

export class ProjectSessionRefRepository {
  constructor(private readonly database: DatabasePort) {}

  create(input: { sessionId: string; remoteProjectId: string; now?: number }): ProjectSessionRefRecord {
    const now = input.now ?? Date.now();
    this.database
      .prepare(
        [
          "INSERT INTO v2_project_session_refs (session_id, remote_project_id, created_at)",
          "VALUES (@sessionId, @remoteProjectId, @now)",
        ].join(" "),
      )
      .run({ sessionId: input.sessionId, remoteProjectId: input.remoteProjectId, now });
    return { sessionId: input.sessionId, remoteProjectId: input.remoteProjectId, createdAt: now };
  }

  getBySessionId(sessionId: string): ProjectSessionRefRecord | null {
    const row = this.database
      .prepare("SELECT * FROM v2_project_session_refs WHERE session_id = @sessionId")
      .get<ProjectSessionRefRow>({ sessionId });
    return row
      ? { sessionId: row.session_id, remoteProjectId: row.remote_project_id, createdAt: row.created_at }
      : null;
  }
}
