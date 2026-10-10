import { randomUUID } from "node:crypto";
import type { DelegationResultDto, DelegationStatus } from "@suduo/client-contracts";
import type { DatabasePort } from "../database-port.js";
import { parseJson, serializeJson } from "./repository-json.js";

/** 委派（迁移 023 `delegations`，多 Agent 协作 S8）。 */
export interface DelegationRecord {
  id: string;
  parentSessionId: string;
  childSessionId: string | null;
  agentId: string;
  task: string;
  origin: "agent" | "user";
  status: DelegationStatus;
  autoHandback: boolean;
  delivered: boolean;
  result: DelegationResultDto | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

interface DelegationRow {
  id: string;
  parent_session_id: string;
  child_session_id: string | null;
  agent_id: string;
  task: string;
  origin: "agent" | "user";
  status: DelegationStatus;
  auto_handback: number;
  delivered: number;
  result_json: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
}

export class DelegationRepository {
  constructor(private readonly database: DatabasePort) {}

  create(input: {
    parentSessionId: string;
    agentId: string;
    task: string;
    origin: "agent" | "user";
    autoHandback: boolean;
    now?: number;
  }): DelegationRecord {
    const id = randomUUID();
    const now = input.now ?? Date.now();
    this.database
      .prepare(
        [
          "INSERT INTO delegations (id, parent_session_id, agent_id, task, origin, status, auto_handback, created_at, updated_at)",
          "VALUES (@id, @parentSessionId, @agentId, @task, @origin, 'queued', @autoHandback, @now, @now)",
        ].join(" "),
      )
      .run({ id, parentSessionId: input.parentSessionId, agentId: input.agentId, task: input.task, origin: input.origin, autoHandback: input.autoHandback ? 1 : 0, now });
    return this.require(id);
  }

  getById(id: string): DelegationRecord | null {
    const row = this.database.prepare("SELECT * FROM delegations WHERE id = @id").get<DelegationRow>({ id });
    return row ? mapRow(row) : null;
  }

  getByChild(childSessionId: string): DelegationRecord | null {
    const row = this.database
      .prepare("SELECT * FROM delegations WHERE child_session_id = @childSessionId ORDER BY created_at DESC LIMIT 1")
      .get<DelegationRow>({ childSessionId });
    return row ? mapRow(row) : null;
  }

  listByParent(parentSessionId: string): DelegationRecord[] {
    return this.database
      .prepare("SELECT * FROM delegations WHERE parent_session_id = @parentSessionId ORDER BY created_at ASC")
      .all<DelegationRow>({ parentSessionId })
      .map(mapRow);
  }

  /** 还没结束的（排队中、运行中）：本机服务启动时收尾。 */
  listUnfinished(): DelegationRecord[] {
    return this.database
      .prepare("SELECT * FROM delegations WHERE status IN ('queued', 'running') ORDER BY created_at ASC")
      .all<DelegationRow>()
      .map(mapRow);
  }

  update(
    id: string,
    patch: Partial<Pick<DelegationRecord, "childSessionId" | "status" | "delivered" | "result" | "error" | "finishedAt">>,
    now = Date.now(),
  ): DelegationRecord {
    const current = this.require(id);
    const next = { ...current, ...patch };
    this.database
      .prepare(
        [
          "UPDATE delegations SET child_session_id = @childSessionId, status = @status, delivered = @delivered,",
          "result_json = @result, error = @error, finished_at = @finishedAt, updated_at = @now WHERE id = @id",
        ].join(" "),
      )
      .run({
        id,
        childSessionId: next.childSessionId,
        status: next.status,
        delivered: next.delivered ? 1 : 0,
        result: next.result === null ? null : serializeJson(next.result as never),
        error: next.error,
        finishedAt: next.finishedAt,
        now,
      });
    return this.require(id);
  }

  private require(id: string): DelegationRecord {
    const record = this.getById(id);
    if (record === null) throw new Error("delegation was not persisted: " + id);
    return record;
  }
}

function mapRow(row: DelegationRow): DelegationRecord {
  return {
    id: row.id,
    parentSessionId: row.parent_session_id,
    childSessionId: row.child_session_id,
    agentId: row.agent_id,
    task: row.task,
    origin: row.origin,
    status: row.status,
    autoHandback: row.auto_handback === 1,
    delivered: row.delivered === 1,
    result: row.result_json === null ? null : (parseJson(row.result_json) as unknown as DelegationResultDto),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}
