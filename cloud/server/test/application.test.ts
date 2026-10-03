import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequirementsServiceConfig } from "../src/config.js";
import type { Database } from "../src/infrastructure/database.js";
import type { UserRepository } from "../src/infrastructure/user-repository.js";

const mocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  close: vi.fn(),
  buildHttpServer: vi.fn(),
}));

vi.mock("../src/application/attachment-service.js", () => ({
  AttachmentService: class {
    initialize = mocks.initialize;
    close = mocks.close;
  },
}));
vi.mock("../src/infrastructure/storage/local-disk-blob-store.js", () => ({
  LocalDiskBlobStore: class {
    initialize = vi.fn().mockResolvedValue(undefined);
  },
}));
vi.mock("../src/http/server.js", () => ({
  buildHttpServer: mocks.buildHttpServer,
}));

import { createApplication } from "../src/application.js";
import { AuthService } from "../src/application/auth-service.js";
import { hashPassword } from "../src/application/password-service.js";

describe("requirements-service application startup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.initialize.mockResolvedValue(undefined);
    mocks.close.mockResolvedValue(undefined);
  });

  it("releases attachment ownership when HTTP server construction fails", async () => {
    const buildError = new Error("Fastify plugin failed");
    mocks.buildHttpServer.mockRejectedValue(buildError);

    await expect(
      createApplication({
        attachmentRoot: "/tmp/suduo-t3-application-test-unused",
        maxAttachmentBytes: 1,
        maxAttachmentsPerRequirement: 20,
        allowedAttachmentExtensions: new Set<string>(),
      } as unknown as RequirementsServiceConfig, {} as Database),
    ).rejects.toBe(buildError);

    expect(mocks.initialize).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.buildHttpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactVersions: expect.anything(),
        attachmentStorage: expect.anything(),
      }),
    );
  });
});

describe("AuthService", () => {
  it("uses the dedicated code for incorrect login credentials", async () => {
    const users = {
      findForAuthentication: vi.fn().mockResolvedValue({
        user: {
          id: "user-1",
          loginName: "alice",
          displayName: "Alice",
          createdAt: "2026-08-23T00:00:00.000Z",
        },
        passwordHash: await hashPassword("correct password"),
      }),
    } as unknown as UserRepository;
    const service = new AuthService(users);

    await expect(service.login({ loginName: "Alice", password: "wrong password" })).rejects.toMatchObject({
      statusCode: 401,
      code: "LOGIN_CREDENTIALS_INVALID",
      message: "登录名或密码错误",
    });
  });
});
