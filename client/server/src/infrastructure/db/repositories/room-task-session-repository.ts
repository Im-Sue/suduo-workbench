import type { DatabasePort } from "../database-port.js";

/** 房间话题对应的本机房间任务会话（迁移 016 `room_task_sessions`）。 */
export interface RoomTaskSessionRecord {
  agentId: string;
  roomId: string;
  threadRootId: string;
  sessionId: string;
  remoteProjectId: string;
  roomName: string;
  /** 需求房间的需求；项目默认房间为 null。 */
  requirementId: string | null;
  /** 建会话时的需求版本（需求只读工具的「开工版本」）。 */
  requirementVersion: number | null;
  /** 上次触发消息的房间序号；0 = 还没发过回合。 */
  lastTriggerSeq: number;
  lastRunId: string | null;
  createdAt: number;
}

interface RoomTaskSessionRow {
  agent_id: string;
  room_id: string;
  thread_root_id: string;
  session_id: string;
  remote_project_id: string;
  room_name: string;
  requirement_id: string | null;
  requirement_version: number | null;
  last_trigger_seq: number;
  last_run_id: string | null;
  created_at: number;
}

export class RoomTaskSessionRepository {
  constructor(private readonly database: DatabasePort) {}

  get(agentId: string, roomId: string, threadRootId: string): RoomTaskSessionRecord | null {
    const row = this.database
      .prepare(
        "SELECT * FROM room_task_sessions WHERE agent_id = @agentId AND room_id = @roomId AND thread_root_id = @threadRootId",
      )
      .get<RoomTaskSessionRow>({ agentId, roomId, threadRootId });
    return row ? mapRow(row) : null;
  }

  getBySessionId(sessionId: string): RoomTaskSessionRecord | null {
    const row = this.database
      .prepare("SELECT * FROM room_task_sessions WHERE session_id = @sessionId")
      .get<RoomTaskSessionRow>({ sessionId });
    return row ? mapRow(row) : null;
  }

  /**
   * 话题换了新会话（旧会话被删除 / 归档后再被 @）时整行替换：同一话题只指向最新的会话，
   * 续接位置从 0 重来（新线程没有历史）。
   */
  upsert(record: RoomTaskSessionRecord): RoomTaskSessionRecord {
    this.database
      .prepare(
        [
          "INSERT INTO room_task_sessions",
          "(agent_id, room_id, thread_root_id, session_id, remote_project_id, room_name,",
          " requirement_id, requirement_version, last_trigger_seq, last_run_id, created_at)",
          "VALUES (@agentId, @roomId, @threadRootId, @sessionId, @remoteProjectId, @roomName,",
          " @requirementId, @requirementVersion, @lastTriggerSeq, @lastRunId, @createdAt)",
          "ON CONFLICT (agent_id, room_id, thread_root_id) DO UPDATE SET",
          "session_id = excluded.session_id, remote_project_id = excluded.remote_project_id,",
          "room_name = excluded.room_name, requirement_id = excluded.requirement_id,",
          "requirement_version = excluded.requirement_version, last_trigger_seq = excluded.last_trigger_seq,",
          "last_run_id = excluded.last_run_id, created_at = excluded.created_at",
        ].join(" "),
      )
      .run({ ...record });
    const saved = this.get(record.agentId, record.roomId, record.threadRootId);
    if (!saved) {
      throw new Error("room task session was not persisted");
    }
    return saved;
  }

  /** 回合已发出：记下这次触发的序号与任务，下次续接只发它之后的新消息。只前进不后退。 */
  recordTrigger(sessionId: string, input: { triggerSeq: number; runId: string; roomName?: string }): void {
    this.database
      .prepare(
        [
          "UPDATE room_task_sessions SET",
          "last_trigger_seq = MAX(last_trigger_seq, @triggerSeq), last_run_id = @runId,",
          "room_name = COALESCE(@roomName, room_name)",
          "WHERE session_id = @sessionId",
        ].join(" "),
      )
      .run({ sessionId, triggerSeq: input.triggerSeq, runId: input.runId, roomName: input.roomName ?? null });
  }
}

function mapRow(row: RoomTaskSessionRow): RoomTaskSessionRecord {
  return {
    agentId: row.agent_id,
    roomId: row.room_id,
    threadRootId: row.thread_root_id,
    sessionId: row.session_id,
    remoteProjectId: row.remote_project_id,
    roomName: row.room_name,
    requirementId: row.requirement_id,
    requirementVersion: row.requirement_version,
    lastTriggerSeq: row.last_trigger_seq,
    lastRunId: row.last_run_id,
    createdAt: row.created_at,
  };
}
