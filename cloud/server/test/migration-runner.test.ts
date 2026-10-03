import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Client, Pool } from "pg";
import { runMigrations } from "../src/infrastructure/migration-runner.js";
import { ignoreTerminatedConnections } from "./pg-test-support.js";

const PG_CONFIG = {
  host: "127.0.0.1",
  port: 15_432,
  user: "suduo",
};
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL("../migrations/", import.meta.url));
const VERSION_005 = "005_audit_project_id.sql";
const VERSION_006 = "006_requirement_number_assignee.sql";
const VERSION_007 = "007_audit_requirement_id.sql";
const VERSION_008 = "008_audit_created_at_clock_timestamp.sql";
const VERSION_009 = "009_requirement_reads.sql";
const VERSION_010 = "010_comment_created_at_clock_timestamp.sql";
const VERSION_011 = "011_rooms_and_shared_agents.sql";
const VERSION_012 = "012_i18n_structured_texts.sql";
const LATEST_VERSION = VERSION_012;
const LEGACY_MIGRATIONS = [
  "001_initial.sql",
  "002_attachments.sql",
  "003_requirement_status_in_refinement.sql",
  "004_requirement_artifact_versions.sql",
];
const ALL_MIGRATIONS = [
  ...LEGACY_MIGRATIONS,
  VERSION_005,
  VERSION_006,
  VERSION_007,
  VERSION_008,
  VERSION_009,
  VERSION_010,
  VERSION_011,
  VERSION_012,
];

describe("迁移 005 审计项目归属", () => {
  it("全新库可完整应用全部迁移", async () => {
    await withTemporaryDatabase(async (pool) => {
      await expect(runMigrations(pool)).resolves.toBe(LATEST_VERSION);
      const applied = await appliedVersions(pool);
      expect(applied.map((migration) => migration.version)).toEqual(ALL_MIGRATIONS);
      await expect(pool.query(`
        SELECT 1
        FROM requirement_artifact_versions
        JOIN requirement_artifact_version_files ON false
        JOIN requirement_publish_operations ON false
      `)).resolves.toBeDefined();
    });
  });

  it("已应用 001 至 004 的库可增量应用 005 至 007，且既有 checksum 不漂移", async () => {
    const legacyDirectory = await legacyMigrationsDirectory(LEGACY_MIGRATIONS);
    try {
      await withTemporaryDatabase(async (pool) => {
        await expect(runMigrations(pool, legacyDirectory)).resolves.toBe(
          "004_requirement_artifact_versions.sql",
        );
        await expect(runMigrations(pool)).resolves.toBe(LATEST_VERSION);

        const applied = await appliedVersions(pool);
        expect(applied.map((migration) => migration.version)).toEqual(ALL_MIGRATIONS);
        for (const migration of applied) {
          expect(migration.checksum).toBe(await migrationChecksum(migration.version));
        }
      });
    } finally {
      await rm(legacyDirectory, { recursive: true, force: true });
    }
  });

  it("回填五种历史审计记录，并逐条与 join 推导的项目、需求一致", async () => {
    const legacyDirectory = await legacyMigrationsDirectory(LEGACY_MIGRATIONS);
    try {
      await withTemporaryDatabase(async (pool) => {
        await expect(runMigrations(pool, legacyDirectory)).resolves.toBe(
          "004_requirement_artifact_versions.sql",
        );
        const seeded = await seedHistoricalAudits(pool);

        await expect(runMigrations(pool)).resolves.toBe(LATEST_VERSION);

        const rows = await pool.query<{
          id: string;
          resource_type: string;
          project_id: string;
          expected_project_id: string;
        }>(
          `
            SELECT
              audit.id,
              audit.resource_type,
              audit.project_id,
              CASE audit.resource_type
                WHEN 'project' THEN audit.resource_id
                WHEN 'requirement' THEN requirement.project_id
                WHEN 'comment' THEN comment_requirement.project_id
                WHEN 'attachment' THEN attachment_requirement.project_id
                WHEN 'artifact_version' THEN artifact_requirement.project_id
              END AS expected_project_id
            FROM audit_logs AS audit
            LEFT JOIN requirements AS requirement
              ON audit.resource_type = 'requirement' AND audit.resource_id = requirement.id
            LEFT JOIN requirement_comments AS comment
              ON audit.resource_type = 'comment' AND audit.resource_id = comment.id
            LEFT JOIN requirements AS comment_requirement
              ON comment_requirement.id = comment.requirement_id
            LEFT JOIN attachments AS attachment
              ON audit.resource_type = 'attachment' AND audit.resource_id = attachment.id
            LEFT JOIN requirements AS attachment_requirement
              ON attachment_requirement.id = attachment.requirement_id
            LEFT JOIN requirement_artifact_versions AS artifact_version
              ON audit.resource_type = 'artifact_version' AND audit.resource_id = artifact_version.id
            LEFT JOIN requirements AS artifact_requirement
              ON artifact_requirement.id = artifact_version.requirement_id
            WHERE audit.id = ANY($1::uuid[])
            ORDER BY audit.resource_type ASC
          `,
          [seeded.auditIds],
        );

        expect(rows.rows).toHaveLength(5);
        expect(rows.rows.map((row) => row.resource_type)).toEqual([
          "artifact_version",
          "attachment",
          "comment",
          "project",
          "requirement",
        ]);
        for (const row of rows.rows) {
          expect(row.project_id).toBe(seeded.projectId);
          expect(row.project_id).toBe(row.expected_project_id);
        }
        await expect(pool.query(
          "SELECT to_regclass('audit_logs_project_created_cursor_idx') AS index_name",
        )).resolves.toMatchObject({
          rows: [{ index_name: "audit_logs_project_created_cursor_idx" }],
        });

        // 007：项目级审计 requirement_id 为空，其余四类回填为所属需求。
        const requirementScopes = await pool.query<{
          resource_type: string;
          requirement_id: string | null;
        }>(
          `
            SELECT resource_type, requirement_id
            FROM audit_logs
            WHERE id = ANY($1::uuid[])
            ORDER BY resource_type ASC
          `,
          [seeded.auditIds],
        );
        expect(requirementScopes.rows).toEqual([
          { resource_type: "artifact_version", requirement_id: seeded.requirementId },
          { resource_type: "attachment", requirement_id: seeded.requirementId },
          { resource_type: "comment", requirement_id: seeded.requirementId },
          { resource_type: "project", requirement_id: null },
          { resource_type: "requirement", requirement_id: seeded.requirementId },
        ]);
        await expect(pool.query(
          "SELECT to_regclass('audit_logs_requirement_created_cursor_idx') AS index_name",
        )).resolves.toMatchObject({
          rows: [{ index_name: "audit_logs_requirement_created_cursor_idx" }],
        });
      });
    } finally {
      await rm(legacyDirectory, { recursive: true, force: true });
    }
  });
});

describe("迁移 006 需求编号与负责人", () => {
  it("按项目、按 created_at, id 回填编号，并把下一个编号设为 max + 1", async () => {
    const legacyDirectory = await legacyMigrationsDirectory([...LEGACY_MIGRATIONS, VERSION_005]);
    try {
      await withTemporaryDatabase(async (pool) => {
        await expect(runMigrations(pool, legacyDirectory)).resolves.toBe(VERSION_005);
        const actorId = randomUUID();
        await pool.query(
          `
            INSERT INTO users (id, login_name, display_name, password_hash)
            VALUES ($1, 'numbering-user', 'Numbering User', 'test-password-hash')
          `,
          [actorId],
        );
        const projectA = await insertLegacyProject(pool, actorId, "项目甲");
        const projectB = await insertLegacyProject(pool, actorId, "项目乙");
        const emptyProject = await insertLegacyProject(pool, actorId, "空项目");
        // 同一时刻创建的两条按 id 升序决定先后。
        const tieLow = "00000000-0000-4000-8000-000000000001";
        const tieHigh = "ffffffff-ffff-4fff-bfff-ffffffffffff";
        const seeded = [
          { id: randomUUID(), projectId: projectA, createdAt: "2026-01-03T00:00:00.000Z" },
          { id: tieHigh, projectId: projectA, createdAt: "2026-01-01T00:00:00.000Z" },
          { id: tieLow, projectId: projectA, createdAt: "2026-01-01T00:00:00.000Z" },
          { id: randomUUID(), projectId: projectB, createdAt: "2026-01-02T00:00:00.000Z" },
        ];
        for (const requirement of seeded) {
          await pool.query(
            `
              INSERT INTO requirements (
                id, project_id, title, summary, status, created_by, updated_by, created_at, updated_at
              ) VALUES ($1, $2, '历史需求', '历史摘要', 'draft', $3, $3, $4, $4)
            `,
            [requirement.id, requirement.projectId, actorId, requirement.createdAt],
          );
        }

        await expect(runMigrations(pool)).resolves.toBe(LATEST_VERSION);

        const numbers = await pool.query<{ id: string; project_id: string; number: number }>(
          "SELECT id, project_id, number FROM requirements ORDER BY project_id, number",
        );
        const byId = new Map(numbers.rows.map((row) => [row.id, row.number]));
        expect(byId.get(tieLow)).toBe(1);
        expect(byId.get(tieHigh)).toBe(2);
        expect(byId.get(seeded[0]!.id)).toBe(3);
        expect(byId.get(seeded[3]!.id)).toBe(1);

        const counters = await pool.query<{ id: string; next_requirement_number: number }>(
          "SELECT id, next_requirement_number FROM projects",
        );
        expect(Object.fromEntries(
          counters.rows.map((row) => [row.id, row.next_requirement_number]),
        )).toEqual({ [projectA]: 4, [projectB]: 2, [emptyProject]: 1 });

        await expect(pool.query(
          `
            INSERT INTO requirements (
              id, project_id, number, title, summary, status, created_by, updated_by
            ) VALUES ($1, $2, 1, '重复编号', '', 'draft', $3, $3)
          `,
          [randomUUID(), projectA, actorId],
        )).rejects.toMatchObject({ constraint: "requirements_project_number_unique" });

        // 描述放宽为可空串；负责人列可写入已存在的用户。
        await expect(pool.query(
          `
            INSERT INTO requirements (
              id, project_id, number, title, summary, status, assignee_id, created_by, updated_by
            ) VALUES ($1, $2, 4, '空描述', '', 'draft', $3, $3, $3)
          `,
          [randomUUID(), projectA, actorId],
        )).resolves.toBeDefined();
        await expect(pool.query(
          "SELECT to_regclass('requirements_project_assignee_idx') AS index_name",
        )).resolves.toMatchObject({
          rows: [{ index_name: "requirements_project_assignee_idx" }],
        });
      });
    } finally {
      await rm(legacyDirectory, { recursive: true, force: true });
    }
  });
});

describe("迁移 012 系统评论存类型与参数", () => {
  it("只回填挂在版本上、且正文逐字等于当时系统句式的评论", async () => {
    const legacyDirectory = await legacyMigrationsDirectory(
      ALL_MIGRATIONS.filter((version) => version !== VERSION_012),
    );
    try {
      await withTemporaryDatabase(async (pool) => {
        await expect(runMigrations(pool, legacyDirectory)).resolves.toBe(VERSION_011);
        const actorId = randomUUID();
        await pool.query(
          `
            INSERT INTO users (id, login_name, display_name, password_hash)
            VALUES ($1, 'publish-user', 'Publish User', 'test-password-hash')
          `,
          [actorId],
        );
        const projectId = await insertLegacyProject(pool, actorId, "发布评论项目");
        const requirementId = randomUUID();
        await pool.query(
          `
            INSERT INTO requirements (
              id, project_id, number, title, summary, status, created_by, updated_by
            ) VALUES ($1, $2, 1, '历史需求', '', 'draft', $3, $3)
          `,
          [requirementId, projectId, actorId],
        );
        const attachmentIds = [randomUUID(), randomUUID()];
        for (const attachmentId of attachmentIds) {
          await pool.query(
            `
              INSERT INTO attachments (
                id, requirement_id, storage_key, file_name, content_type,
                size_bytes, sha256, uploaded_by
              ) VALUES ($1, $2, $3, 'material.md', 'text/markdown', 7, $4, $5)
            `,
            [attachmentId, requirementId, `objects/${attachmentId.slice(0, 2)}/${attachmentId}`, "b".repeat(64), actorId],
          );
        }
        const insertVersion = async (versionNumber: number, files: number, body: string) => {
          const versionId = randomUUID();
          await pool.query(
            `
              INSERT INTO requirement_artifact_versions (id, requirement_id, version_number, published_by)
              VALUES ($1, $2, $3, $4)
            `,
            [versionId, requirementId, versionNumber, actorId],
          );
          for (const attachmentId of attachmentIds.slice(0, files)) {
            await pool.query(
              `
                INSERT INTO requirement_artifact_version_files (
                  id, version_id, attachment_id, file_name, size_bytes, sha256, storage_key
                ) VALUES ($1, $2, $3, 'material.md', 7, $4, $5)
              `,
              [randomUUID(), versionId, attachmentId, "b".repeat(64), `objects/${attachmentId}`],
            );
          }
          const commentId = randomUUID();
          await pool.query(
            `
              INSERT INTO requirement_comments (id, requirement_id, artifact_version_id, body, author_id)
              VALUES ($1, $2, $3, $4, $5)
            `,
            [commentId, requirementId, versionId, body, actorId],
          );
          return commentId;
        };
        const systemComment = await insertVersion(1, 1, "发布了产物 v1，含 1 个文件。");
        const userNote = await insertVersion(2, 2, "按评审意见改了第三节");
        const wrongCount = await insertVersion(3, 1, "发布了产物 v3，含 2 个文件。");
        const plainComment = randomUUID();
        await pool.query(
          `
            INSERT INTO requirement_comments (id, requirement_id, body, author_id)
            VALUES ($1, $2, '发布了产物 v1，含 1 个文件。', $3)
          `,
          [plainComment, requirementId, actorId],
        );

        await expect(runMigrations(pool)).resolves.toBe(LATEST_VERSION);

        const rows = await pool.query<{ id: string; system_kind: string | null; system_params: unknown }>(
          "SELECT id, system_kind, system_params FROM requirement_comments",
        );
        const byId = new Map(rows.rows.map((row) => [row.id, row]));
        expect(byId.get(systemComment)).toMatchObject({
          system_kind: "artifact_published",
          system_params: { versionNumber: 1, fileCount: 1 },
        });
        for (const id of [userNote, wrongCount, plainComment]) {
          expect(byId.get(id)).toMatchObject({ system_kind: null, system_params: null });
        }
      });
    } finally {
      await rm(legacyDirectory, { recursive: true, force: true });
    }
  });
});

async function legacyMigrationsDirectory(migrations: readonly string[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "suduo-migrations-legacy-"));
  await Promise.all(
    migrations.map((migration) => copyFile(
      join(MIGRATIONS_DIRECTORY, migration),
      join(directory, migration),
    )),
  );
  return directory;
}

async function insertLegacyProject(pool: Pool, actorId: string, name: string): Promise<string> {
  const projectId = randomUUID();
  await pool.query(
    `
      INSERT INTO projects (id, name, created_by, updated_by)
      VALUES ($1, $2, $3, $3)
    `,
    [projectId, name, actorId],
  );
  return projectId;
}

async function seedHistoricalAudits(pool: Pool): Promise<{
  auditIds: string[];
  projectId: string;
  requirementId: string;
}> {
  const actorId = randomUUID();
  const projectId = randomUUID();
  const requirementId = randomUUID();
  const commentId = randomUUID();
  const attachmentId = randomUUID();
  const artifactVersionId = randomUUID();
  const auditIds = Array.from({ length: 5 }, () => randomUUID());
  const sha256 = "a".repeat(64);

  await pool.query(
    `
      INSERT INTO users (id, login_name, display_name, password_hash)
      VALUES ($1, 'migration-user', 'Migration User', 'test-password-hash')
    `,
    [actorId],
  );
  await pool.query(
    `
      INSERT INTO projects (id, name, created_by, updated_by)
      VALUES ($1, '历史审计项目', $2, $2)
    `,
    [projectId, actorId],
  );
  await pool.query(
    `
      INSERT INTO requirements (
        id, project_id, title, summary, status, created_by, updated_by
      ) VALUES ($1, $2, '历史需求', '历史需求摘要', 'draft', $3, $3)
    `,
    [requirementId, projectId, actorId],
  );
  await pool.query(
    `
      INSERT INTO requirement_comments (id, requirement_id, body, author_id)
      VALUES ($1, $2, '历史评论', $3)
    `,
    [commentId, requirementId, actorId],
  );
  await pool.query(
    `
      INSERT INTO attachments (
        id, requirement_id, storage_key, file_name, content_type,
        size_bytes, sha256, uploaded_by
      ) VALUES ($1, $2, $3, 'history.txt', 'text/plain', 7, $4, $5)
    `,
    [attachmentId, requirementId, `objects/${attachmentId.slice(0, 2)}/${attachmentId}`, sha256, actorId],
  );
  await pool.query(
    `
      INSERT INTO requirement_artifact_versions (
        id, requirement_id, version_number, published_by
      ) VALUES ($1, $2, 1, $3)
    `,
    [artifactVersionId, requirementId, actorId],
  );
  const auditRows = [
    [auditIds[0], "project", projectId, "project.created"],
    [auditIds[1], "requirement", requirementId, "requirement.created"],
    [auditIds[2], "comment", commentId, "comment.created"],
    [auditIds[3], "attachment", attachmentId, "attachment.created"],
    [auditIds[4], "artifact_version", artifactVersionId, "artifact_version.published"],
  ];
  for (const [id, resourceType, resourceId, action] of auditRows) {
    await pool.query(
      `
        INSERT INTO audit_logs (
          id, actor_id, resource_type, resource_id, action, before_json, after_json
        ) VALUES ($1, $2, $3, $4, $5, NULL, NULL)
      `,
      [id, actorId, resourceType, resourceId, action],
    );
  }
  return { auditIds, projectId, requirementId };
}

async function withTemporaryDatabase(work: (pool: Pool) => Promise<void>): Promise<void> {
  const databaseName = `suduo_pr4_migration_${randomUUID().replaceAll("-", "")}`;
  const databaseIdentifier = quotedIdentifier(databaseName);
  const admin = new Client({ ...PG_CONFIG, database: "postgres" });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${databaseIdentifier}`);
  } finally {
    await admin.end();
  }

  const pool = ignoreTerminatedConnections(new Pool({ ...PG_CONFIG, database: databaseName }));
  try {
    await work(pool);
  } finally {
    await pool.end();
    const cleanup = new Client({ ...PG_CONFIG, database: "postgres" });
    await cleanup.connect();
    try {
      await cleanup.query(`DROP DATABASE ${databaseIdentifier} WITH (FORCE)`);
    } finally {
      await cleanup.end();
    }
  }
}

async function appliedVersions(pool: Pool): Promise<Array<{ version: string; checksum: string }>> {
  const result = await pool.query<{ version: string; checksum: string }>(
    "SELECT version, checksum FROM schema_migrations ORDER BY version ASC",
  );
  return result.rows;
}

async function migrationChecksum(version: string): Promise<string> {
  const content = await readFile(join(MIGRATIONS_DIRECTORY, version));
  return createHash("sha256").update(content).digest("hex");
}

function quotedIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(value)) {
    throw new Error("临时 PostgreSQL 数据库名无效");
  }
  return `"${value}"`;
}
