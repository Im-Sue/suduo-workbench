import { randomUUID } from "node:crypto";
import type { AgentDto, AgentKind } from "@suduo/cloud-contracts";
import type { Database, QueryExecutor } from "../database.js";
import { ONLINE_SINCE, agentJson, mapAgent, requiredRow, shareActive, type AgentJson } from "./sql.js";

export interface AgentRecord {
  agent: AgentDto;
  ownerId: string;
}

/** Agent 登记、心跳与在线状态；真人在线（user_presence）也在这里。 */
export class AgentRepository {
  constructor(private readonly database: Database) {}

  async list(): Promise<AgentDto[]> {
    const result = await this.database.query<{ agent_json: AgentJson }>(
      `
        SELECT ${agentJson("a.id")} AS agent_json
        FROM agents a
        JOIN users o ON o.id = a.owner_id
        ORDER BY o.display_name, a.created_at, a.id
      `,
    );
    return result.rows.map((row) => mapAgent(row.agent_json));
  }

  async find(agentId: string, executor: QueryExecutor = this.database): Promise<AgentRecord | null> {
    const result = await executor.query<{ owner_id: string; agent_json: AgentJson }>(
      `SELECT a.owner_id, ${agentJson("a.id")} AS agent_json FROM agents a WHERE a.id = $1`,
      [agentId],
    );
    const row = result.rows[0];
    return row === undefined ? null : { agent: mapAgent(row.agent_json), ownerId: row.owner_id };
  }

  /**
   * 登记：同一所有者 + 设备 + 类型合并为同一个 Agent（ADR-0004 合并），更新设备名；
   * 登记即视为在线（刷新 last_seen_at）。
   */
  async register(input: {
    ownerId: string;
    deviceKey: string;
    deviceName: string;
    kind: AgentKind;
  }): Promise<{ agentId: string; created: boolean }> {
    const result = await this.database.query<{ id: string; created: boolean }>(
      `
        INSERT INTO agents (id, owner_id, kind, device_key, device_name, last_seen_at)
        VALUES ($1, $2, $3, $4, $5, now())
        ON CONFLICT (owner_id, device_key, kind)
        DO UPDATE SET device_name = EXCLUDED.device_name, last_seen_at = now()
        RETURNING id, (xmax = 0) AS created
      `,
      [randomUUID(), input.ownerId, input.kind, input.deviceKey, input.deviceName],
    );
    const row = requiredRow(result.rows[0]);
    return { agentId: row.id, created: row.created };
  }

  /** 心跳：只有所有者能刷新；不是所有者返回 false（服务层按 404 处理）。 */
  async touch(agentId: string, ownerId: string): Promise<boolean> {
    const result = await this.database.query(
      "UPDATE agents SET last_seen_at = now() WHERE id = $1 AND owner_id = $2",
      [agentId, ownerId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async touchUserPresence(userId: string): Promise<void> {
    await this.database.query(
      `
        INSERT INTO user_presence (user_id, last_active_at) VALUES ($1, now())
        ON CONFLICT (user_id) DO UPDATE SET last_active_at = EXCLUDED.last_active_at
      `,
      [userId],
    );
  }

  async onlineAgentIds(): Promise<Set<string>> {
    const result = await this.database.query<{ id: string }>(
      `SELECT id FROM agents WHERE last_seen_at > ${ONLINE_SINCE}`,
    );
    return new Set(result.rows.map((row) => row.id));
  }

  async onlineUserIds(): Promise<Set<string>> {
    const result = await this.database.query<{ user_id: string }>(
      `SELECT user_id FROM user_presence WHERE last_active_at > ${ONLINE_SINCE}`,
    );
    return new Set(result.rows.map((row) => row.user_id));
  }

  /** @ 一个 Agent 时它在这个房间能不能执行：共享开着且未到期 + 所有者本机在线。 */
  async availability(
    executor: QueryExecutor,
    agentId: string,
    roomId: string,
  ): Promise<{ shared: boolean; online: boolean }> {
    const result = await executor.query<{ shared: boolean; online: boolean }>(
      `
        SELECT
          EXISTS (
            SELECT 1 FROM agent_shares s
            WHERE s.agent_id = a.id AND s.room_id = $2 AND ${shareActive("s")}
          ) AS shared,
          COALESCE(a.last_seen_at > ${ONLINE_SINCE}, false) AS online
        FROM agents a
        WHERE a.id = $1
      `,
      [agentId, roomId],
    );
    return result.rows[0] ?? { shared: false, online: false };
  }

  /** @ 里引用的 Agent：ID → 展示标签（不存在的不在结果里）。 */
  async labels(executor: QueryExecutor, agentIds: readonly string[]): Promise<Map<string, string>> {
    if (agentIds.length === 0) return new Map();
    const result = await executor.query<{ agent_json: AgentJson }>(
      `SELECT ${agentJson("a.id")} AS agent_json FROM agents a WHERE a.id = ANY($1::uuid[])`,
      [[...new Set(agentIds)]],
    );
    return new Map(result.rows.map((row) => {
      const agent = mapAgent(row.agent_json);
      return [agent.id, agent.label];
    }));
  }
}
