import type { DatabasePort } from "../database-port.js";
import {
  mapSession,
  type SessionRecord,
  type SessionRow,
} from "./session-repository.js";

export type SessionListView = "active" | "archived" | "all";
export type SessionListKind = "normal" | "room_task";

/** 键集游标：排序键（最后活动时间，无则创建时间）+ 会话 id。 */
export interface SessionListCursor {
  sortKey: number;
  id: string;
}

export interface SessionListEntry {
  session: SessionRecord;
  sortKey: number;
  project: {
    id: string;
    name: string;
    rootPath: string;
    state: "active" | "removed";
    remoteProjectId: string | null;
  };
  requirement: {
    remoteRequirementId: string;
    number: number | null;
    title: string | null;
  } | null;
  lastMessage: { role: "user" | "assistant"; text: string } | null;
  /** 房间任务会话对应的房间话题；普通会话为 null。 */
  roomTask: {
    remoteProjectId: string;
    roomId: string;
    roomName: string;
    threadRootId: string;
    lastRunId: string | null;
  } | null;
}

interface SessionListRow extends SessionRow {
  sort_key: number;
  last_message_role: "user" | "assistant" | null;
  last_message_text: string | null;
  project_name: string;
  project_root_path: string;
  project_state: "active" | "removed";
  ref_remote_project_id: string | null;
  ref_remote_requirement_id: string | null;
  ref_requirement_number: number | null;
  ref_requirement_title: string | null;
  mapping_remote_project_id: string | null;
  room_remote_project_id: string | null;
  room_id: string | null;
  room_name: string | null;
  room_thread_root_id: string | null;
  room_last_run_id: string | null;
}

const VIEW_STATES: Readonly<Record<SessionListView, readonly string[]>> = {
  active: ["starting", "active", "error"],
  archived: ["archived"],
  all: ["starting", "active", "error", "archived"],
};

/**
 * 跨项目会话列表的只读查询：一次 SQL 把会话、项目、需求快照、项目映射与预览列拼好，
 * 不扫事件表。排序 = COALESCE(last_activity_at, created_at) DESC, id ASC，与游标一致。
 */
export class SessionListRepository {
  constructor(private readonly database: DatabasePort) {}

  listPage(input: {
    view: SessionListView;
    /** 缺省 normal：普通列表不出现房间任务会话。 */
    kind?: SessionListKind;
    /** 只列这个远程项目的会话；缺省 / null 不按项目过滤。 */
    remoteProjectId?: string | null;
    after: SessionListCursor | null;
    limit: number;
  }): SessionListEntry[] {
    const states = JSON.stringify(VIEW_STATES[input.view]);
    const kind = input.kind ?? "normal";
    const remoteProjectId = input.remoteProjectId ?? null;
    const statement = this.database.prepare(
      sessionListSql(input.after !== null, remoteProjectId !== null),
    );
    const rows = statement.all<SessionListRow>({
      states,
      kind,
      limit: input.limit,
      ...(remoteProjectId === null ? {} : { remoteProjectId }),
      ...(input.after === null ? {} : { afterKey: input.after.sortKey, afterId: input.after.id }),
    });
    return rows.map((row) => ({
      session: mapSession(row),
      sortKey: row.sort_key,
      project: {
        id: row.project_id,
        name: row.project_name,
        rootPath: row.project_root_path,
        state: row.project_state,
        remoteProjectId: row.ref_remote_project_id ?? row.mapping_remote_project_id,
      },
      requirement:
        row.ref_remote_requirement_id === null
          ? null
          : {
              remoteRequirementId: row.ref_remote_requirement_id,
              number: row.ref_requirement_number,
              title: row.ref_requirement_title,
            },
      lastMessage:
        row.last_message_role === null || row.last_message_text === null
          ? null
          : { role: row.last_message_role, text: row.last_message_text },
      roomTask:
        row.room_id === null || row.room_thread_root_id === null
          ? null
          : {
              remoteProjectId: row.room_remote_project_id ?? "",
              roomId: row.room_id,
              roomName: row.room_name ?? "",
              threadRootId: row.room_thread_root_id,
              lastRunId: row.room_last_run_id,
            },
    }));
  }
}

/**
 * 列表 SQL。有游标时先用范围条件让 idx_sessions_list_recent 直接定位到游标处
 * （SEARCH 而不是从索引头 SCAN），再在同刻内按 id 决胜；排序与游标比较口径一致。
 * 按远程项目过滤时，会话所属项目 = 房间任务的房间项目 → 需求会话的需求项目 → 代码目录映射。
 */
export function sessionListSql(withCursor: boolean, withRemoteProject = false): string {
  return [
    "SELECT s.*, COALESCE(s.last_activity_at, s.created_at) AS sort_key,",
    "p.name AS project_name, p.root_path AS project_root_path, p.state AS project_state,",
    "r.remote_project_id AS ref_remote_project_id,",
    "r.remote_requirement_id AS ref_remote_requirement_id,",
    "r.requirement_number AS ref_requirement_number,",
    "r.requirement_title AS ref_requirement_title,",
    "m.remote_project_id AS mapping_remote_project_id,",
    "rt.remote_project_id AS room_remote_project_id, rt.room_id AS room_id, rt.room_name AS room_name,",
    "rt.thread_root_id AS room_thread_root_id, rt.last_run_id AS room_last_run_id",
    "FROM sessions s",
    "JOIN projects p ON p.id = s.project_id",
    "LEFT JOIN v2_requirement_session_refs r ON r.session_id = s.id",
    "LEFT JOIN v2_project_workspace_mappings m ON m.local_project_id = s.project_id",
    "LEFT JOIN room_task_sessions rt ON rt.session_id = s.id",
    "WHERE s.state IN (SELECT value FROM json_each(@states))",
    "AND s.kind = @kind",
    ...(withRemoteProject
      ? ["AND COALESCE(rt.remote_project_id, r.remote_project_id, m.remote_project_id) = @remoteProjectId"]
      : []),
    ...(withCursor
      ? [
          "AND COALESCE(s.last_activity_at, s.created_at) <= @afterKey",
          "AND (COALESCE(s.last_activity_at, s.created_at) < @afterKey OR s.id > @afterId)",
        ]
      : []),
    "ORDER BY COALESCE(s.last_activity_at, s.created_at) DESC, s.id ASC",
    "LIMIT @limit",
  ].join(" ");
}
