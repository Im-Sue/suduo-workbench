import type { DatabasePort } from "../database-port.js";

/** 会话的协作记录上报开关（迁移 026，多 Agent 协作 S11，P2-D1）：只存明确设过的；没设过为 null（跟着发起它的会话）。 */
export class AiActivitySettingRepository {
  constructor(private readonly database: DatabasePort) {}

  get(sessionId: string): boolean | null {
    const row = this.database
      .prepare("SELECT reporting FROM session_ai_activity_settings WHERE session_id = @sessionId")
      .get<{ reporting: number }>({ sessionId });
    return row === undefined ? null : row.reporting === 1;
  }

  set(sessionId: string, reporting: boolean, now = Date.now()): void {
    this.database
      .prepare(
        "INSERT INTO session_ai_activity_settings (session_id, reporting, updated_at) VALUES (@sessionId, @reporting, @now) " +
          "ON CONFLICT (session_id) DO UPDATE SET reporting = excluded.reporting, updated_at = excluded.updated_at",
      )
      .run({ sessionId, reporting: reporting ? 1 : 0, now });
  }
}
