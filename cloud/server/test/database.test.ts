import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { RequirementsServiceConfig } from "../src/config.js";
import { createDatabase } from "../src/infrastructure/database.js";

describe("requirements-service database", () => {
  it("记录连接错误而不触发未处理 error 事件", async () => {
    const logError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const database = createDatabase(testConfig());
    const idleError = new Error("terminating connection due to administrator command");
    const clientError = new Error("Connection terminated unexpectedly");
    const client = new EventEmitter();
    try {
      expect(database.pool.listenerCount("error")).toBeGreaterThan(0);
      expect(() => database.pool.emit("error", idleError)).not.toThrow();
      expect(logError).toHaveBeenCalledWith(
        "requirements-service PostgreSQL idle connection error",
        idleError,
      );

      database.pool.emit("connect", client);
      expect(() => client.emit("error", clientError)).not.toThrow();
      expect(logError).toHaveBeenCalledWith(
        "requirements-service PostgreSQL connection error",
        clientError,
      );
    } finally {
      await database.pool.end();
      logError.mockRestore();
    }
  });
});

function testConfig(): RequirementsServiceConfig {
  return {
    host: "127.0.0.1",
    port: 4100,
    databaseUrl: "postgresql://unused",
    databasePoolMax: 2,
    databaseConnectionTimeoutMs: 100,
    authSecret: "t3-test-secret-at-least-thirty-two-characters",
    authTtlSeconds: 3_600,
    authIssuer: "suduo-requirements-service",
    authAudience: "suduo-local-bff",
    attachmentRoot: "/tmp/suduo-t3-database-test-unused",
    maxAttachmentBytes: 314_572_800,
    maxAttachmentsPerRequirement: 20,
    allowedAttachmentExtensions: new Set([".txt"]),
    runMigrations: false,
    logger: false,
  };
}
