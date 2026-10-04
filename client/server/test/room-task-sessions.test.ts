import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  APPROVAL_MODE_POLICIES,
  ROOM_AGENT_SECURITY_POLICY,
  type AgentRuntime,
  type ApproveResult,
  type CodexTransportFactory,
  type JsonRpcId,
  type JsonValue,
  type RpcConnection,
  type RpcInbound,
  type RuntimeEventDraft,
  type StartThreadInput,
  type StartThreadResult,
  type StartTurnInput,
  type StartTurnResult,
} from "@suduo/client-contracts";
import { sessionSecurityPolicy } from "../src/application/approval-mode-cap.js";
import { EventBroker } from "../src/application/event-broker.js";
import { EventLedger } from "../src/application/event-ledger.js";
import { MessageService } from "../src/application/message-service.js";
import { RuntimeSupervisor } from "../src/application/runtime-supervisor.js";
import { SessionListService } from "../src/application/session-list-service.js";
import { SessionRunStatusService } from "../src/application/session-run-status-service.js";
import { SessionService } from "../src/application/session-service.js";
import { openBetterSqlite3Database } from "../src/infrastructure/db/better-sqlite3-database.js";
import { runMigrations } from "../src/infrastructure/db/migration-runner.js";
import { ApprovalRepository } from "../src/infrastructure/db/repositories/approval-repository.js";
import { EventRepository } from "../src/infrastructure/db/repositories/event-repository.js";
import { ProjectRepository } from "../src/infrastructure/db/repositories/project-repository.js";
import { RoomTaskSessionRepository } from "../src/infrastructure/db/repositories/room-task-session-repository.js";
import { SessionListRepository } from "../src/infrastructure/db/repositories/session-list-repository.js";
import { SessionRepository } from "../src/infrastructure/db/repositories/session-repository.js";
import { SessionThreadRepository } from "../src/infrastructure/db/repositories/session-thread-repository.js";
import { CodexRuntime, assertM1SecurityPolicy } from "../src/infrastructure/runtime/codex/codex-runtime.js";
import { RuntimeRegistry } from "../src/infrastructure/runtime/runtime-registry.js";

/**
 * 房间任务会话（迁移 016）：不进普通会话列表、按 kind 筛选可见；安全档固定为房间 Agent 档，
 * Codex 回合里映射成 `{type:"readOnly", networkAccess:true}` + 不审批。
 */

const temporaryPaths: string[] = [];
afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

class FakeRuntime implements AgentRuntime {
  readonly runtimeId = "codex-local";
  readonly runtimeKind = "codex";
  readonly threads: StartThreadInput[] = [];
  readonly turns: StartTurnInput[] = [];
  async startThread(input: StartThreadInput): Promise<StartThreadResult> {
    this.threads.push(input);
    const thread = {
      threadRef: { runtimeId: "codex-local", runtimeKind: "codex", threadId: "thread-" + String(this.threads.length) },
      role: "primary",
      metadata: {},
    };
    return { primaryThread: thread, threads: [thread] };
  }
  async startTurn(input: StartTurnInput): Promise<StartTurnResult> {
    this.turns.push(input);
    return { turnRef: { threadId: input.threadRef.threadId, turnId: "turn-1" }, acceptedAt: Date.now() };
  }
  async approve(): Promise<ApproveResult> {
    return { acknowledged: true };
  }
  async interrupt(): Promise<void> {}
  async *subscribe(): AsyncIterable<RuntimeEventDraft> {
    yield* [];
  }
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "suduo-room-task-"));
  temporaryPaths.push(root);
  const database = openBetterSqlite3Database(":memory:");
  runMigrations(database);
  const projects = new ProjectRepository(database);
  const sessions = new SessionRepository(database);
  const threads = new SessionThreadRepository(database);
  const events = new EventRepository(database);
  const approvals = new ApprovalRepository(database);
  const roomTasks = new RoomTaskSessionRepository(database);
  const runtime = new FakeRuntime();
  const registry = new RuntimeRegistry();
  registry.register(runtime);
  const supervisor = new RuntimeSupervisor(registry);
  const sessionService = new SessionService(database, projects, sessions, threads, supervisor);
  const ledger = new EventLedger(database, events, approvals, new EventBroker());
  const messages = new MessageService(projects, sessions, threads, registry, supervisor, ledger, null);
  const list = new SessionListService({ list: new SessionListRepository(database), threads, events, approvals });
  const runStatus = new SessionRunStatusService(projects, sessions, events, approvals);
  const project = projects.create({ name: "商家端", rootPath: root, rootPathKey: root });
  return { database, projects, sessions, sessionService, roomTasks, runtime, messages, list, runStatus, project };
}

describe("房间任务会话", () => {
  it("普通列表（跨项目与按项目）都不显示房间任务；kind=room_task 筛选可见并带房间话题", async () => {
    const context = setup();
    try {
      const normal = await context.sessionService.create(context.project.id, { title: "普通会话" });
      const task = await context.sessionService.create(
        context.project.id,
        { title: "订单中心 · 收货信息" },
        { developerInstructions: "房间固定层" },
        { kind: "room_task" },
      );
      context.roomTasks.upsert({
        agentId: "agent-1",
        roomId: "room-1",
        threadRootId: "m-4",
        sessionId: task.id,
        remoteProjectId: "proj-1",
        roomName: "订单中心",
        requirementId: null,
        requirementVersion: null,
        lastTriggerSeq: 4,
        lastRunId: "run-1",
        createdAt: 1,
      });

      const defaults = context.list.list({}, "zh-CN");
      expect(defaults.items.map((item) => item.id)).toEqual([normal.id]);
      expect(defaults.items[0]).toMatchObject({ kind: "normal", roomTask: null });

      const tasks = context.list.list({ kind: "room_task" }, "zh-CN");
      expect(tasks.items.map((item) => item.id)).toEqual([task.id]);
      // 按项目过滤时房间任务归房间所属项目（这里的本机目录没有关联任何项目）。
      expect(context.list.list({ kind: "room_task", remoteProjectId: "proj-1" }, "zh-CN").items.map((item) => item.id)).toEqual([task.id]);
      expect(context.list.list({ kind: "room_task", remoteProjectId: "proj-2" }, "zh-CN").items).toEqual([]);
      expect(tasks.items[0]).toMatchObject({
        kind: "room_task",
        title: "订单中心 · 收货信息",
        roomTask: { remoteProjectId: "proj-1", roomId: "room-1", roomName: "订单中心", threadRootId: "m-4", lastRunId: "run-1" },
      });

      expect(context.sessionService.list(context.project.id, {}).items.map((item) => item.id)).toEqual([normal.id]);
      expect(context.runStatus.list(context.project.id).items.map((item) => item.sessionId)).toEqual([normal.id]);
      expect(context.sessions.listActiveByLastActivity(10).map((item) => item.id)).toEqual([normal.id]);
    } finally {
      context.database.close();
    }
  });

  it("安全档：房间任务会话建线程与发回合都用房间 Agent 档；普通会话照旧按审批档", async () => {
    const context = setup();
    try {
      const task = await context.sessionService.create(context.project.id, { title: "房间任务" }, {}, { kind: "room_task" });
      const normal = await context.sessionService.create(context.project.id, { title: "普通" });
      expect(context.runtime.threads[0]!.security).toEqual(ROOM_AGENT_SECURITY_POLICY);
      expect(context.runtime.threads[1]!.security).toEqual(APPROVAL_MODE_POLICIES.ask);

      await context.messages.send(task.id, { content: [{ type: "text", text: "你好" }] }, "key-1");
      await context.messages.send(normal.id, { content: [{ type: "text", text: "你好" }] }, "key-2");
      expect(context.runtime.turns[0]!.security).toEqual(ROOM_AGENT_SECURITY_POLICY);
      expect(context.runtime.turns[1]!.security).toEqual(APPROVAL_MODE_POLICIES.ask);

      // 会话自己的审批档（哪怕被改成 full）不影响房间任务会话。
      expect(sessionSecurityPolicy({ approvalMode: "full", kind: "room_task" })).toEqual(ROOM_AGENT_SECURITY_POLICY);
      expect(sessionSecurityPolicy({ approvalMode: "auto" })).toEqual(APPROVAL_MODE_POLICIES.auto);
    } finally {
      context.database.close();
    }
  });

  it("Codex runtime 放行房间 Agent 档：thread/start 只读 + never，turn/start 的 sandboxPolicy 是 readOnly + 联网", async () => {
    expect(() => assertM1SecurityPolicy(ROOM_AGENT_SECURITY_POLICY)).not.toThrow();
    expect(() =>
      assertM1SecurityPolicy({ approvalPolicy: "never", approvalsReviewer: "user", sandbox: { mode: "workspace-write", networkAccess: true } }),
    ).toThrow("不在允许的组合内");

    const connection = new FakeRpcConnection();
    const transport: CodexTransportFactory = { kind: "stdio", connect: async () => connection };
    const runtime = new CodexRuntime({ transport, codexBin: "fake-codex" });
    const started = await runtime.startThread({
      mode: "create",
      sessionId: "s-1",
      projectRoot: "/tmp/project",
      workspaceRoots: ["/tmp/project"],
      security: ROOM_AGENT_SECURITY_POLICY,
    });
    await runtime.startTurn({
      sessionId: "s-1",
      threadRef: started.primaryThread.threadRef,
      clientTurnId: "client-1",
      input: [{ type: "text", text: "hi" }],
      projectRoot: "/tmp/project",
      workspaceRoots: ["/tmp/project"],
      security: ROOM_AGENT_SECURITY_POLICY,
    });
    expect(connection.requests.find((request) => request.method === "thread/start")?.params).toMatchObject({
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    expect(connection.requests.find((request) => request.method === "turn/start")?.params).toMatchObject({
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: true },
    });
  });
});

class FakeRpcConnection implements RpcConnection {
  readonly connectionId = "fake-connection";
  readonly transportKind = "stdio" as const;
  readonly requests: Array<{ method: string; params: JsonValue | undefined }> = [];
  async request(method: string, params: JsonValue | undefined): Promise<JsonValue> {
    this.requests.push({ method, params });
    if (method === "initialize") return { userAgent: "fake" };
    if (method === "thread/start" || method === "thread/resume") return { thread: { id: "thread-1" } };
    if (method === "turn/start") return { turn: { id: "turn-1" } };
    if (method === "config/read") return { config: {}, origins: {}, layers: [] };
    if (method === "model/list") return { data: [], nextCursor: null };
    return {};
  }
  async respond(id: JsonRpcId, result: JsonValue): Promise<void> {
    void id;
    void result;
  }
  async respondError(id: JsonRpcId, code: number, message: string): Promise<void> {
    void id;
    void code;
    void message;
  }
  async notify(): Promise<void> {}
  async *messages(): AsyncIterable<RpcInbound> {
    yield* [];
  }
  async close(): Promise<void> {}
}
