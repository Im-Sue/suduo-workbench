import type { AttachmentDto, UserSummaryDto } from "@suduo/cloud-contracts";
import { ApplicationError, notFound } from "../application/errors.js";
import { insertAuditLog } from "./audit-log.js";
import type { StoredAttachment } from "./attachment-storage.js";
import type { Database, QueryExecutor } from "./database.js";
import { touchRequirement } from "./requirement-touch.js";
import type { PoolClient } from "pg";

interface AttachmentRow {
  id: string;
  requirement_id: string;
  project_id: string;
  storage_key: string;
  file_name: string;
  content_type: string;
  size_bytes: string | number;
  sha256: string;
  uploaded_by_user: UserSummaryDto;
  created_at: Date;
  requirement_version: number;
}

const ATTACHMENT_SELECT = `
  SELECT
    a.id,
    a.requirement_id,
    r.project_id,
    a.storage_key,
    a.file_name,
    a.content_type,
    a.size_bytes,
    a.sha256,
    json_build_object('id', uploader.id, 'displayName', uploader.display_name) AS uploaded_by_user,
    a.created_at,
    r.version AS requirement_version
  FROM attachments a
  JOIN requirements r ON r.id = a.requirement_id
  JOIN users uploader ON uploader.id = a.uploaded_by
`;

const STORAGE_LOCK_NAMESPACE = 1_515_947_075;
const STORAGE_LOCK_ID = 3;

export interface AttachmentMutationResult {
  attachment: AttachmentDto;
  storageKey: string;
  projectId: string;
  requirementVersion: number;
}

export class AttachmentRepository {
  private ownershipClient: PoolClient | null = null;
  private ownershipLost = false;
  private ownershipErrorHandler: (() => void) | null = null;
  private ownershipOperationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly database: Database,
    private readonly maxPerRequirement: number,
  ) {}

  async acquireStorageOwnership(): Promise<void> {
    if (this.ownershipClient !== null && !this.ownershipLost) return;
    const client = await this.database.pool.connect();
    try {
      const result = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1, $2) AS acquired",
        [STORAGE_LOCK_NAMESPACE, STORAGE_LOCK_ID],
      );
      if (result.rows[0]?.acquired !== true) {
        throw new Error("附件根目录已由另一个 requirements-service 实例持有");
      }
      this.ownershipLost = false;
      const onOwnershipError = () => {
        if (this.ownershipClient === client) this.ownershipLost = true;
      };
      client.once("error", onOwnershipError);
      this.ownershipClient = client;
      this.ownershipErrorHandler = onOwnershipError;
    } catch (error) {
      client.release();
      throw error;
    }
  }

  async assertStorageOwnership(): Promise<void> {
    await this.withOwnershipOperation(async () => {
      const client = this.requireOwnershipClient();
      try {
        await client.query("SELECT 1");
      } catch (error) {
        this.ownershipLost = true;
        throw new ApplicationError(
          503,
          "DEPENDENCY_UNAVAILABLE",
          "附件存储写入所有权已丢失",
          undefined,
          { cause: error },
        );
      }
    });
  }

  async releaseStorageOwnership(): Promise<void> {
    await this.withOwnershipOperation(async () => {
      const client = this.ownershipClient;
      const errorHandler = this.ownershipErrorHandler;
      if (client === null) return;
      let releaseError: Error | null = null;
      try {
        const result = await client.query<{ unlocked: boolean }>(
          "SELECT pg_advisory_unlock($1, $2) AS unlocked",
          [STORAGE_LOCK_NAMESPACE, STORAGE_LOCK_ID],
        );
        if (result.rows[0]?.unlocked !== true || this.ownershipLost) {
          throw new Error("附件存储写入所有权释放失败");
        }
      } catch (error) {
        releaseError = error instanceof Error ? error : new Error(String(error));
        throw error;
      } finally {
        this.ownershipClient = null;
        this.ownershipErrorHandler = null;
        this.ownershipLost = false;
        if (errorHandler !== null) client.off("error", errorHandler);
        if (releaseError === null) client.release();
        else client.release(releaseError);
      }
    });
  }

  async assertCanUpload(requirementId: string): Promise<void> {
    const result = await this.database.query<{ active_count: string }>(
      `
        SELECT COUNT(a.id)::text AS active_count
        FROM requirements r
        LEFT JOIN attachments a
          ON a.requirement_id = r.id AND a.deleted_at IS NULL
        WHERE r.id = $1
        GROUP BY r.id
      `,
      [requirementId],
    );
    const row = result.rows[0];
    if (row === undefined) throw notFound("需求");
    if (Number(row.active_count) >= this.maxPerRequirement) {
      throw new ApplicationError(409, "ATTACHMENT_INVALID", "该需求的附件数量已达上限", {
        maxAttachments: this.maxPerRequirement,
      });
    }
  }

  async attachmentIdState(
    attachmentId: string,
  ): Promise<"missing" | "active" | "deleted"> {
    const result = await this.database.query<{ is_deleted: boolean }>(
      "SELECT deleted_at IS NOT NULL AS is_deleted FROM attachments WHERE id = $1",
      [attachmentId],
    );
    const row = result.rows[0];
    if (row === undefined) return "missing";
    return row.is_deleted ? "deleted" : "active";
  }

  async create(
    actorId: string,
    requirementId: string,
    stored: StoredAttachment,
    attachmentId: string,
  ): Promise<AttachmentMutationResult> {
    return this.storageTransaction(async (client) => {
      const requirement = await client.query<{ project_id: string; version: number }>(
        "SELECT project_id, version FROM requirements WHERE id = $1 FOR UPDATE",
        [requirementId],
      );
      const requirementRow = requirement.rows[0];
      if (requirementRow === undefined) throw notFound("需求");
      const count = await client.query<{ active_count: string }>(
        "SELECT COUNT(*)::text AS active_count FROM attachments WHERE requirement_id = $1 AND deleted_at IS NULL",
        [requirementId],
      );
      if (Number(count.rows[0]?.active_count ?? "0") >= this.maxPerRequirement) {
        throw new ApplicationError(409, "ATTACHMENT_INVALID", "该需求的附件数量已达上限", {
          maxAttachments: this.maxPerRequirement,
        });
      }
      await client.query(
        `
          INSERT INTO attachments (
            id, requirement_id, storage_key, file_name, content_type,
            size_bytes, sha256, uploaded_by
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
        [
          attachmentId,
          requirementId,
          stored.storageKey,
          stored.fileName,
          stored.contentType,
          stored.sizeBytes,
          stored.sha256,
          actorId,
        ],
      );
      const version = await touchRequirement(client, requirementId, actorId);
      const attachment = await this.getRow(attachmentId, client);
      await insertAuditLog(client, {
        actorId,
        projectId: requirementRow.project_id,
        requirementId,
        resourceType: "attachment",
        resourceId: attachmentId,
        action: "attachment.created",
        before: null,
        after: attachmentAudit(attachment, version),
      });
      return {
        attachment: mapAttachment(attachment),
        storageKey: attachment.storage_key,
        projectId: requirementRow.project_id,
        requirementVersion: version,
      };
    });
  }

  async list(requirementId: string): Promise<{
    items: AttachmentDto[];
    requirementVersion: number;
  }> {
    return this.database.transaction(async (client) => {
      const requirement = await client.query<{ version: number }>(
        "SELECT version FROM requirements WHERE id = $1 FOR SHARE",
        [requirementId],
      );
      if (requirement.rows[0] === undefined) throw notFound("需求");
      const result = await client.query<AttachmentRow>(
        `${ATTACHMENT_SELECT}
         WHERE a.requirement_id = $1 AND a.deleted_at IS NULL
         ORDER BY a.created_at ASC, a.id ASC`,
        [requirementId],
      );
      return {
        items: result.rows.map(mapAttachment),
        requirementVersion: requirement.rows[0]?.version ?? 0,
      };
    });
  }

  async getForDownload(attachmentId: string): Promise<AttachmentMutationResult> {
    const row = await this.getRow(attachmentId, this.database);
    return {
      attachment: mapAttachment(row),
      storageKey: row.storage_key,
      projectId: row.project_id,
      requirementVersion: row.requirement_version,
    };
  }

  async recordDownload(actorId: string, attachmentId: string): Promise<void> {
    await this.database.transaction(async (client) => {
      const row = await this.getRow(attachmentId, client);
      await insertAuditLog(client, {
        actorId,
        projectId: row.project_id,
        requirementId: row.requirement_id,
        resourceType: "attachment",
        resourceId: attachmentId,
        action: "attachment.downloaded",
        before: null,
        after: attachmentAudit(row, row.requirement_version),
      });
    });
  }

  async delete(
    actorId: string,
    attachmentId: string,
  ): Promise<AttachmentMutationResult> {
    return this.storageTransaction(async (client) => {
      const result = await client.query<AttachmentRow>(
        `${ATTACHMENT_SELECT}
         WHERE a.id = $1 AND a.deleted_at IS NULL
         FOR UPDATE OF a, r`,
        [attachmentId],
      );
      const row = result.rows[0];
      if (row === undefined) throw notFound("附件");
      await client.query(
        "UPDATE attachments SET deleted_at = now(), deleted_by = $1 WHERE id = $2 AND deleted_at IS NULL",
        [actorId, attachmentId],
      );
      const version = await touchRequirement(client, row.requirement_id, actorId);
      await insertAuditLog(client, {
        actorId,
        projectId: row.project_id,
        requirementId: row.requirement_id,
        resourceType: "attachment",
        resourceId: attachmentId,
        action: "attachment.deleted",
        before: attachmentAudit(row, row.requirement_version),
        after: {
          requirementId: row.requirement_id,
          version,
          deleted: true,
        },
      });
      return {
        attachment: mapAttachment(row),
        storageKey: row.storage_key,
        projectId: row.project_id,
        requirementVersion: version,
      };
    });
  }

  async activeStorageKeys(): Promise<ReadonlySet<string>> {
    const result = await this.database.query<{ storage_key: string }>(
      "SELECT storage_key FROM attachments WHERE deleted_at IS NULL",
    );
    return new Set(result.rows.map((row) => row.storage_key));
  }

  async findActiveByStorageKey(
    storageKey: string,
  ): Promise<AttachmentMutationResult | null> {
    const result = await this.database.query<AttachmentRow>(
      `${ATTACHMENT_SELECT}
       WHERE a.storage_key = $1 AND a.deleted_at IS NULL`,
      [storageKey],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      attachment: mapAttachment(row),
      storageKey: row.storage_key,
      projectId: row.project_id,
      requirementVersion: row.requirement_version,
    };
  }

  async findActiveById(
    attachmentId: string,
  ): Promise<AttachmentMutationResult | null> {
    const result = await this.database.query<AttachmentRow>(
      `${ATTACHMENT_SELECT}
       WHERE a.id = $1 AND a.deleted_at IS NULL`,
      [attachmentId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      attachment: mapAttachment(row),
      storageKey: row.storage_key,
      projectId: row.project_id,
      requirementVersion: row.requirement_version,
    };
  }

  private async getRow(
    attachmentId: string,
    executor: QueryExecutor,
  ): Promise<AttachmentRow> {
    const result = await executor.query<AttachmentRow>(
      `${ATTACHMENT_SELECT} WHERE a.id = $1 AND a.deleted_at IS NULL`,
      [attachmentId],
    );
    const row = result.rows[0];
    if (row === undefined) throw notFound("附件");
    return row;
  }

  private requireOwnershipClient(): PoolClient {
    const client = this.ownershipClient;
    if (client === null || this.ownershipLost) {
      throw new ApplicationError(503, "DEPENDENCY_UNAVAILABLE", "附件存储写入所有权已丢失");
    }
    return client;
  }

  private async storageTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.withOwnershipOperation(async () => {
      const client = this.requireOwnershipClient();
      try {
        await client.query("BEGIN");
        const result = await work(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {
          this.ownershipLost = true;
        });
        throw error;
      }
    });
  }

  private async withOwnershipOperation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.ownershipOperationTail;
    let release: () => void = () => undefined;
    this.ownershipOperationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function attachmentAudit(row: AttachmentRow, version: number): Record<string, unknown> {
  return {
    requirementId: row.requirement_id,
    fileName: row.file_name,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    version,
  };
}

function mapAttachment(row: AttachmentRow): AttachmentDto {
  const sizeBytes = Number(row.size_bytes);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new ApplicationError(500, "INTERNAL_ERROR", "附件大小元数据无效");
  }
  return {
    id: row.id,
    requirementId: row.requirement_id,
    fileName: row.file_name,
    contentType: row.content_type,
    sizeBytes,
    sha256: row.sha256,
    uploadedBy: row.uploaded_by_user,
    createdAt: row.created_at.toISOString(),
  };
}
