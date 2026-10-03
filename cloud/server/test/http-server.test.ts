import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttachmentService } from "../src/application/attachment-service.js";
import type { ArtifactVersionService } from "../src/application/artifact-version-service.js";
import { RequirementsEventHub } from "../src/application/event-hub.js";
import type { AuthService } from "../src/application/auth-service.js";
import type { CollaborationService } from "../src/application/collaboration-service.js";
import type { RequirementsServiceConfig } from "../src/config.js";
import { buildHttpServer } from "../src/http/server.js";
import type { Database } from "../src/infrastructure/database.js";
import type { AttachmentStorage } from "../src/infrastructure/attachment-storage.js";

const openServers: Array<Awaited<ReturnType<typeof buildHttpServer>>> = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(async (server) => {
    await server.close().catch(() => undefined);
  }));
});

describe("requirements-service HTTP lifecycle", () => {
  it("returns 503 when the database health query fails", async () => {
    const server = await buildHttpServer({
      config: testConfig(),
      database: {
        query: vi.fn().mockRejectedValue(new Error("connection refused")),
      } as unknown as Database,
      auth: {} as AuthService,
      collaboration: {} as CollaborationService,
      attachments: {} as AttachmentService,
      artifactVersions: {} as ArtifactVersionService,
      attachmentStorage: {} as AttachmentStorage,
      events: new RequirementsEventHub(),
    });
    openServers.push(server);

    const response = await server.inject({ method: "GET", url: "/v2/health" });

    expect(response.statusCode).toBe(503);
  });

  it("reports the product version and schema version when healthy", async () => {
    const server = await buildHttpServer({
      config: { ...testConfig(), version: "0.7.0" },
      database: {
        query: vi.fn().mockResolvedValue({ rows: [] }),
        pool: { query: vi.fn().mockResolvedValue({ rows: [{ version: "011_rooms_and_shared_agents.sql" }] }) },
      } as unknown as Database,
      auth: {} as AuthService,
      collaboration: {} as CollaborationService,
      attachments: {} as AttachmentService,
      artifactVersions: {} as ArtifactVersionService,
      attachmentStorage: {} as AttachmentStorage,
      events: new RequirementsEventHub(),
    });
    openServers.push(server);

    const response = await server.inject({ method: "GET", url: "/v2/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      service: "suduo-requirements-service",
      status: "ok",
      version: "0.7.0",
      database: { status: "ok", schemaVersion: "011_rooms_and_shared_agents.sql" },
    });
  });

  it("ends active SSE responses before releasing attachment ownership", async () => {
    const attachments = { close: vi.fn().mockResolvedValue(undefined) };
    const server = await buildHttpServer({
      config: testConfig(),
      database: {} as Database,
      auth: {} as AuthService,
      collaboration: {} as CollaborationService,
      attachments: attachments as unknown as AttachmentService,
      artifactVersions: {} as ArtifactVersionService,
      attachmentStorage: {} as AttachmentStorage,
      events: new RequirementsEventHub(),
    });
    openServers.push(server);
    await server.listen({ host: "127.0.0.1", port: 0 });
    const address = server.server.address() as AddressInfo;
    const token = server.jwt.sign({
      sub: "11111111-1111-4111-8111-111111111111",
      loginName: "t3-lifecycle-test",
    });
    const response = await fetch(`http://127.0.0.1:${address.port}/v2/events`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const firstChunk = await reader?.read();
    expect(new TextDecoder().decode(firstChunk?.value)).toContain("event: ready");

    await server.close();
    openServers.splice(openServers.indexOf(server), 1);

    expect(attachments.close).toHaveBeenCalledOnce();
    await expect(reader?.read()).resolves.toMatchObject({ done: true });
  });

  it("仅在需求正文实际变化时发布 requirement.changed", async () => {
    const events = new RequirementsEventHub();
    const publish = vi.spyOn(events, "publish");
    const requirement = {
      id: "22222222-2222-4222-8222-222222222222",
      projectId: "33333333-3333-4333-8333-333333333333",
      title: "需求标题",
      summary: "需求摘要",
      status: "draft" as const,
      createdBy: { id: "11111111-1111-4111-8111-111111111111", displayName: "测试用户" },
      updatedBy: { id: "11111111-1111-4111-8111-111111111111", displayName: "测试用户" },
      createdAt: "2026-09-06T00:00:00.000Z",
      updatedAt: "2026-09-06T00:00:00.000Z",
      version: 7,
    };
    const updateRequirement = vi.fn()
      .mockResolvedValueOnce({ requirement, changed: false })
      .mockResolvedValueOnce({ requirement, changed: true });
    const server = await buildHttpServer({
      config: testConfig(),
      database: {} as Database,
      auth: {} as AuthService,
      collaboration: { updateRequirement } as unknown as CollaborationService,
      attachments: {} as AttachmentService,
      artifactVersions: {} as ArtifactVersionService,
      attachmentStorage: {} as AttachmentStorage,
      events,
    });
    openServers.push(server);
    const authorization = {
      authorization: `Bearer ${server.jwt.sign({
        sub: "11111111-1111-4111-8111-111111111111",
        loginName: "t3-http-test",
      })}`,
    };

    const unchanged = await server.inject({
      method: "PATCH",
      url: `/v2/requirements/${requirement.id}`,
      headers: authorization,
      payload: { title: requirement.title },
    });
    expect(unchanged.statusCode).toBe(200);
    expect(publish).not.toHaveBeenCalled();

    const changed = await server.inject({
      method: "PATCH",
      url: `/v2/requirements/${requirement.id}`,
      headers: authorization,
      payload: { title: "已更新标题" },
    });
    expect(changed.statusCode).toBe(200);
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith({
      type: "requirement.changed",
      projectId: requirement.projectId,
      requirementId: requirement.id,
      requirementVersion: requirement.version,
    });
  });
});

function testConfig(): RequirementsServiceConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    databaseUrl: "postgresql://unused",
    databasePoolMax: 2,
    databaseConnectionTimeoutMs: 100,
    authSecret: "t3-test-secret-at-least-thirty-two-characters",
    authTtlSeconds: 3_600,
    authIssuer: "suduo-requirements-service",
    authAudience: "suduo-local-bff",
    attachmentRoot: "/tmp/suduo-t3-http-test-unused",
    maxAttachmentBytes: 314_572_800,
    maxAttachmentsPerRequirement: 20,
    allowedAttachmentExtensions: new Set([".txt"]),
    runMigrations: false,
    logger: false,
  };
}
