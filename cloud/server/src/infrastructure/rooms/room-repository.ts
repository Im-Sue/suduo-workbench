import { randomUUID } from "node:crypto";
import type {
  RoomDto,
  RoomKind,
  RoomMemberDto,
  RoomRequirementRefDto,
  UserSummaryDto,
} from "@suduo/cloud-contracts";
import { LAST_MESSAGE_PREVIEW_LENGTH } from "../../application/rooms/constants.js";
import { notFound } from "../../application/errors.js";
import type { Database, QueryExecutor } from "../database.js";
import { ONLINE_SINCE, agentLabel, requiredRow, userJson } from "./sql.js";

/** 写路径用的房间基本信息（锁行后读取）。 */
export interface RoomRef {
  id: string;
  projectId: string;
  requirementId: string | null;
  kind: RoomKind;
  /** 需求房间的名字；默认房间为 null（读时取项目名）。 */
  name: string | null;
  archivedAt: Date | null;
  lastSeq: number;
}

interface RoomRefRow {
  id: string;
  project_id: string;
  requirement_id: string | null;
  kind: RoomKind;
  name: string | null;
  archived_at: Date | null;
  last_seq: string;
}

interface RoomRow {
  id: string;
  project_id: string;
  kind: RoomKind;
  name: string;
  last_seq: string;
  archived_at: Date | null;
  created_at: Date;
  requirement_json: RoomRequirementRefDto | null;
  created_by_json: UserSummaryDto | null;
  member_count: number;
  viewer_joined: boolean;
  viewer_last_read_seq: string;
  viewer_unread_count: number;
  viewer_mention_count: number;
  last_message_seq: string | null;
  last_message_body: string | null;
  last_message_at: Date | null;
  last_message_author_kind: "user" | "agent" | "system" | null;
  last_message_author_name: string | null;
  last_message_agent_device_name: string | null;
  last_message_first_file_name: string | null;
  last_message_file_count: number | null;
}

/**
 * 房间查询（`$1` 恒为当前用户 ID，可为 null = 广播用的中性视角）。
 * 未读只算别人发的、序号大于已读位置的；需求房间只有成员才有未读。
 * 默认房间里还没有已读行的人：只算注册之后的消息，后注册的人不背整段历史的未读（`um.created_at > viewer.created_at`）。
 */
function roomSelect(tail: string): string {
  return `
    SELECT
      r.id,
      r.project_id,
      r.kind,
      COALESCE(r.name, p.name) AS name,
      r.last_seq,
      r.archived_at,
      r.created_at,
      CASE WHEN req.id IS NULL THEN NULL
        ELSE json_build_object('id', req.id, 'number', req.number, 'title', req.title)
      END AS requirement_json,
      ${userJson("r.created_by")} AS created_by_json,
      CASE WHEN r.kind = 'project_default' THEN (SELECT count(*)::integer FROM users)
        ELSE (SELECT count(*)::integer FROM room_members cm WHERE cm.room_id = r.id)
      END AS member_count,
      (r.kind = 'project_default' OR me.user_id IS NOT NULL) AS viewer_joined,
      COALESCE(me.last_read_seq, 0) AS viewer_last_read_seq,
      COALESCE(unread.unread_count, 0) AS viewer_unread_count,
      COALESCE(unread.mention_count, 0) AS viewer_mention_count,
      last_message.seq AS last_message_seq,
      last_message.body AS last_message_body,
      last_message.created_at AS last_message_at,
      last_message.author_kind AS last_message_author_kind,
      last_message.author_name AS last_message_author_name,
      last_message.agent_device_name AS last_message_agent_device_name,
      last_message.first_file_name AS last_message_first_file_name,
      last_message.file_count AS last_message_file_count
    FROM rooms r
    JOIN projects p ON p.id = r.project_id
    LEFT JOIN requirements req ON req.id = r.requirement_id
    LEFT JOIN users viewer ON viewer.id = $1::uuid
    LEFT JOIN room_members me ON me.room_id = r.id AND me.user_id = viewer.id
    LEFT JOIN LATERAL (
      SELECT
        count(*)::integer AS unread_count,
        (count(*) FILTER (
          WHERE um.mentions @> jsonb_build_array(jsonb_build_object('kind', 'user', 'id', viewer.id::text))
             OR um.mentions @> '[{"kind":"all"}]'::jsonb
        ))::integer AS mention_count
      FROM room_messages um
      WHERE viewer.id IS NOT NULL
        AND (r.kind = 'project_default' OR me.user_id IS NOT NULL)
        AND um.room_id = r.id
        AND um.seq > COALESCE(me.last_read_seq, 0)
        AND NOT (um.author_kind = 'user' AND um.author_id = viewer.id)
        AND (me.user_id IS NOT NULL OR um.created_at > viewer.created_at)
    ) unread ON true
    LEFT JOIN LATERAL (
      SELECT
        lm.seq,
        lm.body,
        lm.created_at,
        lm.author_kind,
        lu.display_name AS author_name,
        la.device_name AS agent_device_name,
        (
          SELECT lf.file_name
          FROM room_message_files lmf
          JOIN room_files lf ON lf.id = lmf.file_id
          WHERE lmf.message_id = lm.id
          ORDER BY lmf.position
          LIMIT 1
        ) AS first_file_name,
        (SELECT count(*)::integer FROM room_message_files lmc WHERE lmc.message_id = lm.id) AS file_count
      FROM room_messages lm
      LEFT JOIN users lu ON lu.id = lm.author_id
      LEFT JOIN agents la ON la.id = lm.agent_id
      WHERE lm.room_id = r.id
      ORDER BY lm.seq DESC
      LIMIT 1
    ) last_message ON true
    ${tail}
  `;
}

export class RoomRepository {
  constructor(private readonly database: Database) {}

  /**
   * 惰性建项目默认房间：先查，已有就不再写（侧栏每 60 秒轮询列房间，不能每次都执行 INSERT）；
   * 没有才插，并发插入靠唯一约束 ON CONFLICT DO NOTHING 合并（ADR-0004）。
   * 返回项目是否存在。
   */
  async ensureDefaultRoom(projectId: string, executor: QueryExecutor = this.database): Promise<boolean> {
    const project = await executor.query<{ has_default_room: boolean }>(
      `
        SELECT EXISTS (
          SELECT 1 FROM rooms r WHERE r.project_id = p.id AND r.kind = 'project_default'
        ) AS has_default_room
        FROM projects p
        WHERE p.id = $1
      `,
      [projectId],
    );
    const row = project.rows[0];
    if (row === undefined) return false;
    if (row.has_default_room) return true;
    await executor.query(
      `
        INSERT INTO rooms (id, project_id, kind, name, created_by)
        SELECT $1, p.id, 'project_default', NULL, p.created_by
        FROM projects p
        WHERE p.id = $2
        ON CONFLICT (project_id) WHERE kind = 'project_default' DO NOTHING
      `,
      [randomUUID(), projectId],
    );
    return true;
  }

  async listProjectRooms(projectId: string, viewerId: string | null): Promise<RoomDto[]> {
    const result = await this.database.query<RoomRow>(
      roomSelect(`
        WHERE r.project_id = $2
        ORDER BY (r.kind = 'project_default') DESC,
                 COALESCE(last_message.created_at, r.created_at) DESC,
                 r.id
      `),
      [viewerId, projectId],
    );
    return result.rows.map(mapRoom);
  }

  async listRequirementRooms(requirementId: string, viewerId: string | null): Promise<RoomDto[]> {
    const result = await this.database.query<RoomRow>(
      roomSelect("WHERE r.requirement_id = $2 ORDER BY r.created_at, r.id"),
      [viewerId, requirementId],
    );
    return result.rows.map(mapRoom);
  }

  async getRoom(roomId: string, viewerId: string | null, executor: QueryExecutor = this.database): Promise<RoomDto> {
    const result = await executor.query<RoomRow>(roomSelect("WHERE r.id = $2"), [viewerId, roomId]);
    const row = result.rows[0];
    if (row === undefined) throw notFound("Room");
    return mapRoom(row);
  }

  async findRef(roomId: string, executor: QueryExecutor = this.database): Promise<RoomRef | null> {
    const result = await executor.query<RoomRefRow>(
      "SELECT id, project_id, requirement_id, kind, name, archived_at, last_seq FROM rooms WHERE id = $1",
      [roomId],
    );
    return result.rows[0] === undefined ? null : mapRef(result.rows[0]);
  }

  async requireRef(roomId: string, executor: QueryExecutor = this.database): Promise<RoomRef> {
    const room = await this.findRef(roomId, executor);
    if (room === null) throw notFound("Room");
    return room;
  }

  /** 锁住房间行（发消息时按房间串行分配序号）。 */
  async lock(executor: QueryExecutor, roomId: string): Promise<RoomRef> {
    const result = await executor.query<RoomRefRow>(
      `
        SELECT id, project_id, requirement_id, kind, name, archived_at, last_seq
        FROM rooms WHERE id = $1
        FOR UPDATE
      `,
      [roomId],
    );
    if (result.rows[0] === undefined) throw notFound("Room");
    return mapRef(result.rows[0]);
  }

  async allocateSeq(executor: QueryExecutor, roomId: string): Promise<number> {
    const result = await executor.query<{ last_seq: string }>(
      "UPDATE rooms SET last_seq = last_seq + 1 WHERE id = $1 RETURNING last_seq",
      [roomId],
    );
    return Number(requiredRow(result.rows[0]).last_seq);
  }

  async insertRequirementRoom(
    executor: QueryExecutor,
    input: { id: string; projectId: string; requirementId: string; name: string; createdBy: string },
  ): Promise<void> {
    await executor.query(
      `
        INSERT INTO rooms (id, project_id, requirement_id, kind, name, created_by)
        VALUES ($1, $2, $3, 'requirement', $4, $5)
      `,
      [input.id, input.projectId, input.requirementId, input.name, input.createdBy],
    );
  }

  async rename(executor: QueryExecutor, roomId: string, name: string): Promise<void> {
    await executor.query("UPDATE rooms SET name = $2, updated_at = clock_timestamp() WHERE id = $1", [roomId, name]);
  }

  async setArchived(executor: QueryExecutor, roomId: string, archived: boolean): Promise<void> {
    await executor.query(
      `
        UPDATE rooms
        SET archived_at = CASE WHEN $2::boolean THEN COALESCE(archived_at, clock_timestamp()) ELSE NULL END,
            updated_at = clock_timestamp()
        WHERE id = $1
      `,
      [roomId, archived],
    );
  }

  /**
   * 加成员：已是成员就跳过（合并）。新成员的已读位置从当前序号起，不背加入前的历史未读。
   * 返回本次真正新加入的用户。
   */
  async addMembers(executor: QueryExecutor, roomId: string, userIds: readonly string[]): Promise<string[]> {
    if (userIds.length === 0) return [];
    const result = await executor.query<{ user_id: string }>(
      `
        INSERT INTO room_members (room_id, user_id, last_read_seq)
        SELECT r.id, u.id, r.last_seq
        FROM rooms r
        CROSS JOIN users u
        WHERE r.id = $1 AND u.id = ANY($2::uuid[])
        ON CONFLICT (room_id, user_id) DO NOTHING
        RETURNING user_id
      `,
      [roomId, [...new Set(userIds)]],
    );
    return result.rows.map((row) => row.user_id);
  }

  /**
   * 已读位置只前进：取 max(已读, min(upTo, 房间当前序号))，回退请求不改。
   * 默认房间的已读行惰性建立；需求房间只更新成员（不是成员不记，见服务层说明）。
   */
  async recordRead(executor: QueryExecutor, room: RoomRef, userId: string, upToSeq: number): Promise<void> {
    if (room.kind === "project_default") {
      await executor.query(
        `
          INSERT INTO room_members (room_id, user_id, last_read_seq)
          SELECT r.id, $2, LEAST($3::bigint, r.last_seq) FROM rooms r WHERE r.id = $1
          ON CONFLICT (room_id, user_id)
          DO UPDATE SET last_read_seq = GREATEST(room_members.last_read_seq, EXCLUDED.last_read_seq)
        `,
        [room.id, userId, upToSeq],
      );
      return;
    }
    await executor.query(
      `
        UPDATE room_members m
        SET last_read_seq = GREATEST(m.last_read_seq, LEAST($3::bigint, r.last_seq))
        FROM rooms r
        WHERE r.id = m.room_id AND m.room_id = $1 AND m.user_id = $2
      `,
      [room.id, userId, upToSeq],
    );
  }

  async listMembers(room: RoomRef): Promise<RoomMemberDto[]> {
    if (room.kind === "project_default") {
      const result = await this.database.query<MemberRow>(
        `
          SELECT u.id, u.display_name, NULL::timestamptz AS joined_at,
                 COALESCE(up.last_active_at > ${ONLINE_SINCE}, false) AS online
          FROM users u
          LEFT JOIN user_presence up ON up.user_id = u.id
          ORDER BY u.display_name, u.id
        `,
      );
      return result.rows.map(mapMember);
    }
    const result = await this.database.query<MemberRow>(
      `
        SELECT u.id, u.display_name, m.joined_at,
               COALESCE(up.last_active_at > ${ONLINE_SINCE}, false) AS online
        FROM room_members m
        JOIN users u ON u.id = m.user_id
        LEFT JOIN user_presence up ON up.user_id = u.id
        WHERE m.room_id = $1
        ORDER BY m.joined_at, u.id
      `,
      [room.id],
    );
    return result.rows.map(mapMember);
  }

  /** 输入里引用的用户有哪些存在（输入校验用）。 */
  async existingUserIds(executor: QueryExecutor, userIds: readonly string[]): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const result = await executor.query<{ id: string }>(
      "SELECT id FROM users WHERE id = ANY($1::uuid[])",
      [[...new Set(userIds)]],
    );
    return new Set(result.rows.map((row) => row.id));
  }
}

interface MemberRow {
  id: string;
  display_name: string;
  joined_at: Date | null;
  online: boolean;
}

function mapMember(row: MemberRow): RoomMemberDto {
  return {
    user: { id: row.id, displayName: row.display_name },
    joinedAt: row.joined_at?.toISOString() ?? null,
    online: row.online,
  };
}

function mapRef(row: RoomRefRow): RoomRef {
  return {
    id: row.id,
    projectId: row.project_id,
    requirementId: row.requirement_id,
    kind: row.kind,
    name: row.name,
    archivedAt: row.archived_at,
    lastSeq: Number(row.last_seq),
  };
}

function mapRoom(row: RoomRow): RoomDto {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    name: row.name,
    requirement: row.requirement_json,
    lastSeq: Number(row.last_seq),
    archivedAt: row.archived_at?.toISOString() ?? null,
    createdBy: row.created_by_json,
    createdAt: row.created_at.toISOString(),
    memberCount: row.member_count,
    viewer: {
      joined: row.viewer_joined,
      lastReadSeq: Number(row.viewer_last_read_seq),
      unreadCount: row.viewer_unread_count,
      mentionCount: row.viewer_mention_count,
    },
    lastMessage:
      row.last_message_seq === null || row.last_message_at === null
        ? null
        : {
            seq: Number(row.last_message_seq),
            authorName: lastMessageAuthor(row),
            preview: messagePreview(
              row.last_message_body ?? "",
              row.last_message_first_file_name,
              row.last_message_file_count ?? 0,
            ),
            createdAt: row.last_message_at.toISOString(),
          },
  };
}

function lastMessageAuthor(row: RoomRow): string {
  if (row.last_message_author_kind === "agent") {
    return agentLabel(row.last_message_author_name ?? "", row.last_message_agent_device_name ?? "");
  }
  if (row.last_message_author_kind === "user") return row.last_message_author_name ?? "";
  return "系统";
}

/** 预览：正文压成一行截 80 字；只有附件时给「[附件] 文件名」。 */
export function messagePreview(body: string, firstFileName: string | null, fileCount: number): string {
  const text = body.replace(/\s+/gu, " ").trim();
  if (text !== "") {
    const characters = Array.from(text);
    return characters.length > LAST_MESSAGE_PREVIEW_LENGTH
      ? `${characters.slice(0, LAST_MESSAGE_PREVIEW_LENGTH).join("")}…`
      : text;
  }
  if (firstFileName !== null) {
    return fileCount > 1 ? `[附件] ${firstFileName} 等 ${fileCount} 个` : `[附件] ${firstFileName}`;
  }
  return "";
}
