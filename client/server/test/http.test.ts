import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentRuntime,
  ApproveInput,
  ApproveResult,
  InterruptInput,
  RuntimeEventDraft,
  StartThreadInput,
  StartThreadResult,
  StartTurnInput,
  StartTurnResult,
} from "@suduo/client-contracts";
import { ApprovalService } from "../src/application/approval-service.js";
import {
  LocalDirectoryService,
  linkedRemoteProjectIds,
  mappedWorkspaceRoots,
} from "../src/application/local-directory-service.js";
import { RequirementsV2Service } from "../src/application/requirements-v2-service.js";
import { SessionContextService } from "../src/application/session-tools/session-context.js";
import { MyWorkbenchService } from "../src/application/my-workbench-service.js";
import { EventBroker } from "../src/application/event-broker.js";
import { EventLedger } from "../src/application/event-ledger.js";
import { GitService } from "../src/application/git-service.js";
import { IdempotencyService } from "../src/application/idempotency-service.js";
import { InterruptService } from "../src/application/interrupt-service.js";
import { MessageService } from "../src/application/message-service.js";
import { ModelProviderService } from "../src/application/model-provider-service.js";
import { ProjectService } from "../src/application/project-service.js";
import { ProxyConnectivityService } from "../src/application/proxy-connectivity-service.js";
import type { ProxySettings } from "../src/application/proxy-settings.js";
import { RuntimeEventIngestor } from "../src/application/runtime-event-ingestor.js";
import { CodexGlobalState } from "../src/application/codex-global-state.js";
import { RuntimeSupervisor } from "../src/application/runtime-supervisor.js";
import { SessionEventStream } from "../src/application/event-stream.js";
import { SessionRunStatusService } from "../src/application/session-run-status-service.js";
import { SessionService } from "../src/application/session-service.js";
import { SettingsService } from "../src/application/settings-service.js";
import { SkillAdminService } from "../src/application/skill-admin-service.js";
import { WorkspaceService } from "../src/application/workspace-service.js";
import { openBetterSqlite3Database } from "../src/infrastructure/db/better-sqlite3-database.js";
import { runMigrations } from "../src/infrastructure/db/migration-runner.js";
import { ApprovalRepository } from "../src/infrastructure/db/repositories/approval-repository.js";
import { EventRepository } from "../src/infrastructure/db/repositories/event-repository.js";
import { IdempotencyRepository } from "../src/infrastructure/db/repositories/idempotency-repository.js";
import { ProjectRepository } from "../src/infrastructure/db/repositories/project-repository.js";
import { SessionRepository } from "../src/infrastructure/db/repositories/session-repository.js";
import { SessionThreadRepository } from "../src/infrastructure/db/repositories/session-thread-repository.js";
import { RequirementSessionRefRepository } from "../src/infrastructure/db/repositories/requirement-session-ref-repository.js";
import { WorkspaceMappingRepository } from "../src/infrastructure/db/repositories/workspace-mapping-repository.js";
import { ProjectSessionRefRepository } from "../src/infrastructure/db/repositories/project-session-ref-repository.js";
import { buildHttpServer } from "../src/infrastructure/http/http-server.js";
import { LoopbackGuard } from "../src/infrastructure/http/loopback-guard.js";
import { RequirementsCredentialStore } from "../src/infrastructure/requirements-v2/credential-store.js";
import { RequirementsRemoteClient } from "../src/infrastructure/requirements-v2/remote-client.js";
import { RequirementsSettingsStore } from "../src/infrastructure/requirements-v2/settings-store.js";
import { RuntimeRegistry } from "../src/infrastructure/runtime/runtime-registry.js";
import { WorkspaceWatcher } from "../src/infrastructure/workspace/workspace-watcher.js";

const temporaryPaths: string[] = [];
const ARTIFACT_VERSION_ID = "11111111-1111-4111-8111-111111111111";
const ARTIFACT_ATTACHMENT_ID = "22222222-2222-4222-8222-222222222222";
const ARTIFACT_FILE_ID = "33333333-3333-4333-8333-333333333333";
const ARTIFACT_FILE_CONTENT = "released artifact bytes";
const SESSION_PROJECT_ID = "44444444-4444-4444-8444-444444444444";
const SESSION_REQUIREMENT_ID = "55555555-5555-4555-8555-555555555555";
/** 与 SESSION_PROJECT_ID 共用一个本机目录的另一个项目（一个仓库对应前端、后端两个项目）。 */
const SHARED_PROJECT_ID = "66666666-6666-4666-8666-666666666666";

interface ArtifactFileFixture {
  id: string;
  attachmentId: string;
  fileName: string;
  content: string;
  sha256: string;
}

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("Gate B HTTP", () => {
  it("保留 loopback、项目、会话、消息与幂等闭环", async () => {
    const context = createContext();
    try {
      const rejected = await context.server.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers: { host: "192.168.1.20:8787", origin: "http://192.168.1.20:8787" },
        payload: { rootPath: context.projectRoot },
      });
      expect(rejected.statusCode).toBe(403);

      const project = await write(context, {
        method: "POST",
        url: "/api/v1/projects",
        key: "project-key",
        body: { rootPath: context.projectRoot, name: "HTTP" },
      });
      expect(project.statusCode).toBe(201);
      const replay = await write(context, {
        method: "POST",
        url: "/api/v1/projects",
        key: "project-key",
        body: { rootPath: context.projectRoot, name: "HTTP" },
      });
      expect(replay.json()).toEqual(project.json());

      const session = await write(context, {
        method: "POST",
        url: `/api/v1/projects/${String(project.json().id)}/sessions`,
        key: "session-key",
        body: { title: "session", purpose: "pm_requirement" },
      });
      expect(session.statusCode).toBe(201);
      const sessionId = String(session.json().id);

      const message = await write(context, {
        method: "POST",
        url: `/api/v1/sessions/${sessionId}/messages`,
        key: "message-key",
        body: { content: [{ type: "text", text: "hello" }] },
      });
      expect(message.statusCode).toBe(202);
      expect(context.runtime.turns).toHaveLength(1);
    } finally {
      await context.server.close();
      context.database.close();
    }
  });

  it("保留审批决策与运行态摘要路由", async () => {
    const context = createContext();
    try {
      const project = await write(context, {
        method: "POST",
        url: "/api/v1/projects",
        key: "project-2",
        body: { rootPath: context.projectRoot },
      });
      const session = await write(context, {
        method: "POST",
        url: `/api/v1/projects/${String(project.json().id)}/sessions`,
        key: "session-2",
        body: {},
      });
      const sessionId = String(session.json().id);
      const threadRef = session.json().threads[0].threadRef;
      context.ingestor.ingest({
        source: "runtime:codex-local",
        type: "approval.requested",
        payload: { kind: "command", connectionId: "test", requestId: "1", approvalRef: "a", request: { threadId: threadRef.threadId, turnId: "t" } },
        threadRef,
        turnRef: { threadId: threadRef.threadId, turnId: "t" },
        ts: Date.now(),
        dedupeKey: "test:1",
      });
      const pending = await context.server.inject({
        method: "GET",
        url: `/api/v1/sessions/${sessionId}/approvals`,
        headers: { host: context.host },
      });
      const decided = await write(context, {
        method: "POST",
        url: `/api/v1/approvals/${String(pending.json().items[0].id)}/decision`,
        key: "approval-1",
        body: { decision: "accept" },
      });
      expect(decided.statusCode).toBe(200);
      const status = await context.server.inject({
        method: "GET",
        url: `/api/v1/projects/${String(project.json().id)}/sessions/run-status`,
        headers: { host: context.host },
      });
      expect(status.statusCode).toBe(200);
      expect(status.json().items).toHaveLength(1);
    } finally {
      await context.server.close();
      context.database.close();
    }
  });

  it("区分登录口令错误与已失效的远程登录态", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "suduo-requirements-remote-error-"));
    temporaryPaths.push(projectRoot);
    const settings = new RequirementsSettingsStore(projectRoot);
    const credentials = new RequirementsCredentialStore(projectRoot);
    const baseUrl = "https://requirements.fixture";
    settings.setBaseUrl(baseUrl);
    credentials.save({
      baseUrl,
      accessToken: "fixture-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
      user: {
        id: "fixture-user",
        loginName: "fixture",
        displayName: "Fixture User",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    });
    let remoteCode = "LOGIN_CREDENTIALS_INVALID";
    const client = new RequirementsRemoteClient(settings, credentials, async () =>
      new Response(
        JSON.stringify({ error: { code: remoteCode, message: "不应透传的远程文本" } }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(
      client.login({ loginName: "fixture", password: "wrong password" }),
    ).rejects.toMatchObject({
      statusCode: 401,
      code: "LOGIN_CREDENTIALS_INVALID",
      message: "登录名或密码错误",
    });
    expect(credentials.getForBaseUrl(baseUrl)).not.toBeNull();

    remoteCode = "AUTH_INVALID";
    await expect(client.me()).rejects.toMatchObject({
      statusCode: 401,
      code: "AUTH_INVALID",
      message: "登录凭证无效或已过期，请重新登录",
    });
    expect(credentials.getForBaseUrl(baseUrl)).toBeNull();
  });

  it("将 Codex 全局投影以 SSE 快照读出", async () => {
    const context = createContext();
    const streamAbort = new AbortController();
    try {
      context.codexGlobalState.record({
        source: "runtime:codex-local",
        type: "runtime.unknown",
        payload: {
          summary: "配置需检查",
          extensions: { codex: { nativeType: "configWarning" } },
        },
        threadRef: null,
        turnRef: null,
        ts: 1_700_000_000_000,
      });
      // 在当前 Linux 容器中，Fastify 连续绑定 loopback 临时端口会偶发拒绝连接；
      // 仍通过 127.0.0.1 发起请求，保证路由实际接受的是 loopback Host。
      await context.server.listen({ host: "0.0.0.0", port: 0 });
      const address = context.server.server.address();
      if (!address || typeof address === "string") {
        throw new Error("test server did not expose a TCP address");
      }
      const response = await fetch(
        `http://127.0.0.1:${String(address.port)}/api/v1/codex/status`,
        { signal: streamAbort.signal },
      );
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const body = await readUntilSseData(response);
      expect(body).toContain("event: status");
      expect(body).toContain("configWarning");
    } finally {
      streamAbort.abort();
      await context.server.close();
      context.database.close();
    }
  });

  it("以官方模型清单端点替换旧 model-provider/test 路由", async () => {
    const context = createContext();
    try {
      const models = await context.server.inject({
        method: "GET",
        url: "/api/v1/codex/models",
        headers: { host: context.host },
      });
      expect(models.statusCode).toBe(200);
      expect(models.json()).toEqual({ models: [], items: [] });
      const removed = await context.server.inject({
        method: "POST",
        url: "/api/v1/settings/model-provider/test",
        headers: { host: context.host, origin: `http://${context.host}` },
      });
      expect(removed.statusCode).toBe(404);
    } finally {
      await context.server.close();
      context.database.close();
    }
  });

  it("/api/v1/settings 返回审批档部署上限及锁定态", async () => {
    const context = createContext({
      settingsEnv: { SUDUO_MAX_APPROVAL_MODE: "auto" },
    });
    try {
      const response = await context.server.inject({
        method: "GET",
        url: "/api/v1/settings",
        headers: { host: context.host },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        maxApprovalMode: "auto",
        approvalModeLocked: true,
      });
    } finally {
      await context.server.close();
      context.database.close();
    }
  });

  it("代理设置可读写；草稿连通性检查不写入设置", async () => {
    const context = createContext();
    try {
      const updated = await context.server.inject({
        method: "PATCH",
        url: "/api/v1/settings",
        headers: { host: context.host, origin: `http://${context.host}` },
        payload: { httpProxy: "http://127.0.0.1:7890" },
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json()).toMatchObject({
        httpProxy: "http://127.0.0.1:7890",
        httpsProxy: "",
        allProxy: "",
        noProxy: "",
      });

      const tested = await context.server.inject({
        method: "POST",
        url: "/api/v1/settings/proxy/test",
        headers: { host: context.host, origin: `http://${context.host}` },
        payload: { allProxy: "socks5h://127.0.0.1:7890" },
      });
      expect(tested.statusCode).toBe(200);
      expect(tested.json()).toMatchObject({ reachable: true, statusCode: 401 });
      expect(context.proxyProbes).toHaveLength(1);
      expect(context.proxyProbes[0]).toMatchObject({
        httpProxy: "http://127.0.0.1:7890",
        allProxy: "socks5h://127.0.0.1:7890",
      });

      const current = await context.server.inject({
        method: "GET",
        url: "/api/v1/settings",
        headers: { host: context.host },
      });
      expect(current.json()).toMatchObject({
        httpProxy: "http://127.0.0.1:7890",
        allProxy: "",
      });
    } finally {
      await context.server.close();
      context.database.close();
    }
  });

  it("试未保存的需求服务地址且不写入本机配置", async () => {
    const context = createContext();
    try {
      const before = snapshotTree(context.v2DataDirectory);
      const response = await context.server.inject({
        method: "POST",
        url: "/api/v2/requirements/settings/test",
        headers: { host: context.host, origin: `http://${context.host}` },
        payload: { baseUrl: "https://requirements-probe.example" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        baseUrl: "https://requirements-probe.example",
        reachable: true,
        message: "远程需求服务连接正常",
        version: null,
        features: [],
      });
      expect(context.requirementsRemote.state.requests).toEqual([
        "https://requirements-probe.example/v2/health",
      ]);
      expect(snapshotTree(context.v2DataDirectory)).toEqual(before);
      expect(context.requirementsSettings.getBaseUrl()).toBeNull();

      // 新版云端在健康检查里报告产品版本，连接测试原样带回，供设置页比对本机版本。
      context.requirementsRemote.state.healthVersion = "0.7.0";
      const withVersion = await context.server.inject({
        method: "POST",
        url: "/api/v2/requirements/settings/test",
        headers: { host: context.host, origin: `http://${context.host}` },
        payload: { baseUrl: "https://requirements-probe.example" },
      });
      expect(withVersion.json()).toMatchObject({ reachable: true, version: "0.7.0" });

      // 云端声明的功能原样带回（只留字符串），网页据此显示优先级等入口。
      context.requirementsRemote.state.healthFeatures = ["requirement_priority", 42, null];
      const withFeatures = await context.server.inject({
        method: "POST",
        url: "/api/v2/requirements/settings/test",
        headers: { host: context.host, origin: `http://${context.host}` },
        payload: { baseUrl: "https://requirements-probe.example" },
      });
      expect(withFeatures.json()).toMatchObject({ features: ["requirement_priority"] });
    } finally {
      await context.server.close();
      context.database.close();
    }
  });

  it("BFF 不转发附件版本头，连续上传和删除保持正文版本", async () => {
    const context = createContext();
    try {
      context.requirementsSettings.setBaseUrl("https://requirements.fixture");
      context.requirementsCredentials.save({
        baseUrl: "https://requirements.fixture",
        accessToken: "fixture-token",
        expiresAt: "2030-01-01T00:00:00.000Z",
        user: {
          id: "fixture-user",
          loginName: "fixture-user",
          displayName: "Fixture User",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      });

      const upload = async (id: string) =>
        await context.server.inject({
          method: "POST",
          url: "/api/v2/requirements/remote-requirement/attachments",
          headers: {
            host: context.host,
            origin: `http://${context.host}`,
            "content-type": "multipart/form-data; boundary=fixture",
            "idempotency-key": id,
            "x-requirement-expected-version": "999",
          },
          payload: "--fixture--\r\n",
        });

      for (const id of [
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
        "00000000-0000-4000-8000-000000000003",
      ]) {
        const response = await upload(id);
        expect(response.statusCode).toBe(201);
        expect(response.json().requirementVersion).toBe(1);
      }

      const deleted = await context.server.inject({
        method: "DELETE",
        url: "/api/v2/attachments/remote-attachment-1/content",
        headers: {
          host: context.host,
          origin: `http://${context.host}`,
          "x-requirement-expected-version": "1",
        },
      });
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json().requirementVersion).toBe(1);
      expect(context.requirementsRemote.state.requirementVersion).toBe(1);
      expect(context.requirementsRemote.state.attachmentCount).toBe(2);
      expect(context.requirementsRemote.state.expectedVersionHeaders).toEqual([
        null,
        null,
        null,
        null,
      ]);
    } finally {
      await context.server.close();
      context.database.close();
    }
  });

  it("BFF 原样透传新旧需求 PATCH body，不校验版本字段", async () => {
    const context = createContext();
    try {
      configureRequirementsRemote(context);
      const freshBody = { title: "新版需求编辑" };
      const legacyBody = { summary: "旧版需求编辑", expectedVersion: 999 };

      for (const body of [freshBody, legacyBody]) {
        const response = await context.server.inject({
          method: "PATCH",
          url: "/api/v2/requirements/remote-requirement",
          headers: { host: context.host, origin: `http://${context.host}` },
          payload: body,
        });
        expect(response.statusCode).toBe(200);
      }

      expect(context.requirementsRemote.state.requirementUpdateBodies).toEqual([
        freshBody,
        legacyBody,
      ]);
    } finally {
      await context.server.close();
      context.database.close();
    }
  });

  it("BFF 透传项目改名 / 归档 body，不再要求或校验 expectedVersion", async () => {
    const context = createContext();
    try {
      configureRequirementsRemote(context);
      const bodies = [{ name: "新项目名" }, { isArchived: true }, { name: "旧客户端", expectedVersion: 1 }];
      for (const body of bodies) {
        const response = await context.server.inject({
          method: "PATCH",
          url: "/api/v2/projects/remote-project",
          headers: { host: context.host, origin: `http://${context.host}` },
          payload: body,
        });
        expect(response.statusCode).toBe(200);
      }
      expect(context.requirementsRemote.state.projectUpdateBodies).toEqual(bodies);

      const empty = await context.server.inject({
        method: "PATCH",
        url: "/api/v2/projects/remote-project",
        headers: { host: context.host, origin: `http://${context.host}` },
        payload: {},
      });
      expect(empty.statusCode).toBe(400);
      expect(context.requirementsRemote.state.projectUpdateBodies).toHaveLength(bodies.length);
    } finally {
      await context.server.close();
      context.database.close();
    }
  });

  it("需求列表透传 status / search / assignee，并补本机未删除会话数", async () => {
    const context = createContext();
    try {
      configureRequirementsRemote(context);
      const project = context.projects.create({
        name: "local-session-count",
        rootPath: context.projectRoot,
        rootPathKey: context.projectRoot,
      });
      const live = addRequirementSession(context, project.id, "remote-requirement");
      const archived = addRequirementSession(context, project.id, "remote-requirement");
      const deleted = addRequirementSession(context, project.id, "remote-requirement");
      addRequirementSession(context, project.id, "unlisted-requirement");
      expect(context.sessions.updateState(archived.id, archived.version, "archived")).toBe(true);
      expect(context.sessions.updateState(deleted.id, deleted.version, "deleted")).toBe(true);
      expect(live.state).toBe("active");

      const listed = await context.server.inject({
        method: "GET",
        url: "/api/v2/projects/remote-project/requirements?status=draft&search=REQ-7&assignee=me&limit=20",
        headers: { host: context.host },
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toEqual({
        items: [
          { ...remoteRequirementSummary("remote-requirement", 7), localSessionCount: 2 },
          { ...remoteRequirementSummary("other-requirement", 8), localSessionCount: 0 },
        ],
        nextCursor: "remote-next-cursor",
      });
      const forwarded = new URLSearchParams(context.requirementsRemote.state.requirementListQueries[0]);
      expect(Object.fromEntries(forwarded)).toEqual({
        status: "draft",
        search: "REQ-7",
        assignee: "me",
        limit: "20",
      });
      // 创建人筛选原样转给需求服务（我的工作：我提的、还没人负责）。
      const created = await context.server.inject({
        method: "GET",
        url: "/api/v2/projects/remote-project/requirements?creator=me&assignee=none",
        headers: { host: context.host },
      });
      expect(created.statusCode).toBe(200);
      expect(Object.fromEntries(new URLSearchParams(context.requirementsRemote.state.requirementListQueries.at(-1)))).toEqual({
        creator: "me",
        assignee: "none",
      });
      context.requirementsRemote.state.requirementListQueries.pop();
      // 优先级筛选与排序原样转给需求服务（看板按优先级排序）。
      const prioritized = await context.server.inject({
        method: "GET",
        url: "/api/v2/projects/remote-project/requirements?status=draft&priority=urgent,none&sort=priority",
        headers: { host: context.host },
      });
      expect(prioritized.statusCode).toBe(200);
      expect(Object.fromEntries(new URLSearchParams(context.requirementsRemote.state.requirementListQueries.at(-1)))).toEqual({
        status: "draft",
        priority: "urgent,none",
        sort: "priority",
      });
      context.requirementsRemote.state.requirementListQueries.pop();

      // 已读位置：带水位原样转发；不带请求体按现在记。
      const read = await context.server.inject({
        method: "PUT",
        url: "/api/v2/requirements/remote-requirement/read",
        headers: { host: context.host, origin: `http://${context.host}` },
        payload: { upTo: "2026-09-29T10:00:00.000Z" },
      });
      expect(read.statusCode).toBe(204);
      const readNow = await context.server.inject({
        method: "PUT",
        url: "/api/v2/requirements/remote-requirement/read",
        headers: { host: context.host, origin: `http://${context.host}` },
      });
      expect(readNow.statusCode).toBe(204);
      expect(context.requirementsRemote.state.readBodies).toEqual([{ upTo: "2026-09-29T10:00:00.000Z" }, {}]);

      const unknown = await context.server.inject({
        method: "GET",
        url: "/api/v2/projects/remote-project/requirements?owner=me",
        headers: { host: context.host },
      });
      expect(unknown.statusCode).toBe(400);
      expect(context.requirementsRemote.state.requirementListQueries).toHaveLength(1);

      const detail = await context.server.inject({
        method: "GET",
        url: "/api/v2/requirements/remote-requirement",
        headers: { host: context.host },
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({
        id: "remote-requirement",
        number: 7,
        project: { id: "remote-project" },
        localSessionCount: 2,
      });

      const byNumber = await context.server.inject({
        method: "GET",
        url: "/api/v2/projects/remote-project/requirements/by-number/7",
        headers: { host: context.host },
      });
      expect(byNumber.statusCode).toBe(200);
      expect(byNumber.json()).toMatchObject({ id: "remote-requirement", localSessionCount: 2 });
      for (const invalid of ["0", "07", "abc", "1234567890"]) {
        const rejected = await context.server.inject({
          method: "GET",
          url: `/api/v2/projects/remote-project/requirements/by-number/${invalid}`,
          headers: { host: context.host },
        });
        expect(rejected.statusCode, invalid).toBe(400);
      }
    } finally {
      await context.server.close();
      context.database.close();
    }
  });

  it("创建 / 更新需求透传描述可空与负责人字段，并补本机会话数", async () => {
    const context = createContext();
    try {
      configureRequirementsRemote(context);
      const headers = { host: context.host, origin: `http://${context.host}` };
      const bodies = [
        { title: "只有标题" },
        { title: "空描述带负责人", summary: "", assigneeId: "fixture-user" },
        { title: "显式不指派", assigneeId: null },
        { title: "带优先级", priority: "urgent" },
      ];
      for (const payload of bodies) {
        const created = await context.server.inject({
          method: "POST",
          url: "/api/v2/projects/remote-project/requirements",
          headers,
          payload,
        });
        expect(created.statusCode).toBe(201);
        expect(created.json()).toMatchObject({ number: 9, localSessionCount: 0 });
      }
      expect(context.requirementsRemote.state.requirementCreateBodies).toEqual(bodies);

      const blankTitle = await context.server.inject({
        method: "POST",
        url: "/api/v2/projects/remote-project/requirements",
        headers,
        payload: { title: "  " },
      });
      expect(blankTitle.statusCode).toBe(400);
      const badAssignee = await context.server.inject({
        method: "POST",
        url: "/api/v2/projects/remote-project/requirements",
        headers,
        payload: { title: "负责人类型错误", assigneeId: 42 },
      });
      expect(badAssignee.statusCode).toBe(400);
      const badPriority = await context.server.inject({
        method: "POST",
        url: "/api/v2/projects/remote-project/requirements",
        headers,
        payload: { title: "优先级不认识", priority: "critical" },
      });
      expect(badPriority.statusCode).toBe(400);
      expect(context.requirementsRemote.state.requirementCreateBodies).toHaveLength(4);

      for (const payload of [
        { assigneeId: "fixture-user" },
        { assigneeId: null },
        { summary: "" },
        { priority: "low" },
        { priority: null },
      ]) {
        const updated = await context.server.inject({
          method: "PATCH",
          url: "/api/v2/requirements/remote-requirement",
          headers,
          payload,
        });
        expect(updated.statusCode).toBe(200);
        expect(updated.json()).toMatchObject({ id: "remote-requirement", localSessionCount: 0 });
      }
      const empty = await context.server.inject({
        method: "PATCH",
        url: "/api/v2/requirements/remote-requirement",
        headers,
        payload: {},
      });
      expect(empty.statusCode).toBe(400);
      expect(context.requirementsRemote.state.requirementUpdateBodies).toEqual([
        { assigneeId: "fixture-user" },
        { assigneeId: null },
        { summary: "" },
        { priority: "low" },
        { priority: null },
      ]);
    } finally {
      await context.server.close();
      context.database.close();
    }
  });

  it("代理用户列表与需求活动时间线，活动只透传 cursor / limit", async () => {
    const context = createContext();
    try {
      configureRequirementsRemote(context);
      const users = await context.server.inject({
        method: "GET",
        url: "/api/v2/users",
        headers: { host: context.host },
      });
      expect(users.statusCode).toBe(200);
      expect(users.json()).toEqual({
        items: [
          { id: "fixture-user", displayName: "Fixture User" },
          { id: "other-user", displayName: "Other User" },
        ],
      });

      const activity = await context.server.inject({
        method: "GET",
        url: "/api/v2/requirements/remote-requirement/activity?cursor=abc&limit=10",
        headers: { host: context.host },
      });
      expect(activity.statusCode).toBe(200);
      expect(activity.json()).toEqual({
        items: [expect.objectContaining({ action: "comment.created", comment: { id: "c1", body: "hi" } })],
        nextCursor: null,
      });
      expect(Object.fromEntries(
        new URLSearchParams(context.requirementsRemote.state.activityQueries[0]),
      )).toEqual({ cursor: "abc", limit: "10" });

      const rejected = await context.server.inject({
        method: "GET",
        url: "/api/v2/requirements/remote-requirement/activity?action=comment.created",
        headers: { host: context.host },
      });
      expect(rejected.statusCode).toBe(400);
      expect(context.requirementsRemote.state.activityQueries).toHaveLength(1);
    } finally {
      await context.server.close();
      context.database.close();
    }
  });

  it("本机目录浏览只在 loopback 可用，错误映射为 LOCAL_PATH_* 而不是 500", async () => {
    const context = createContext();
    try {
      const root = join(context.projectRoot, "browse");
      mkdirSync(join(root, "repo", ".git"), { recursive: true });
      writeFileSync(join(root, "repo", ".git", "HEAD"), "ref: refs/heads/feature/p2\n");
      mkdirSync(join(root, ".hidden"));
      writeFileSync(join(root, "note.txt"), "not a directory");
      addWorkspaceMapping(context, "remote-project", join(root, "repo"));

      const rejected = await context.server.inject({
        method: "GET",
        url: `/api/v2/local/dirs?path=${encodeURIComponent(root)}`,
        headers: { host: "192.168.1.20:8787" },
      });
      expect(rejected.statusCode).toBe(403);
      expect(rejected.json().error.code).toBe("ORIGIN_REJECTED");

      const listed = await context.server.inject({
        method: "GET",
        url: `/api/v2/local/dirs?path=${encodeURIComponent(root)}`,
        headers: { host: context.host },
      });
      expect(listed.statusCode).toBe(200);
      const realRoot = realpathSync(root);
      expect(listed.json()).toMatchObject({
        path: realRoot,
        parent: realpathSync(context.projectRoot),
        entries: [{ name: "repo", path: join(realRoot, "repo"), isGitRepo: true }],
        truncated: false,
        recent: [join(root, "repo")],
      });

      const withHidden = await context.server.inject({
        method: "GET",
        url: `/api/v2/local/dirs?hidden=1&path=${encodeURIComponent(root)}`,
        headers: { host: context.host },
      });
      expect(withHidden.json().entries.map((entry: { name: string }) => entry.name)).toEqual([
        ".hidden",
        "repo",
      ]);

      const inspected = await context.server.inject({
        method: "GET",
        url: `/api/v2/local/dirs/inspect?path=${encodeURIComponent(join(root, "repo"))}`,
        headers: { host: context.host },
      });
      expect(inspected.json()).toEqual({
        path: join(realRoot, "repo"),
        exists: true,
        isDirectory: true,
        readable: true,
        writable: true,
        isGitRepo: true,
        branch: "feature/p2",
        // 这个目录已关联给 remote-project：选目录时据此告知（一个目录可关联多个项目）。
        linkedRemoteProjectIds: ["remote-project"],
      });

      const cases: Array<[string, number, string]> = [
        ["/api/v2/local/dirs?path=relative/path", 400, "LOCAL_PATH_INVALID"],
        [`/api/v2/local/dirs?path=${encodeURIComponent(join(root, "missing"))}`, 404, "LOCAL_PATH_NOT_FOUND"],
        [`/api/v2/local/dirs?path=${encodeURIComponent(join(root, "note.txt"))}`, 400, "LOCAL_PATH_NOT_DIRECTORY"],
        ["/api/v2/local/dirs/inspect", 400, "LOCAL_PATH_INVALID"],
        ["/api/v2/local/dirs/inspect?path=relative", 400, "LOCAL_PATH_INVALID"],
        [`/api/v2/local/dirs?path=${encodeURIComponent(root)}&hidden=yes`, 400, "VALIDATION_ERROR"],
        [`/api/v2/local/dirs?path=${encodeURIComponent(root)}&depth=2`, 400, "VALIDATION_ERROR"],
      ];
      for (const [url, statusCode, code] of cases) {
        const response = await context.server.inject({
          method: "GET",
          url,
          headers: { host: context.host },
        });
        expect(response.statusCode, url).toBe(statusCode);
        expect(response.json().error.code, url).toBe(code);
      }
    } finally {
      await context.server.close();
      context.database.close();
    }
  });

  it("代理产物版本列表、详情和版本文件下载（只读）；发布不再代理", async () => {
    const context = createContext();
    try {
      configureRequirementsRemote(context);
      const list = await context.server.inject({
        method: "GET",
        url: "/api/v2/requirements/remote-requirement/artifact-versions",
        headers: { host: context.host },
      });
      expect(list.statusCode).toBe(200);
      expect(list.json().items).toEqual([
        expect.objectContaining({ id: ARTIFACT_VERSION_ID, versionNumber: 1 }),
      ]);

      // 确认版停用：本机服务不再代理发布，只留读取（历史确认版只读）。
      const publish = await context.server.inject({
        method: "POST",
        url: "/api/v2/requirements/remote-requirement/artifact-versions",
        headers: { host: context.host, origin: `http://${context.host}` },
        payload: { operationKey: "artifact-publish-operation-key", attachmentIds: [ARTIFACT_ATTACHMENT_ID] },
      });
      expect(publish.statusCode).toBe(404);
      expect(context.requirementsRemote.state.artifactPublishBodies).toEqual([]);

      const detail = await context.server.inject({
        method: "GET",
        url: `/api/v2/artifact-versions/${ARTIFACT_VERSION_ID}`,
        headers: { host: context.host },
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({
        id: ARTIFACT_VERSION_ID,
        files: [{ id: ARTIFACT_FILE_ID, attachmentId: ARTIFACT_ATTACHMENT_ID }],
      });

      const content = await context.server.inject({
        method: "GET",
        url: `/api/v2/artifact-versions/${ARTIFACT_VERSION_ID}/files/${ARTIFACT_FILE_ID}/content`,
        headers: { host: context.host },
      });
      expect(content.statusCode).toBe(200);
      expect(content.body).toBe("released artifact bytes");
      expect(content.headers["x-attachment-sha256"]).toBe(artifactFileFixtures()[0]!.sha256);
    } finally {
      await context.server.close();
      context.database.close();
    }
  });

  it("评论带文件：透传 fileIds，只有文件可不写正文，编号不合法 400；评论文件上传、下载、存为附件都转发", async () => {
    const context = createContext();
    try {
      configureRequirementsRemote(context);
      const headers = { host: context.host, origin: `http://${context.host}` };
      const post = (payload: unknown) =>
        context.server.inject({ method: "POST", url: `/api/v2/requirements/${SESSION_REQUIREMENT_ID}/comments`, headers, payload: payload as Record<string, unknown> });
      expect((await post({ body: "看图", fileIds: ["cf-1"] })).statusCode).toBe(201);
      expect((await post({ fileIds: ["cf-1"] })).statusCode).toBe(201);
      expect((await post({ body: "  ", fileIds: ["cf-1"] })).statusCode).toBe(201);
      for (const invalid of [
        { fileIds: "cf-1" },
        { fileIds: [1] },
        { body: "x", fileIds: Array.from({ length: 11 }, (_, index) => `cf-${String(index)}`) },
        { body: "  " },
        {},
      ]) {
        expect((await post(invalid)).statusCode, JSON.stringify(invalid)).toBe(400);
      }
      expect(context.requirementsRemote.state.commentBodies).toEqual([
        { body: "看图", fileIds: ["cf-1"] },
        { fileIds: ["cf-1"] },
        { body: "  ", fileIds: ["cf-1"] },
      ]);

      const uploaded = await context.server.inject({
        method: "POST",
        url: `/api/v2/requirements/${SESSION_REQUIREMENT_ID}/comment-files`,
        headers: { ...headers, "content-type": "multipart/form-data; boundary=fixture" },
        payload: "--fixture--\r\n",
      });
      expect(uploaded.statusCode).toBe(201);
      expect(uploaded.json()).toMatchObject({ id: "cf-1", commentId: null });
      const notMultipart = await context.server.inject({
        method: "POST",
        url: `/api/v2/requirements/${SESSION_REQUIREMENT_ID}/comment-files`,
        headers: { ...headers, "content-type": "application/json" },
        payload: {},
      });
      expect(notMultipart.statusCode).toBe(400);

      const content = await context.server.inject({
        method: "GET",
        url: "/api/v2/comment-files/cf-1/content?disposition=inline",
        headers: { host: context.host, range: "bytes=0-2" },
      });
      expect(content.statusCode).toBe(200);
      expect(content.body).toBe("png-bytes");
      expect(content.headers["content-type"]).toBe("image/png");
      expect(content.headers["content-security-policy"]).toBe("sandbox");
      expect(content.headers["x-content-type-options"]).toBe("nosniff");

      const saved = await context.server.inject({
        method: "POST",
        url: "/api/v2/comment-files/cf-1/save-as-attachment",
        headers,
      });
      expect(saved.statusCode).toBe(201);
      expect(saved.json()).toMatchObject({ attachment: { id: "att-from-comment" } });
      const meta = await context.server.inject({ method: "GET", url: "/api/v2/comment-files/cf-1", headers: { host: context.host } });
      expect(meta.json()).toMatchObject({ id: "cf-1", commentId: "c-1" });
      // 旧云端没有评论文件端点：框架默认的 404 照「找不到」处理，不说成「无法识别的响应」。
      const missing = await context.server.inject({ method: "GET", url: "/api/v2/comment-files/missing", headers: { host: context.host } });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
      expect(context.requirementsRemote.state.commentFileRequests).toEqual([
        "POST upload multipart/form-data; boundary=fixture",
        "GET content inline bytes=0-2",
        "POST save no-body",
      ]);
    } finally {
      await context.server.close();
      context.database.close();
    }
  });

  it("附件与产物文件 ?disposition=inline：安全类型经文件头确认才内联，其余回落为下载", async () => {
    const context = createContext();
    try {
      configureRequirementsRemote(context);
      const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(20_000, 0xab),
      ]);
      // 第 8191 字节起是一个三字节汉字，横跨 8KB 嗅探边界。
      const text = Buffer.from(`${"a".repeat(8_191)}中文说明\n`, "utf8");
      const cases: Array<{
        name: string;
        fileName: string;
        content: Buffer;
        inline: { contentType: string; csp: string } | null;
      }> = [
        {
          name: "白名单图片",
          fileName: "截图 (1).png",
          content: png,
          inline: {
            contentType: "image/png",
            csp: "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
          },
        },
        {
          name: "伪装成 PNG 的 HTML",
          fileName: "evil.png",
          content: Buffer.from("<html><script>alert(1)</script></html>"),
          inline: null,
        },
        {
          name: "SVG",
          fileName: "logo.svg",
          content: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
          inline: null,
        },
        {
          name: "PDF",
          fileName: "需求说明.pdf",
          content: Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n", "latin1"),
          inline: { contentType: "application/pdf", csp: "default-src 'none'" },
        },
        {
          name: "纯文本",
          fileName: "说明.txt",
          content: text,
          inline: {
            contentType: "text/plain; charset=utf-8",
            csp: "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
          },
        },
        {
          name: "含 NUL 的 .txt",
          fileName: "binary.txt",
          content: Buffer.from([0x68, 0x69, 0x00, 0x01]),
          inline: null,
        },
      ];
      const endpoints = [
        (id: string) => `/api/v2/attachments/${id}/content`,
        (id: string) => `/api/v2/artifact-versions/${ARTIFACT_VERSION_ID}/files/${id}/content`,
      ];
      for (const [index, testCase] of cases.entries()) {
        const id = `66666666-6666-4666-8666-${String(index).padStart(12, "0")}`;
        context.requirementsRemote.state.previewFiles.set(id, {
          fileName: testCase.fileName,
          content: testCase.content,
        });
        for (const endpoint of endpoints) {
          const label = `${testCase.name} ${endpoint(id)}`;
          const response = await context.server.inject({
            method: "GET",
            url: `${endpoint(id)}?disposition=inline`,
            headers: { host: context.host },
          });
          expect(response.statusCode, label).toBe(200);
          expect(response.rawPayload.equals(testCase.content), label).toBe(true);
          expect(response.headers["content-length"], label).toBe(String(testCase.content.length));
          expect(response.headers["x-content-type-options"], label).toBe("nosniff");
          expect(response.headers["cache-control"], label).toBe("no-store");
          if (testCase.inline === null) {
            expect(response.headers["content-type"], label).toBe("application/octet-stream");
            expect(response.headers["content-disposition"], label).toMatch(/^attachment;/u);
            expect(response.headers["content-security-policy"], label).toBeUndefined();
          } else {
            expect(response.headers["content-type"], label).toBe(testCase.inline.contentType);
            expect(response.headers["content-security-policy"], label).toBe(testCase.inline.csp);
            expect(response.headers["content-disposition"], label).toBe(
              `inline; filename*=UTF-8''${encodeURIComponent(testCase.fileName)
                .replaceAll("(", "%28")
                .replaceAll(")", "%29")}`,
            );
          }
        }
      }

      // 未带参数与非 inline 取值：行为不变，一律下载。
      const pngId = "66666666-6666-4666-8666-000000000000";
      for (const endpoint of endpoints) {
        for (const query of ["", "?disposition=attachment", "?disposition=INLINE"]) {
          const response = await context.server.inject({
            method: "GET",
            url: `${endpoint(pngId)}${query}`,
            headers: { host: context.host },
          });
          expect(response.statusCode).toBe(200);
          expect(response.rawPayload.equals(png)).toBe(true);
          expect(response.headers["content-type"]).toBe("application/octet-stream");
          expect(response.headers["content-disposition"]).toBe(
            `attachment; filename="__ (1).png"; filename*=UTF-8''${encodeURIComponent("截图 (1).png")}`,
          );
          expect(response.headers["content-security-policy"]).toBeUndefined();
        }
      }
    } finally {
      await context.server.close();
      context.database.close();
    }
  });

  it("从需求服务的项目开本机会话：默认标题用创建请求的语言", async () => {
    const context = createContext();
    try {
      configureRequirementsRemote(context);
      const mappingRoot = join(context.projectRoot, "project-session-mapping");
      mkdirSync(mappingRoot);
      addWorkspaceMapping(context, SESSION_PROJECT_ID, mappingRoot);
      const create = (headers: Record<string, string>) =>
        context.server.inject({
          method: "POST",
          url: `/api/v2/projects/${SESSION_PROJECT_ID}/sessions`,
          headers: { host: context.host, origin: `http://${context.host}`, ...headers },
          payload: {},
        });

      const chinese = await create({});
      expect(chinese.statusCode).toBe(201);
      expect(chinese.json()).toMatchObject({ title: "新会话" });
      // 会话语言随创建请求记下（迁移 017），交给 Codex 的开场按它写（S7）。
      expect(context.sessions.getById(chinese.json<{ id: string }>().id)?.locale).toBe("zh-CN");
      // 所属项目建时记下（迁移 018），之后不随目录关联变化。
      expect(context.projectSessionRefs.getBySessionId(chinese.json<{ id: string }>().id)?.remoteProjectId).toBe(SESSION_PROJECT_ID);
      expect(context.runtime.threadStarts.at(-1)?.developerInstructions).toContain("# SuDuo 项目会话");
      const english = await create({ "x-suduo-locale": "en" });
      expect(english.statusCode).toBe(201);
      expect(english.json()).toMatchObject({ title: "New session" });
      expect(context.sessions.getById(english.json<{ id: string }>().id)?.locale).toBe("en");
      const englishOpening = context.runtime.threadStarts.at(-1)?.developerInstructions ?? "";
      expect(englishOpening).toContain("# SuDuo project session");
      expect(englishOpening).toContain("Reply in the language the user writes in.");
    } finally {
      await context.server.close();
      context.database.close();
    }
  });

  it("目录关联按服务器区分：一个目录可关联多个项目并告知，会话按建时的所属项目列出，换服务器后旧关联不出现、换回原样恢复，解除不访问远程", async () => {
    const context = createContext();
    try {
      configureRequirementsRemote(context);
      const shared = join(context.projectRoot, "shared-repo");
      mkdirSync(shared);
      const realShared = realpathSync(shared);
      const write = (method: "PUT" | "POST" | "DELETE", url: string, payload?: Record<string, unknown>) =>
        context.server.inject({
          method,
          url,
          headers: { host: context.host, origin: `http://${context.host}` },
          ...(payload === undefined ? {} : { payload }),
        });
      const get = (url: string) => context.server.inject({ method: "GET", url, headers: { host: context.host } });

      // 同一目录先后关联给两个项目：都成功，不再拒绝。
      expect((await write("PUT", `/api/v2/projects/${SESSION_PROJECT_ID}/workspace-mapping`, { rootPath: shared })).statusCode).toBe(200);
      expect((await write("PUT", `/api/v2/projects/${SHARED_PROJECT_ID}/workspace-mapping`, { rootPath: shared })).statusCode).toBe(200);
      const inspected = await get(`/api/v2/local/dirs/inspect?path=${encodeURIComponent(shared)}`);
      expect([...inspected.json<{ linkedRemoteProjectIds: string[] }>().linkedRemoteProjectIds].sort()).toEqual(
        [SESSION_PROJECT_ID, SHARED_PROJECT_ID].sort(),
      );
      const mapped = await get("/api/v2/project-mappings?verify=1");
      expect(mapped.json<{ items: Array<{ remoteProjectId: string; rootPath: string }> }>().items.map((item) => [item.remoteProjectId, item.rootPath]).sort()).toEqual(
        [[SESSION_PROJECT_ID, realShared], [SHARED_PROJECT_ID, realShared]].sort(),
      );

      // 会话属于开它的项目：共用目录的另一个项目下看不到它。
      const created = await write("POST", `/api/v2/projects/${SESSION_PROJECT_ID}/sessions`, {});
      expect(created.statusCode).toBe(201);
      const sessionId = created.json<{ id: string }>().id;
      const listed = async (projectId: string) =>
        (await get(`/api/v2/projects/${projectId}/sessions`)).json<{ items: Array<{ session: { id: string } }> }>().items.map((item) => item.session.id);
      expect(await listed(SESSION_PROJECT_ID)).toEqual([sessionId]);
      expect(await listed(SHARED_PROJECT_ID)).toEqual([]);
      const context1 = await get(`/api/v1/sessions/${sessionId}/context`);
      expect(context1.json()).toMatchObject({ kind: "project", remoteProjectId: SESSION_PROJECT_ID });

      // 换到另一台服务器：这台服务器的关联不出现、不算进「最近使用」；换回来原样恢复。
      context.requirementsSettings.setBaseUrl("https://other-requirements.fixture");
      expect((await get("/api/v2/project-mappings?verify=1")).json<{ items: unknown[] }>().items).toEqual([]);
      expect((await get(`/api/v2/local/dirs/inspect?path=${encodeURIComponent(shared)}`)).json()).toMatchObject({ linkedRemoteProjectIds: [] });
      expect((await get(`/api/v2/local/dirs?path=${encodeURIComponent(context.projectRoot)}`)).json()).toMatchObject({ recent: [] });
      context.requirementsSettings.setBaseUrl("https://requirements.fixture");
      expect((await get("/api/v2/project-mappings?verify=1")).json<{ items: unknown[] }>().items).toHaveLength(2);

      // 解除关联是纯本机操作：不向服务器发任何请求；会话仍属原项目。
      const requestsBefore = context.requirementsRemote.state.requests.length;
      expect((await write("DELETE", `/api/v2/projects/${SESSION_PROJECT_ID}/workspace-mapping`)).statusCode).toBe(204);
      expect(context.requirementsRemote.state.requests.length).toBe(requestsBefore);
      expect(context.workspaceMappings.getByRemoteProjectId(SESSION_PROJECT_ID)).toBeNull();
      expect(context.projectSessionRefs.getBySessionId(sessionId)?.remoteProjectId).toBe(SESSION_PROJECT_ID);
    } finally {
      await context.server.close();
      context.database.close();
    }
  });

  it("升级前的存量关联（没有服务器信息）在配上服务器地址时记为这台服务器", async () => {
    const context = createContext();
    try {
      const rootPath = join(context.projectRoot, "legacy-mapping");
      mkdirSync(rootPath);
      const project = context.projects.create({ name: "legacy", rootPath, rootPathKey: realpathSync(rootPath) });
      context.database
        .prepare(
          [
            "INSERT INTO v2_project_workspace_mappings",
            "(remote_project_id, local_project_id, server_origin, created_at, updated_at, last_validated_at)",
            "VALUES ('remote-legacy', @localProjectId, NULL, 1, 1, 1)",
          ].join(" "),
        )
        .run({ localProjectId: project.id });
      const saved = await context.server.inject({
        method: "PUT",
        url: "/api/v2/requirements/settings",
        headers: { host: context.host, origin: `http://${context.host}` },
        payload: { baseUrl: "https://requirements.fixture" },
      });
      expect(saved.json()).toMatchObject({ mappingCount: 1 });
      expect(context.workspaceMappings.getByRemoteProjectId("remote-legacy")?.serverOrigin).toBe("https://requirements.fixture");
    } finally {
      await context.server.close();
      context.database.close();
    }
  });

  it("创建需求会话：带英文语言头时会话记下 en，需求卡、规则与工具定义是英文", async () => {
    const context = createContext();
    try {
      configureRequirementsRemote(context);
      const mappingRoot = join(context.projectRoot, "requirement-session-mapping-en");
      mkdirSync(mappingRoot);
      addWorkspaceMapping(context, SESSION_PROJECT_ID, mappingRoot);
      const created = await context.server.inject({
        method: "POST",
        url: `/api/v2/requirements/${SESSION_REQUIREMENT_ID}/sessions`,
        headers: { host: context.host, origin: `http://${context.host}`, "x-suduo-locale": "en" },
        payload: {},
      });
      expect(created.statusCode).toBe(201);
      expect(context.sessions.getById(created.json<{ id: string }>().id)?.locale).toBe("en");
      const started = context.runtime.threadStarts.at(-1);
      expect(started?.developerInstructions).toContain("# SuDuo requirement session");
      expect(started?.developerInstructions).toContain("Reply in the language the user writes in.");
      expect(started?.dynamicTools?.find((tool) => tool.name === "suduo_requirement_get")?.description).toMatch(/^[\x20-\x7e“”‘’…—]+$/u);
    } finally {
      await context.server.close();
      context.database.close();
    }
  });

  it("创建需求会话可指定 Agent（多 Agent S3）：没接上的 Agent 报 400，其他字段与非字符串报 400", async () => {
    const context = createContext();
    try {
      configureRequirementsRemote(context);
      const mappingRoot = join(context.projectRoot, "requirement-session-mapping-agent");
      mkdirSync(mappingRoot);
      addWorkspaceMapping(context, SESSION_PROJECT_ID, mappingRoot);
      const post = (payload: unknown) =>
        context.server.inject({
          method: "POST",
          url: `/api/v2/requirements/${SESSION_REQUIREMENT_ID}/sessions`,
          headers: { host: context.host, origin: `http://${context.host}` },
          payload: payload as Record<string, unknown>,
        });
      const created = await post({ agentId: "codex" });
      expect(created.statusCode).toBe(201);
      expect(created.json<{ agentId: string }>().agentId).toBe("codex");
      // 测试上下文只注册了 Codex 运行时
      expect((await post({ agentId: "claude-code" })).statusCode).toBe(400);
      expect((await post({ agentId: 1 })).statusCode).toBe(400);
      expect((await post({ title: "x" })).statusCode).toBe(400);
    } finally {
      await context.server.close();
      context.database.close();
    }
  });

  it("创建需求会话：线程带需求卡与 suduo 工具，登记开工版本，不再生成快照与现状文件", async () => {
    const context = createContext();
    try {
      configureRequirementsRemote(context);
      const mappingRoot = join(context.projectRoot, "requirement-session-mapping");
      mkdirSync(mappingRoot);
      addWorkspaceMapping(context, SESSION_PROJECT_ID, mappingRoot);

      const created = await context.server.inject({
        method: "POST",
        url: `/api/v2/requirements/${SESSION_REQUIREMENT_ID}/sessions`,
        headers: { host: context.host, origin: `http://${context.host}` },
        payload: {},
      });
      expect(created.statusCode).toBe(201);
      const sessionId = created.json<{ id: string }>().id;
      const reference = context.requirementSessionRefs.getBySessionId(sessionId);
      expect(reference).toMatchObject({
        remoteRequirementId: SESSION_REQUIREMENT_ID,
        requirementVersion: 7,
        contextMode: "tools",
        materialPath: null,
        manifestSha256: null,
      });
      expect(reference?.auditAnchor.state).toBe("empty");
      const started = context.runtime.threadStarts.at(-1);
      expect(started?.developerInstructions).toContain("SuDuo 需求会话");
      expect(started?.dynamicTools?.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["suduo_requirement_get", "suduo_attachment_view", "suduo_comment_submit"]),
      );
      expect(existsSync(join(context.v2DataDirectory, "materials"))).toBe(false);
      expect(existsSync(join(context.v2DataDirectory, "observations"))).toBe(false);

      const sessionContext = await context.server.inject({
        method: "GET",
        url: `/api/v1/sessions/${sessionId}/context`,
        headers: { host: context.host },
      });
      expect(sessionContext.statusCode).toBe(200);
      expect(sessionContext.json()).toMatchObject({
        sessionId,
        kind: "requirement",
        contextMode: "tools",
        requirement: { remoteRequirementId: SESSION_REQUIREMENT_ID, startVersion: 7 },
      });
    } finally {
      await context.server.close();
      context.database.close();
    }
  });

  it("交给另一个 Agent 接着做（多 Agent 协作 S7）：同一需求 / 项目下开新会话，记下接续关系，两边互相显示；房间任务不行", async () => {
    const context = createContext();
    try {
      configureRequirementsRemote(context);
      const mappingRoot = join(context.projectRoot, "continue-mapping");
      mkdirSync(mappingRoot);
      addWorkspaceMapping(context, SESSION_PROJECT_ID, mappingRoot);
      const headers = { host: context.host, origin: `http://${context.host}` };
      const post = (url: string) => context.server.inject({ method: "POST", url, headers, payload: {} });
      const get = (url: string) => context.server.inject({ method: "GET", url, headers: { host: context.host } });

      const source = (await post(`/api/v2/requirements/${SESSION_REQUIREMENT_ID}/sessions`)).json<{ id: string; title: string }>();
      const continued = await post(`/api/v2/sessions/${source.id}/continue`);
      expect(continued.statusCode).toBe(201);
      const next = continued.json<{ id: string; parentSessionId: string; rootSessionId: string; relation: string; title: string }>();
      expect(next).toMatchObject({ parentSessionId: source.id, rootSessionId: source.id, relation: "continue", title: source.title });
      // 同一条需求：新会话也是需求会话。
      expect(context.requirementSessionRefs.getBySessionId(next.id)?.remoteRequirementId).toBe(SESSION_REQUIREMENT_ID);
      expect((await get(`/api/v1/sessions/${source.id}`)).json<{ links: unknown }>().links).toEqual({
        continuedFrom: null,
        continuedBy: [{ id: next.id, title: source.title, agentId: "codex", agentName: "Codex", state: "active" }],
      });
      expect((await get(`/api/v1/sessions/${next.id}`)).json<{ links: { continuedFrom: { id: string } } }>().links.continuedFrom.id).toBe(source.id);
      // 再接着做一次：根会话仍是最早那个。
      const third = (await post(`/api/v2/sessions/${next.id}/continue`)).json<{ parentSessionId: string; rootSessionId: string }>();
      expect(third).toMatchObject({ parentSessionId: next.id, rootSessionId: source.id });

      // 项目会话：沿用原会话的标题，所属项目不变。
      const project = (await post(`/api/v2/projects/${SESSION_PROJECT_ID}/sessions`)).json<{ id: string; title: string }>();
      const projectNext = (await post(`/api/v2/sessions/${project.id}/continue`)).json<{ id: string; title: string }>();
      expect(projectNext.title).toBe(project.title);
      expect(context.projectSessionRefs.getBySessionId(projectNext.id)?.remoteProjectId).toBe(SESSION_PROJECT_ID);

      const roomTask = context.sessions.create({ projectId: context.sessions.getById(source.id)!.projectId, title: "房间任务", kind: "room_task", state: "active" });
      expect((await post(`/api/v2/sessions/${roomTask.id}/continue`)).statusCode).toBe(400);
      expect((await post(`/api/v2/sessions/nope/continue`)).statusCode).toBe(404);
    } finally {
      await context.server.close();
      context.database.close();
    }
  });

  it("试未保存的需求服务地址会报告不可达且不写入本机配置", async () => {
    const context = createContext();
    try {
      context.requirementsRemote.state.connection = "unavailable";
      const before = snapshotTree(context.v2DataDirectory);
      const response = await context.server.inject({
        method: "POST",
        url: "/api/v2/requirements/settings/test",
        headers: { host: context.host, origin: `http://${context.host}` },
        payload: { baseUrl: "https://requirements-probe.example" },
      });

      expect(response.statusCode).toBe(503);
      expect(response.json().error).toMatchObject({
        code: "DEPENDENCY_UNAVAILABLE",
        message: "无法连接远程需求服务，请确认地址、网络和服务状态",
      });
      expect(snapshotTree(context.v2DataDirectory)).toEqual(before);
      expect(context.requirementsSettings.getBaseUrl()).toBeNull();
    } finally {
      await context.server.close();
      context.database.close();
    }
  });

  it("工作台路由恒 200，stats 的 tz 与 audit 的 projectId 均原样透传", async () => {
    const context = createContext();
    try {
      configureRequirementsRemote(context);
      const workbench = await context.server.inject({
        method: "GET",
        url: "/api/v2/my/workbench",
        headers: { host: context.host },
      });
      const stats = await context.server.inject({
        method: "GET",
        url: "/api/v2/projects/remote-project/stats?window=7d&tz=America%2FChicago",
        headers: { host: context.host },
      });
      const unknownParam = await context.server.inject({
        method: "GET",
        url: "/api/v2/projects/remote-project/stats?window=7d&tz=UTC&staleDays=7",
        headers: { host: context.host },
      });
      const audit = await context.server.inject({
        method: "GET",
        url: "/api/v2/audit?projectId=remote-project&resourceType=artifact_version",
        headers: { host: context.host },
      });

      expect(workbench.statusCode).toBe(200);
      expect(workbench.json()).toMatchObject({
        actions: { status: "ready" },
        requirements: { status: "ready" },
        sessions: { status: "ready" },
      });
      expect(stats.statusCode).toBe(200);
      expect(audit.statusCode).toBe(200);
      const requestedStats = context.requirementsRemote.state.requests.find((request) =>
        request.includes("/v2/projects/remote-project/stats"),
      );
      expect(new URL(requestedStats ?? "https://missing.test").searchParams.get("tz"))
        .toBe("America/Chicago");
      // 停滞改为按各状态的节奏判断，统一天数的参数已取消：旧页面带来也只是忽略，不让整块统计失败。
      expect(unknownParam.statusCode).toBe(200);
      const staleRequests = context.requirementsRemote.state.requests.filter((request) => request.includes("/stats"));
      expect(staleRequests.every((request) => new URL(request).searchParams.get("staleDays") === null)).toBe(true);
      const requestedAudit = context.requirementsRemote.state.requests.find((request) =>
        request.includes("/v2/audit"),
      );
      expect(new URL(requestedAudit ?? "https://missing.test").searchParams.get("projectId"))
        .toBe("remote-project");
    } finally {
      await context.server.close();
      context.database.close();
    }
  });

  it("project-mappings?verify=1 返回可用性且不写入目录、配置或映射", async () => {
    const context = createContext();
    try {
      const rootPath = join(context.projectRoot, "available-mapping");
      mkdirSync(rootPath);
      addWorkspaceMapping(context, "remote-available", rootPath);
      const beforeDirectory = snapshotTree(rootPath);
      const beforeConfig = snapshotTree(context.v2DataDirectory);
      const beforeMappings = context.workspaceMappings.list("https://requirements.fixture");

      const response = await context.server.inject({
        method: "GET",
        url: "/api/v2/project-mappings?verify=1",
        headers: { host: context.host },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().items).toEqual([
        expect.objectContaining({
          remoteProjectId: "remote-available",
          rootPath,
          verification: {
            exists: true,
            readable: true,
            writable: true,
            executable: true,
            available: true,
            message: "本机工作目录可用",
          },
        }),
      ]);
      expect(context.requirementsRemote.state.requests).toEqual([]);
      expect(snapshotTree(rootPath)).toEqual(beforeDirectory);
      expect(snapshotTree(context.v2DataDirectory)).toEqual(beforeConfig);
      expect(context.workspaceMappings.list("https://requirements.fixture")).toEqual(beforeMappings);
    } finally {
      await context.server.close();
      context.database.close();
    }
  });

  it("project-mappings?verify=1 报告目录不存在与无权限", async () => {
    const context = createContext();
    const inaccessiblePath = join(context.projectRoot, "inaccessible-mapping");
    try {
      const missingPath = join(context.projectRoot, "missing-mapping");
      mkdirSync(inaccessiblePath);
      addWorkspaceMapping(context, "remote-missing", missingPath);
      addWorkspaceMapping(context, "remote-inaccessible", inaccessiblePath);
      if (process.platform !== "win32") {
        chmodSync(inaccessiblePath, 0o000);
      }

      const response = await context.server.inject({
        method: "GET",
        url: "/api/v2/project-mappings?verify=1",
        headers: { host: context.host },
      });

      expect(response.statusCode).toBe(200);
      const items = response.json().items as Array<Record<string, unknown>>;
      const missing = items.find((item) => item["remoteProjectId"] === "remote-missing");
      expect(missing?.["verification"]).toMatchObject({
        exists: false,
        available: false,
        message: "本机工作目录不存在或无法访问",
      });
      const inaccessible = items.find(
        (item) => item["remoteProjectId"] === "remote-inaccessible",
      );
      if (process.platform !== "win32" && process.getuid?.() !== 0) {
        expect(inaccessible?.["verification"]).toMatchObject({
          exists: true,
          readable: false,
          writable: false,
          executable: false,
          available: false,
        });
      }
    } finally {
      if (existsSync(inaccessiblePath) && process.platform !== "win32") {
        chmodSync(inaccessiblePath, 0o700);
      }
      await context.server.close();
      context.database.close();
    }
  });

  it("只会用 mock 系统编辑器打开当前 CODEX_HOME/config.toml，并拒绝其它路径", async () => {
    const context = createContext();
    try {
      mkdirSync(context.codexHome, { recursive: true });
      const configFile = join(context.codexHome, "config.toml");
      writeFileSync(configFile, "model = \"gpt-5.6\"\n");
      const opened = await context.server.inject({
        method: "POST",
        url: "/api/v1/codex/config-file/open",
        headers: { host: context.host, origin: `http://${context.host}` },
        payload: {},
      });
      const rejected = await context.server.inject({
        method: "POST",
        url: "/api/v1/codex/config-file/open",
        headers: { host: context.host, origin: `http://${context.host}` },
        payload: { path: join(context.projectRoot, "other.toml") },
      });

      expect(opened.statusCode).toBe(200);
      expect(opened.json()).toEqual({ opened: true, path: configFile });
      expect(context.openedConfigFiles).toEqual([configFile]);
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json().error.message).toBe("只能打开当前 CODEX_HOME 的 config.toml");
      expect(context.openedConfigFiles).toEqual([configFile]);
    } finally {
      await context.server.close();
      context.database.close();
    }
  });

  it("配置文件缺失时不会调用系统编辑器", async () => {
    const context = createContext();
    try {
      const response = await context.server.inject({
        method: "POST",
        url: "/api/v1/codex/config-file/open",
        headers: { host: context.host, origin: `http://${context.host}` },
        payload: {},
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error.message).toBe("Codex 配置文件不存在，无法打开");
      expect(context.openedConfigFiles).toEqual([]);
    } finally {
      await context.server.close();
      context.database.close();
    }
  });
});

function createContext(options: {
  settingsEnv?: NodeJS.ProcessEnv;
} = {}) {
  const projectRoot = mkdtempSync(join(tmpdir(), "suduo-http-"));
  temporaryPaths.push(projectRoot);
  // 基线不能放进 projectRoot：它同时是测试项目的根目录，会被当成项目文件扫进基线。
  const baselineRoot = mkdtempSync(join(tmpdir(), "suduo-http-baselines-"));
  temporaryPaths.push(baselineRoot);
  const database = openBetterSqlite3Database(":memory:");
  runMigrations(database);
  const projects = new ProjectRepository(database);
  const sessions = new SessionRepository(database);
  const threads = new SessionThreadRepository(database);
  const events = new EventRepository(database);
  const approvals = new ApprovalRepository(database);
  const workspaceMappings = new WorkspaceMappingRepository(database);
  const requirementSessionRefs = new RequirementSessionRefRepository(database);
  const projectSessionRefs = new ProjectSessionRefRepository(database);
  const broker = new EventBroker();
  const ledger = new EventLedger(database, events, approvals, broker);
  const runtime = new FakeRuntime();
  const registry = new RuntimeRegistry();
  registry.register(runtime);
  const supervisor = new RuntimeSupervisor(registry);
  const sessionService = new SessionService(
    database,
    projects,
    sessions,
    threads,
    supervisor,
    undefined,
    undefined,
    requirementSessionRefs,
    undefined,
    null,
    projectSessionRefs,
  );
  const approvalService = new ApprovalService(approvals, threads, registry, ledger);
  const codexGlobalState = new CodexGlobalState();
  const v2DataDirectory = join(projectRoot, "requirements-v2");
  const requirementsSettings = new RequirementsSettingsStore(v2DataDirectory);
  const requirementsCredentials = new RequirementsCredentialStore(v2DataDirectory);
  const requirementsRemote = createRequirementsRemoteClient(
    requirementsSettings,
    requirementsCredentials,
  );
  // 与 server-application 一致：目录关联只看当前服务器的。
  const currentServerMappings = {
    list: () => workspaceMappings.list(requirementsSettings.getBaseUrl()),
    listByLocalProjectId: (localProjectId: string) =>
      workspaceMappings.listByLocalProjectId(requirementsSettings.getBaseUrl(), localProjectId),
  };
  const sessionContext = new SessionContextService({
    sessions,
    projects,
    projectRefs: projectSessionRefs,
    refs: requirementSessionRefs,
    remote: requirementsRemote.client,
  });
  const requirementsV2 = new RequirementsV2Service(
    requirementsSettings,
    requirementsCredentials,
    requirementsRemote.client,
    workspaceMappings,
    projects,
    sessionService,
    requirementSessionRefs,
    database,
    sessionContext,
  );
  const myWorkbench = new MyWorkbenchService({
    refs: requirementSessionRefs,
    approvals,
    sessions,
    events,
    projects,
    mappings: currentServerMappings,
    remote: requirementsRemote.client,
  });
  const codexHome = join(projectRoot, "codex-home");
  const openedConfigFiles: string[] = [];
  const proxyProbes: ProxySettings[] = [];
  const settings = new SettingsService(
    join(projectRoot, "settings.json"),
    options.settingsEnv,
  );
  // 测试里的请求默认按中文出错误文字（与前端测试固定 zh-CN 一致）；英文由专门的测试带请求头覆盖。
  settings.rememberLocale("zh-CN");
  const server = buildHttpServer({
    requestGuard: new LoopbackGuard(),
    idempotency: new IdempotencyService(new IdempotencyRepository(database)),
    projects: new ProjectService(projects, sessions),
    sessions: sessionService,
    runStatus: new SessionRunStatusService(projects, sessions, events, approvals),
    messages: new MessageService(projects, sessions, threads, registry, supervisor, ledger, sessionContext),
    sessionContext,
    approvals: approvalService,
    interrupts: new InterruptService(projects, sessions, threads, events, registry, supervisor, ledger),
    eventStream: new SessionEventStream(events, broker),
    codexGlobalState,
    workspace: new WorkspaceService(projects, sessions, { roots: () => [] }, undefined, { baselineRoot }),
    workspaceWatcher: new WorkspaceWatcher(),
    git: new GitService(projects),
    settings,
    requirementsV2,
    myWorkbench,
    localDirectories: new LocalDirectoryService({
      recentRoots: () => mappedWorkspaceRoots(currentServerMappings, projects),
      linkedRemoteProjectIds: (path) => linkedRemoteProjectIds(currentServerMappings, projects, path),
    }),
    codexHome,
    openCodexConfigFile: async (absolutePath) => {
      openedConfigFiles.push(absolutePath);
    },
    modelProvider: new ModelProviderService({
      controlPlane: {
        configRead: async () => ({
          config: {
            model_provider: "fixture",
            model_providers: { fixture: { name: "Fixture", base_url: "https://fixture.test" } },
          },
          origins: {},
          layers: [
            {
              name: { type: "user", file: "/fixture/config.toml" },
              version: "v1",
              config: {},
            },
          ],
        }),
        configBatchWrite: async () => ({
          status: "ok",
          version: "v2",
          overriddenMetadata: null,
        }),
        modelList: async () => ({ data: [], nextCursor: null }),
      },
      codexBin: "/fixture/codex",
      codexHome: projectRoot,
      cliRunner: async () => ({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }),
    }),
    proxyConnectivity: new ProxyConnectivityService(
      settings,
      { modelGatewayBaseUrl: async () => "https://fixture.test/v1" },
      async (_baseUrl, proxy) => {
        proxyProbes.push(proxy);
        return {
          reachable: true,
          targetOrigin: "https://fixture.test",
          statusCode: 401,
          usingProxy: proxy.allProxy !== "",
          message: "fixture reachable",
        };
      },
    ),
    skillAdmin: new SkillAdminService(join(projectRoot, ".test-global-skills")),
    setSkillEnabled: async () => undefined,
    doctor: async () => ({ status: "PASS", codexHome: "/test/.codex", platform: process.platform, mode: "installed", configDir: "/test/.codex", dataDir: "/test/data", port: 8787, checkedAt: "2026-07-12T00:00:00.000Z", checks: [] }),
    webRoot: projectRoot,
  });
  return {
    host: "127.0.0.1:8787",
    projectRoot,
    database,
    sessions,
    server,
    runtime,
    codexGlobalState,
    ingestor: new RuntimeEventIngestor(threads, ledger, codexGlobalState),
    v2DataDirectory,
    requirementsSettings,
    requirementsCredentials,
    requirementsRemote,
    workspaceMappings,
    requirementSessionRefs,
    projectSessionRefs,
    projects,
    codexHome,
    openedConfigFiles,
    proxyProbes,
  };
}

function createRequirementsRemoteClient(
  settings: RequirementsSettingsStore,
  credentials: RequirementsCredentialStore,
) {
  const state: {
    connection: "ok" | "unavailable";
    /** 健康检查里报告的云端版本；不设置时模拟不报告版本的较早云端。 */
    healthVersion?: string;
    healthFeatures?: unknown;
    requests: string[];
    requirementVersion: number;
    attachmentCount: number;
    expectedVersionHeaders: Array<string | null>;
    requirementUpdateBodies: unknown[];
    projectUpdateBodies: unknown[];
    requirementCreateBodies: unknown[];
    requirementListQueries: string[];
    readBodies: unknown[];
    activityQueries: string[];
    artifactFiles: ArtifactFileFixture[];
    artifactPublishBodies: unknown[];
    deletedArtifactAttachmentIds: Set<string>;
    sessionAttachments: unknown[];
    commentBodies: unknown[];
    /** 评论文件端点收到的请求（方法 + 路径 + 关键参数）。 */
    commentFileRequests: string[];
    commentConnection: "ok" | "unavailable";
    commentPostAttempts: number;
    commentListRequests: number;
    /** 附件与产物文件共用：键为附件 id 或产物文件 id。 */
    previewFiles: Map<string, { fileName: string; content: Buffer }>;
  } = {
    connection: "ok",
    requests: [],
    requirementVersion: 1,
    attachmentCount: 0,
    expectedVersionHeaders: [],
    requirementUpdateBodies: [],
    projectUpdateBodies: [],
    requirementCreateBodies: [],
    requirementListQueries: [],
    readBodies: [],
    activityQueries: [],
    artifactFiles: artifactFileFixtures(),
    artifactPublishBodies: [],
    deletedArtifactAttachmentIds: new Set(),
    sessionAttachments: [],
    commentBodies: [],
    commentFileRequests: [],
    commentConnection: "ok",
    commentPostAttempts: 0,
    commentListRequests: 0,
    previewFiles: new Map(),
  };
  const client = new RequirementsRemoteClient(settings, credentials, async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    state.requests.push(url.toString());
    if (url.pathname === "/v2/health") {
      if (state.connection === "unavailable") {
        throw new Error("connection refused");
      }
      return new Response(
        JSON.stringify({
          service: "suduo-requirements-service",
          status: "ok",
          ...(state.healthVersion === undefined ? {} : { version: state.healthVersion }),
          ...(state.healthFeatures === undefined ? {} : { features: state.healthFeatures }),
          database: { status: "ok", schemaVersion: "fixture" },
          uptimeMs: 1,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (init?.method === "GET" && /^\/v2\/projects\/[^/]+\/stats$/u.test(url.pathname)) {
      return new Response(
        JSON.stringify({ statusCounts: {}, staleRequirements: [], transitions: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (init?.method === "PUT" && /^\/v2\/requirements\/[^/]+\/read$/u.test(url.pathname)) {
      state.readBodies.push(JSON.parse(String(init.body ?? "{}")));
      return new Response(null, { status: 204 });
    }
    if (init?.method === "GET" && url.pathname === "/v2/audit") {
      return new Response(
        JSON.stringify({ items: [], nextCursor: null }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (
      init?.method === "GET" &&
      url.pathname === "/v2/requirements/remote-requirement/artifact-versions"
    ) {
      return new Response(JSON.stringify({ items: [artifactVersionSummary(state.artifactFiles)] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (
      init?.method === "POST" &&
      url.pathname === "/v2/requirements/remote-requirement/artifact-versions"
    ) {
      const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
      state.artifactPublishBodies.push(body);
      return new Response(JSON.stringify(artifactVersionDetail(state.artifactFiles)), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    if (
      init?.method === "GET" &&
      url.pathname === `/v2/artifact-versions/${ARTIFACT_VERSION_ID}`
    ) {
      return new Response(JSON.stringify(artifactVersionDetail(state.artifactFiles)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const attachmentContentMatch = /^\/v2\/attachments\/([^/]+)\/content$/u.exec(url.pathname);
    const previewAttachment = state.previewFiles.get(attachmentContentMatch?.[1] ?? "");
    if (init?.method === "GET" && previewAttachment !== undefined) {
      return remoteFileResponse(previewAttachment.fileName, previewAttachment.content);
    }
    if (init?.method === "GET" && attachmentContentMatch) {
      const file = state.artifactFiles.find(
        (item) => item.attachmentId === attachmentContentMatch[1],
      );
      if (!file || state.deletedArtifactAttachmentIds.has(file.attachmentId)) {
        return new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(file.content, {
        status: 200,
        headers: {
          "content-length": String(Buffer.byteLength(file.content)),
          "content-type": "application/octet-stream",
          "x-attachment-sha256": file.sha256,
        },
      });
    }
    const artifactFileMatch = /^\/v2\/artifact-versions\/([^/]+)\/files\/([^/]+)\/content$/u.exec(
      url.pathname,
    );
    const previewArtifactFile = state.previewFiles.get(artifactFileMatch?.[2] ?? "");
    if (init?.method === "GET" && previewArtifactFile !== undefined) {
      return remoteFileResponse(previewArtifactFile.fileName, previewArtifactFile.content);
    }
    if (init?.method === "GET" && artifactFileMatch?.[1] === ARTIFACT_VERSION_ID) {
      const file = state.artifactFiles.find((item) => item.id === artifactFileMatch[2]);
      if (!file) {
        return new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(file.content, {
        status: 200,
        headers: {
          "content-length": String(Buffer.byteLength(file.content)),
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename="${file.fileName}"`,
          "x-attachment-sha256": file.sha256,
        },
      });
    }
    if (init?.method === "GET" && url.pathname === "/v2/requirements/remote-requirement") {
      return new Response(JSON.stringify(remoteRequirementDetail()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (init?.method === "GET" && url.pathname === "/v2/projects/remote-project/requirements") {
      state.requirementListQueries.push(url.search);
      return new Response(JSON.stringify({
        items: [
          remoteRequirementSummary("remote-requirement", 7),
          remoteRequirementSummary("other-requirement", 8),
        ],
        nextCursor: "remote-next-cursor",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (init?.method === "POST" && url.pathname === "/v2/projects/remote-project/requirements") {
      const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
      state.requirementCreateBodies.push(body);
      return new Response(JSON.stringify(remoteRequirementSummary("created-requirement", 9)), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    if (
      init?.method === "GET" &&
      url.pathname === "/v2/projects/remote-project/requirements/by-number/7"
    ) {
      return new Response(JSON.stringify(remoteRequirementDetail()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (init?.method === "GET" && url.pathname === "/v2/users") {
      return new Response(JSON.stringify({
        items: [
          { id: "fixture-user", displayName: "Fixture User" },
          { id: "other-user", displayName: "Other User" },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (init?.method === "GET" && url.pathname === "/v2/requirements/remote-requirement/activity") {
      state.activityQueries.push(url.search);
      return new Response(JSON.stringify({
        items: [{
          id: "a1",
          requirementId: "remote-requirement",
          actor: { id: "fixture-user", displayName: "Fixture User" },
          action: "comment.created",
          resourceType: "comment",
          resourceId: "c1",
          createdAt: "2026-01-02T00:00:00.000Z",
          changes: [],
          comment: { id: "c1", body: "hi" },
          attachment: null,
          artifactVersion: null,
        }],
        nextCursor: null,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const projectMatch = /^\/v2\/projects\/([^/]+)$/u.exec(url.pathname);
    const fixtureProjectId = projectMatch?.[1];
    if (
      init?.method === "GET" &&
      (fixtureProjectId === SESSION_PROJECT_ID || fixtureProjectId === SHARED_PROJECT_ID)
    ) {
      return new Response(JSON.stringify({
        id: fixtureProjectId,
        name: fixtureProjectId === SESSION_PROJECT_ID ? "session-project" : "shared-project",
        isArchived: false,
        createdBy: { id: "fixture-user", displayName: "Fixture User" },
        updatedBy: { id: "fixture-user", displayName: "Fixture User" },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        version: 1,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (init?.method === "PATCH" && url.pathname === "/v2/projects/remote-project") {
      const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
      state.projectUpdateBodies.push(body);
      return new Response(JSON.stringify({
        id: "remote-project",
        name: body?.name ?? "remote-project",
        isArchived: body?.isArchived ?? false,
        createdBy: { id: "fixture-user", displayName: "Fixture User" },
        updatedBy: { id: "fixture-user", displayName: "Fixture User" },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        version: 2,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (init?.method === "PATCH" && url.pathname === "/v2/requirements/remote-requirement") {
      const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
      state.requirementUpdateBodies.push(body);
      return new Response(JSON.stringify(remoteRequirementDetail()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (
      init?.method === "GET" &&
      url.pathname === `/v2/requirements/${SESSION_REQUIREMENT_ID}`
    ) {
      return new Response(JSON.stringify(sessionRequirementDetail()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (
      init?.method === "GET" &&
      url.pathname === `/v2/requirements/${SESSION_REQUIREMENT_ID}/attachments`
    ) {
      return new Response(
        JSON.stringify({ items: state.sessionAttachments, requirementVersion: 7 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (
      init?.method === "GET" &&
      url.pathname === `/v2/requirements/${SESSION_REQUIREMENT_ID}/comments`
    ) {
      state.commentListRequests += 1;
      return new Response(
        JSON.stringify({ items: [], nextCursor: null }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (
      init?.method === "POST" &&
      url.pathname === `/v2/requirements/${SESSION_REQUIREMENT_ID}/comments`
    ) {
      state.commentPostAttempts += 1;
      if (state.commentConnection === "unavailable") {
        throw new Error("comment transport closed after POST dispatch");
      }
      const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
      state.commentBodies.push(body);
      return new Response(JSON.stringify({
        id: "77777777-7777-4777-8777-777777777777",
        requirementId: SESSION_REQUIREMENT_ID,
        artifactVersionId: null,
        body: body?.body,
        author: { id: "fixture-user", displayName: "Fixture User" },
        createdAt: "2026-09-05T00:00:00.000Z",
      }), { status: 201, headers: { "content-type": "application/json" } });
    }
    if (init?.method === "POST" && url.pathname === `/v2/requirements/${SESSION_REQUIREMENT_ID}/comment-files`) {
      const headers = new Headers(init.headers);
      state.commentFileRequests.push(`POST upload ${headers.get("content-type") ?? ""}`);
      return new Response(JSON.stringify({ id: "cf-1", requirementId: SESSION_REQUIREMENT_ID, commentId: null, fileName: "截图.png" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    if (init?.method === "GET" && url.pathname === "/v2/comment-files/cf-1/content") {
      state.commentFileRequests.push(`GET content ${url.searchParams.get("disposition") ?? ""} ${new Headers(init.headers).get("range") ?? ""}`);
      return new Response("png-bytes", {
        status: 200,
        headers: { "content-type": "image/png", "content-disposition": "inline; filename=\"a.png\"", etag: "\"sha\"" },
      });
    }
    if (init?.method === "GET" && url.pathname === "/v2/comment-files/cf-1") {
      return new Response(JSON.stringify({ id: "cf-1", requirementId: SESSION_REQUIREMENT_ID, commentId: "c-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (init?.method === "GET" && url.pathname === "/v2/comment-files/missing") {
      // 较早的需求服务没有这个端点：框架默认的 404 正文，不是我们的错误格式。
      return new Response(JSON.stringify({ message: "Route GET:/v2/comment-files/missing not found", error: "Not Found", statusCode: 404 }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    if (init?.method === "POST" && url.pathname === "/v2/comment-files/cf-1/save-as-attachment") {
      state.commentFileRequests.push(`POST save ${init.body === undefined ? "no-body" : "body"}`);
      return new Response(JSON.stringify({ attachment: { id: "att-from-comment" }, requirementVersion: 1 }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    if (
      init?.method === "POST" &&
      /^\/v2\/requirements\/[^/]+\/attachments$/u.test(url.pathname)
    ) {
      const expectedVersion = new Headers(init.headers).get("x-requirement-expected-version");
      state.expectedVersionHeaders.push(expectedVersion);
      state.attachmentCount += 1;
      return new Response(
        JSON.stringify({
          attachment: {
            id: `remote-attachment-${String(state.attachmentCount)}`,
            requirementId: "remote-requirement",
            fileName: "fixture.txt",
            contentType: "text/plain",
            sizeBytes: 1,
            sha256: "a".repeat(64),
            uploadedBy: { id: "fixture-user", displayName: "Fixture User" },
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          requirementVersion: state.requirementVersion,
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }
    if (init?.method === "DELETE" && /^\/v2\/attachments\/[^/]+\/content$/u.test(url.pathname)) {
      const expectedVersion = new Headers(init.headers).get("x-requirement-expected-version");
      state.expectedVersionHeaders.push(expectedVersion);
      state.attachmentCount -= 1;
      return new Response(
        JSON.stringify({
          attachment: {
            id: url.pathname.split("/")[3],
            requirementId: "remote-requirement",
            fileName: "fixture.txt",
            contentType: "text/plain",
            sizeBytes: 1,
            sha256: "a".repeat(64),
            uploadedBy: { id: "fixture-user", displayName: "Fixture User" },
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          requirementVersion: state.requirementVersion,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  });
  return { client, state };
}

/** 与远程需求服务一致的下载响应；内容按小块吐出，覆盖嗅探跨块读取与回放。 */
function remoteFileResponse(fileName: string, content: Buffer): Response {
  const fallback = fileName.replace(/[^\u0020-\u007e]/gu, "_").replace(/["\\]/gu, "_");
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= content.length) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(content.subarray(offset, offset + 1_500)));
      offset += 1_500;
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-length": String(content.length),
      "content-type": "application/octet-stream",
      "content-disposition":
        `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "x-attachment-sha256": createHash("sha256").update(content).digest("hex"),
      "x-content-type-options": "nosniff",
    },
  });
}

function configureRequirementsRemote(context: ReturnType<typeof createContext>): void {
  context.requirementsSettings.setBaseUrl("https://requirements.fixture");
  context.requirementsCredentials.save({
    baseUrl: "https://requirements.fixture",
    accessToken: "fixture-token",
    expiresAt: "2030-01-01T00:00:00.000Z",
    user: {
      id: "fixture-user",
      loginName: "fixture-user",
      displayName: "Fixture User",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  });
}

function artifactFileFixtures(count = 1): ArtifactFileFixture[] {
  return Array.from({ length: count }, (_, index) => {
    const ordinal = String(index + 1).padStart(12, "0");
    const content = index === 0 ? ARTIFACT_FILE_CONTENT : `released artifact bytes ${String(index + 1)}`;
    return {
      id: index === 0 ? ARTIFACT_FILE_ID : `33333333-3333-4333-8333-${ordinal}`,
      attachmentId:
        index === 0 ? ARTIFACT_ATTACHMENT_ID : `22222222-2222-4222-8222-${ordinal}`,
      fileName: index === 0 ? "released-prd.md" : `released-${String(index + 1)}.md`,
      content,
      sha256: createHash("sha256").update(content, "utf8").digest("hex"),
    };
  });
}

function artifactVersionDetail(files: ArtifactFileFixture[]) {
  return {
    id: ARTIFACT_VERSION_ID,
    requirementId: "remote-requirement",
    versionNumber: 1,
    publishedBy: { id: "fixture-user", displayName: "Fixture User" },
    publishedAt: "2026-01-01T00:00:00.000Z",
    fileCount: files.length,
    files: files.map((file) => ({
      id: file.id,
      artifactVersionId: ARTIFACT_VERSION_ID,
      attachmentId: file.attachmentId,
      fileName: file.fileName,
      sizeBytes: Buffer.byteLength(file.content),
      sha256: file.sha256,
    })),
  };
}

function artifactVersionSummary(files: ArtifactFileFixture[]) {
  return {
    id: ARTIFACT_VERSION_ID,
    requirementId: "remote-requirement",
    versionNumber: 1,
    publishedBy: { id: "fixture-user", displayName: "Fixture User" },
    publishedAt: "2026-01-01T00:00:00.000Z",
    fileCount: files.length,
  };
}

function remoteRequirementSummary(id: string, number: number) {
  const user = { id: "fixture-user", displayName: "Fixture User" };
  return {
    id,
    projectId: "remote-project",
    number,
    title: `Fixture ${id}`,
    summary: "",
    status: "draft",
    assignee: user,
    commentCount: 1,
    attachmentCount: 2,
    createdBy: user,
    updatedBy: user,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 3,
  };
}

function addRequirementSession(
  context: ReturnType<typeof createContext>,
  localProjectId: string,
  remoteRequirementId: string,
) {
  const session = context.sessions.create({
    projectId: localProjectId,
    title: `会话 ${remoteRequirementId}`,
    state: "active",
    purpose: "pm_requirement",
  });
  context.requirementSessionRefs.create({
    sessionId: session.id,
    remoteProjectId: "remote-project",
    remoteRequirementId,
    requirementVersion: 1,
    materialPath: join(context.v2DataDirectory, "materials", session.id),
    manifestSha256: "a".repeat(64),
  });
  return session;
}

function remoteRequirementDetail() {
  const user = { id: "fixture-user", displayName: "Fixture User" };
  return {
    id: "remote-requirement",
    projectId: "remote-project",
    number: 7,
    title: "Fixture requirement",
    summary: "Fixture requirement summary",
    status: "draft",
    assignee: null,
    commentCount: 0,
    attachmentCount: 0,
    createdBy: user,
    updatedBy: user,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 7,
    project: {
      id: "remote-project",
      name: "Fixture project",
      isArchived: false,
      version: 1,
    },
  };
}

function sessionRequirementDetail() {
  const user = { id: "fixture-user", displayName: "Fixture User" };
  return {
    id: SESSION_REQUIREMENT_ID,
    projectId: SESSION_PROJECT_ID,
    title: "Session fixture requirement",
    summary: "Session fixture requirement summary",
    status: "draft",
    createdBy: user,
    updatedBy: user,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 7,
    project: {
      id: SESSION_PROJECT_ID,
      name: "Session fixture project",
      isArchived: false,
      version: 1,
    },
  };
}

function addWorkspaceMapping(
  context: ReturnType<typeof createContext>,
  remoteProjectId: string,
  rootPath: string,
): void {
  // 比较键按真实路径（与保存关联、开会话时的校验一致）：macOS 的临时目录 /var 指向 /private/var。
  const project = context.projects.create({
    name: remoteProjectId,
    rootPath,
    rootPathKey: existsSync(rootPath) ? realpathSync(rootPath) : rootPath,
  });
  // 关联属于当前服务器：没配置时按测试默认的需求服务地址配上（不登录、不发请求）。
  const serverOrigin =
    context.requirementsSettings.getBaseUrl() ??
    context.requirementsSettings.setBaseUrl("https://requirements.fixture");
  context.workspaceMappings.save({
    remoteProjectId,
    localProjectId: project.id,
    serverOrigin,
  });
}

function snapshotTree(path: string): unknown {
  if (!existsSync(path)) {
    return null;
  }
  const info = statSync(path);
  if (!info.isDirectory()) {
    return { type: "file", contents: readFileSync(path, "utf8") };
  }
  return {
    type: "directory",
    entries: readdirSync(path)
      .sort()
      .map((entry) => [entry, snapshotTree(join(path, entry))]),
  };
}

async function readUntilSseData(response: Response): Promise<string> {
  if (!response.body) {
    throw new Error("SSE response has no body");
  }
  const reader = response.body.getReader();
  let body = "";
  try {
    while (!body.includes("\n\ndata: ") && !body.includes("data: ")) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      body += new TextDecoder().decode(next.value);
    }
    return body;
  } finally {
    await reader.cancel();
  }
}

async function write(context: ReturnType<typeof createContext>, input: { method: "POST"; url: string; key: string; body: unknown }) {
  return await context.server.inject({
    method: input.method,
    url: input.url,
    headers: { host: context.host, origin: `http://${context.host}`, "idempotency-key": input.key, "content-type": "application/json" },
    payload: JSON.stringify(input.body),
  });
}

class FakeRuntime implements AgentRuntime {
  readonly runtimeId = "codex-local";
  readonly runtimeKind = "codex";
  readonly turns: StartTurnInput[] = [];
  readonly approvals: ApproveInput[] = [];
  readonly interrupts: InterruptInput[] = [];
  readonly threadStarts: StartThreadInput[] = [];
  private threadOrdinal = 0;
  async startThread(input: StartThreadInput): Promise<StartThreadResult> {
    this.threadStarts.push(input);
    const thread = { threadRef: { runtimeId: this.runtimeId, runtimeKind: this.runtimeKind, threadId: `thread-${String(++this.threadOrdinal)}` }, role: "primary", metadata: {} };
    return { primaryThread: thread, threads: [thread] };
  }
  async startTurn(input: StartTurnInput): Promise<StartTurnResult> {
    this.turns.push(input);
    return { turnRef: { threadId: input.threadRef.threadId, turnId: "turn-1" }, acceptedAt: Date.now() };
  }
  async approve(input: ApproveInput): Promise<ApproveResult> { this.approvals.push(input); return { acknowledged: true }; }
  async interrupt(input: InterruptInput): Promise<void> { this.interrupts.push(input); }
  async *subscribe(): AsyncIterable<RuntimeEventDraft> { yield* []; }
}
