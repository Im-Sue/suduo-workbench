import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime } from "@suduo/client-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { RequirementsV2Service } from "../src/application/requirements-v2-service.js";
import type { SessionService } from "../src/application/session-service.js";
import { openBetterSqlite3Database } from "../src/infrastructure/db/better-sqlite3-database.js";
import { runMigrations } from "../src/infrastructure/db/migration-runner.js";
import { ProjectRepository } from "../src/infrastructure/db/repositories/project-repository.js";
import { RequirementSessionRefRepository } from "../src/infrastructure/db/repositories/requirement-session-ref-repository.js";
import { WorkspaceMappingRepository } from "../src/infrastructure/db/repositories/workspace-mapping-repository.js";
import { RequirementsCredentialStore } from "../src/infrastructure/requirements-v2/credential-store.js";
import { RequirementsRemoteClient } from "../src/infrastructure/requirements-v2/remote-client.js";
import { RequirementsSettingsStore } from "../src/infrastructure/requirements-v2/settings-store.js";
import { createMinimalHttpContext } from "./helpers/minimal-http-context.js";

/**
 * 需求服务（远程）相关的说明按请求语言生成：带 `x-suduo-locale: en` 出英文；
 * 不带头时用夹具记下的界面语言（zh-CN），与迁移前逐字相同。
 * 带头的请求会把语言记下来，所以每个上下文里先发不带头的请求。
 */
const HOST = "127.0.0.1:8787";
const ORIGIN = "http://" + HOST;
const REMOTE = "http://remote.test";
const HEALTH = { service: "suduo-requirements-service", status: "ok", database: {}, uptimeMs: 1 };

type FetchStub = (url: string, init?: RequestInit) => Promise<Response>;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function setup(options: { fetch: FetchStub; configured?: boolean }) {
  const dataDirectory = mkdtempSync(join(tmpdir(), "suduo-remote-i18n-"));
  const database = openBetterSqlite3Database(":memory:");
  runMigrations(database);
  const settings = new RequirementsSettingsStore(dataDirectory);
  if (options.configured !== false) settings.setBaseUrl(REMOTE);
  const credentials = new RequirementsCredentialStore(dataDirectory);
  const remote = new RequirementsRemoteClient(settings, credentials, ((input: string | URL | Request, init?: RequestInit) =>
    options.fetch(String(input), init)) as typeof fetch);
  const requirementsV2 = new RequirementsV2Service(
    settings,
    credentials,
    remote,
    new WorkspaceMappingRepository(database),
    new ProjectRepository(database),
    {} as SessionService,
    new RequirementSessionRefRepository(database),
    database,
  );
  const context = createMinimalHttpContext({ runtimeId: "unused" } as unknown as AgentRuntime, { requirementsV2 });
  cleanups.push(async () => {
    await context.close();
    database.close();
    rmSync(dataDirectory, { recursive: true, force: true });
  });
  const send = async (
    method: "GET" | "POST",
    url: string,
    locale: "en" | null,
    payload?: unknown,
  ) =>
    context.server.inject({
      method,
      url,
      headers: {
        host: HOST,
        ...(method === "POST" ? { origin: ORIGIN } : {}),
        ...(locale === null ? {} : { "x-suduo-locale": locale }),
      },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  return { send };
}

describe("需求服务的说明按请求语言", () => {
  it("试连成功的说明（DTO 里的 message）", async () => {
    const { send } = setup({ fetch: async () => json(200, HEALTH) });
    const zh = await send("POST", "/api/v2/requirements/settings/test", null, { baseUrl: REMOTE });
    expect(zh.json()).toMatchObject({ reachable: true, message: "远程需求服务连接正常" });
    const en = await send("POST", "/api/v2/requirements/settings/test", "en", { baseUrl: REMOTE });
    expect(en.statusCode).toBe(200);
    expect(en.json()).toMatchObject({ reachable: true, message: "Connected to the requirements service" });
  });

  it("试连失败与健康检查异常", async () => {
    const unreachable = setup({ fetch: async () => { throw new TypeError("fetch failed"); } });
    const zh = await unreachable.send("POST", "/api/v2/requirements/settings/test", null, { baseUrl: REMOTE });
    expect(zh.json().error.message).toBe("无法连接远程需求服务，请确认地址、网络和服务状态");
    const en = await unreachable.send("POST", "/api/v2/requirements/settings/test", "en", { baseUrl: REMOTE });
    expect(en.statusCode).toBe(503);
    expect(en.json().error.message).toBe(
      "Can't reach the requirements service. Check the address, your network, and that the service is running.",
    );

    const failing = setup({ fetch: async () => json(502, {}) });
    expect((await failing.send("POST", "/api/v2/requirements/settings/test", null, { baseUrl: REMOTE })).json().error.message)
      .toBe("远程需求服务健康检查失败（HTTP 502）");
    expect((await failing.send("POST", "/api/v2/requirements/settings/test", "en", { baseUrl: REMOTE })).json().error.message)
      .toBe("The requirements service health check failed (HTTP 502)");
  });

  it("远程错误码按本机字典说明，远程原文不透传", async () => {
    const { send } = setup({
      fetch: async () =>
        json(401, { error: { code: "LOGIN_CREDENTIALS_INVALID", message: "Remote wording that must not leak", requestId: "r" } }),
    });
    const body = { loginName: "alice", password: "wrong-password" };
    const zh = await send("POST", "/api/v2/auth/login", null, body);
    expect(zh.json().error).toMatchObject({ code: "LOGIN_CREDENTIALS_INVALID", message: "登录名或密码错误" });
    const en = await send("POST", "/api/v2/auth/login", "en", body);
    expect(en.statusCode).toBe(401);
    expect(en.json().error).toMatchObject({ code: "LOGIN_CREDENTIALS_INVALID", message: "Incorrect username or password" });
  });

  it("未配置地址、未登录", async () => {
    const notConfigured = setup({ fetch: async () => json(200, {}), configured: false });
    const body = { loginName: "alice", password: "secret" };
    expect((await notConfigured.send("POST", "/api/v2/auth/login", null, body)).json().error.message)
      .toBe("请先配置远程需求服务地址");
    expect((await notConfigured.send("POST", "/api/v2/auth/login", "en", body)).json().error.message)
      .toBe("Set the requirements service address first");

    const signedOut = setup({ fetch: async () => json(200, {}) });
    expect((await signedOut.send("GET", "/api/v2/auth/me", null)).json().error.message).toBe("请先登录远程需求服务");
    const en = await signedOut.send("GET", "/api/v2/auth/me", "en");
    expect(en.statusCode).toBe(401);
    expect(en.json().error.message).toBe("Sign in to the requirements service first");
  });

  it("本机校验：字段名与长度说明一起按语言", async () => {
    const { send } = setup({ fetch: async () => json(200, {}) });
    expect((await send("POST", "/api/v2/projects", null, { name: "  " })).json().error.message)
      .toBe("项目名称长度必须为 1 到 120");
    const en = await send("POST", "/api/v2/projects", "en", { name: "  " });
    expect(en.statusCode).toBe(400);
    expect(en.json().error.message).toBe("Project name must be 1 to 120 characters");

    const settings = await send("POST", "/api/v2/requirements/settings/test", "en", { baseUrl: "ftp://remote.test" });
    expect(settings.json().error.message).toBe("The server address isn't valid");
  });
});
