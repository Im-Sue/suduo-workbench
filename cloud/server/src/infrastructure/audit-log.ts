import { randomUUID } from "node:crypto";
import type { AuditResourceType, RecordedAuditAction } from "@suduo/cloud-contracts";
import type { QueryExecutor } from "./database.js";

export interface InsertAuditLogInput {
  actorId: string;
  projectId: string;
  /** 资源所属需求；只有项目级审计为 null（由数据库 CHECK 兜底）。 */
  requirementId: string | null;
  resourceType: AuditResourceType;
  resourceId: string;
  action: RecordedAuditAction;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/** 审计写入复用调用方事务；此处不推导归属、不创建事务，也不发事件。 */
export async function insertAuditLog(
  executor: QueryExecutor,
  input: InsertAuditLogInput,
): Promise<void> {
  await executor.query(
    `
      INSERT INTO audit_logs (
        id, actor_id, project_id, requirement_id, resource_type, resource_id,
        action, before_json, after_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)
    `,
    [
      randomUUID(),
      input.actorId,
      input.projectId,
      input.requirementId,
      input.resourceType,
      input.resourceId,
      input.action,
      input.before === null ? null : JSON.stringify(input.before),
      input.after === null ? null : JSON.stringify(input.after),
    ],
  );
}
