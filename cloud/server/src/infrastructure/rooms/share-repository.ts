import { randomUUID } from "node:crypto";
import type { Database, QueryExecutor } from "../database.js";
import {
  SHARE_COLUMNS,
  SHARE_FROM,
  SHARE_REQUEST_COLUMNS,
  SHARE_REQUEST_FROM,
  mapShare,
  mapShareRequest,
  requiredRow,
  type ShareRecord,
  type ShareRequestRecord,
  type ShareRequestRow,
  type ShareRow,
} from "./sql.js";

export interface ShareLockRow {
  id: string;
  agent_id: string;
  room_id: string;
  expires_at: Date | null;
  closed_at: Date | null;
}

/** Agent 共享与申请共享。唯一约束（开着的共享、待处理的申请）只用于合并（ADR-0004）。 */
export class AgentShareRepository {
  constructor(private readonly database: Database) {}

  /** 房间里开着的共享（含已到期但还没被扫描关闭的，active=false）。 */
  async listOpen(roomId: string): Promise<ShareRecord[]> {
    const result = await this.database.query<ShareRow>(
      `SELECT ${SHARE_COLUMNS} ${SHARE_FROM} WHERE s.room_id = $1 AND s.closed_at IS NULL ORDER BY s.started_at, s.id`,
      [roomId],
    );
    return result.rows.map(mapShare);
  }

  async find(shareId: string, executor: QueryExecutor = this.database): Promise<ShareRecord | null> {
    const result = await executor.query<ShareRow>(`SELECT ${SHARE_COLUMNS} ${SHARE_FROM} WHERE s.id = $1`, [shareId]);
    return result.rows[0] === undefined ? null : mapShare(result.rows[0]);
  }

  async lock(executor: QueryExecutor, shareId: string): Promise<ShareLockRow | null> {
    const result = await executor.query<ShareLockRow>(
      "SELECT id, agent_id, room_id, expires_at, closed_at FROM agent_shares WHERE id = $1 FOR UPDATE",
      [shareId],
    );
    return result.rows[0] ?? null;
  }

  async lockOpen(executor: QueryExecutor, agentId: string, roomId: string): Promise<ShareLockRow | null> {
    const result = await executor.query<ShareLockRow>(
      `
        SELECT id, agent_id, room_id, expires_at, closed_at
        FROM agent_shares
        WHERE agent_id = $1 AND room_id = $2 AND closed_at IS NULL
        FOR UPDATE
      `,
      [agentId, roomId],
    );
    return result.rows[0] ?? null;
  }

  /** 开共享：已有开着的就改到期时间，返回同一条（合并）。 */
  async upsertOpen(executor: QueryExecutor, agentId: string, roomId: string, expiresAt: Date | null): Promise<string> {
    const result = await executor.query<{ id: string }>(
      `
        INSERT INTO agent_shares (id, agent_id, room_id, expires_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (agent_id, room_id) WHERE closed_at IS NULL
        DO UPDATE SET expires_at = EXCLUDED.expires_at
        RETURNING id
      `,
      [randomUUID(), agentId, roomId, expiresAt],
    );
    return requiredRow(result.rows[0]).id;
  }

  async close(executor: QueryExecutor, shareId: string, reason: "closed" | "expired"): Promise<void> {
    await executor.query(
      "UPDATE agent_shares SET closed_at = now(), closed_reason = $2 WHERE id = $1 AND closed_at IS NULL",
      [shareId, reason],
    );
  }

  /** 到期的共享一次性关闭（closed_reason=expired），返回关掉的那些。 */
  async closeExpired(executor: QueryExecutor): Promise<ShareLockRow[]> {
    const result = await executor.query<ShareLockRow>(
      `
        UPDATE agent_shares
        SET closed_at = now(), closed_reason = 'expired'
        WHERE closed_at IS NULL AND expires_at IS NOT NULL AND expires_at <= now()
        RETURNING id, agent_id, room_id, expires_at, closed_at
      `,
    );
    return result.rows;
  }

  // ───────────────────────────── 申请共享 ─────────────────────────────

  /** 申请共享：同一人对同一 Agent 在同一房间只有一条待处理的，重复申请返回它（合并）。 */
  async createRequest(
    executor: QueryExecutor,
    input: { roomId: string; agentId: string; requesterId: string },
  ): Promise<{ id: string; created: boolean }> {
    const inserted = await executor.query<{ id: string }>(
      `
        INSERT INTO agent_share_requests (id, room_id, agent_id, requester_id)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (room_id, agent_id, requester_id) WHERE status = 'pending' DO NOTHING
        RETURNING id
      `,
      [randomUUID(), input.roomId, input.agentId, input.requesterId],
    );
    if (inserted.rows[0] !== undefined) return { id: inserted.rows[0].id, created: true };
    const existing = await executor.query<{ id: string }>(
      `
        SELECT id FROM agent_share_requests
        WHERE room_id = $1 AND agent_id = $2 AND requester_id = $3 AND status = 'pending'
      `,
      [input.roomId, input.agentId, input.requesterId],
    );
    return { id: requiredRow(existing.rows[0]).id, created: false };
  }

  async listPendingRequests(roomId: string): Promise<ShareRequestRecord[]> {
    const result = await this.database.query<ShareRequestRow>(
      `
        SELECT ${SHARE_REQUEST_COLUMNS} ${SHARE_REQUEST_FROM}
        WHERE sr.room_id = $1 AND sr.status = 'pending'
        ORDER BY sr.created_at, sr.id
      `,
      [roomId],
    );
    return result.rows.map(mapShareRequest);
  }

  async findRequest(requestId: string, executor: QueryExecutor = this.database): Promise<ShareRequestRecord | null> {
    const result = await executor.query<ShareRequestRow>(
      `SELECT ${SHARE_REQUEST_COLUMNS} ${SHARE_REQUEST_FROM} WHERE sr.id = $1`,
      [requestId],
    );
    return result.rows[0] === undefined ? null : mapShareRequest(result.rows[0]);
  }

  async lockRequest(executor: QueryExecutor, requestId: string): Promise<{ status: string } | null> {
    const result = await executor.query<{ status: string }>(
      "SELECT status FROM agent_share_requests WHERE id = $1 FOR UPDATE",
      [requestId],
    );
    return result.rows[0] ?? null;
  }

  async ignoreRequest(executor: QueryExecutor, requestId: string): Promise<void> {
    await executor.query(
      "UPDATE agent_share_requests SET status = 'ignored', resolved_at = now() WHERE id = $1 AND status = 'pending'",
      [requestId],
    );
  }

  /** 共享开了：这个 Agent 在这个房间所有待处理的申请都算已开启。 */
  async acceptPending(executor: QueryExecutor, roomId: string, agentId: string): Promise<string[]> {
    const result = await executor.query<{ id: string }>(
      `
        UPDATE agent_share_requests
        SET status = 'accepted', resolved_at = now()
        WHERE room_id = $1 AND agent_id = $2 AND status = 'pending'
        RETURNING id
      `,
      [roomId, agentId],
    );
    return result.rows.map((row) => row.id);
  }
}
