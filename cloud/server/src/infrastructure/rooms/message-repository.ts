import type {
  RoomMentionDto,
  RoomMessageAuthorKind,
  RoomMessageDto,
  UserSummaryDto,
} from "@suduo/cloud-contracts";
import { THREAD_LAST_REPLIERS } from "../../application/rooms/constants.js";
import type { Database, QueryExecutor } from "../database.js";
import {
  FILE_COLUMNS,
  RUN_COLUMNS,
  RUN_FROM,
  agentJson,
  escapeLike,
  mapAgent,
  mapFile,
  mapRun,
  requiredRow,
  toAgentSummary,
  userJson,
  type AgentJson,
  type FileRow,
  type RunRow,
} from "./sql.js";

interface MessageRow {
  id: string;
  room_id: string;
  seq: string;
  client_id: string | null;
  author_kind: RoomMessageAuthorKind;
  body: string;
  mentions: RoomMentionDto[];
  thread_root_id: string | null;
  reply_count: number;
  last_reply_at: Date | null;
  created_at: Date;
  author_json: UserSummaryDto | null;
  agent_json: AgentJson | null;
}

const MESSAGE_SELECT = `
  SELECT
    m.id, m.room_id, m.seq, m.client_id, m.author_kind, m.body, m.mentions, m.thread_root_id,
    m.reply_count, m.last_reply_at, m.created_at,
    ${userJson("m.author_id")} AS author_json,
    ${agentJson("m.agent_id")} AS agent_json
  FROM room_messages m
`;

export interface InsertMessageInput {
  id: string;
  roomId: string;
  seq: number;
  clientId: string | null;
  authorKind: RoomMessageAuthorKind;
  authorId: string;
  agentId: string | null;
  body: string;
  mentions: RoomMentionDto[];
  threadRootId: string | null;
}

export interface MessagePageInput {
  after?: number;
  before?: number;
  threadRootId?: string;
  limit: number;
}

export interface MessagePage {
  items: RoomMessageDto[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
}

export class MessageRepository {
  constructor(private readonly database: Database) {}

  /** 合并网络重试：同房间同客户端 ID 已有消息就返回它的 ID。 */
  async findIdByClientId(executor: QueryExecutor, roomId: string, clientId: string): Promise<string | null> {
    const result = await executor.query<{ id: string }>(
      "SELECT id FROM room_messages WHERE room_id = $1 AND client_id = $2",
      [roomId, clientId],
    );
    return result.rows[0]?.id ?? null;
  }

  /** 话题根：引用的消息若本身是回复，归到它的根（话题只有一层）。不在本房间返回 null。 */
  async resolveThreadRoot(executor: QueryExecutor, roomId: string, messageId: string): Promise<string | null> {
    const result = await executor.query<{ id: string; thread_root_id: string | null }>(
      "SELECT id, thread_root_id FROM room_messages WHERE id = $1 AND room_id = $2",
      [messageId, roomId],
    );
    const row = result.rows[0];
    return row === undefined ? null : (row.thread_root_id ?? row.id);
  }

  async existsInRoom(roomId: string, messageId: string): Promise<boolean> {
    const result = await this.database.query(
      "SELECT 1 FROM room_messages WHERE id = $1 AND room_id = $2",
      [messageId, roomId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** 插入消息；有话题根时同时把根的回复数 +1、最后回复时间对齐到这条。 */
  async insert(executor: QueryExecutor, input: InsertMessageInput): Promise<void> {
    const inserted = await executor.query<{ created_at: Date }>(
      `
        INSERT INTO room_messages (
          id, room_id, seq, client_id, author_kind, author_id, agent_id, body, mentions, thread_root_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
        RETURNING created_at
      `,
      [
        input.id,
        input.roomId,
        input.seq,
        input.clientId,
        input.authorKind,
        input.authorId,
        input.agentId,
        input.body,
        JSON.stringify(input.mentions),
        input.threadRootId,
      ],
    );
    if (input.threadRootId !== null) {
      await executor.query(
        `
          UPDATE room_messages
          SET reply_count = reply_count + 1,
              last_reply_at = GREATEST(COALESCE(last_reply_at, $2::timestamptz), $2::timestamptz)
          WHERE id = $1
        `,
        [input.threadRootId, requiredRow(inserted.rows[0]).created_at],
      );
    }
  }

  async linkFiles(executor: QueryExecutor, messageId: string, fileIds: readonly string[]): Promise<void> {
    if (fileIds.length === 0) return;
    await executor.query(
      `
        INSERT INTO room_message_files (message_id, file_id, position)
        SELECT $1, f.id, (f.ordinal - 1)::integer
        FROM unnest($2::uuid[]) WITH ORDINALITY AS f(id, ordinal)
      `,
      [messageId, fileIds],
    );
  }

  async getById(messageId: string, executor: QueryExecutor = this.database): Promise<RoomMessageDto | null> {
    const result = await executor.query<MessageRow>(`${MESSAGE_SELECT} WHERE m.id = $1`, [messageId]);
    const [message] = await this.hydrate(result.rows, executor);
    return message ?? null;
  }

  /**
   * 按序号分页：给 after 时从它往后正序取（补拉）；否则从 before（缺省 = 最新）往前取，再按序号正序返回。
   * threadRootId 时范围是「根 + 它的回复」。
   */
  async page(roomId: string, input: MessagePageInput): Promise<MessagePage> {
    const scope = ["m.room_id = $1"];
    const values: unknown[] = [roomId];
    if (input.threadRootId !== undefined) {
      values.push(input.threadRootId);
      scope.push(`(m.id = $${values.length} OR m.thread_root_id = $${values.length})`);
    }
    const scopeValues = [...values];
    const scopeSql = scope.join(" AND ");
    const range = [...scope];
    if (input.after !== undefined) {
      values.push(input.after);
      range.push(`m.seq > $${values.length}`);
    }
    if (input.before !== undefined) {
      values.push(input.before);
      range.push(`m.seq < $${values.length}`);
    }
    values.push(input.limit + 1);
    const ascending = input.after !== undefined;
    const result = await this.database.query<MessageRow>(
      `
        ${MESSAGE_SELECT}
        WHERE ${range.join(" AND ")}
        ORDER BY m.seq ${ascending ? "ASC" : "DESC"}
        LIMIT $${values.length}
      `,
      values,
    );
    const overflow = result.rows.length > input.limit;
    const rows = result.rows.slice(0, input.limit);
    if (!ascending) rows.reverse();
    const first = rows[0];
    const last = rows.at(-1);
    // 边界外是否还有：没取到任何行时，以请求的边界为准。
    const hasMoreBefore = ascending
      ? await this.existsInScope(scopeSql, scopeValues, "<", first === undefined ? (input.after ?? 0) + 1 : Number(first.seq))
      : overflow;
    const hasMoreAfter = !ascending
      ? last !== undefined
        ? await this.existsInScope(scopeSql, scopeValues, ">", Number(last.seq))
        : input.before !== undefined && (await this.existsInScope(scopeSql, scopeValues, ">=", input.before))
      : overflow;
    return { items: await this.hydrate(rows), hasMoreBefore, hasMoreAfter };
  }

  /** 正文包含关键词（不分大小写）的消息；最新的 limit 条，按序号正序返回。 */
  async search(roomId: string, input: { q: string; limit: number; before?: number }): Promise<MessagePage> {
    const values: unknown[] = [roomId, `%${escapeLike(input.q)}%`, input.limit + 1];
    let beforeClause = "";
    if (input.before !== undefined) {
      values.push(input.before);
      beforeClause = `AND m.seq < $${values.length}`;
    }
    const result = await this.database.query<MessageRow>(
      `
        ${MESSAGE_SELECT}
        WHERE m.room_id = $1 AND m.body ILIKE $2 ESCAPE '\\' ${beforeClause}
        ORDER BY m.seq DESC
        LIMIT $3
      `,
      values,
    );
    const rows = result.rows.slice(0, input.limit).reverse();
    return {
      items: await this.hydrate(rows),
      hasMoreBefore: result.rows.length > input.limit,
      hasMoreAfter: false,
    };
  }

  private async existsInScope(
    scopeSql: string,
    scopeValues: readonly unknown[],
    operator: "<" | ">" | ">=",
    bound: number,
  ): Promise<boolean> {
    const values = [...scopeValues, bound];
    const result = await this.database.query(
      `SELECT 1 FROM room_messages m WHERE ${scopeSql} AND m.seq ${operator} $${values.length} LIMIT 1`,
      values,
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** 批量补齐附件、话题摘要与这条消息唤起的任务。 */
  private async hydrate(rows: MessageRow[], executor: QueryExecutor = this.database): Promise<RoomMessageDto[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const rootIds = rows.filter((row) => row.reply_count > 0).map((row) => row.id);
    const [files, runs, repliers] = await Promise.all([
      executor.query<FileRow & { message_id: string }>(
        `
          SELECT mf.message_id, ${FILE_COLUMNS}
          FROM room_message_files mf
          JOIN room_files f ON f.id = mf.file_id
          WHERE mf.message_id = ANY($1::uuid[])
          ORDER BY mf.message_id, mf.position
        `,
        [ids],
      ),
      executor.query<RunRow>(
        `SELECT ${RUN_COLUMNS} ${RUN_FROM} WHERE ar.trigger_message_id = ANY($1::uuid[]) ORDER BY ar.created_at, ar.id`,
        [ids],
      ),
      rootIds.length === 0
        ? Promise.resolve({ rows: [] as ReplierRow[] })
        : executor.query<ReplierRow>(
            `
              SELECT x.thread_root_id, u.id, u.display_name
              FROM (
                SELECT rm.thread_root_id, rm.author_id, max(rm.seq) AS last_seq
                FROM room_messages rm
                WHERE rm.thread_root_id = ANY($1::uuid[]) AND rm.author_kind = 'user'
                GROUP BY rm.thread_root_id, rm.author_id
              ) x
              JOIN users u ON u.id = x.author_id
              ORDER BY x.thread_root_id, x.last_seq DESC
            `,
            [rootIds],
          ),
    ]);
    const filesByMessage = groupBy(files.rows, (row) => row.message_id);
    const runsByMessage = groupBy(runs.rows, (row) => row.trigger_message_id);
    const repliersByRoot = groupBy(repliers.rows, (row) => row.thread_root_id);
    return rows.map((row) => ({
      id: row.id,
      roomId: row.room_id,
      seq: Number(row.seq),
      clientId: row.client_id,
      authorKind: row.author_kind,
      author: row.author_json,
      agent: row.agent_json === null ? null : toAgentSummary(mapAgent(row.agent_json)),
      body: row.body,
      mentions: row.mentions,
      threadRootId: row.thread_root_id,
      files: (filesByMessage.get(row.id) ?? []).map(mapFile),
      thread:
        row.reply_count > 0
          ? {
              replyCount: row.reply_count,
              lastReplyAt: row.last_reply_at?.toISOString() ?? null,
              lastRepliers: (repliersByRoot.get(row.id) ?? [])
                .slice(0, THREAD_LAST_REPLIERS)
                .map((replier) => ({ id: replier.id, displayName: replier.display_name })),
            }
          : null,
      runs: (runsByMessage.get(row.id) ?? []).map((run) => mapRun(run).summary),
      createdAt: row.created_at.toISOString(),
    }));
  }
}

interface ReplierRow {
  thread_root_id: string;
  id: string;
  display_name: string;
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const value = key(row);
    const group = groups.get(value);
    if (group === undefined) groups.set(value, [row]);
    else group.push(row);
  }
  return groups;
}
