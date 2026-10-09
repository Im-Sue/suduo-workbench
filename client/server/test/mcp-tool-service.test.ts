import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SUDUO_MCP_CONNECTION_ID,
  type AgentRuntime,
  type ApproveResult,
  type EventEnvelope,
  type JsonValue,
  type RuntimeEventDraft,
  type StartThreadInput,
  type StartThreadResult,
  type StartTurnResult,
} from "@suduo/client-contracts";
import { ApprovalService } from "../src/application/approval-service.js";
import { EventLedger } from "../src/application/event-ledger.js";
import { RuntimeSupervisor, toolServerTools, usesToolServer } from "../src/application/runtime-supervisor.js";
import { mcpToolSpecs, sessionToolNames } from "../src/application/session-tools/catalog.js";
import { RequirementTools } from "../src/application/session-tools/requirement-tools.js";
import { SessionContextService } from "../src/application/session-tools/session-context.js";
import { SessionToolService } from "../src/application/session-tools/session-tool-service.js";
import { openBetterSqlite3Database } from "../src/infrastructure/db/better-sqlite3-database.js";
import { runMigrations } from "../src/infrastructure/db/migration-runner.js";
import { ApprovalRepository } from "../src/infrastructure/db/repositories/approval-repository.js";
import { EventRepository } from "../src/infrastructure/db/repositories/event-repository.js";
import { ProjectRepository } from "../src/infrastructure/db/repositories/project-repository.js";
import { ProjectSessionRefRepository } from "../src/infrastructure/db/repositories/project-session-ref-repository.js";
import { RequirementSessionRefRepository } from "../src/infrastructure/db/repositories/requirement-session-ref-repository.js";
import { SessionRepository } from "../src/infrastructure/db/repositories/session-repository.js";
import { SessionThreadRepository } from "../src/infrastructure/db/repositories/session-thread-repository.js";
import { registerMcpEndpoint, type McpToolHost } from "../src/infrastructure/mcp/mcp-endpoint.js";
import { withLoopbackNoProxy } from "../src/infrastructure/mcp/loopback-no-proxy.js";
import { ToolTokenRegistry } from "../src/infrastructure/mcp/tool-tokens.js";
import { normalizeCodexNotification, OMITTED_IMAGE_URL } from "../src/infrastructure/runtime/codex/codex-event-normalizer.js";
import { threadConfig } from "../src/infrastructure/runtime/codex/codex-runtime.js";
import { RuntimeRegistry } from "../src/infrastructure/runtime/runtime-registry.js";
import { FakeRequirementsRemote } from "./helpers/fake-requirements-remote.js";
import { createMinimalHttpContext } from "./helpers/minimal-http-context.js";

/** 多 Agent S2：SuDuo 本机 MCP 工具服务（ADR-0015，技术设计 2.9、4.3）。 */

const THREAD_REF = { runtimeId: "codex-local", runtimeKind: "codex", threadId: "thread-1" };
const paths: string[] = [];
afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

class IdleRuntime implements AgentRuntime {
  readonly runtimeId = "codex-local";
  readonly runtimeKind = "codex";
  async startThread(): Promise<StartThreadResult> {
    throw new Error("unused");
  }
  async startTurn(): Promise<StartTurnResult> {
    throw new Error("unused");
  }
  async approve(): Promise<ApproveResult> {
    return { acknowledged: true };
  }
  async interrupt(): Promise<void> {}
  async *subscribe(): AsyncIterable<RuntimeEventDraft> {}
}

function setup(options: { draftAfterMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "suduo-mcp-tools-"));
  paths.push(root);
  const database = openBetterSqlite3Database(":memory:");
  runMigrations(database);
  const projects = new ProjectRepository(database);
  const sessions = new SessionRepository(database);
  const threads = new SessionThreadRepository(database);
  const refs = new RequirementSessionRefRepository(database);
  const events = new EventRepository(database);
  const approvals = new ApprovalRepository(database);
  const published: EventEnvelope<string, JsonValue>[] = [];
  const ledger = new EventLedger(database, events, approvals, { publish: (event) => published.push(event) });
  const project = projects.create({ name: "p", rootPath: root, rootPathKey: root });
  const session = sessions.create({ projectId: project.id, title: "REQ-1" });
  // 刚建、还没写需求关联的会话（建线程期间的状态）
  const sessionWithoutRef = sessions.create({ projectId: project.id, title: "REQ-2", locale: "en" });
  threads.attach({ sessionId: session.id, threadRef: THREAD_REF });
  refs.create({
    sessionId: session.id,
    remoteProjectId: "proj-1",
    remoteRequirementId: "req-1",
    requirementVersion: 2,
    requirementNumber: 1,
    requirementTitle: "商家端-订单详情优化",
  });
  const registry = new RuntimeRegistry();
  registry.register(new IdleRuntime());
  const remote = new FakeRequirementsRemote();
  const context = new SessionContextService({ sessions, projects, projectRefs: new ProjectSessionRefRepository(database), refs, remote });
  const service = new SessionToolService({
    runtimes: registry,
    threads,
    approvals,
    ledger,
    context,
    sessions,
    tools: new RequirementTools(remote),
    log: () => undefined,
    ...(options.draftAfterMs === undefined ? {} : { mcpDraftAfterMs: options.draftAfterMs }),
  });
  const approvalService = new ApprovalService(approvals, threads, registry, ledger);
  approvalService.setToolConfirmationHandler(service);
  const pendingCard = async () => {
    await vi.waitFor(() => expect(approvals.listBySession(session.id).some((approval) => approval.status === "pending")).toBe(true));
    return approvals.listBySession(session.id).find((approval) => approval.status === "pending")!;
  };
  const text = (result: { content: Array<{ type: string; text?: string }> }) => result.content.map((item) => item.text ?? "").join("\n");
  return { session, sessionWithoutRef, service, approvalService, approvals, remote, pendingCard, text };
}

const live = () => ({ requestKey: "s:1", signal: new AbortController().signal });
/** 需求会话建线程时授予的工具清单（与 dynamicTools 相同）。 */
const grant = (sessionId: string) => ({ sessionId, toolNames: sessionToolNames("requirement"), toolTimeoutSec: 600 });

describe("MCP 下发的工具定义", () => {
  it("工具名去掉 suduo_ 前缀，说明里不再有代码模式的写法", () => {
    for (const locale of ["zh-CN", "en"] as const) {
      const specs = mcpToolSpecs("requirement", locale);
      expect(specs.map((spec) => spec.name)).toEqual([
        "requirement_get",
        "requirement_comments",
        "requirement_attachments",
        "attachment_view",
        "notes_read",
        "notes_save",
        "comment_submit",
        "session_list",
        "session_read",
      ]);
      const all = JSON.stringify(specs);
      expect(all).not.toMatch(/suduo_/);
      expect(all).not.toMatch(/\bexec\b|text\(\)|image\(\)|tools\./);
    }
    expect(mcpToolSpecs("room", "zh-CN").map((spec) => spec.name)).toEqual(["room_history", "room_search", "room_file_view"]);
  });
});

describe("会话工具服务的 MCP 一侧", () => {
  it("tools/list 给令牌授予的清单；只读工具直接执行；清单外的不执行", async () => {
    const { session, service, text } = setup();
    expect(service.listTools(grant(session.id)).map((tool) => tool.name)).toEqual([
      "requirement_get",
      "requirement_comments",
      "requirement_attachments",
      "attachment_view",
      "notes_read",
      "notes_save",
      "comment_submit",
      "session_list",
      "session_read",
    ]);
    const result = await service.callTool(grant(session.id), "requirement_get", {}, live());
    expect(result.isError).toBe(false);
    // 回复里提到的工具名也换成 MCP 名
    expect(text(result)).toContain("requirement_comments");
    expect(text(result)).not.toContain("suduo_");
    expect((await service.callTool(grant(session.id), "room_history", {}, live())).isError).toBe(true);
    // 会话范围里有、但这个线程没被授予的工具也不执行
    const narrow = { sessionId: session.id, toolNames: ["suduo_requirement_get"], toolTimeoutSec: 600 };
    expect(service.listTools(narrow).map((tool) => tool.name)).toEqual(["requirement_get"]);
    expect((await service.callTool(narrow, "notes_read", {}, live())).isError).toBe(true);
  });

  it("建线程时 Agent 就来取清单：那时需求关联还没写入，清单照样完整（S2 端到端发现的时序）", () => {
    const { service, sessionWithoutRef } = setup();
    const names = service.listTools(grant(sessionWithoutRef.id)).map((tool) => tool.name);
    expect(names).toContain("comment_submit");
    expect(names).toHaveLength(9);
  });

  it("发评论：建确认卡（不属于任何运行时连接），确认后发出并回给这次调用", async () => {
    const { session, service, approvalService, pendingCard, remote, text } = setup();
    const pending = service.callTool(grant(session.id), "comment_submit", { body: "按月汇总的口径已确认" }, live());
    const card = await pendingCard();
    expect(card.runtimeConnectionId).toBe(SUDUO_MCP_CONNECTION_ID);
    expect(remote.callsOf("createComment")).toEqual([]);
    await approvalService.decide(card.id, { decision: "accept" });
    const result = await pending;
    expect(result.isError).toBe(false);
    expect(remote.callsOf("createComment")).toHaveLength(1);
    expect(text(result)).not.toBe("");
  });

  it("等确认等到截止时间：先回「已存为草稿」，卡片留着，之后确认照样发出", async () => {
    const { session, service, approvalService, approvals, pendingCard, remote, text } = setup({ draftAfterMs: 30 });
    const result = await service.callTool(grant(session.id), "comment_submit", { body: "草稿" }, live());
    expect(text(result)).toContain("草稿");
    const card = await pendingCard();
    // 本机服务重启或运行时断开时都不作废（它是草稿，不属于运行时连接）
    expect(approvalService.orphanPersistedPending("restart")).toBe(0);
    expect(approvals.getById(card.id)?.status).toBe("pending");
    const decided = await approvalService.decide(card.id, { decision: "accept" });
    expect(remote.callsOf("createComment")).toHaveLength(1);
    expect(decided.status).toBe("resolved");
  });

  it("用户的决定已在执行时到点：不回「已存为草稿」，等执行结果（审查第 4 条）", async () => {
    const { session, service, approvalService, pendingCard, remote, text } = setup({ draftAfterMs: 300 });
    const original = remote.createComment.bind(remote);
    remote.createComment = async (...args: Parameters<typeof original>) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return original(...args);
    };
    const pending = service.callTool(grant(session.id), "comment_submit", { body: "慢" }, live());
    const card = await pendingCard();
    const decided = approvalService.decide(card.id, { decision: "accept" });
    const result = await pending;
    expect(result.isError).toBe(false);
    expect(text(result)).not.toContain("草稿");
    expect(remote.callsOf("createComment")).toHaveLength(1);
    await decided;
  });

  it("执行中的卡：本进程里留着；重启后结果未知，作废并说明（审查第 3 条）", async () => {
    const { session, service, approvalService, approvals, pendingCard } = setup({ draftAfterMs: 30 });
    await service.callTool(grant(session.id), "comment_submit", { body: "崩溃前" }, live());
    const card = await pendingCard();
    expect(approvals.markDeciding(card.id, card.version, "accept")).toBe(true);
    expect(approvalService.orphanPersistedPending("disconnect", { inProcess: true })).toBe(0);
    expect(approvalService.orphanPersistedPending("restart")).toBe(1);
    expect(approvals.getById(card.id)?.status).toBe("orphaned");
  });

  it("Agent 撤回审批请求：只作废待确认的那张（多 Agent S3）", async () => {
    const { session, service, approvalService, approvals, pendingCard } = setup({ draftAfterMs: 30 });
    await service.callTool(grant(session.id), "comment_submit", { body: "撤回" }, live());
    const card = await pendingCard();
    expect(approvalService.orphanWithdrawn("no-such-ref", "x")).toBe(0);
    expect(approvalService.orphanWithdrawn(card.runtimeApprovalRef, "withdrawn")).toBe(1);
    expect(approvals.getById(card.id)?.status).toBe("orphaned");
  });

  it("Agent 取消这次调用：同样转草稿", async () => {
    const { session, service, pendingCard, text } = setup();
    const controller = new AbortController();
    const pending = service.callTool(grant(session.id), "comment_submit", { body: "取消" }, { requestKey: "s:2", signal: controller.signal });
    await pendingCard();
    controller.abort();
    expect(text(await pending)).toContain("草稿");
  });
});

describe("MCP 端点", () => {
  function server(host: McpToolHost) {
    const app = Fastify();
    const tokens = new ToolTokenRegistry();
    registerMcpEndpoint(app, { tokens, host, serverVersion: "test" });
    return { app, token: tokens.issue("session-1", ["suduo_requirement_get"], 600), tokens };
  }
  const echoHost: McpToolHost = {
    listTools: (grant) => [{ name: "echo", description: `${grant.sessionId}:${grant.toolNames.join(",")}`, inputSchema: { type: "object" } }],
    callTool: async (_sessionId, name, args, call) => {
      if (args["wait"] === true) {
        await new Promise<void>((resolve) => call.signal.addEventListener("abort", () => resolve(), { once: true }));
        return { content: [{ type: "text", text: "cancelled" }], isError: false };
      }
      return { content: [{ type: "text", text: `${name}:${JSON.stringify(args)}` }], isError: false };
    },
  };
  const post = (app: ReturnType<typeof Fastify>, body: unknown, headers: Record<string, string>) =>
    app.inject({ method: "POST", url: "/mcp", headers: { host: "127.0.0.1:8787", "content-type": "application/json", ...headers }, payload: JSON.stringify(body) });

  it("没令牌、错令牌 401；跨源 403；非本机 Host 403", async () => {
    const { app, token } = server(echoHost);
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } };
    expect((await post(app, init, {})).statusCode).toBe(401);
    expect((await post(app, init, { authorization: "Bearer nope" })).statusCode).toBe(401);
    expect((await post(app, init, { authorization: `Bearer ${token}`, origin: "https://evil.example" })).statusCode).toBe(403);
    expect((await post(app, init, { authorization: `Bearer ${token}`, host: "10.0.0.2:8787" })).statusCode).toBe(403);
    const ok = await post(app, init, { authorization: `Bearer ${token}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ result: { protocolVersion: "2025-06-18", serverInfo: { name: "suduo" } } });
  });

  it("tools/list、tools/call、ping；通知回 202；令牌按会话", async () => {
    const { app, token, tokens } = server(echoHost);
    const auth = { authorization: `Bearer ${token}` };
    expect((await post(app, { jsonrpc: "2.0", method: "notifications/initialized" }, auth)).statusCode).toBe(202);
    expect((await post(app, { jsonrpc: "2.0", id: 2, method: "tools/list" }, auth)).json()).toMatchObject({ result: { tools: [{ name: "echo", description: "session-1:suduo_requirement_get" }] } });
    expect((await post(app, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { a: 1 } } }, auth)).json()).toMatchObject({ result: { content: [{ type: "text", text: 'echo:{"a":1}' }], isError: false } });
    expect((await post(app, { jsonrpc: "2.0", id: 4, method: "ping" }, auth)).json()).toMatchObject({ result: {} });
    expect((await post(app, { jsonrpc: "2.0", id: 5, method: "nope" }, auth)).json()).toMatchObject({ error: { code: -32601 } });
    // 只含 JSON-RPC 响应的 POST 回 202
    expect((await post(app, { jsonrpc: "2.0", id: 7, result: {} }, auth)).statusCode).toBe(202);
    // 重签后旧令牌作废
    tokens.issue("session-1", [], 600);
    expect((await post(app, { jsonrpc: "2.0", id: 6, method: "ping" }, auth)).statusCode).toBe(401);
  });

  it("notifications/cancelled 中止进行中的调用", async () => {
    const { app, token } = server(echoHost);
    const auth = { authorization: `Bearer ${token}` };
    const call = post(app, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "echo", arguments: { wait: true } } }, auth);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await post(app, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 9 } }, auth)).statusCode).toBe(202);
    expect((await call).json()).toMatchObject({ result: { content: [{ text: "cancelled" }] } });
  });
});

describe("监督器选择工具通道", () => {
  class ThreadRuntime implements AgentRuntime {
    readonly runtimeId = "codex-local";
    readonly runtimeKind = "codex";
    readonly inputs: StartThreadInput[] = [];
    readonly supportsToolServer?: boolean;
    constructor(supports: boolean) {
      if (supports) this.supportsToolServer = true;
    }
    async startThread(input: StartThreadInput): Promise<StartThreadResult> {
      this.inputs.push(input);
      const thread = { threadRef: THREAD_REF, role: "primary", metadata: { origin: "runtime" } };
      return { primaryThread: thread, threads: [thread] };
    }
    async startTurn(): Promise<StartTurnResult> {
      throw new Error("unused");
    }
    async approve(): Promise<ApproveResult> {
      return { acknowledged: true };
    }
    async interrupt(): Promise<void> {}
    async *subscribe(): AsyncIterable<RuntimeEventDraft> {}
  }
  const session = { id: "s-1", approvalMode: "ask", kind: "normal" } as never;
  const workspace = { executionRoot: "/repo" } as never;
  const tools = [{ name: "suduo_requirement_get", description: "d", inputSchema: {} }];

  it("运行时支持且工具服务在线：签令牌走 MCP（授予这份工具清单），主线程记下清单；续接时按清单重签", async () => {
    const runtime = new ThreadRuntime(true);
    const registry = new RuntimeRegistry();
    registry.register(runtime);
    const tokens = new ToolTokenRegistry();
    const supervisor = new RuntimeSupervisor(registry, {}, { tokens, url: () => "http://127.0.0.1:8787/mcp" });
    const started = await supervisor.createPrimaryThread({ runtimeId: "codex-local", session, workspace, dynamicTools: tools });
    expect(runtime.inputs[0]).toMatchObject({ toolServer: { url: "http://127.0.0.1:8787/mcp", toolTimeoutSec: 600 } });
    expect(runtime.inputs[0]).not.toHaveProperty("dynamicTools");
    expect(usesToolServer(started.primaryThread.metadata)).toBe(true);
    expect(started.primaryThread.metadata).toMatchObject({ origin: "runtime", suDuoTools: ["suduo_requirement_get"] });
    expect(toolServerTools(started.primaryThread.metadata)).toEqual(["suduo_requirement_get"]);
    const firstToken = runtime.inputs[0]!.toolServer!.token;
    expect(tokens.resolve(firstToken)).toEqual({ sessionId: "s-1", toolNames: ["suduo_requirement_get"], toolTimeoutSec: 600 });

    await supervisor.ensureReady({ session, workspace, binding: { threadRef: THREAD_REF, metadata: started.primaryThread.metadata } as never });
    const resumed = runtime.inputs[1]!;
    expect(resumed.mode).toBe("resume");
    expect(resumed.toolServer?.token).not.toBe(firstToken);
    expect(tokens.resolve(firstToken)).toBeNull();
    expect(tokens.resolve(resumed.toolServer!.token)).toEqual({ sessionId: "s-1", toolNames: ["suduo_requirement_get"], toolTimeoutSec: 600 });
  });

  it("工具服务还没监听时续接用 MCP 的线程：先不续接、不记为就绪；监听后再续接带上工具（审查第 1 条）", async () => {
    const runtime = new ThreadRuntime(true);
    const registry = new RuntimeRegistry();
    registry.register(runtime);
    let url: string | null = null;
    const supervisor = new RuntimeSupervisor(registry, {}, { tokens: new ToolTokenRegistry(), url: () => url });
    const binding = { threadRef: THREAD_REF, metadata: { suDuoToolChannel: "mcp", suDuoTools: ["suduo_requirement_get"] } } as never;
    await supervisor.ensureReady({ session, workspace, binding });
    expect(runtime.inputs).toHaveLength(0);
    url = "http://127.0.0.1:8787/mcp";
    await supervisor.ensureReady({ session, workspace, binding });
    expect(runtime.inputs).toHaveLength(1);
    expect(runtime.inputs[0]).toMatchObject({ mode: "resume", toolServer: { url: "http://127.0.0.1:8787/mcp" } });
  });

  it("续接时把运行时记在线程元数据里的说明带回去（Claude 的系统提示追加不进会话记录）", async () => {
    const runtime = new ThreadRuntime(true);
    const registry = new RuntimeRegistry();
    registry.register(runtime);
    const supervisor = new RuntimeSupervisor(registry, {}, { tokens: new ToolTokenRegistry(), url: () => "http://127.0.0.1:8787/mcp" });
    await supervisor.ensureReady({ session, workspace, binding: { threadRef: THREAD_REF, metadata: { suDuoInstructions: "需求卡" } } as never });
    expect(runtime.inputs[0]).toMatchObject({ mode: "resume", developerInstructions: "需求卡" });
  });

  it("运行时不支持或工具服务没在监听：沿用 dynamicTools；老线程续接不注入", async () => {
    for (const [supports, url] of [[false, "http://127.0.0.1:1/mcp"], [true, null]] as const) {
      const runtime = new ThreadRuntime(supports);
      const registry = new RuntimeRegistry();
      registry.register(runtime);
      const supervisor = new RuntimeSupervisor(registry, {}, { tokens: new ToolTokenRegistry(), url: () => url });
      const started = await supervisor.createPrimaryThread({ runtimeId: "codex-local", session, workspace, dynamicTools: tools });
      expect(runtime.inputs[0]).toMatchObject({ dynamicTools: tools });
      expect(runtime.inputs[0]).not.toHaveProperty("toolServer");
      expect(usesToolServer(started.primaryThread.metadata)).toBe(false);
    }
  });
});

describe("Codex 线程配置覆盖", () => {
  it("房间档关掉所有者的 MCP，同时保留 SuDuo 的工具服务", () => {
    const merged = threadConfig(
      { mcp_servers: { mine: { enabled: false } }, apps: { _default: { enabled: false } } },
      { url: "http://127.0.0.1:8787/mcp", token: "t", toolTimeoutSec: 600 },
    );
    expect(merged.config).toEqual({
      mcp_servers: {
        mine: { enabled: false },
        suduo: {
          enabled: true,
          url: "http://127.0.0.1:8787/mcp",
          http_headers: { Authorization: "Bearer t" },
          tool_timeout_sec: 600,
          startup_timeout_sec: 20,
          default_tools_approval_mode: "approve",
        },
      },
      apps: { _default: { enabled: false } },
    });
    expect(threadConfig(null, null)).toEqual({});
  });
});

describe("挂在本机服务上的 MCP 端点", () => {
  it("真连接上：读完请求体不算断开，调用不被中止；Agent 断开连接才中止", async () => {
    const tokens = new ToolTokenRegistry();
    const seen: string[] = [];
    const host: McpToolHost = {
      listTools: () => [],
      callTool: async (_grant, name, _args, call) => {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, name === "slow" ? 150 : 5_000);
          call.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
        seen.push(`${name}:${call.signal.aborted ? "aborted" : "ok"}`);
        return { content: [{ type: "text", text: call.signal.aborted ? "aborted" : "ok" }], isError: false };
      },
    };
    const context = createMinimalHttpContext(new IdleRuntime(), { toolMcp: { tokens, host, serverVersion: "test" } });
    try {
      const base = await context.listen();
      const headers = { authorization: `Bearer ${tokens.issue("session-1", [], 600)}`, "content-type": "application/json" };
      const call = (id: number, name: string, signal?: AbortSignal) =>
        fetch(base + "/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name } }), ...(signal ? { signal } : {}) });
      expect(await (await call(1, "slow")).json()).toMatchObject({ result: { content: [{ text: "ok" }] } });
      const controller = new AbortController();
      const hanging = call(2, "hang", controller.signal).catch(() => null);
      await new Promise((resolve) => setTimeout(resolve, 100));
      controller.abort();
      await hanging;
      await vi.waitFor(() => expect(seen).toEqual(["slow:ok", "hang:aborted"]));
    } finally {
      await context.close();
    }
  });

  it("Agent 不带 Origin 的 POST 不被全局守卫拦；其余写接口照旧要同源 Origin", async () => {
    const tokens = new ToolTokenRegistry();
    const host: McpToolHost = { listTools: () => [], callTool: async () => ({ content: [], isError: false }) };
    const context = createMinimalHttpContext(new IdleRuntime(), { toolMcp: { tokens, host, serverVersion: "test" } });
    try {
      const base = await context.listen();
      const token = tokens.issue("session-1", [], 600);
      const mcp = await fetch(base + "/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(mcp.status).toBe(200);
      expect(await mcp.json()).toMatchObject({ result: { tools: [] } });
      const api = await fetch(base + "/api/v1/projects", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(api.status).toBe(403);
    } finally {
      await context.close();
    }
  });
});

describe("Codex 记录的 SuDuo MCP 调用落成 SuDuo 工具调用", () => {
  const normalize = (method: string, item: Record<string, JsonValue>) =>
    (normalizeCodexNotification({
      runtimeId: "codex-local",
      connectionId: "connection-a",
      ordinal: 1,
      message: { kind: "notification", method, params: { threadId: "thread-1", turnId: "turn-1", item } },
    }).payload as Record<string, JsonValue>)["item"];
  // 形状取自 Codex 0.159.2 实测（isError 的结果记为 failed，内容保留，error 为 null）
  const mcpItem = (status: string, result: JsonValue, error: JsonValue = null): Record<string, JsonValue> => ({
    type: "mcpToolCall",
    id: "exec-1",
    server: "suduo",
    tool: "attachment_view",
    status,
    arguments: { attachmentId: "a-1" },
    appContext: null,
    mcpAppUi: null,
    pluginId: null,
    readOnlyHint: null,
    result,
    error,
    durationMs: 11,
  });

  it("完成：工具名补回前缀，文字与图片换成 inputText / inputImage，图片照常瘦身", () => {
    const result = { content: [{ type: "text", text: "附件" }, { type: "image", data: "iVBOR", mimeType: "image/png" }], structuredContent: null, _meta: null };
    expect(normalize("item/completed", mcpItem("completed", result))).toEqual({
      type: "dynamicToolCall",
      id: "exec-1",
      namespace: null,
      tool: "suduo_attachment_view",
      arguments: { attachmentId: "a-1" },
      status: "completed",
      contentItems: [
        { type: "inputText", text: "附件" },
        { type: "inputImage", imageUrl: OMITTED_IMAGE_URL },
      ],
      success: true,
      durationMs: 11,
    });
  });

  it("工具报错记为失败；调用本身出错用错误文字；进行中 success 为 null", () => {
    const failed = normalize("item/completed", mcpItem("failed", { content: [{ type: "text", text: "boom" }], structuredContent: null, _meta: null }));
    expect(failed).toMatchObject({ status: "failed", success: false, contentItems: [{ type: "inputText", text: "boom" }] });
    const errored = normalize("item/completed", mcpItem("failed", null, { message: "timed out" }));
    expect(errored).toMatchObject({ success: false, contentItems: [{ type: "inputText", text: "timed out" }] });
    expect(normalize("item/started", mcpItem("inProgress", null))).toMatchObject({ type: "dynamicToolCall", success: null, contentItems: null });
  });

  it("别的 MCP 服务的调用原样不动", () => {
    const other = { ...mcpItem("completed", { content: [], structuredContent: null, _meta: null }), server: "github" };
    expect(normalize("item/completed", other)).toEqual(other);
  });
});

describe("Agent 子进程的代理环境", () => {
  it("NO_PROXY / no_proxy 补上本机地址，已有的不重复，原环境不改（审查第 2 条）", () => {
    const source = { HTTP_PROXY: "http://10.0.0.2:7890", NO_PROXY: "localhost,.corp", PATH: "/bin" };
    expect(withLoopbackNoProxy(source)).toEqual({
      HTTP_PROXY: "http://10.0.0.2:7890",
      NO_PROXY: "localhost,.corp,127.0.0.1,::1",
      no_proxy: "127.0.0.1,localhost,::1",
      PATH: "/bin",
    });
    expect(source.NO_PROXY).toBe("localhost,.corp");
  });
});
