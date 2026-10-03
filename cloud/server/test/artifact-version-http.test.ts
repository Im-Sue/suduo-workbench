import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client, Pool } from "pg";
import type {
  ArtifactVersionDetailDto,
  ListArtifactVersionsResponse,
  ListCommentsResponse,
  ListRequirementActivityResponse,
  RequirementsEventDto,
} from "@suduo/cloud-contracts";
import { ArtifactVersionService } from "../src/application/artifact-version-service.js";
import type { AttachmentService } from "../src/application/attachment-service.js";
import type { AuthService } from "../src/application/auth-service.js";
import { CollaborationService } from "../src/application/collaboration-service.js";
import { RequirementsEventHub } from "../src/application/event-hub.js";
import type { RequirementsServiceConfig } from "../src/config.js";
import { buildHttpServer } from "../src/http/server.js";
import { Database } from "../src/infrastructure/database.js";
import type { AttachmentStorage } from "../src/infrastructure/attachment-storage.js";
import { ArtifactVersionRepository } from "../src/infrastructure/artifact-version-repository.js";
import { CollaborationRepository } from "../src/infrastructure/collaboration-repository.js";
import { runMigrations } from "../src/infrastructure/migration-runner.js";
import { ignoreTerminatedConnections } from "./pg-test-support.js";

const FILE_CONTENT = Buffer.from("published material");
const FILE_SHA256 = createHash("sha256").update(FILE_CONTENT).digest("hex");
const TEST_DATABASE = process.env["SUDUO_ARTIFACT_VERSION_HTTP_TEST_DB"] ??
  `suduo_artifact_http_${randomUUID().replaceAll("-", "")}`;
const DATABASE_IDENTIFIER = quotedIdentifier(TEST_DATABASE);
const PG_CONFIG = {
  host: "127.0.0.1",
  port: 15_432,
  user: "suduo",
};

let pool: Pool;
let server: Awaited<ReturnType<typeof buildHttpServer>>;
let storage: { open: ReturnType<typeof vi.fn> };
let publishedEvents: RequirementsEventDto[];
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

  storage = { open: vi.fn() };
  publishedEvents = [];
  const events = new RequirementsEventHub();
  events.subscribe((event) => publishedEvents.push(event));
  const database = new Database(pool);
  server = await buildHttpServer({
    config: testConfig(),
    database,
    auth: {} as AuthService,
    collaboration: new CollaborationService(new CollaborationRepository(database)),
    attachments: { close: vi.fn().mockResolvedValue(undefined) } as unknown as AttachmentService,
    artifactVersions: new ArtifactVersionService(new ArtifactVersionRepository(database)),
    attachmentStorage: storage as unknown as AttachmentStorage,
    events,
  });
});

afterAll(async () => {
  await server?.close();
  await pool?.end();
  if (!databaseCreated) return;
  const admin = new Client({ ...PG_CONFIG, database: "postgres" });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE ${DATABASE_IDENTIFIER} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
});

beforeEach(async () => {
  await pool.query("TRUNCATE TABLE users CASCADE");
  storage.open.mockReset();
  publishedEvents = [];
});

describe("产物版本 HTTP 路由", () => {
  it("发布后可按版本号倒序列表，并读取版本详情和文件清单", async () => {
    const seeded = await seedRequirement();
    const attachment = await createAttachment(seeded.requirementId, seeded.actorId, "prd.md");

    const first = await publish(seeded.actorId, seeded.requirementId, {
      operationKey: "http-publish-v1",
      attachmentIds: [attachment.id],
      note: "第一版",
    });
    const second = await publish(seeded.actorId, seeded.requirementId, {
      operationKey: "http-publish-v2",
      attachmentIds: [attachment.id],
      note: "第二版",
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    const firstBody = first.json<ArtifactVersionDetailDto>();
    const secondBody = second.json<ArtifactVersionDetailDto>();
    expect(secondBody).toMatchObject({
      requirementId: seeded.requirementId,
      versionNumber: 2,
      files: [{ attachmentId: attachment.id, fileName: "prd.md" }],
    });

    const listed = await server.inject({
      method: "GET",
      url: `/v2/requirements/${seeded.requirementId}/artifact-versions`,
      headers: authorization(seeded.actorId),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<ListArtifactVersionsResponse>().items.map((item) => item.versionNumber))
      .toEqual([2, 1]);

    const detail = await server.inject({
      method: "GET",
      url: `/v2/artifact-versions/${secondBody.id}`,
      headers: authorization(seeded.actorId),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json<ArtifactVersionDetailDto>()).toMatchObject({
      id: secondBody.id,
      files: [{ attachmentId: attachment.id, sha256: FILE_SHA256 }],
    });
    expect(firstBody.versionNumber).toBe(1);
    expect(publishedEvents).toEqual([
      expect.objectContaining({
        type: "artifact.published",
        projectId: seeded.projectId,
        requirementId: seeded.requirementId,
        requirementVersion: 1,
      }),
      expect.objectContaining({
        type: "artifact.published",
        projectId: seeded.projectId,
        requirementId: seeded.requirementId,
        requirementVersion: 1,
      }),
    ]);
  });

  it("下载路由从版本文件快照打开存储对象，不受附件软删影响", async () => {
    const seeded = await seedRequirement();
    const attachment = await createAttachment(seeded.requirementId, seeded.actorId, "published.md");
    const published = await publish(seeded.actorId, seeded.requirementId, {
      operationKey: "http-download",
      attachmentIds: [attachment.id],
    });
    const version = published.json<ArtifactVersionDetailDto>();
    await pool.query(
      "UPDATE attachments SET deleted_at = now(), deleted_by = $1 WHERE id = $2",
      [seeded.actorId, attachment.id],
    );
    storage.open.mockResolvedValue(Readable.from([FILE_CONTENT]));

    const response = await server.inject({
      method: "GET",
      url: `/v2/artifact-versions/${version.id}/files/${version.files[0]!.id}/content`,
      headers: authorization(seeded.actorId),
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(FILE_CONTENT.toString("utf8"));
    expect(response.headers["content-length"]).toBe(String(FILE_CONTENT.byteLength));
    expect(response.headers["x-attachment-sha256"]).toBe(FILE_SHA256);
    expect(response.headers["content-disposition"]).toContain("published.md");
    expect(storage.open).toHaveBeenCalledWith(attachment.storageKey);
  });

  it("带过期 expectedVersion 与不带该字段的发布经 HTTP 均返回 201", async () => {
    const seeded = await seedRequirement();
    const attachment = await createAttachment(seeded.requirementId, seeded.actorId, "stale.md");

    const legacy = await publish(seeded.actorId, seeded.requirementId, {
      expectedVersion: 999,
      operationKey: "http-legacy-field",
      attachmentIds: [attachment.id],
    });
    const current = await publish(seeded.actorId, seeded.requirementId, {
      operationKey: "http-no-legacy-field",
      attachmentIds: [attachment.id],
    });

    expect(legacy.statusCode).toBe(201);
    expect(current.statusCode).toBe(201);
  });

  it("跨需求 attachmentId 经 HTTP 返回 400 ATTACHMENT_INVALID", async () => {
    const seeded = await seedRequirement();
    const otherRequirementId = await createRequirement(
      seeded.projectId,
      seeded.actorId,
      "其他需求",
    );
    const foreignAttachment = await createAttachment(
      otherRequirementId,
      seeded.actorId,
      "foreign.md",
    );

    const response = await publish(seeded.actorId, seeded.requirementId, {
      operationKey: "http-foreign",
      attachmentIds: [foreignAttachment.id],
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "ATTACHMENT_INVALID" } });
  });

  it("评论列表返回 artifactVersionId，审计列表可查 artifact_version 发布记录", async () => {
    const seeded = await seedRequirement();
    const attachment = await createAttachment(seeded.requirementId, seeded.actorId, "traceable.md");
    const published = await publish(seeded.actorId, seeded.requirementId, {
      operationKey: "http-comment-and-audit",
      attachmentIds: [attachment.id],
    });
    const version = published.json<ArtifactVersionDetailDto>();

    const comments = await server.inject({
      method: "GET",
      url: `/v2/requirements/${seeded.requirementId}/comments`,
      headers: authorization(seeded.actorId),
    });
    expect(comments.statusCode).toBe(200);
    expect(comments.json<{ items: Array<{ artifactVersionId: string | null }> }>().items
      .map((comment) => ({ artifactVersionId: comment.artifactVersionId })))
      .toEqual([{ artifactVersionId: version.id }]);

    const audit = await server.inject({
      method: "GET",
      url: `/v2/audit?resourceType=artifact_version&resourceId=${version.id}`,
      headers: authorization(seeded.actorId),
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json<{
      items: Array<{ resourceType: string; resourceId: string; action: string }>;
    }>().items.map((entry) => ({
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      action: entry.action,
    }))).toEqual([
      {
        resourceType: "artifact_version",
        resourceId: version.id,
        action: "artifact_version.published",
      },
    ]);
  });

  it("系统代写的评论带出类型与参数；活动流按类型判断有没有说明，不比较正文", async () => {
    const seeded = await seedRequirement();
    const attachment = await createAttachment(seeded.requirementId, seeded.actorId, "prd.md");
    const withoutNote = await publish(seeded.actorId, seeded.requirementId, {
      operationKey: "http-system-comment-v1",
      attachmentIds: [attachment.id],
    });
    // 用户手写的说明恰好和系统句式一样：它仍是用户的说明。
    const sameAsSystem = await publish(seeded.actorId, seeded.requirementId, {
      operationKey: "http-system-comment-v2",
      attachmentIds: [attachment.id],
      note: "发布了产物 v2，含 1 个文件。",
    });
    const v1 = withoutNote.json<ArtifactVersionDetailDto>().id;
    const v2 = sameAsSystem.json<ArtifactVersionDetailDto>().id;

    const comments = await server.inject({
      method: "GET",
      url: `/v2/requirements/${seeded.requirementId}/comments`,
      headers: authorization(seeded.actorId),
    });
    const items = comments.json<ListCommentsResponse>().items;
    expect(items.find((item) => item.artifactVersionId === v1)).toMatchObject({
      body: "发布了产物 v1，含 1 个文件。",
      system: { kind: "artifact_published", params: { versionNumber: 1, fileCount: 1 } },
    });
    expect(items.find((item) => item.artifactVersionId === v2)).not.toHaveProperty("system");

    const activity = await server.inject({
      method: "GET",
      url: `/v2/requirements/${seeded.requirementId}/activity`,
      headers: authorization(seeded.actorId),
    });
    const published = activity.json<ListRequirementActivityResponse>().items
      .filter((item) => item.action === "artifact_version.published")
      .map((item) => item.artifactVersion);
    expect(published).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: v1, note: null }),
      expect.objectContaining({ id: v2, note: "发布了产物 v2，含 1 个文件。" }),
    ]));
  });
});

function publish(
  actorId: string,
  requirementId: string,
  payload: {
    operationKey: string;
    attachmentIds: string[];
    note?: string;
    expectedVersion?: number;
  },
) {
  return server.inject({
    method: "POST",
    url: `/v2/requirements/${requirementId}/artifact-versions`,
    headers: authorization(actorId),
    payload,
  });
}

function authorization(actorId: string): { authorization: string } {
  return {
    authorization: `Bearer ${server.jwt.sign({ sub: actorId, loginName: "pm-user" })}`,
  };
}

async function seedRequirement(): Promise<{
  actorId: string;
  projectId: string;
  requirementId: string;
}> {
  const actorId = randomUUID();
  const projectId = randomUUID();
  const requirementId = await createRequirement(projectId, actorId, "产物需求", true);
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
        VALUES ($1, '产物版本 HTTP 测试项目', $2, $2)
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
      ) VALUES ($1, $2, $3, $4, 'text/markdown', $5, $6, $7)
    `,
    [
      id,
      requirementId,
      storageKey,
      fileName,
      FILE_CONTENT.byteLength,
      FILE_SHA256,
      actorId,
    ],
  );
  return { id, storageKey };
}

function testConfig(): RequirementsServiceConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    databaseUrl: "postgresql://unused",
    databasePoolMax: 2,
    databaseConnectionTimeoutMs: 100,
    authSecret: "pr4-http-test-secret-at-least-thirty-two-characters",
    authTtlSeconds: 3_600,
    authIssuer: "suduo-requirements-service",
    authAudience: "suduo-local-bff",
    attachmentRoot: "/tmp/suduo-pr4-http-test-unused",
    maxAttachmentBytes: 314_572_800,
    maxAttachmentsPerRequirement: 20,
    allowedAttachmentExtensions: new Set([".md"]),
    runMigrations: false,
    logger: false,
  };
}

function quotedIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(value)) {
    throw new Error("临时 PostgreSQL 数据库名无效");
  }
  return `"${value}"`;
}
