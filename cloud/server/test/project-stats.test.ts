import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client, Pool } from "pg";
import type {
  ListRequirementsByIdsResponse,
  ProjectStatsResponse,
  RequirementStatus,
  RequirementsV2ErrorResponse,
} from "@suduo/cloud-contracts";
import type { ArtifactVersionService } from "../src/application/artifact-version-service.js";
import type { AttachmentService } from "../src/application/attachment-service.js";
import type { AuthService } from "../src/application/auth-service.js";
import { CollaborationService } from "../src/application/collaboration-service.js";
import { RequirementsEventHub } from "../src/application/event-hub.js";
import type { RequirementsServiceConfig } from "../src/config.js";
import { buildHttpServer } from "../src/http/server.js";
import type { AttachmentStorage } from "../src/infrastructure/attachment-storage.js";
import { CollaborationRepository } from "../src/infrastructure/collaboration-repository.js";
import { Database } from "../src/infrastructure/database.js";
import { runMigrations } from "../src/infrastructure/migration-runner.js";
import { ignoreTerminatedConnections } from "./pg-test-support.js";

const TEST_DATABASE = process.env["SUDUO_PROJECT_STATS_TEST_DB"] ??
  `suduo_project_stats_${randomUUID().replaceAll("-", "")}`;
const DATABASE_IDENTIFIER = quotedIdentifier(TEST_DATABASE);
const PG_CONFIG = {
  host: "127.0.0.1",
  port: 15_432,
  user: "suduo",
};

let pool: Pool;
let server: Awaited<ReturnType<typeof buildHttpServer>>;
let clock = new Date("2026-08-25T18:00:00.000Z");
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
  const database = new Database(pool);
  const repository = new CollaborationRepository(database, () => clock);
  server = await buildHttpServer({
    config: testConfig(),
    database,
    auth: {} as AuthService,
    collaboration: new CollaborationService(repository),
    attachments: { close: vi.fn().mockResolvedValue(undefined) } as unknown as AttachmentService,
    artifactVersions: {} as ArtifactVersionService,
    attachmentStorage: {} as AttachmentStorage,
    events: new RequirementsEventHub(),
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
  clock = new Date("2026-08-25T18:00:00.000Z");
  await pool.query("TRUNCATE TABLE users CASCADE");
});

describe("项目 stats 与批量需求读取", () => {
  it("拒绝缺失或非法的 window、tz，绝不回落到 UTC", async () => {
    const { actorId, projectId } = await createActorAndProject();
    const missingWindow = await getStats(actorId, projectId, "tz=America%2FChicago");
    expect(missingWindow.statusCode).toBe(400);
    expect(missingWindow.json<RequirementsV2ErrorResponse>().error.message).toContain("Invalid request parameters");

    const invalidWindow = await getStats(actorId, projectId, "window=14d&tz=America%2FChicago");
    expect(invalidWindow.statusCode).toBe(400);

    const missingTimeZone = await getStats(actorId, projectId, "window=7d");
    expect(missingTimeZone.statusCode).toBe(400);
    expect(missingTimeZone.json<RequirementsV2ErrorResponse>().error.message).toContain("Invalid request parameters");

    const invalidTimeZone = await getStats(actorId, projectId, "window=7d&tz=Not%2FAZone");
    expect(invalidTimeZone.statusCode).toBe(400);
    expect(invalidTimeZone.json<RequirementsV2ErrorResponse>().error.message).toContain("IANA");
  });

  it("补齐七档状态计数", async () => {
    const { actorId, projectId } = await createActorAndProject();
    await insertRequirement(projectId, actorId, "draft", "草稿需求", clock);
    await insertRequirement(projectId, actorId, "completed", "已完成需求", clock);

    const response = await getStats(actorId, projectId, "window=7d&tz=America%2FChicago");
    expect(response.statusCode).toBe(200);
    expect(response.json<ProjectStatsResponse>().statusCounts).toEqual({
      draft: 1,
      in_refinement: 0,
      ready_for_development: 0,
      in_development: 0,
      in_testing: 0,
      completed: 1,
      on_hold: 0,
    });
  });

  it("停滞按各状态的节奏判断：停滞较久的在前，已完成不算，暂缓只在很久没动时提醒", async () => {
    const { actorId, projectId } = await createActorAndProject();
    await insertRequirement(projectId, actorId, "in_development", "开发中 2 天", daysBefore(clock, 2));
    const devNotice = await insertRequirement(projectId, actorId, "in_development", "开发中 3 天", daysBefore(clock, 3));
    const devWarning = await insertRequirement(projectId, actorId, "in_development", "开发中 7 天", daysBefore(clock, 7));
    const refining = await insertRequirement(projectId, actorId, "in_refinement", "梳理中 20 天", daysBefore(clock, 20));
    await insertRequirement(projectId, actorId, "draft", "草稿 10 天", daysBefore(clock, 10));
    const draft = await insertRequirement(projectId, actorId, "draft", "草稿 16 天", daysBefore(clock, 16));
    const onHold = await insertRequirement(projectId, actorId, "on_hold", "暂缓 35 天", daysBefore(clock, 35));
    await insertRequirement(projectId, actorId, "completed", "已完成 90 天", daysBefore(clock, 90));

    const stats = await statsBody(actorId, projectId, "7d", "UTC");
    expect(stats.staleRequirements.map((item) => [item.id, item.level, item.staleDays])).toEqual([
      [refining.id, "warning", 20],
      [devWarning.id, "warning", 7],
      [onHold.id, "notice", 35],
      [draft.id, "notice", 16],
      [devNotice.id, "notice", 3],
    ]);
    expect(stats.staleTotal).toBe(5);
    expect(typeof stats.staleRequirements[0]?.number).toBe("number");
  });

  it("停滞列表最多 10 条，总数照实给出", async () => {
    const { actorId, projectId } = await createActorAndProject();
    for (let index = 0; index < 12; index += 1) {
      await insertRequirement(projectId, actorId, "in_testing", `测试中 ${index}`, daysBefore(clock, 10 + index));
    }
    const stats = await statsBody(actorId, projectId, "7d", "UTC");
    expect(stats.staleRequirements).toHaveLength(10);
    expect(stats.staleTotal).toBe(12);
    expect(stats.staleRequirements[0]?.staleDays).toBe(21);
  });

  it("每天的流转按进入的状态分开计数；没有后值的只计总数", async () => {
    const { actorId, projectId } = await createActorAndProject();
    await insertStatusChange(projectId, actorId, "2026-08-25T12:00:00.000Z", "in_testing");
    await insertStatusChange(projectId, actorId, "2026-08-25T13:00:00.000Z", "in_testing");
    await insertStatusChange(projectId, actorId, "2026-08-25T14:00:00.000Z", "completed");
    await insertStatusChange(projectId, actorId, "2026-08-25T15:00:00.000Z");
    const stats = await statsBody(actorId, projectId, "7d", "UTC");
    expect(stats.transitions.find((item) => item.date === "2026-08-25")).toEqual({
      date: "2026-08-25",
      count: 4,
      byStatus: { in_testing: 2, completed: 1 },
    });
    expect(stats.transitions.find((item) => item.date === "2026-08-24")?.byStatus).toEqual({});
  });

  it("状态和标题一起改（记为 updated）也算流转；没改状态的 updated 不算；不认识的状态只计总数", async () => {
    const { actorId, projectId } = await createActorAndProject();
    await insertAudit(projectId, actorId, "2026-08-25T12:00:00.000Z", "requirement.updated", { status: "draft" }, { status: "in_development" });
    await insertAudit(projectId, actorId, "2026-08-25T13:00:00.000Z", "requirement.updated", { status: "draft" }, { status: "draft" });
    await insertAudit(projectId, actorId, "2026-08-25T14:00:00.000Z", "requirement.status_changed", { status: "draft" }, { status: "legacy_state" });
    const stats = await statsBody(actorId, projectId, "7d", "UTC");
    expect(stats.transitions.find((item) => item.date === "2026-08-25")).toEqual({
      date: "2026-08-25",
      count: 2,
      byStatus: { in_development: 1 },
    });
  });

  it("按请求时区为跨零点与 DST 的状态流转量分桶", async () => {
    const { actorId, projectId } = await createActorAndProject();
    await insertStatusChange(projectId, actorId, "2026-08-25T04:30:00.000Z");
    await insertStatusChange(projectId, actorId, "2026-08-25T05:30:00.000Z");

    const chicago = await statsBody(actorId, projectId, "7d", "America/Chicago");
    expect(transitionCount(chicago, "2026-08-24")).toBe(1);
    expect(transitionCount(chicago, "2026-08-25")).toBe(1);

    const utc = await statsBody(actorId, projectId, "7d", "UTC");
    expect(transitionCount(utc, "2026-08-25")).toBe(2);

    clock = new Date("2026-03-08T18:00:00.000Z");
    await insertStatusChange(projectId, actorId, "2026-03-08T05:30:00.000Z");
    await insertStatusChange(projectId, actorId, "2026-03-08T08:30:00.000Z");
    const dst = await statsBody(actorId, projectId, "7d", "America/Chicago");
    expect(transitionCount(dst, "2026-03-07")).toBe(1);
    expect(transitionCount(dst, "2026-03-08")).toBe(1);
  });

  it("批量查询最多 100 个 ID，并静默跳过不存在的需求", async () => {
    const { actorId, projectId } = await createActorAndProject();
    const ids = await Promise.all(Array.from({ length: 100 }, async (_, index) =>
      insertRequirement(projectId, actorId, "draft", `批量需求 ${index}`, clock),
    ));

    const hundred = await listRequirementsByIds(actorId, ids.map((item) => item.id));
    expect(hundred.statusCode).toBe(200);
    expect(hundred.json<ListRequirementsByIdsResponse>().items.map((item) => item.id)).toEqual(
      ids.map((item) => item.id),
    );

    const oneHundredOne = await listRequirementsByIds(
      actorId,
      [...ids.map((item) => item.id), randomUUID()],
    );
    expect(oneHundredOne.statusCode).toBe(400);
    expect(oneHundredOne.json<RequirementsV2ErrorResponse>().error.message).toContain("100");

    const firstId = ids[0]?.id;
    expect(firstId).toBeDefined();
    const withMissing = await listRequirementsByIds(actorId, [firstId!, randomUUID()]);
    expect(withMissing.statusCode).toBe(200);
    expect(withMissing.json<ListRequirementsByIdsResponse>().items.map((item) => item.id)).toEqual([
      firstId,
    ]);
  });
});

async function createActorAndProject(): Promise<{ actorId: string; projectId: string }> {
  const actorId = randomUUID();
  const projectId = randomUUID();
  await pool.query(
    `
      INSERT INTO users (id, login_name, display_name, password_hash)
      VALUES ($1, $2, 'Stats User', 'test-password-hash')
    `,
    [actorId, `stats-${actorId.slice(0, 8)}`],
  );
  await pool.query(
    `
      INSERT INTO projects (id, name, created_by, updated_by)
      VALUES ($1, 'Stats Project', $2, $2)
    `,
    [projectId, actorId],
  );
  return { actorId, projectId };
}

async function insertRequirement(
  projectId: string,
  actorId: string,
  status: RequirementStatus,
  title: string,
  updatedAt: Date,
): Promise<{ id: string }> {
  const id = randomUUID();
  await pool.query(
    `
      WITH allocation AS (
        UPDATE projects
        SET next_requirement_number = next_requirement_number + 1
        WHERE id = $2
        RETURNING next_requirement_number - 1 AS number
      )
      INSERT INTO requirements (
        id, project_id, number, title, summary, status, created_by, updated_by, created_at, updated_at
      )
      SELECT $1, $2, allocation.number, $3, '测试摘要', $4, $5, $5, $6, $6
      FROM allocation
    `,
    [id, projectId, title, status, actorId, updatedAt.toISOString()],
  );
  return { id };
}

async function insertStatusChange(
  projectId: string,
  actorId: string,
  createdAt: string,
  toStatus: string | null = null,
): Promise<void> {
  await pool.query(
    `
      INSERT INTO audit_logs (
        id, actor_id, project_id, requirement_id, resource_type, resource_id,
        action, before_json, after_json, created_at
      ) VALUES ($1, $2, $3, $4, 'requirement', $4, 'requirement.status_changed', NULL, $6::jsonb, $5)
    `,
    [randomUUID(), actorId, projectId, randomUUID(), createdAt, toStatus === null ? null : JSON.stringify({ status: toStatus })],
  );
}

async function insertAudit(
  projectId: string,
  actorId: string,
  createdAt: string,
  action: "requirement.updated" | "requirement.status_changed",
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    `
      INSERT INTO audit_logs (
        id, actor_id, project_id, requirement_id, resource_type, resource_id,
        action, before_json, after_json, created_at
      ) VALUES ($1, $2, $3, $4, 'requirement', $4, $5, $6::jsonb, $7::jsonb, $8)
    `,
    [randomUUID(), actorId, projectId, randomUUID(), action, JSON.stringify(before), JSON.stringify(after), createdAt],
  );
}

async function getStats(actorId: string, projectId: string, query: string) {
  return server.inject({
    method: "GET",
    url: `/v2/projects/${projectId}/stats?${query}`,
    headers: authorization(actorId),
  });
}

async function statsBody(
  actorId: string,
  projectId: string,
  window: "7d" | "30d",
  tz: string,
): Promise<ProjectStatsResponse> {
  const response = await getStats(
    actorId,
    projectId,
    new URLSearchParams({ window, tz }).toString(),
  );
  expect(response.statusCode).toBe(200);
  return response.json<ProjectStatsResponse>();
}

function transitionCount(stats: ProjectStatsResponse, date: string): number {
  return stats.transitions.find((item) => item.date === date)?.count ?? 0;
}

async function listRequirementsByIds(actorId: string, ids: string[]) {
  return server.inject({
    method: "GET",
    url: `/v2/requirements?${new URLSearchParams({ ids: ids.join(",") }).toString()}`,
    headers: authorization(actorId),
  });
}

function daysBefore(date: Date, days: number): Date {
  return new Date(date.getTime() - days * 86_400_000);
}

function authorization(actorId: string): { authorization: string } {
  return {
    authorization: `Bearer ${server.jwt.sign({ sub: actorId, loginName: "stats-user" })}`,
  };
}

function testConfig(): RequirementsServiceConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    databaseUrl: "postgresql://unused",
    databasePoolMax: 2,
    databaseConnectionTimeoutMs: 100,
    authSecret: "project-stats-test-secret-at-least-thirty-two-characters",
    authTtlSeconds: 3_600,
    authIssuer: "suduo-requirements-service",
    authAudience: "suduo-local-bff",
    attachmentRoot: "/tmp/suduo-project-stats-unused",
    maxAttachmentBytes: 314_572_800,
    maxAttachmentsPerRequirement: 20,
    allowedAttachmentExtensions: new Set([".txt"]),
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
