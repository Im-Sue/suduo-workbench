import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ROOM_AGENT_SECURITY_POLICY,
  type AgentRuntime,
  type ApproveResult,
  type InterruptInput,
  type JsonValue,
  type RuntimeEventDraft,
  type StartThreadInput,
  type StartThreadResult,
  type StartTurnInput,
  type StartTurnResult,
} from "@suduo/client-contracts";
import type {
  AgentDto,
  AgentRunProgressRequest,
  AgentRunStatus,
  AgentRunSummaryDto,
  CompleteAgentRunRequest,
  FinishAgentRunRequest,
  ListRoomMessagesQuery,
  ListRoomMessagesResponse,
  RoomDto,
  RoomMessageDto,
  StartAgentRunResponse,
} from "@suduo/cloud-contracts";
import { ApiError } from "../src/application/api-error.js";
import { EventBroker } from "../src/application/event-broker.js";
import { EventLedger } from "../src/application/event-ledger.js";
import { InterruptService } from "../src/application/interrupt-service.js";
import { MessageService } from "../src/application/message-service.js";
import type { RemoteEventsSignal } from "../src/application/remote-events-hub.js";
import { RoomAgentRunner, type RoomRunnerRemote } from "../src/application/room-agent/runner.js";
import { RuntimeSupervisor } from "../src/application/runtime-supervisor.js";
import { SessionService } from "../src/application/session-service.js";
import { SessionContextService } from "../src/application/session-tools/session-context.js";
import { openBetterSqlite3Database } from "../src/infrastructure/db/better-sqlite3-database.js";
import { runMigrations } from "../src/infrastructure/db/migration-runner.js";
import { ApprovalRepository } from "../src/infrastructure/db/repositories/approval-repository.js";
import { EventRepository } from "../src/infrastructure/db/repositories/event-repository.js";
import { ProjectRepository } from "../src/infrastructure/db/repositories/project-repository.js";
import { RequirementSessionRefRepository } from "../src/infrastructure/db/repositories/requirement-session-ref-repository.js";
import { RoomTaskSessionRepository } from "../src/infrastructure/db/repositories/room-task-session-repository.js";
import { SessionRepository } from "../src/infrastructure/db/repositories/session-repository.js";
import { SessionThreadRepository } from "../src/infrastructure/db/repositories/session-thread-repository.js";
import { WorkspaceMappingRepository } from "../src/infrastructure/db/repositories/workspace-mapping-repository.js";
import { RuntimeRegistry } from "../src/infrastructure/runtime/runtime-registry.js";
import { DEV, FakeRequirementsRemote, PM, requirementFixture } from "./helpers/fake-requirements-remote.js";

/**
 * RoomAgentRunner（技术设计 4.2 / 4.4）：真 SQLite + 真会话 / 消息 / 中断服务 + 假 Codex runtime + 假远程。
 * 回合事件由测试直接写进账本（与 runtime-event-ingestor 入账后的效果相同），runner 经 EventBroker 收到。
 */

const RUNTIME_ID = "codex-local";
const AGENT: AgentDto = {
  id: "agent-1",
  kind: "codex",
  owner: DEV,
  deviceName: "MacBook",
  label: "陈思远 的 Codex · MacBook",
  online: true,
  lastSeenAt: null,
  activeShareCount: 1,
};

const temporaryPaths: string[] = [];
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

class FakeRuntime implements AgentRuntime {
  readonly runtimeId = RUNTIME_ID;
  readonly runtimeKind = "codex";
  readonly threads: StartThreadInput[] = [];
  readonly turns: StartTurnInput[] = [];
  readonly interrupts: InterruptInput[] = [];
  async startThread(input: StartThreadInput): Promise<StartThreadResult> {
    this.threads.push(input);
    const thread = {
      threadRef: { runtimeId: RUNTIME_ID, runtimeKind: "codex", threadId: "thread-" + String(this.threads.length) },
      role: "primary",
      metadata: {},
    };
    return { primaryThread: thread, threads: [thread] };
  }
  async startTurn(input: StartTurnInput): Promise<StartTurnResult> {
    this.turns.push(input);
    return { turnRef: { threadId: input.threadRef.threadId, turnId: "turn-" + String(this.turns.length) }, acceptedAt: Date.now() };
  }
  async approve(): Promise<ApproveResult> {
    return { acknowledged: true };
  }
  async interrupt(input: InterruptInput): Promise<void> {
    this.interrupts.push(input);
  }
  async *subscribe(): AsyncIterable<RuntimeEventDraft> {
    yield* [];
  }
}

function message(seq: number, overrides: Partial<RoomMessageDto> = {}): RoomMessageDto {
  return {
    id: "m-" + String(seq),
    roomId: "room-1",
    seq,
    clientId: null,
    authorKind: "user",
    author: PM,
    agent: null,
    body: "第 " + String(seq) + " 条",
    mentions: [],
    threadRootId: null,
    files: [],
    thread: null,
    runs: [],
    createdAt: new Date(Date.now() - (100 - seq) * 60_000).toISOString(),
    ...overrides,
  };
}

function runFixture(id: string, overrides: Partial<AgentRunSummaryDto> = {}): AgentRunSummaryDto {
  return {
    id,
    roomId: "room-1",
    agent: AGENT,
    triggerMessageId: "m-4",
    threadRootId: "m-4",
    triggeredBy: PM,
    status: "queued",
    queuePosition: 0,
    progress: null,
    summary: null,
    replyMessageId: null,
    reason: null,
    stopRequested: false,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

/** 房间、消息、任务都在内存里的假远程需求服务。 */
class FakeRoomRemote extends FakeRequirementsRemote implements RoomRunnerRemote {
  readonly rooms = new Map<string, RoomDto>();
  messages: RoomMessageDto[] = [];
  readonly runs = new Map<string, AgentRunSummaryDto>();
  readonly started: string[] = [];
  readonly progress: Array<{ runId: string; body: AgentRunProgressRequest }> = [];
  readonly completed: Array<{ runId: string; body: CompleteAgentRunRequest }> = [];
  readonly finished: Array<{ runId: string; body: FinishAgentRunRequest }> = [];
  readonly listedStatuses: AgentRunStatus[] = [];
  /** startAgentRun 返回 started=false 的任务。 */
  readonly notStartable = new Set<string>();
  /** complete 时远程回 400（模拟远程不收这个回答）。 */
  rejectComplete = false;
  /** 回写（complete / finish）远程暂不可用（503）的剩余次数。 */
  unavailableReports = 0;
  /** 带执行过程的回写一律 500（模拟执行过程里有远程存不了的内容）。 */
  rejectReportEvents = false;
  /** startAgentRun 远程暂不可用（503）的剩余次数。 */
  unavailableStarts = 0;
  /** 回写时本机登录已失效（401）的剩余次数。 */
  unauthorizedReports = 0;

  async listAgentRuns(query: { agentId?: string; status?: AgentRunStatus }) {
    if (query.status !== undefined) this.listedStatuses.push(query.status);
    return {
      items: [...this.runs.values()].filter(
        (run) => (query.status === undefined || run.status === query.status) && (query.agentId === undefined || run.agent.id === query.agentId),
      ),
    };
  }
  async startAgentRun(runId: string): Promise<StartAgentRunResponse> {
    this.started.push(runId);
    if (this.unavailableStarts > 0) {
      this.unavailableStarts -= 1;
      throw new ApiError(503, "DEPENDENCY_UNAVAILABLE", "需求服务暂不可用");
    }
    const run = this.runs.get(runId) ?? runFixture(runId);
    if (this.notStartable.has(runId)) {
      return { run: { ...run, status: "stopped" }, started: false };
    }
    const running = { ...run, status: "running" as const, queuePosition: null };
    this.runs.set(runId, running);
    return { run: running, started: true };
  }
  async getRoom(roomId: string): Promise<RoomDto> {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error("room not found");
    return room;
  }
  async listRoomMessages(roomId: string, query: ListRoomMessagesQuery = {}): Promise<ListRoomMessagesResponse> {
    let items = this.messages.filter((item) => item.roomId === roomId).sort((a, b) => a.seq - b.seq);
    if (query.threadRootId !== undefined) {
      items = items.filter((item) => item.id === query.threadRootId || item.threadRootId === query.threadRootId);
    } else {
      items = items.filter((item) => item.threadRootId === null);
    }
    if (query.before !== undefined) items = items.filter((item) => item.seq < query.before!);
    const limit = query.limit ?? 50;
    const page = items.slice(-limit);
    return { items: page, hasMoreBefore: items.length > page.length, hasMoreAfter: false, lastSeq: items.at(-1)?.seq ?? 0 };
  }
  async progressAgentRun(runId: string, body: AgentRunProgressRequest) {
    this.progress.push({ runId, body });
    return this.runs.get(runId) ?? runFixture(runId);
  }
  private failReport(events: unknown[] | undefined): void {
    if (this.unauthorizedReports > 0) {
      this.unauthorizedReports -= 1;
      throw new ApiError(401, "AUTH_INVALID", "登录凭证无效或已过期，请重新登录");
    }
    if (this.unavailableReports > 0) {
      this.unavailableReports -= 1;
      throw new ApiError(503, "DEPENDENCY_UNAVAILABLE", "需求服务暂不可用");
    }
    if (this.rejectReportEvents && events !== undefined && events.length > 0) {
      throw new ApiError(502, "DEPENDENCY_UNAVAILABLE", "需求服务出错");
    }
  }
  async completeAgentRun(runId: string, body: CompleteAgentRunRequest) {
    this.completed.push({ runId, body });
    if (this.rejectComplete) throw new ApiError(400, "VALIDATION_ERROR", "远程服务拒绝了请求参数");
    this.failReport(body.events);
    const run = { ...(this.runs.get(runId) ?? runFixture(runId)), status: "completed" as const };
    this.runs.set(runId, run);
    return run;
  }
  async finishAgentRun(runId: string, body: FinishAgentRunRequest) {
    this.finished.push({ runId, body });
    this.failReport(body.events);
    const run = { ...(this.runs.get(runId) ?? runFixture(runId)), status: body.status };
    this.runs.set(runId, run);
    return run;
  }
}

function roomFixture(overrides: Partial<RoomDto> = {}): RoomDto {
  return {
    id: "room-1",
    projectId: "proj-1",
    kind: "project_default",
    name: "商家端",
    requirement: null,
    lastSeq: 10,
    archivedAt: null,
    createdBy: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    memberCount: 3,
    viewer: { joined: true, lastReadSeq: 0, unreadCount: 0, mentionCount: 0 },
    lastMessage: null,
    ...overrides,
  };
}

function setup(
  options: {
    progressIntervalMs?: number;
    eventsEveryTicks?: number;
    syncIntervalMs?: number;
    startRetryMs?: number[];
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "suduo-room-runner-"));
  temporaryPaths.push(root);
  const database = openBetterSqlite3Database(":memory:");
  runMigrations(database);
  const projects = new ProjectRepository(database);
  const sessions = new SessionRepository(database);
  const threads = new SessionThreadRepository(database);
  const events = new EventRepository(database);
  const approvals = new ApprovalRepository(database);
  const mappings = new WorkspaceMappingRepository(database);
  const refs = new RequirementSessionRefRepository(database);
  const roomTasks = new RoomTaskSessionRepository(database);
  const broker = new EventBroker();
  const ledger = new EventLedger(database, events, approvals, broker);
  const runtime = new FakeRuntime();
  const registry = new RuntimeRegistry();
  registry.register(runtime);
  const supervisor = new RuntimeSupervisor(registry);
  const sessionService = new SessionService(database, projects, sessions, threads, supervisor);
  const messageService = new MessageService(projects, sessions, threads, registry, supervisor, ledger, null);
  const interruptService = new InterruptService(projects, sessions, threads, events, registry, supervisor, ledger);
  const remote = new FakeRoomRemote(requirementFixture());
  remote.rooms.set("room-1", roomFixture());
  const project = projects.create({ name: "商家端", rootPath: root, rootPathKey: root });
  mappings.save({ remoteProjectId: "proj-1", localProjectId: project.id });
  const context = new SessionContextService({ sessions, projects, mappings, refs, remote, roomTasks });
  let listener: ((signal: RemoteEventsSignal) => void) | null = null;
  const logs: Array<Record<string, unknown>> = [];
  const runner = new RoomAgentRunner({
    remote,
    presence: { currentAgent: () => AGENT },
    hub: {
      subscribe: (next) => {
        listener = next;
        return () => {
          listener = null;
        };
      },
    },
    mappings,
    projects,
    roomTasks,
    sessionRecords: sessions,
    sessions: sessionService,
    messages: messageService,
    interrupts: interruptService,
    events,
    broker,
    context,
    progressIntervalMs: options.progressIntervalMs ?? 10,
    eventsEveryTicks: options.eventsEveryTicks ?? 1_000,
    reportRetryMs: [],
    syncIntervalMs: options.syncIntervalMs ?? 0,
    startRetryMs: options.startRetryMs ?? [60_000],
    log: (line) => logs.push(line),
  });
  runner.start();
  cleanups.push(() => {
    runner.stop();
    database.close();
  });

  let dedupe = 0;
  const append = (sessionId: string, turnId: string, type: string, payload: JsonValue) => {
    const binding = threads.getPrimary(sessionId)!;
    dedupe += 1;
    ledger.append({
      sessionId,
      sessionThreadId: binding.id,
      event: {
        source: "runtime:" + RUNTIME_ID,
        type,
        payload,
        threadRef: binding.threadRef,
        turnRef: { threadId: binding.threadRef.threadId, turnId },
        ts: Date.now(),
        dedupeKey: "test:" + String(dedupe),
      },
    });
  };
  const emitRun = (run: AgentRunSummaryDto) => {
    remote.runs.set(run.id, run);
    listener?.({
      type: "event",
      event: {
        event: "room",
        data: JSON.stringify({ id: 1, type: "room.run", projectId: "proj-1", roomId: run.roomId, run, occurredAt: new Date().toISOString() }),
      },
    });
  };
  const emitConnected = () => listener?.({ type: "connected", reconnect: true });
  /** 模拟 Codex 跑完一回合：看了一个文件、给出回答、回合完成。 */
  const completeTurn = (sessionId: string, turnId: string, reply: string) => {
    append(sessionId, turnId, "turn.started", { turn: { id: turnId } });
    append(sessionId, turnId, "item.completed", {
      item: { id: "cmd-" + turnId, type: "commandExecution", commandActions: [{ type: "read", name: "a.ts" }], aggregatedOutput: "ok" },
      extensions: { codex: { params: { big: "x" } } },
    });
    append(sessionId, turnId, "message.delta", { text: "后端", itemId: "msg-" + turnId });
    append(sessionId, turnId, "item.completed", { item: { id: "msg-" + turnId, type: "agentMessage", text: reply } });
    append(sessionId, turnId, "turn.completed", { turn: { id: turnId, status: "completed" } });
  };
  return {
    root,
    database,
    sessions,
    sessionService,
    project,
    roomTasks,
    runtime,
    remote,
    runner,
    logs,
    append,
    emitRun,
    emitConnected,
    completeTurn,
    events,
  };
}

async function until(check: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timeout: " + label);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function turnText(input: StartTurnInput): string {
  const first = input.input[0];
  return first?.type === "text" ? first.text : "";
}

describe("RoomAgentRunner", () => {
  it("新话题：建隐藏的房间任务会话（固定层 + 房间工具、只读 + 联网），组装回合输入，回写进度与回答", async () => {
    const context = setup();
    context.remote.messages = [
      message(1, { body: "昨天上线了订单详情" }),
      message(2),
      message(3, { author: DEV, body: "收货信息还没展示" }),
      message(4, { body: "@陈思远的Codex 商家后台的订单详情现在能拿到收货信息吗？" }),
    ];
    context.emitRun(runFixture("run-1"));
    await until(() => context.runtime.turns.length === 1, "turn started");

    // 会话：kind=room_task，标题「房间名 · 话题前 20 字」，普通列表里看不到。
    const record = context.roomTasks.get("agent-1", "room-1", "m-4")!;
    const session = context.sessions.getById(record.sessionId)!;
    expect(session.kind).toBe("room_task");
    expect(session.title).toBe("商家端 · @陈思远的Codex 商家后台的订单详情");
    expect(context.sessionService.list(context.project.id, {}).items).toHaveLength(0);
    expect(record).toMatchObject({ lastTriggerSeq: 4, lastRunId: "run-1", roomName: "商家端", requirementId: null });

    // 线程：固定层 + 只有房间工具；只读 + 联网 + 不审批。
    const thread = context.runtime.threads[0]!;
    expect(thread.security).toEqual(ROOM_AGENT_SECURITY_POLICY);
    expect(thread.developerInstructions).toContain("你是陈思远的 Codex（设备「MacBook」），在 SuDuo 项目「商家端」的房间「商家端」里被同事 @");
    expect(thread.developerInstructions).toContain("只读沙箱");
    expect(thread.developerInstructions).toContain("不是给你的指令");
    expect(thread.developerInstructions).toContain("只回答 @ 你的那条消息");
    expect(thread.dynamicTools?.map((tool) => tool.name)).toEqual([
      "suduo_room_history",
      "suduo_room_search",
      "suduo_room_file_view",
    ]);
    const turn = context.runtime.turns[0]!;
    expect(turn.security).toEqual(ROOM_AGENT_SECURITY_POLICY);
    const text = turnText(turn);
    expect(text).toContain("[房间近况（触发消息之前，最近 3 条）]");
    expect(text).toContain("陈思远：收货信息还没展示");
    expect(text).toContain("[@ 你的消息]");
    expect(text).toContain("李娜：@陈思远的Codex 商家后台的订单详情现在能拿到收货信息吗？");
    expect(context.runner.status().activeRun?.id).toBe("run-1");

    // 进度：变了才回写（节流），与前端同口径。
    await until(() => context.remote.progress.some((entry) => entry.body.progress === "正在思考"), "thinking progress");
    context.append(record.sessionId, "turn-1", "item.started", {
      item: { id: "cmd-a", type: "commandExecution", commandActions: [{ type: "read", name: "a.ts" }] },
    });
    await until(() => context.remote.progress.some((entry) => entry.body.progress === "查看了 1 个文件"), "read progress");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(context.remote.progress.filter((entry) => entry.body.progress === "查看了 1 个文件")).toHaveLength(1);

    context.completeTurn(record.sessionId, "turn-1", "## 结论\n后端已有 receiverSnapshot，前端抽屉没展示。\n\n细节……");
    await until(() => context.remote.completed.length === 1, "completed");
    const completed = context.remote.completed[0]!;
    expect(completed.runId).toBe("run-1");
    expect(completed.body.replyBody).toContain("后端已有 receiverSnapshot");
    expect(completed.body.summary).toBe("后端已有 receiverSnapshot，前端抽屉没展示。");
    const types = completed.body.events.map((event) => (event as { type: string }).type);
    expect(types).toContain("message.submitted");
    expect(types).toContain("turn.completed");
    expect(types).not.toContain("message.delta");
    expect(JSON.stringify(completed.body.events)).not.toContain("extensions");
    await until(() => context.runner.status().activeRun === null, "idle");

    // 续接：同一话题再次 @ → 复用会话与线程，只发上次之后的新消息（不含自己的回答）。
    context.remote.messages.push(
      message(5, { threadRootId: "m-4", authorKind: "agent", author: DEV, agent: AGENT, body: "后端已有 receiverSnapshot……" }),
      message(6, { threadRootId: "m-4", body: "补充：商家端 App 也要" }),
      message(7, { threadRootId: "m-4", body: "@陈思远的Codex 历史订单也有吗？" }),
    );
    context.emitRun(runFixture("run-2", { triggerMessageId: "m-7", threadRootId: "m-4" }));
    await until(() => context.runtime.turns.length === 2, "second turn");
    expect(context.runtime.threads).toHaveLength(1);
    expect(context.roomTasks.get("agent-1", "room-1", "m-4")).toMatchObject({ sessionId: record.sessionId, lastTriggerSeq: 7, lastRunId: "run-2" });
    const second = turnText(context.runtime.turns[1]!);
    expect(second).toContain("[话题里的新消息（你上次被 @ 之后）]");
    expect(second).toContain("补充：商家端 App 也要");
    expect(second).not.toContain("后端已有 receiverSnapshot");
    expect(second).not.toContain("房间近况");
    expect(second).toContain("@陈思远的Codex 历史订单也有吗？");
    context.completeTurn(record.sessionId, "turn-2", "历史订单也有。");
    await until(() => context.remote.completed.length === 2, "second completed");
  });

  it("串行：一次只跑一个、按排队顺序；start 返回 started=false 的跳过", async () => {
    const context = setup();
    context.remote.messages = [message(4), message(5), message(6)];
    context.remote.runs.set("run-a", runFixture("run-a", { queuePosition: 2, triggerMessageId: "m-4", threadRootId: "m-4" }));
    context.remote.runs.set("run-b", runFixture("run-b", { queuePosition: 0, triggerMessageId: "m-5", threadRootId: "m-5" }));
    context.remote.runs.set("run-c", runFixture("run-c", { queuePosition: 1, triggerMessageId: "m-6", threadRootId: "m-6" }));
    context.remote.notStartable.add("run-c");
    await context.runner.sync();
    await until(() => context.runtime.turns.length === 1, "first turn");
    expect(context.remote.started).toEqual(["run-b"]);
    expect(context.runner.status()).toMatchObject({ activeRun: { id: "run-b" }, queuedRuns: 2 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(context.remote.started).toEqual(["run-b"]);

    const first = context.roomTasks.get("agent-1", "room-1", "m-5")!;
    context.completeTurn(first.sessionId, "turn-1", "好的。");
    await until(() => context.runtime.turns.length === 2, "second turn");
    // run-c 开始不了（已不是排队中）就跳过，不建会话。
    expect(context.remote.started).toEqual(["run-b", "run-c", "run-a"]);
    expect(context.roomTasks.get("agent-1", "room-1", "m-6")).toBeNull();
    expect(context.logs.some((line) => line["event"] === "suduo.room_run.skipped" && line["runId"] === "run-c")).toBe(true);
  });

  it("房间所属项目在本机没有映射：finish failed「这台电脑没有为这个项目关联代码目录」", async () => {
    const context = setup();
    context.remote.rooms.set("room-2", roomFixture({ id: "room-2", projectId: "proj-unmapped", name: "别的项目" }));
    context.remote.messages = [message(4, { roomId: "room-2" })];
    context.emitRun(runFixture("run-x", { roomId: "room-2" }));
    await until(() => context.remote.finished.length === 1, "finished");
    expect(context.remote.finished[0]).toEqual({
      runId: "run-x",
      body: { status: "failed", reason: "这台电脑没有为这个项目关联代码目录" },
    });
    expect(context.runtime.threads).toHaveLength(0);
  });

  it("收到 stopRequested 的 room.run：中断本回合，回合结束后 finish stopped", async () => {
    const context = setup();
    context.remote.messages = [message(4)];
    context.emitRun(runFixture("run-s"));
    await until(() => context.runtime.turns.length === 1, "turn");
    const record = context.roomTasks.get("agent-1", "room-1", "m-4")!;
    context.emitRun(runFixture("run-s", { status: "running", stopRequested: true }));
    await until(() => context.runtime.interrupts.length === 1, "interrupt");
    expect(context.runtime.interrupts[0]).toMatchObject({ sessionId: record.sessionId, turnId: "turn-1" });
    context.append(record.sessionId, "turn-1", "turn.interrupted", { turn: { id: "turn-1", status: "interrupted" } });
    await until(() => context.remote.finished.length === 1, "finished");
    expect(context.remote.finished[0]!.body).toMatchObject({ status: "stopped", reason: "执行中被叫停" });
    expect(context.remote.completed).toHaveLength(0);
  });

  it("回合失败：finish failed，原因人话化；本回合事件一并回写", async () => {
    const context = setup();
    context.remote.messages = [message(4)];
    context.emitRun(runFixture("run-f"));
    await until(() => context.runtime.turns.length === 1, "turn");
    const record = context.roomTasks.get("agent-1", "room-1", "m-4")!;
    context.append(record.sessionId, "turn-1", "turn.completed", {
      turn: { id: "turn-1", status: "failed", error: { message: "limit", codexErrorInfo: "usageLimitExceeded" } },
    });
    await until(() => context.remote.finished.length === 1, "finished");
    const body = context.remote.finished[0]!.body;
    expect(body.status).toBe("failed");
    expect(body.reason).toContain("用量已经到上限");
    expect(body.events?.some((event) => (event as { type: string }).type === "turn.completed")).toBe(true);
  });

  it("需求房间：线程挂房间工具 + 需求只读工具（无笔记与写工具），固定层带需求卡", async () => {
    const context = setup();
    context.remote.rooms.set(
      "room-1",
      roomFixture({ kind: "requirement", name: "REQ-1 讨论", requirement: { id: "req-1", number: 1, title: "商家端-订单详情优化" } }),
    );
    context.remote.messages = [message(4)];
    context.emitRun(runFixture("run-r"));
    await until(() => context.runtime.turns.length === 1, "turn");
    const names = context.runtime.threads[0]!.dynamicTools?.map((tool) => tool.name) ?? [];
    expect(names).toEqual([
      "suduo_room_history",
      "suduo_room_search",
      "suduo_room_file_view",
      "suduo_requirement_get",
      "suduo_requirement_comments",
      "suduo_requirement_attachments",
      "suduo_attachment_view",
      "suduo_artifact_versions",
      "suduo_artifact_fetch",
    ]);
    const instructions = context.runtime.threads[0]!.developerInstructions ?? "";
    expect(instructions).toContain("房间「REQ-1 讨论」");
    expect(instructions).toContain("需求 REQ-1「商家端-订单详情优化」");
    expect(instructions).not.toContain("suduo_notes");
    expect(instructions).not.toContain("suduo_comment_submit");
    expect(context.roomTasks.get("agent-1", "room-1", "m-4")).toMatchObject({ requirementId: "req-1", requirementVersion: 3 });
    const record = context.roomTasks.get("agent-1", "room-1", "m-4")!;
    context.completeTurn(record.sessionId, "turn-1", "好。");
    await until(() => context.remote.completed.length === 1, "completed");
  });

  it("远程不收回答（4xx）：改成 finish failed，任务不会一直停在执行中；超长回答先截断", async () => {
    const context = setup();
    context.remote.messages = [message(4)];
    context.remote.rejectComplete = true;
    context.emitRun(runFixture("run-long"));
    await until(() => context.runtime.turns.length === 1, "turn");
    const record = context.roomTasks.get("agent-1", "room-1", "m-4")!;
    context.completeTurn(record.sessionId, "turn-1", "长".repeat(120_000));
    await until(() => context.remote.finished.length === 1, "fallback finish");
    expect(context.remote.completed[0]!.body.replyBody.length).toBeLessThanOrEqual(100_000);
    expect(context.remote.completed[0]!.body.replyBody).toContain("回答太长，后面省略");
    expect(context.remote.finished[0]!.body).toMatchObject({ status: "failed" });
    expect(context.remote.finished[0]!.body.reason).toContain("回答没能发到房间");
  });

  it("重启：远程仍是执行中、不是本进程开始的任务标失败（执行中断）；已收尾的不重复标", async () => {
    const context = setup();
    context.remote.runs.set("run-old", runFixture("run-old", { status: "running" }));
    await context.runner.sync();
    await context.runner.sync();
    expect(context.remote.finished).toEqual([
      { runId: "run-old", body: { status: "failed", reason: "执行中断（本机服务重启）" } },
    ]);
    // 每次同步都对账执行中的任务（不只启动时一次）。
    expect(context.remote.listedStatuses.filter((status) => status === "running")).toHaveLength(2);
  });

  it("上游重连信号触发补拉排队任务；别的 Agent 的任务不接", async () => {
    const context = setup();
    context.remote.messages = [message(4)];
    context.remote.runs.set(
      "run-other",
      runFixture("run-other", { agent: { ...AGENT, id: "agent-2" } }),
    );
    context.emitRun(runFixture("run-other", { agent: { ...AGENT, id: "agent-2" } }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(context.remote.started).toEqual([]);

    // 断线期间漏掉的 room.run：上游重连后按 REST 补拉到排队任务。
    context.remote.runs.set("run-missed", runFixture("run-missed"));
    context.emitConnected();
    await until(() => context.runtime.turns.length === 1, "missed run picked up");
    expect(context.remote.started).toEqual(["run-missed"]);
  });

  it("回写一直失败（远程暂不可用）：记下结果，下次同步再发；带执行过程发不出去时退一步不带执行过程", async () => {
    const context = setup();
    context.remote.messages = [message(4)];
    context.remote.rejectReportEvents = true;
    context.remote.unavailableReports = 1;
    context.emitRun(runFixture("run-r"));
    await until(() => context.runtime.turns.length === 1, "turn");
    const record = context.roomTasks.get("agent-1", "room-1", "m-4")!;
    context.completeTurn(record.sessionId, "turn-1", "结论：有。");
    // 第一次（带执行过程）503，第二次（不带执行过程）成功。
    await until(() => context.remote.runs.get("run-r")?.status === "completed", "completed without events");
    expect(context.remote.completed.map((entry) => entry.body.events.length > 0)).toEqual([true, false]);
    expect(context.remote.completed.at(-1)!.body.replyBody).toBe("结论：有。");
  });

  it("回写两次都失败：任务不卡在执行中——同步时重发记下的结果", async () => {
    const context = setup();
    context.remote.messages = [message(4)];
    context.remote.unavailableReports = 2;
    context.emitRun(runFixture("run-u"));
    await until(() => context.runtime.turns.length === 1, "turn");
    const record = context.roomTasks.get("agent-1", "room-1", "m-4")!;
    context.completeTurn(record.sessionId, "turn-1", "好的。");
    await until(() => context.remote.completed.length === 2, "two failed attempts");
    await until(() => context.runner.status().activeRun === null, "idle");
    expect(context.remote.runs.get("run-u")?.status).toBe("running");

    await context.runner.sync();
    expect(context.remote.runs.get("run-u")?.status).toBe("completed");
    expect(context.remote.completed.at(-1)!.body).toMatchObject({ replyBody: "好的。", events: [] });
    // 不会被误标成「本机服务重启」。
    expect(context.remote.finished).toEqual([]);
  });

  it("回答、原因与执行过程里的 NUL 字符上传前去掉（PostgreSQL 存不了）", async () => {
    const context = setup();
    context.remote.messages = [message(4)];
    context.emitRun(runFixture("run-nul"));
    await until(() => context.runtime.turns.length === 1, "turn");
    const record = context.roomTasks.get("agent-1", "room-1", "m-4")!;
    context.append(record.sessionId, "turn-1", "item.completed", {
      item: { id: "cmd-bin", type: "commandExecution", aggregatedOutput: "head\u0000\u0000tail", "k\u0000": "v" },
    });
    context.completeTurn(record.sessionId, "turn-1", "结论\u0000：有。");
    await until(() => context.remote.completed.length === 1, "completed");
    const body = context.remote.completed[0]!.body;
    expect(body.replyBody).toBe("结论：有。");
    expect(JSON.stringify(body.events)).not.toContain("\\u0000");
    expect(JSON.stringify(body.events)).toContain("headtail");
  });

  it("开始任务失败（远程暂不可用）：任务仍排队，按退避安排同步后再取", async () => {
    const context = setup({ startRetryMs: [20] });
    context.remote.messages = [message(4)];
    context.remote.unavailableStarts = 1;
    context.emitRun(runFixture("run-later"));
    await until(() => context.runtime.turns.length === 1, "picked up after retry sync");
    expect(context.remote.started).toEqual(["run-later", "run-later"]);
  });

  it("执行过程只传本回合：所有者在房间任务会话里另起的回合不上传", async () => {
    const context = setup();
    context.remote.messages = [message(4)];
    context.emitRun(runFixture("run-own"));
    await until(() => context.runtime.turns.length === 1, "turn");
    const record = context.roomTasks.get("agent-1", "room-1", "m-4")!;
    context.append(record.sessionId, "turn-private", "item.completed", {
      item: { id: "msg-private", type: "agentMessage", text: "所有者的私聊回答" },
    });
    context.completeTurn(record.sessionId, "turn-1", "房间里的回答。");
    await until(() => context.remote.completed.length === 1, "completed");
    const body = context.remote.completed[0]!.body;
    expect(JSON.stringify(body.events)).not.toContain("所有者的私聊回答");
    expect(body.events.some((event) => (event as { type: string }).type === "message.submitted")).toBe(true);
    expect(body.replyBody).toBe("房间里的回答。");
  });

  it("推送丢了停止信号：定时同步对账执行中的任务时拿到 stopRequested 并中断", async () => {
    const context = setup({ syncIntervalMs: 30 });
    context.remote.messages = [message(4)];
    context.emitRun(runFixture("run-lost-stop"));
    await until(() => context.runtime.turns.length === 1, "turn");
    // 远程已记下停止请求，但没有推送。
    context.remote.runs.set("run-lost-stop", runFixture("run-lost-stop", { status: "running", stopRequested: true }));
    await until(() => context.runtime.interrupts.length === 1, "interrupt via periodic sync");
    expect(context.remote.finished).toEqual([]);
  });

  it("同步不会把正在开始的任务当成重启前中断的", async () => {
    const context = setup();
    context.remote.messages = [message(4)];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalStart = context.remote.startAgentRun.bind(context.remote);
    context.remote.startAgentRun = async (runId: string) => {
      const response = await originalStart(runId);
      await gate;
      return response;
    };
    context.emitRun(runFixture("run-race"));
    await until(() => context.remote.runs.get("run-race")?.status === "running", "started remotely");
    await context.runner.sync();
    expect(context.remote.finished).toEqual([]);
    release();
    await until(() => context.runtime.turns.length === 1, "turn");
  });

  it("回写时登录失效（401）：不当成远程不收，记下来，重新登录后同步重发回答", async () => {
    const context = setup();
    context.remote.messages = [message(4)];
    context.remote.unauthorizedReports = 10;
    context.emitRun(runFixture("run-auth"));
    await until(() => context.runtime.turns.length === 1, "turn");
    const record = context.roomTasks.get("agent-1", "room-1", "m-4")!;
    context.completeTurn(record.sessionId, "turn-1", "结论：有。");
    await until(() => context.runner.status().activeRun === null, "idle");
    // 没有改成失败收尾。
    expect(context.remote.finished).toEqual([]);
    expect(context.remote.runs.get("run-auth")?.status).toBe("running");

    context.remote.unauthorizedReports = 0;
    await context.runner.sync();
    expect(context.remote.runs.get("run-auth")?.status).toBe("completed");
    expect(context.remote.completed.at(-1)!.body.replyBody).toBe("结论：有。");
    expect(context.remote.finished).toEqual([]);
  });

  it("同步拿到的执行中列表是旧快照：本进程已收尾的任务不再补标失败", async () => {
    const context = setup();
    context.remote.messages = [message(4)];
    context.emitRun(runFixture("run-done"));
    await until(() => context.runtime.turns.length === 1, "turn");
    const record = context.roomTasks.get("agent-1", "room-1", "m-4")!;
    context.completeTurn(record.sessionId, "turn-1", "好。");
    await until(() => context.remote.completed.length === 1, "completed");
    await until(() => context.runner.status().activeRun === null, "idle");
    // 模拟列表查询早于回写：远程快照里它还是执行中。
    const listAgentRuns = context.remote.listAgentRuns.bind(context.remote);
    context.remote.listAgentRuns = async (query) =>
      query.status === "running"
        ? { items: [runFixture("run-done", { status: "running" })] }
        : listAgentRuns(query);
    await context.runner.sync();
    expect(context.remote.finished).toEqual([]);
  });

  it("没回写成功的任务被重试后重新开始：旧结果作废，不会拿来覆盖新的一轮", async () => {
    const context = setup();
    context.remote.messages = [message(4)];
    context.remote.unavailableReports = 2;
    context.emitRun(runFixture("run-again"));
    await until(() => context.runtime.turns.length === 1, "turn");
    const record = context.roomTasks.get("agent-1", "room-1", "m-4")!;
    context.completeTurn(record.sessionId, "turn-1", "旧回答");
    await until(() => context.runner.status().activeRun === null, "idle");
    // 远程判离线收尾后，触发人重试：任务重新排队，本机再次开始。
    context.emitRun(runFixture("run-again", { status: "queued" }));
    await until(() => context.runtime.turns.length === 2, "second turn");
    await context.runner.sync();
    expect(context.remote.completed.filter((entry) => entry.body.replyBody === "旧回答")).toHaveLength(2);
    expect(context.remote.runs.get("run-again")?.status).toBe("running");
  });

  it("线程重建（rebuildSetup）：固定层补上话题此前的消息与自己上次的回答", async () => {
    const context = setup();
    context.remote.messages = [message(4)];
    context.emitRun(runFixture("run-rb"));
    await until(() => context.runtime.turns.length === 1, "turn");
    const record = context.roomTasks.get("agent-1", "room-1", "m-4")!;
    context.completeTurn(record.sessionId, "turn-1", "第一次的回答");
    await until(() => context.runner.status().activeRun === null, "idle");
    context.remote.messages.push(
      message(5, { threadRootId: "m-4", authorKind: "agent", agent: AGENT, author: DEV, body: "第一次的回答" }),
      message(6, { threadRootId: "m-4", body: "之后别人补充的" }),
    );
    const rebuilt = await context.runner.rebuildSetup(context.roomTasks.get("agent-1", "room-1", "m-4")!);
    expect(rebuilt?.developerInstructions).toContain("# SuDuo 房间");
    expect(rebuilt?.developerInstructions).toContain("线程重建");
    expect(rebuilt?.developerInstructions).toContain("第一次的回答");
    expect(rebuilt?.developerInstructions).not.toContain("之后别人补充的");
    expect(rebuilt?.dynamicTools.map((tool) => tool.name)).toContain("suduo_room_history");
  });
});
