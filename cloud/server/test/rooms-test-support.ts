import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, Pool } from "pg";
import { expect } from "vitest";
import {
  REQUIREMENTS_SERVICE_MAX_ACTIVE_ATTACHMENTS_PER_REQUIREMENT,
  type AgentDto,
  type ProjectDto,
  type RequirementDto,
  type RoomDto,
  type RoomMessageDto,
} from "@suduo/cloud-contracts";
import type { ArtifactVersionService } from "../src/application/artifact-version-service.js";
import type { AttachmentService } from "../src/application/attachment-service.js";
import { AuthService } from "../src/application/auth-service.js";
import { CollaborationService } from "../src/application/collaboration-service.js";
import { RequirementsEventHub } from "../src/application/event-hub.js";
import { ROOM_FILE_ROOT_MARKER } from "../src/application/rooms/constants.js";
import { createRoomsModule, type RoomsModule } from "../src/application/rooms/module.js";
import type { RequirementsServiceConfig } from "../src/config.js";
import { buildHttpServer } from "../src/http/server.js";
import type { AttachmentStorage } from "../src/infrastructure/attachment-storage.js";
import { CollaborationRepository } from "../src/infrastructure/collaboration-repository.js";
import { Database } from "../src/infrastructure/database.js";
import { runMigrations } from "../src/infrastructure/migration-runner.js";
import { LocalDiskBlobStore } from "../src/infrastructure/storage/local-disk-blob-store.js";
import { UserRepository } from "../src/infrastructure/user-repository.js";
import { ignoreTerminatedConnections } from "./pg-test-support.js";

/** 房间测试共用：每个测试文件自建随机库 + 真实 PostgreSQL（127.0.0.1:15432）。 */

const PG_CONFIG = { host: "127.0.0.1", port: 15_432, user: "suduo" };

export interface RoomsTestContext {
  pool: Pool;
  database: Database;
  server: Awaited<ReturnType<typeof buildHttpServer>>;
  rooms: RoomsModule;
  roomFileRoot: string;
  close(): Promise<void>;
}

export async function setupRoomsTest(options: {
  name: string;
  maxFileBytes?: number;
  allowedFileExtensions?: ReadonlySet<string>;
}): Promise<RoomsTestContext> {
  const databaseName = `suduo_${options.name}_${randomUUID().replaceAll("-", "")}`;
  const identifier = quotedIdentifier(databaseName);
  const admin = new Client({ ...PG_CONFIG, database: "postgres" });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${identifier}`);
  } finally {
    await admin.end();
  }
  const pool = ignoreTerminatedConnections(new Pool({ ...PG_CONFIG, database: databaseName }));
  await runMigrations(pool);
  const database = new Database(pool);
  const roomFileRoot = await mkdtemp(join(tmpdir(), `suduo-${options.name}-room-files-`));
  const blobStore = new LocalDiskBlobStore(roomFileRoot, ROOM_FILE_ROOT_MARKER);
  await blobStore.initialize();
  const rooms = createRoomsModule({
    database,
    blobStore,
    ...(options.maxFileBytes === undefined ? {} : { maxFileBytes: options.maxFileBytes }),
    ...(options.allowedFileExtensions === undefined ? {} : { allowedFileExtensions: options.allowedFileExtensions }),
  });
  const server = await buildHttpServer({
    config: testConfig(roomFileRoot),
    database,
    auth: new AuthService(new UserRepository(database)),
    collaboration: new CollaborationService(new CollaborationRepository(database)),
    attachments: { close: async () => undefined } as unknown as AttachmentService,
    artifactVersions: {} as ArtifactVersionService,
    attachmentStorage: {} as AttachmentStorage,
    events: new RequirementsEventHub(),
    rooms,
  });
  return {
    pool,
    database,
    server,
    rooms,
    roomFileRoot,
    async close() {
      await server.close();
      await pool.end();
      await rm(roomFileRoot, { recursive: true, force: true }).catch(() => undefined);
      const cleanup = new Client({ ...PG_CONFIG, database: "postgres" });
      await cleanup.connect();
      try {
        await cleanup.query(`DROP DATABASE ${identifier} WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}

/** 测试里的一个用户：ID + 带令牌的请求头。 */
export interface TestUser {
  id: string;
  displayName: string;
  headers: { authorization: string };
}

export async function createUser(context: RoomsTestContext, displayName: string): Promise<TestUser> {
  const id = randomUUID();
  await context.pool.query(
    "INSERT INTO users (id, login_name, display_name, password_hash) VALUES ($1, $2, $3, 'test-password-hash')",
    [id, `user-${id.slice(0, 8)}`, displayName],
  );
  return {
    id,
    displayName,
    headers: { authorization: `Bearer ${context.server.jwt.sign({ sub: id, loginName: `user-${id.slice(0, 8)}` })}` },
  };
}

export async function createProject(context: RoomsTestContext, user: TestUser, name: string): Promise<ProjectDto> {
  const response = await context.server.inject({
    method: "POST",
    url: "/v2/projects",
    headers: user.headers,
    payload: { name },
  });
  expect(response.statusCode).toBe(201);
  return response.json<ProjectDto>();
}

export async function createRequirement(
  context: RoomsTestContext,
  user: TestUser,
  projectId: string,
  payload: Record<string, unknown> = {},
): Promise<RequirementDto> {
  const response = await context.server.inject({
    method: "POST",
    url: `/v2/projects/${projectId}/requirements`,
    headers: user.headers,
    payload: { title: "房间测试需求", summary: "", status: "draft", ...payload },
  });
  expect(response.statusCode).toBe(201);
  return response.json<RequirementDto>();
}

export async function defaultRoom(context: RoomsTestContext, user: TestUser, projectId: string): Promise<RoomDto> {
  const response = await context.server.inject({
    method: "GET",
    url: `/v2/projects/${projectId}/rooms`,
    headers: user.headers,
  });
  expect(response.statusCode).toBe(200);
  const room = response.json<{ items: RoomDto[] }>().items.find((item) => item.kind === "project_default");
  if (room === undefined) throw new Error("没有默认房间");
  return room;
}

export async function sendMessage(
  context: RoomsTestContext,
  user: TestUser,
  roomId: string,
  payload: Record<string, unknown>,
  expectedStatus = 201,
): Promise<RoomMessageDto> {
  const response = await context.server.inject({
    method: "POST",
    url: `/v2/rooms/${roomId}/messages`,
    headers: user.headers,
    payload: { clientId: randomUUID(), body: "你好", ...payload },
  });
  expect(response.statusCode, response.body).toBe(expectedStatus);
  return response.json<RoomMessageDto>();
}

export async function registerAgent(
  context: RoomsTestContext,
  user: TestUser,
  deviceKey = `device-${randomUUID()}`,
  deviceName = "MacBook Pro",
): Promise<AgentDto> {
  const response = await context.server.inject({
    method: "POST",
    url: "/v2/agents",
    headers: user.headers,
    payload: { deviceKey, deviceName },
  });
  expect([200, 201]).toContain(response.statusCode);
  return response.json<AgentDto>();
}

export async function openShare(
  context: RoomsTestContext,
  user: TestUser,
  roomId: string,
  agentId: string,
  duration: "until_closed" | "two_hours" | "today" = "until_closed",
): Promise<{ id: string; expiresAt: string | null; active: boolean }> {
  const response = await context.server.inject({
    method: "POST",
    url: `/v2/rooms/${roomId}/shares`,
    headers: user.headers,
    payload: { agentId, duration },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

/** 把 Agent 的心跳拨回去 seconds 秒（模拟掉线）。 */
export async function ageAgent(context: RoomsTestContext, agentId: string, seconds: number): Promise<void> {
  await context.pool.query(
    "UPDATE agents SET last_seen_at = now() - make_interval(secs => $2) WHERE id = $1",
    [agentId, seconds],
  );
}

function testConfig(roomFileRoot: string): RequirementsServiceConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    databaseUrl: "postgresql://unused",
    databasePoolMax: 4,
    databaseConnectionTimeoutMs: 1_000,
    authSecret: "rooms-test-secret-at-least-thirty-two-characters",
    authTtlSeconds: 3_600,
    authIssuer: "suduo-requirements-service",
    authAudience: "suduo-local-bff",
    attachmentRoot: `${roomFileRoot}-unused-attachments`,
    maxAttachmentBytes: 1_024,
    maxAttachmentsPerRequirement: REQUIREMENTS_SERVICE_MAX_ACTIVE_ATTACHMENTS_PER_REQUIREMENT,
    allowedAttachmentExtensions: new Set([".txt"]),
    runMigrations: false,
    logger: false,
  };
}

function quotedIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(value)) throw new Error("临时 PostgreSQL 数据库名无效");
  return `"${value}"`;
}
