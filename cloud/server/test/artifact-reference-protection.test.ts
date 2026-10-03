import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client, Pool } from "pg";
import {
  REQUIREMENTS_SERVICE_MAX_ACTIVE_ATTACHMENTS_PER_REQUIREMENT,
} from "@suduo/cloud-contracts";
import { AttachmentService } from "../src/application/attachment-service.js";
import { ArtifactVersionService } from "../src/application/artifact-version-service.js";
import { Database } from "../src/infrastructure/database.js";
import { AttachmentRepository } from "../src/infrastructure/attachment-repository.js";
import { AttachmentStorage } from "../src/infrastructure/attachment-storage.js";
import { ArtifactVersionRepository } from "../src/infrastructure/artifact-version-repository.js";
import { runMigrations } from "../src/infrastructure/migration-runner.js";
import { ignoreTerminatedConnections } from "./pg-test-support.js";

const FILE_CONTENT = Buffer.from("published artifact bytes\n");
const TEST_DATABASE = process.env["SUDUO_ARTIFACT_REFERENCE_TEST_DB"] ??
  `suduo_artifact_reference_${randomUUID().replaceAll("-", "")}`;
const DATABASE_IDENTIFIER = quotedIdentifier(TEST_DATABASE);
const PG_CONFIG = {
  host: "127.0.0.1",
  port: 15_432,
  user: "suduo",
};

let pool: Pool;
let database: Database;
let artifactRepository: ArtifactVersionRepository;
let artifactVersions: ArtifactVersionService;
let attachments: AttachmentService;
let storage: AttachmentStorage;
let storageRoot: string;
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
  database = new Database(pool);
  artifactRepository = new ArtifactVersionRepository(database);
  artifactVersions = new ArtifactVersionService(artifactRepository);
});

afterAll(async () => {
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
  storageRoot = await mkdtemp(join(tmpdir(), "suduo-pr4-reference-"));
  storage = new AttachmentStorage(storageRoot, 1_024, new Set([".md"]));
  attachments = new AttachmentService(
    new AttachmentRepository(
      database,
      REQUIREMENTS_SERVICE_MAX_ACTIVE_ATTACHMENTS_PER_REQUIREMENT,
    ),
    storage,
    artifactRepository,
  );
  await attachments.initialize();
});

afterEach(async () => {
  await attachments?.close().catch(() => undefined);
  await rm(storageRoot, { recursive: true, force: true }).catch(() => undefined);
});

describe("产物版本引用保护", () => {
  it("红线一：软删已发布附件后，版本文件仍可下载且字节一致", async () => {
    const seeded = await seedRequirement();
    const uploaded = await uploadAttachment(seeded);
    const published = await artifactVersions.publish(seeded.actorId, seeded.requirementId, {
      operationKey: "reference-redline-download",
      attachmentIds: [uploaded.attachment.id],
    });

    const deleted = await attachments.delete(
      seeded.actorId,
      uploaded.attachment.id,
    );
    const versionFile = await artifactVersions.getFileForDownload(
      published.artifactVersion.id,
      published.artifactVersion.files[0]!.id,
    );

    expect(deleted.cleanupFailed).toBe(false);
    await expect(readStream(await storage.open(versionFile.storageKey))).resolves.toEqual(FILE_CONTENT);
    expect(versionFile.storageKey).toBe(uploaded.storageKey);
  });

  it("红线二：软删后重启运行 reconcile，版本引用的 blob 仍存在", async () => {
    const seeded = await seedRequirement();
    const uploaded = await uploadAttachment(seeded);
    await artifactVersions.publish(seeded.actorId, seeded.requirementId, {
      operationKey: "reference-redline-reconcile",
      attachmentIds: [uploaded.attachment.id],
    });
    await attachments.delete(
      seeded.actorId,
      uploaded.attachment.id,
    );

    await attachments.close();
    attachments = new AttachmentService(
      new AttachmentRepository(
        database,
        REQUIREMENTS_SERVICE_MAX_ACTIVE_ATTACHMENTS_PER_REQUIREMENT,
      ),
      storage,
      artifactRepository,
    );
    await attachments.initialize();

    await expect(readStream(await storage.open(uploaded.storageKey))).resolves.toEqual(FILE_CONTENT);
    await expect(artifactRepository.referencedStorageKeys()).resolves.toEqual(
      new Set([uploaded.storageKey]),
    );
  });
});

async function seedRequirement(): Promise<{
  actorId: string;
  projectId: string;
  requirementId: string;
}> {
  const actorId = randomUUID();
  const projectId = randomUUID();
  const requirementId = randomUUID();
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
      VALUES ($1, '产物版本引用保护测试', $2, $2)
    `,
    [projectId, actorId],
  );
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
      SELECT $1, $2, allocation.number, '产物需求', '测试需求摘要', 'draft', $3, $3
      FROM allocation
    `,
    [requirementId, projectId, actorId],
  );
  return { actorId, projectId, requirementId };
}

async function uploadAttachment(input: {
  actorId: string;
  requirementId: string;
}): Promise<{
  attachment: { id: string };
  storageKey: string;
  requirementVersion: number;
}> {
  return attachments.upload({
    actorId: input.actorId,
    attachmentId: randomUUID(),
    requirementId: input.requirementId,
    stream: chunks(FILE_CONTENT),
    fileName: "published.md",
    contentType: "text/markdown",
    declaredSize: FILE_CONTENT.byteLength,
  });
}

async function* chunks(...values: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const value of values) yield value;
}

async function readStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const value of stream) chunks.push(Buffer.from(value));
  return Buffer.concat(chunks);
}

function quotedIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(value)) {
    throw new Error("临时 PostgreSQL 数据库名无效");
  }
  return `"${value}"`;
}
