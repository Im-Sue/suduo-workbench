import { randomUUID } from "node:crypto";
import type {
  ArtifactVersionDetailDto,
  ArtifactVersionDto,
  ArtifactVersionFileDto,
  CommentSystemContent,
  ListArtifactVersionsResponse,
  UserSummaryDto,
} from "@suduo/cloud-contracts";
import { notFound } from "../application/errors.js";
import { insertAuditLog } from "./audit-log.js";
import type { Database, QueryExecutor } from "./database.js";

interface ArtifactVersionRow {
  id: string;
  requirement_id: string;
  version_number: number;
  published_by_user: UserSummaryDto;
  published_at: Date;
  file_count: string | number;
}

interface ArtifactVersionFileRow {
  id: string;
  version_id: string;
  attachment_id: string;
  file_name: string;
  size_bytes: string | number;
  sha256: string;
  storage_key: string;
}

interface RequirementLockRow {
  id: string;
  project_id: string;
  version: number;
}

interface AttachmentSnapshotRow {
  id: string;
  file_name: string;
  size_bytes: string | number;
  sha256: string;
  storage_key: string;
}

interface PublishOperationRow {
  request_digest: string;
  response_json: unknown;
}

const ARTIFACT_VERSION_SELECT = `
  SELECT
    v.id,
    v.requirement_id,
    v.version_number,
    json_build_object('id', publisher.id, 'displayName', publisher.display_name) AS published_by_user,
    v.published_at,
    COUNT(f.id)::text AS file_count
  FROM requirement_artifact_versions v
  JOIN users publisher ON publisher.id = v.published_by
  LEFT JOIN requirement_artifact_version_files f ON f.version_id = v.id
`;

export interface LockedRequirement {
  id: string;
  projectId: string;
  version: number;
}

export interface ArtifactAttachmentSnapshot {
  id: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  storageKey: string;
}

export interface ArtifactVersionFileSnapshot {
  id: string;
  artifactVersionId: string;
  attachmentId: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  storageKey: string;
}

export interface PublishOperationReplay<TResponse> {
  requestDigest: string;
  response: TResponse;
}

export class ArtifactVersionRepository {
  constructor(private readonly database: Database) {}

  transaction<T>(work: (executor: QueryExecutor) => Promise<T>): Promise<T> {
    return this.database.transaction(work);
  }

  async list(requirementId: string): Promise<ListArtifactVersionsResponse> {
    await this.assertRequirementExists(requirementId, this.database);
    const result = await this.database.query<ArtifactVersionRow>(
      `
        ${ARTIFACT_VERSION_SELECT}
        WHERE v.requirement_id = $1
        GROUP BY v.id, publisher.id
        ORDER BY v.version_number DESC
      `,
      [requirementId],
    );
    return { items: result.rows.map(mapArtifactVersion) };
  }

  async getDetail(versionId: string): Promise<ArtifactVersionDetailDto> {
    return this.getDetailWithExecutor(versionId, this.database);
  }

  /**
   * 以版本文件快照为权威查询下载信息；刻意不关联 attachments，
   * 因而不会被附件的 deleted_at 过滤影响。
   */
  async getVersionFileForDownload(
    versionId: string,
    fileId: string,
  ): Promise<ArtifactVersionFileSnapshot> {
    const result = await this.database.query<ArtifactVersionFileRow>(
      `
        SELECT
          f.id,
          f.version_id,
          f.attachment_id,
          f.file_name,
          f.size_bytes,
          f.sha256,
          f.storage_key
        FROM requirement_artifact_version_files f
        WHERE f.version_id = $1 AND f.id = $2
      `,
      [versionId, fileId],
    );
    const row = result.rows[0];
    if (row === undefined) throw notFound("Confirmed version file");
    return mapArtifactVersionFileSnapshot(row);
  }

  async referencedStorageKeys(): Promise<ReadonlySet<string>> {
    const result = await this.database.query<{ storage_key: string }>(
      "SELECT DISTINCT storage_key FROM requirement_artifact_version_files",
    );
    return new Set(result.rows.map((row) => row.storage_key));
  }

  async lockRequirement(
    requirementId: string,
    executor: QueryExecutor,
  ): Promise<LockedRequirement> {
    const result = await executor.query<RequirementLockRow>(
      "SELECT id, project_id, version FROM requirements WHERE id = $1 FOR UPDATE",
      [requirementId],
    );
    const row = result.rows[0];
    if (row === undefined) throw notFound("Requirement");
    return {
      id: row.id,
      projectId: row.project_id,
      version: row.version,
    };
  }

  async findPublishOperation<TResponse>(
    requirementId: string,
    operationKey: string,
    executor: QueryExecutor,
  ): Promise<PublishOperationReplay<TResponse> | null> {
    const result = await executor.query<PublishOperationRow>(
      `
        SELECT request_digest, response_json
        FROM requirement_publish_operations
        WHERE requirement_id = $1 AND operation_key = $2
      `,
      [requirementId, operationKey],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      requestDigest: row.request_digest,
      response: row.response_json as TResponse,
    };
  }

  async findActiveAttachmentSnapshots(
    requirementId: string,
    attachmentIds: readonly string[],
    executor: QueryExecutor,
  ): Promise<ArtifactAttachmentSnapshot[]> {
    const result = await executor.query<AttachmentSnapshotRow>(
      `
        SELECT id, file_name, size_bytes, sha256, storage_key
        FROM attachments
        WHERE requirement_id = $1
          AND id = ANY($2::uuid[])
          AND deleted_at IS NULL
      `,
      [requirementId, attachmentIds],
    );
    return result.rows.map(mapAttachmentSnapshot);
  }

  async createVersionWithFiles(
    input: {
      requirementId: string;
      actorId: string;
      files: readonly ArtifactAttachmentSnapshot[];
    },
    executor: QueryExecutor,
  ): Promise<ArtifactVersionDetailDto> {
    const versionNumber = await this.nextVersionNumber(input.requirementId, executor);
    const versionId = randomUUID();
    await executor.query(
      `
        INSERT INTO requirement_artifact_versions (
          id, requirement_id, version_number, published_by
        ) VALUES ($1, $2, $3, $4)
      `,
      [versionId, input.requirementId, versionNumber, input.actorId],
    );
    for (const file of input.files) {
      await executor.query(
        `
          INSERT INTO requirement_artifact_version_files (
            id, version_id, attachment_id, file_name, size_bytes, sha256, storage_key
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        [
          randomUUID(),
          versionId,
          file.id,
          file.fileName,
          file.sizeBytes,
          file.sha256,
          file.storageKey,
        ],
      );
    }
    return this.getDetailWithExecutor(versionId, executor);
  }

  async createPublishComment(
    input: {
      actorId: string;
      projectId: string;
      requirementId: string;
      artifactVersionId: string;
      body: string;
      /** 系统代写时的类型 + 参数；用户写了说明时为 null。 */
      system: CommentSystemContent | null;
    },
    executor: QueryExecutor,
  ): Promise<void> {
    const commentId = randomUUID();
    await executor.query(
      `
        INSERT INTO requirement_comments (
          id, requirement_id, artifact_version_id, body, author_id, system_kind, system_params
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      `,
      [
        commentId,
        input.requirementId,
        input.artifactVersionId,
        input.body,
        input.actorId,
        input.system?.kind ?? null,
        input.system === null ? null : JSON.stringify(input.system.params),
      ],
    );
    await insertAuditLog(executor, {
      actorId: input.actorId,
      projectId: input.projectId,
      requirementId: input.requirementId,
      resourceType: "comment",
      resourceId: commentId,
      action: "comment.created",
      before: null,
      after: {
        requirementId: input.requirementId,
        artifactVersionId: input.artifactVersionId,
        body: input.body,
      },
    });
  }

  async createPublicationAudit(
    input: {
      actorId: string;
      projectId: string;
      artifactVersion: ArtifactVersionDetailDto;
      requirementVersion: number;
    },
    executor: QueryExecutor,
  ): Promise<void> {
    await insertAuditLog(executor, {
      actorId: input.actorId,
      projectId: input.projectId,
      requirementId: input.artifactVersion.requirementId,
      resourceType: "artifact_version",
      resourceId: input.artifactVersion.id,
      action: "artifact_version.published",
      before: null,
      after: {
        requirementId: input.artifactVersion.requirementId,
        versionNumber: input.artifactVersion.versionNumber,
        fileCount: input.artifactVersion.fileCount,
        requirementVersion: input.requirementVersion,
      },
    });
  }

  async recordPublishOperation(
    input: {
      requirementId: string;
      operationKey: string;
      requestDigest: string;
      response: unknown;
    },
    executor: QueryExecutor,
  ): Promise<void> {
    await executor.query(
      `
        INSERT INTO requirement_publish_operations (
          requirement_id, operation_key, request_digest, response_json
        ) VALUES ($1, $2, $3, $4::jsonb)
      `,
      [
        input.requirementId,
        input.operationKey,
        input.requestDigest,
        JSON.stringify(input.response),
      ],
    );
  }

  private async assertRequirementExists(
    requirementId: string,
    executor: QueryExecutor,
  ): Promise<void> {
    const result = await executor.query<{ id: string }>(
      "SELECT id FROM requirements WHERE id = $1",
      [requirementId],
    );
    if (result.rows[0] === undefined) throw notFound("Requirement");
  }

  private async nextVersionNumber(
    requirementId: string,
    executor: QueryExecutor,
  ): Promise<number> {
    const result = await executor.query<{ version_number: number }>(
      `
        SELECT COALESCE(MAX(version_number), 0) + 1 AS version_number
        FROM requirement_artifact_versions
        WHERE requirement_id = $1
      `,
      [requirementId],
    );
    return result.rows[0]?.version_number ?? 1;
  }

  private async getDetailWithExecutor(
    versionId: string,
    executor: QueryExecutor,
  ): Promise<ArtifactVersionDetailDto> {
    const version = await executor.query<ArtifactVersionRow>(
      `
        ${ARTIFACT_VERSION_SELECT}
        WHERE v.id = $1
        GROUP BY v.id, publisher.id
      `,
      [versionId],
    );
    const versionRow = version.rows[0];
    if (versionRow === undefined) throw notFound("Confirmed version");
    const files = await executor.query<ArtifactVersionFileRow>(
      `
        SELECT id, version_id, attachment_id, file_name, size_bytes, sha256, storage_key
        FROM requirement_artifact_version_files
        WHERE version_id = $1
        ORDER BY file_name ASC, id ASC
      `,
      [versionId],
    );
    return {
      ...mapArtifactVersion(versionRow),
      files: files.rows.map(mapArtifactVersionFile),
    };
  }
}

function mapArtifactVersion(row: ArtifactVersionRow): ArtifactVersionDto {
  return {
    id: row.id,
    requirementId: row.requirement_id,
    versionNumber: row.version_number,
    publishedBy: row.published_by_user,
    publishedAt: row.published_at.toISOString(),
    fileCount: Number(row.file_count),
  };
}

function mapArtifactVersionFile(row: ArtifactVersionFileRow): ArtifactVersionFileDto {
  return {
    id: row.id,
    artifactVersionId: row.version_id,
    attachmentId: row.attachment_id,
    fileName: row.file_name,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
  };
}

function mapArtifactVersionFileSnapshot(
  row: ArtifactVersionFileRow,
): ArtifactVersionFileSnapshot {
  return {
    ...mapArtifactVersionFile(row),
    storageKey: row.storage_key,
  };
}

function mapAttachmentSnapshot(row: AttachmentSnapshotRow): ArtifactAttachmentSnapshot {
  return {
    id: row.id,
    fileName: row.file_name,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    storageKey: row.storage_key,
  };
}
