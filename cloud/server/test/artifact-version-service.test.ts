import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client, Pool } from "pg";
import {
  REQUIREMENTS_SERVICE_MAX_ACTIVE_ATTACHMENTS_PER_REQUIREMENT,
} from "@suduo/cloud-contracts";
import { ArtifactVersionService } from "../src/application/artifact-version-service.js";
import { Database } from "../src/infrastructure/database.js";
import { AttachmentRepository } from "../src/infrastructure/attachment-repository.js";
import { ArtifactVersionRepository } from "../src/infrastructure/artifact-version-repository.js";
import { runMigrations } from "../src/infrastructure/migration-runner.js";
import { ignoreTerminatedConnections } from "./pg-test-support.js";

const TEST_DATABASE = process.env["SUDUO_ARTIFACT_VERSION_TEST_DB"] ??
  `suduo_artifact_versions_${randomUUID().replaceAll("-", "")}`;
const DATABASE_IDENTIFIER = quotedIdentifier(TEST_DATABASE);
const PG_CONFIG = {
  host: "127.0.0.1",
  port: 15_432,
  user: "suduo",
};
const SHA256 = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

let pool: Pool;
let repository: ArtifactVersionRepository;
let service: ArtifactVersionService;
let databaseCreated = false;

beforeAll(async () => {
  const admin = new Client({ ...PG_CONFIG, database: "postgres" });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${DATABASE_IDENTIFIER}`);
    databaseCreated = true;
  } finally {
    await admin.end();
  }
  pool = ignoreTerminatedConnections(new Pool({ ...PG_CONFIG, database: TEST_DATABASE }));
  await runMigrations(pool);
  repository = new ArtifactVersionRepository(new Database(pool));
  service = new ArtifactVersionService(repository);
});

afterAll(async () => {
  await pool?.end();
  if (!databaseCreated) return;
  const admin = new Client({ ...PG_CONFIG, database: "postgres" });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE ${DATABASE_IDENTIFIER}`);
  } finally {
    await admin.end();
  }
});

beforeEach(async () => {
  await pool.query("TRUNCATE TABLE users CASCADE");
});

describe("产物版本发布", () => {
  it("发布成功后保留文件快照、可列出版本并可在附件软删后查询版本文件", async () => {
    const seeded = await seedRequirement();
    const attachment = await createAttachment(seeded.requirementId, seeded.actorId, "prd.md");
    const beforePublish = await requirementWriteState(seeded.requirementId);

    const result = await service.publish(seeded.actorId, seeded.requirementId, {
      operationKey: "publish-success",
      attachmentIds: [attachment.id],
      note: "首版 PRD",
    });

    expect(result).toMatchObject({
      projectId: seeded.projectId,
      requirementVersion: 1,
      artifactVersion: {
        requirementId: seeded.requirementId,
        versionNumber: 1,
        fileCount: 1,
        publishedBy: { id: seeded.actorId, displayName: "PM" },
        files: [{ attachmentId: attachment.id, fileName: "prd.md", sizeBytes: 13, sha256: SHA256 }],
      },
    });
    const afterPublish = await requirementWriteState(seeded.requirementId);
    expect(afterPublish).toMatchObject({ version: beforePublish.version, updated_by: seeded.actorId });
    expect(afterPublish.updated_at.getTime()).toBeGreaterThanOrEqual(beforePublish.updated_at.getTime());
    await expect(service.list(seeded.requirementId)).resolves.toEqual({
      items: [
        expect.objectContaining({
          id: result.artifactVersion.id,
          versionNumber: 1,
          fileCount: 1,
        }),
      ],
    });
    await expect(service.getDetail(result.artifactVersion.id)).resolves.toMatchObject({
      ...result.artifactVersion,
      files: [expect.objectContaining({ attachmentId: attachment.id })],
    });
    await pool.query(
      "UPDATE attachments SET deleted_at = now(), deleted_by = $1 WHERE id = $2",
      [seeded.actorId, attachment.id],
    );
    await expect(
      repository.getVersionFileForDownload(
        result.artifactVersion.id,
        result.artifactVersion.files[0]!.id,
      ),
    ).resolves.toMatchObject({
      attachmentId: attachment.id,
      storageKey: attachment.storageKey,
      fileName: "prd.md",
    });
    await expect(repository.referencedStorageKeys()).resolves.toEqual(
      new Set([attachment.storageKey]),
    );

    const comment = await pool.query<{
      artifact_version_id: string;
      body: string;
    }>(
      "SELECT artifact_version_id, body FROM requirement_comments WHERE requirement_id = $1",
      [seeded.requirementId],
    );
    expect(comment.rows).toEqual([
      { artifact_version_id: result.artifactVersion.id, body: "首版 PRD" },
    ]);
    await expect(publicationCounts()).resolves.toEqual({
      versions: 1,
      files: 1,
      comments: 1,
      audits: 1,
      operations: 1,
    });
  });

  it("相同 operationKey 和请求摘要重放原响应且不新增记录、不 touch", async () => {
    const seeded = await seedRequirement();
    const attachment = await createAttachment(seeded.requirementId, seeded.actorId, "plan.md");
    const request = {
      operationKey: "publish-replay",
      attachmentIds: [attachment.id],
      note: "发布计划",
    };

    const first = await service.publish(seeded.actorId, seeded.requirementId, request);
    const afterFirst = await requirementWriteState(seeded.requirementId);
    const replayed = await service.publish(seeded.actorId, seeded.requirementId, request);

    expect(replayed).toEqual(first);
    expect(await requirementWriteState(seeded.requirementId)).toEqual(afterFirst);
    await expect(publicationCounts()).resolves.toEqual({
      versions: 1,
      files: 1,
      comments: 1,
      audits: 1,
      operations: 1,
    });
  });

  it("同 operationKey 的不同请求仍返回 VALIDATION_ERROR", async () => {
    const seeded = await seedRequirement();
    const firstAttachment = await createAttachment(seeded.requirementId, seeded.actorId, "first.md");
    const secondAttachment = await createAttachment(seeded.requirementId, seeded.actorId, "second.md");

    await service.publish(seeded.actorId, seeded.requirementId, {
      operationKey: "publish-reused-key",
      attachmentIds: [firstAttachment.id],
    });

    await expect(
      service.publish(seeded.actorId, seeded.requirementId, {
        operationKey: "publish-reused-key",
        attachmentIds: [secondAttachment.id],
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "VALIDATION_ERROR" });
    await expect(publicationCounts()).resolves.toEqual({
      versions: 1,
      files: 1,
      comments: 1,
      audits: 1,
      operations: 1,
    });
  });

  it("跨需求和已软删 attachmentId 都以 400 拒绝", async () => {
    const seeded = await seedRequirement();
    const otherRequirementId = await createRequirement(seeded.projectId, seeded.actorId, "其他需求");
    const foreignAttachment = await createAttachment(otherRequirementId, seeded.actorId, "foreign.md");
    const deletedAttachment = await createAttachment(seeded.requirementId, seeded.actorId, "deleted.md");
    await pool.query(
      "UPDATE attachments SET deleted_at = now(), deleted_by = $1 WHERE id = $2",
      [seeded.actorId, deletedAttachment.id],
    );

    await expect(
      service.publish(seeded.actorId, seeded.requirementId, {
        operationKey: "publish-foreign",
        attachmentIds: [foreignAttachment.id],
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "ATTACHMENT_INVALID" });
    await expect(
      service.publish(seeded.actorId, seeded.requirementId, {
        operationKey: "publish-deleted",
        attachmentIds: [deletedAttachment.id],
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "ATTACHMENT_INVALID" });
    await expect(publicationCounts()).resolves.toEqual({
      versions: 0,
      files: 0,
      comments: 0,
      audits: 0,
      operations: 0,
    });
  });

  it("未填写说明时仍落系统生成的发布评论", async () => {
    const seeded = await seedRequirement();
    const attachment = await createAttachment(seeded.requirementId, seeded.actorId, "without-note.md");

    const result = await service.publish(seeded.actorId, seeded.requirementId, {
      operationKey: "publish-system-note",
      attachmentIds: [attachment.id],
    });

    const comment = await pool.query<{
      body: string;
      artifact_version_id: string;
      system_kind: string | null;
      system_params: unknown;
    }>(
      "SELECT body, artifact_version_id, system_kind, system_params FROM requirement_comments WHERE requirement_id = $1",
      [seeded.requirementId],
    );
    expect(comment.rows).toEqual([
      {
        body: "Published confirmed version 1 with 1 file.",
        artifact_version_id: result.artifactVersion.id,
        system_kind: "artifact_published",
        system_params: { versionNumber: 1, fileCount: 1 },
      },
    ]);
  });

  it("填写了说明时评论就是说明本身，不带系统类型", async () => {
    const seeded = await seedRequirement();
    const attachment = await createAttachment(seeded.requirementId, seeded.actorId, "with-note.md");

    await service.publish(seeded.actorId, seeded.requirementId, {
      operationKey: "publish-user-note",
      attachmentIds: [attachment.id],
      note: "Published confirmed version 1 with 1 file.",
    });

    const comment = await pool.query<{ body: string; system_kind: string | null }>(
      "SELECT body, system_kind FROM requirement_comments WHERE requirement_id = $1",
      [seeded.requirementId],
    );
    expect(comment.rows).toEqual([{ body: "Published confirmed version 1 with 1 file.", system_kind: null }]);
  });

  it("单版本超过 50 个文件时拒绝且不创建记录", async () => {
    const seeded = await seedRequirement();
    const attachments = await Promise.all(
      Array.from({ length: 51 }, (_, index) =>
        createAttachment(seeded.requirementId, seeded.actorId, `file-${index}.md`),
      ),
    );

    await expect(
      service.publish(seeded.actorId, seeded.requirementId, {
        operationKey: "publish-too-many-files",
        attachmentIds: attachments.map((attachment) => attachment.id),
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "ATTACHMENT_INVALID" });
    await expect(publicationCounts()).resolves.toEqual({
      versions: 0,
      files: 0,
      comments: 0,
      audits: 0,
      operations: 0,
    });
  });

  it("并行发布同一需求时版本号连续且不重复", async () => {
    const seeded = await seedRequirement();
    const attachment = await createAttachment(seeded.requirementId, seeded.actorId, "concurrent.md");
    const parallelCount = 6;

    const published = await Promise.all(
      Array.from({ length: parallelCount }, (_, index) =>
        service.publish(seeded.actorId, seeded.requirementId, {
          operationKey: `publish-concurrent-${index}`,
          attachmentIds: [attachment.id],
        }),
      ),
    );

    expect(published.map((result) => result.artifactVersion.versionNumber).sort((a, b) => a - b))
      .toEqual([1, 2, 3, 4, 5, 6]);
    const stored = await pool.query<{ version_number: number }>(
      `
        SELECT version_number
        FROM requirement_artifact_versions
        WHERE requirement_id = $1
        ORDER BY version_number ASC
      `,
      [seeded.requirementId],
    );
    expect(stored.rows.map((row) => row.version_number)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("活跃附件上限允许第 100 个并拒绝第 101 个", async () => {
    const seeded = await seedRequirement();
    const attachments = new AttachmentRepository(
      new Database(pool),
      REQUIREMENTS_SERVICE_MAX_ACTIVE_ATTACHMENTS_PER_REQUIREMENT,
    );

    for (let index = 0;
      index < REQUIREMENTS_SERVICE_MAX_ACTIVE_ATTACHMENTS_PER_REQUIREMENT - 1;
      index += 1) {
      await createAttachment(seeded.requirementId, seeded.actorId, `capacity-${index}.md`);
    }
    await expect(attachments.assertCanUpload(seeded.requirementId)).resolves.toBeUndefined();

    await createAttachment(seeded.requirementId, seeded.actorId, "capacity-100.md");
    await expect(attachments.assertCanUpload(seeded.requirementId)).rejects.toMatchObject({
      statusCode: 409,
      code: "ATTACHMENT_INVALID",
      details: {
        maxAttachments: REQUIREMENTS_SERVICE_MAX_ACTIVE_ATTACHMENTS_PER_REQUIREMENT,
      },
    });
  });
});

async function seedRequirement(): Promise<{
  actorId: string;
  projectId: string;
  requirementId: string;
}> {
  const actorId = randomUUID();
  const projectId = randomUUID();
  const requirementId = await createRequirement(projectId, actorId, "发布需求", true);
  return { actorId, projectId, requirementId };
}

async function createRequirement(
  projectId: string,
  actorId: string,
  title: string,
  createProject = false,
): Promise<string> {
  if (createProject) {
    await pool.query(
      `
        INSERT INTO users (id, login_name, display_name, password_hash)
        VALUES ($1, 'pm-user', 'PM', 'test-password-hash')
      `,
      [actorId],
    );
    await pool.query(
      `
        INSERT INTO projects (id, name, created_by, updated_by)
        VALUES ($1, '产物版本测试项目', $2, $2)
      `,
      [projectId, actorId],
    );
  }
  const requirementId = randomUUID();
  await pool.query(
    `
      WITH allocation AS (
        UPDATE projects
        SET next_requirement_number = next_requirement_number + 1
        WHERE id = $2
        RETURNING next_requirement_number - 1 AS number
      )
      INSERT INTO requirements (
        id, project_id, number, title, summary, status, created_by, updated_by
      )
      SELECT $1, $2, allocation.number, $3, '测试需求摘要', 'draft', $4, $4
      FROM allocation
    `,
    [requirementId, projectId, title, actorId],
  );
  return requirementId;
}

async function createAttachment(
  requirementId: string,
  actorId: string,
  fileName: string,
): Promise<{ id: string; storageKey: string }> {
  const id = randomUUID();
  const storageKey = `objects/${id.slice(0, 2)}/${id}`;
  await pool.query(
    `
      INSERT INTO attachments (
        id, requirement_id, storage_key, file_name, content_type,
        size_bytes, sha256, uploaded_by
      ) VALUES ($1, $2, $3, $4, 'text/markdown', 13, $5, $6)
    `,
    [id, requirementId, storageKey, fileName, SHA256, actorId],
  );
  return { id, storageKey };
}

async function publicationCounts(): Promise<{
  versions: number;
  files: number;
  comments: number;
  audits: number;
  operations: number;
}> {
  const result = await pool.query<{
    versions: string;
    files: string;
    comments: string;
    audits: string;
    operations: string;
  }>(`
    SELECT
      (SELECT COUNT(*)::text FROM requirement_artifact_versions) AS versions,
      (SELECT COUNT(*)::text FROM requirement_artifact_version_files) AS files,
      (SELECT COUNT(*)::text FROM requirement_comments) AS comments,
      (SELECT COUNT(*)::text FROM audit_logs WHERE resource_type = 'artifact_version') AS audits,
      (SELECT COUNT(*)::text FROM requirement_publish_operations) AS operations
  `);
  const row = result.rows[0];
  if (row === undefined) throw new Error("无法统计发布记录");
  return {
    versions: Number(row.versions),
    files: Number(row.files),
    comments: Number(row.comments),
    audits: Number(row.audits),
    operations: Number(row.operations),
  };
}

async function requirementWriteState(requirementId: string): Promise<{
  version: number;
  updated_at: Date;
  updated_by: string;
}> {
  const result = await pool.query<{
    version: number;
    updated_at: Date;
    updated_by: string;
  }>(
    "SELECT version, updated_at, updated_by FROM requirements WHERE id = $1",
    [requirementId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("需求不存在");
  return row;
}

function quotedIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(value)) {
    throw new Error("临时 PostgreSQL 数据库名无效");
  }
  return `"${value}"`;
}
