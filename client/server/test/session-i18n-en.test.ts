import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentRuntime,
  ApproveResult,
  RuntimeEventDraft,
  StartThreadResult,
  StartTurnInput,
  StartTurnResult,
} from "@suduo/client-contracts";
import { ApiError } from "../src/application/api-error.js";
import { MyWorkbenchService } from "../src/application/my-workbench-service.js";
import type { SessionRecord } from "../src/infrastructure/db/repositories/session-repository.js";
import type { RoomsRouteDependencies } from "../src/infrastructure/http/routes/rooms-routes.js";
import { createMinimalHttpContext } from "./helpers/minimal-http-context.js";

/**
 * `session` 分区：会话、消息、幂等、会话列表、分页、我的工作、房间路由的报错与文字按请求语言生成。
 * 带 `x-suduo-locale: en` 出英文；不带时用夹具记下的 zh-CN，与迁移前逐字一致。
 * 请求头里的语言会被记下来（之后不带头的请求沿用它），所以每个用例先发不带头的请求，之后的中文断言显式带 zh-CN。
 */

const HOST = "127.0.0.1:8787";
const EN = { "x-suduo-locale": "en" };
const ZH = { "x-suduo-locale": "zh-CN" };

class FixtureRuntime implements AgentRuntime {
  readonly runtimeId = "codex-local";
  readonly runtimeKind = "codex";
  failTurns = false;
  private threadOrdinal = 0;
  async startThread(): Promise<StartThreadResult> {
    const thread = {
      threadRef: { runtimeId: this.runtimeId, runtimeKind: this.runtimeKind, threadId: `thread-${String(++this.threadOrdinal)}` },
      role: "primary",
      metadata: {},
    };
    return { primaryThread: thread, threads: [thread] };
  }
  async startTurn(input: StartTurnInput): Promise<StartTurnResult> {
    if (this.failTurns) throw new Error("codex: connection reset");
    return { turnRef: { threadId: input.threadRef.threadId, turnId: "turn-1" }, acceptedAt: Date.now() };
  }
  async approve(): Promise<ApproveResult> { return { acknowledged: true }; }
  async interrupt(): Promise<void> { return undefined; }
  async *subscribe(): AsyncIterable<RuntimeEventDraft> { yield* []; }
}

const contexts: Array<ReturnType<typeof createMinimalHttpContext>> = [];

afterEach(async () => {
  for (const context of contexts.splice(0)) {
    await context.close();
  }
});

function setup(overrides: Parameters<typeof createMinimalHttpContext>[1] = {}) {
  const runtime = new FixtureRuntime();
  const context = createMinimalHttpContext(runtime, overrides);
  contexts.push(context);
  let keyOrdinal = 0;
  const send = (
    method: "POST" | "PATCH",
    url: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    context.server.inject({
      method,
      url,
      headers: {
        host: HOST,
        origin: `http://${HOST}`,
        "idempotency-key": `key-${String(++keyOrdinal)}`,
        "content-type": "application/json",
        ...headers,
      },
      payload: JSON.stringify(body),
    });
  const get = (url: string, headers: Record<string, string> = {}) =>
    context.server.inject({ method: "GET", url, headers: { host: HOST, ...headers } });
  const createProject = async () => {
    const project = await send("POST", "/api/v1/projects", { rootPath: context.projectRoot, name: "i18n" });
    expect(project.statusCode).toBe(201);
    return String(project.json<{ id: string }>().id);
  };
  return { runtime, context, send, get, createProject };
}

function errorOf(response: { json<T>(): T }): { code: string; message: string } {
  return response.json<{ error: { code: string; message: string } }>().error;
}

describe("会话报错按请求语言", () => {
  it("会话不存在、会话列表与分页的查询参数", async () => {
    const { get, createProject } = setup();
    expect(errorOf(await get("/api/v1/sessions/nope")).message).toBe("会话不存在");
    expect(errorOf(await get("/api/v1/sessions/nope", EN))).toMatchObject({ code: "NOT_FOUND", message: "Session not found" });

    expect(errorOf(await get("/api/v1/sessions?state=bad", EN)).message).toBe("state must be active, archived, or all");
    expect(errorOf(await get("/api/v1/sessions?state=bad", ZH)).message).toBe("state 仅允许 active / archived / all");
    expect(errorOf(await get("/api/v1/sessions?limit=500", EN)).message).toBe("limit must be a whole number from 1 to 200");
    expect(errorOf(await get("/api/v1/sessions?limit=500", ZH)).message).toBe("limit 必须是 1 到 200 的整数");

    const projectId = await createProject();
    expect(errorOf(await get(`/api/v1/projects/${projectId}/sessions?cursor=zzz`, EN)).message).toBe("Invalid cursor");
    expect(errorOf(await get(`/api/v1/projects/${projectId}/sessions?cursor=zzz`, ZH)).message).toBe("cursor 无效");
    expect(errorOf(await get("/api/v1/projects/nope/sessions/run-status", EN)).message).toBe("Project not found");
  });

  it("新会话没给标题时，默认名用创建请求的语言", async () => {
    const { send, createProject } = setup();
    const projectId = await createProject();
    const chinese = await send("POST", `/api/v1/projects/${projectId}/sessions`, {});
    expect(chinese.json()).toMatchObject({ title: "新会话" });
    const english = await send("POST", `/api/v1/projects/${projectId}/sessions`, {}, EN);
    expect(english.statusCode).toBe(201);
    expect(english.json()).toMatchObject({ title: "New session" });
    // 用户给了标题就原样用。
    expect((await send("POST", `/api/v1/projects/${projectId}/sessions`, { title: "Checkout" }, EN)).json()).toMatchObject({
      title: "Checkout",
    });
  });

  it("PATCH 与消息内容的校验", async () => {
    const { send, createProject } = setup();
    const projectId = await createProject();
    const sessionId = String((await send("POST", `/api/v1/projects/${projectId}/sessions`, {})).json<{ id: string }>().id);

    const effort = await send("PATCH", `/api/v1/sessions/${sessionId}`, { reasoningEffort: "HIGH" }, EN);
    expect(errorOf(effort).message).toMatch(/^reasoningEffort must be a lowercase level name \(e\.g\. .+\)\. To follow the default again, pass null\.$/u);
    expect(errorOf(await send("PATCH", `/api/v1/sessions/${sessionId}`, {}, EN)).message).toBe("PATCH must include at least one field");
    expect(errorOf(await send("PATCH", `/api/v1/sessions/${sessionId}`, {}, ZH)).message).toBe("PATCH 至少提供一个字段");

    const empty = await send("POST", `/api/v1/sessions/${sessionId}/messages`, { content: [] }, EN);
    expect(errorOf(empty)).toMatchObject({ code: "VALIDATION_ERROR", message: "content must have 1 to 64 items" });
    const image = await send(
      "POST",
      `/api/v1/sessions/${sessionId}/messages`,
      { content: [{ type: "image-url", url: "ftp://example.com/a.png" }] },
      EN,
    );
    expect(errorOf(image).message).toBe("Image URLs must use http or https");
    expect(errorOf(await send("POST", `/api/v1/sessions/${sessionId}/messages`, { content: [] }, ZH)).message).toBe(
      "content 必须包含 1 到 64 项",
    );
  });

  it("幂等：同一个键换了请求体；结果不确定（409 IDEMPOTENCY_INDETERMINATE）的说明也按请求语言", async () => {
    const { runtime, context, send, createProject } = setup();
    const reuse = (body: unknown, headers: Record<string, string> = {}) =>
      context.server.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers: { host: HOST, origin: `http://${HOST}`, "idempotency-key": "same-key", "content-type": "application/json", ...headers },
        payload: JSON.stringify(body),
      });
    expect((await reuse({ rootPath: context.projectRoot, name: "first" })).statusCode).toBe(201);
    expect(errorOf(await reuse({ rootPath: context.projectRoot, name: "second" }, EN))).toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
      message: "This Idempotency-Key was already used for a different request",
    });
    expect(errorOf(await reuse({ rootPath: context.projectRoot, name: "second" }, ZH)).message).toBe("相同 Idempotency-Key 已用于不同请求");

    const projectId = await createProject();
    const sessionId = String((await send("POST", `/api/v1/projects/${projectId}/sessions`, {})).json<{ id: string }>().id);
    runtime.failTurns = true;
    const message = { content: [{ type: "text", text: "hello" }] };
    const english = await send("POST", `/api/v1/sessions/${sessionId}/messages`, message, EN);
    expect(english.statusCode).toBe(409);
    expect(errorOf(english)).toMatchObject({ code: "IDEMPOTENCY_INDETERMINATE", message: "Couldn't confirm whether the turn started" });
    const chinese = await send("POST", `/api/v1/sessions/${sessionId}/messages`, message, ZH);
    expect(errorOf(chinese)).toMatchObject({ code: "IDEMPOTENCY_INDETERMINATE", message: "启动 turn 的结果不确定" });
  });

  it("房间端点：本机 Agent 状态按请求语言渲染，本机校验也是", async () => {
    const remote: RoomsRouteDependencies["remote"] = {
      forward: async () => {
        throw new Error("not used");
      },
      uploadRoomFile: async () => {
        throw new Error("not used");
      },
      downloadRoomFile: async () => {
        throw new Error("not used");
      },
    };
    const { context, get } = setup({
      rooms: {
        remote,
        agentState: () => ({
          status: "unregistered",
          agent: null,
          message: (t) => t.activity.agent.notSignedIn,
          activeRun: null,
          queuedRuns: 0,
        }),
      },
    });
    expect((await get("/api/v2/agents/self")).json()).toMatchObject({ message: "还没有登录需求服务" });
    expect((await get("/api/v2/agents/self", EN)).json()).toMatchObject({
      status: "unregistered",
      message: "Not signed in to the requirements service yet",
    });

    const notMultipart = await context.server.inject({
      method: "POST",
      url: "/api/v2/rooms/room-1/files",
      headers: { host: HOST, origin: `http://${HOST}`, "content-type": "application/json", ...EN },
      payload: "{}",
    });
    expect(errorOf(notMultipart).message).toBe("Room file uploads must use multipart/form-data");
    const notObject = await context.server.inject({
      method: "POST",
      url: "/api/v2/rooms/room-1/messages",
      headers: { host: HOST, origin: `http://${HOST}`, "content-type": "application/json", ...EN },
      payload: "[1]",
    });
    expect(errorOf(notObject).message).toBe("Request body must be a JSON object");
  });
});

describe("我的工作：各块的说明按请求语言", () => {
  it("映射失效、需求不可用、远程报错", async () => {
    const session = sessionRecord("s-1", "local-project");
    const service = (listRequirementsByIds: () => Promise<never[]>) =>
      new MyWorkbenchService({
        refs: {
          listAll: () => [{
            sessionId: session.id,
            remoteProjectId: "remote-project",
            remoteRequirementId: "requirement-1",
            requirementVersion: 1,
            materialPath: null,
            manifestSha256: null,
            auditAnchor: { state: "unknown", createdAt: null, id: null },
            requirementNumber: null,
            requirementTitle: "requirement-1",
            contextMode: "tools",
            createdAt: 1,
          }],
        },
        approvals: { countPendingGroupedBySession: () => new Map() },
        sessions: { getById: (id) => (id === session.id ? session : null), listActiveByLastActivity: () => [session] },
        events: { listRunStatusEventsForSessions: () => [] },
        projects: { getById: () => null },
        mappings: {
          list: () => [{ remoteProjectId: "remote-project", localProjectId: "gone", serverOrigin: "https://requirements.example", createdAt: 1, updatedAt: 1, lastValidatedAt: 1 }],
        },
        remote: {
          getProjectStats: async () => {
            throw new Error("not used");
          },
          listAudit: async () => ({ items: [], nextCursor: null }),
          listRequirementsByIds,
        },
      });

    const english = await service(async () => []).getWorkbench("en");
    expect(english.actions).toMatchObject({
      status: "ready",
      data: [{ kind: "invalid_mapping", message: "Local project record not found" }],
    });
    expect(english.requirements).toMatchObject({
      status: "ready",
      data: [{ availability: "unavailable", unavailableMessage: "Requirement unavailable" }],
    });
    const chinese = await service(async () => []).getWorkbench("zh-CN");
    expect(chinese.actions).toMatchObject({ data: [{ message: "本机项目记录不存在" }] });
    expect(chinese.requirements).toMatchObject({ data: [{ unavailableMessage: "需求不可用" }] });

    // 远程报的 ApiError 按请求语言渲染；其它错误（系统、第三方）用原文。
    const failing = service(async () => {
      throw new ApiError(503, "DEPENDENCY_UNAVAILABLE", (t) => t.common.internalError);
    });
    expect((await failing.getWorkbench("en")).requirements).toMatchObject({
      status: "unavailable",
      error: { code: "DEPENDENCY_UNAVAILABLE", message: "Something went wrong on the local service" },
    });
    expect((await failing.getWorkbench("zh-CN")).requirements).toMatchObject({
      error: { message: "服务端处理请求失败" },
    });
  });
});

function sessionRecord(id: string, projectId: string): SessionRecord {
  return {
    id,
    projectId,
    title: id,
    state: "active",
    purpose: "general",
    approvalMode: "ask",
    kind: "normal",
    locale: "zh-CN",
    agentId: "codex",
    model: null,
    reasoningEffort: null,
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: null,
    lastActivityAt: 1,
    archivedAt: null,
    deletedAt: null,
    error: null,
    version: 1,
  };
}
