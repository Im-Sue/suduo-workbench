import { afterEach, describe, expect, it } from "vitest";
import type { JsonValue, RuntimeRegistry } from "@suduo/client-contracts";
import type { EventLedger } from "../src/application/event-ledger.js";
import { closeQueuedAfterRestart, MessageService } from "../src/application/message-service.js";
import type { RuntimeSupervisor } from "../src/application/runtime-supervisor.js";
import { TurnScheduler } from "../src/application/scheduler/turn-scheduler.js";
import { openBetterSqlite3Database } from "../src/infrastructure/db/better-sqlite3-database.js";
import { runMigrations } from "../src/infrastructure/db/migration-runner.js";
import { EventRepository } from "../src/infrastructure/db/repositories/event-repository.js";
import { ProjectRepository } from "../src/infrastructure/db/repositories/project-repository.js";
import { SessionRepository } from "../src/infrastructure/db/repositories/session-repository.js";
import { SessionThreadRepository } from "../src/infrastructure/db/repositories/session-thread-repository.js";

/** 发消息经本机调度（多 Agent 协作 S8，需求 4.11「排队不拒绝」）。 */

const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

function setup(global = 1) {
  const database = openBetterSqlite3Database(":memory:");
  runMigrations(database);
  closers.push(() => database.close());
  const projects = new ProjectRepository(database);
  const sessions = new SessionRepository(database);
  const threads = new SessionThreadRepository(database);
  const project = projects.create({ name: "p", rootPath: "/tmp/suduo-scheduling", rootPathKey: "/tmp/suduo-scheduling" });
  const newSession = (title: string, agentId = "codex") => {
    const session = sessions.create({ projectId: project.id, title, state: "active", agentId });
    threads.attach({
      sessionId: session.id,
      threadRef: { runtimeId: "codex-local", runtimeKind: "codex", threadId: "thread-" + session.id },
      role: "primary",
      ordinal: 0,
      primary: true,
      metadata: {},
    });
    return session;
  };
  const started: string[] = [];
  const modes: string[] = [];
  let turnCount = 0;
  const runtimes = {
    get: () => ({
      startTurn: async (input: { sessionId: string; approvalMode: string }) => {
        started.push(input.sessionId);
        modes.push(input.approvalMode);
        turnCount += 1;
        return { turnRef: { threadId: "thread-" + input.sessionId, turnId: "turn-" + String(turnCount) }, acceptedAt: 1 };
      },
    }),
  } as unknown as RuntimeRegistry;
  const events: Array<{ sessionId: string; type: string; payload: JsonValue }> = [];
  const service = new MessageService(
    projects,
    sessions,
    threads,
    runtimes,
    { ensureReadyOrRebuild: async () => null } as unknown as RuntimeSupervisor,
    {
      append: (input: { sessionId: string; event: { type: string; payload: JsonValue } }) => {
        events.push({ sessionId: input.sessionId, type: input.event.type, payload: input.event.payload });
        return { seq: events.length };
      },
    } as unknown as EventLedger,
    null,
  );
  const scheduler = new TurnScheduler({ limits: () => ({ global, perAgent: () => 2 }) });
  service.setScheduler(scheduler);
  const send = (sessionId: string, text: string, options: Parameters<MessageService["send"]>[3] = {}) =>
    service.send(sessionId, { content: [{ type: "text", text }] }, "k-" + text, options);
  const flush = async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  };
  return { newSession, send, started, modes, events, scheduler, flush, sessions };
}

describe("发消息经本机调度", () => {
  it("有名额就开；满了先登记消息、返回排队中（不拒绝），记 turn.queued；前一个回合结束后自动开", async () => {
    const context = setup(1);
    const a = context.newSession("A");
    const b = context.newSession("B", "claude-code");
    const first = await context.send(a.id, "one");
    expect(first.turnRef?.turnId).toBe("turn-1");
    const second = await context.send(b.id, "two");
    expect(second).toMatchObject({ turnRef: null, queued: { position: 1 } });
    expect(context.started).toEqual([a.id]);
    expect(context.events.filter((event) => event.sessionId === b.id).map((event) => event.type)).toEqual(["message.submitted", "turn.queued"]);
    expect(context.events.at(-1)?.payload).toMatchObject({ queueItemId: second.queued?.itemId, position: 1, agentId: "claude-code" });

    context.scheduler.turnEnded(a.id, "turn-1");
    await context.flush();
    expect(context.started).toEqual([a.id, b.id]);
  });

  it("同一会话已有回合在跑：这条由运行时并入，不另占名额、不排队", async () => {
    const context = setup(1);
    const a = context.newSession("A");
    await context.send(a.id, "one");
    const merged = await context.send(a.id, "two");
    expect(merged.queued).toBeUndefined();
    expect(context.started).toEqual([a.id, a.id]);
    expect(context.scheduler.snapshot().running).toHaveLength(1);
  });

  it("排队中被取消：不开回合，记 turn.dequeued", async () => {
    const context = setup(1);
    const a = context.newSession("A");
    const b = context.newSession("B");
    await context.send(a.id, "one");
    const queued = await context.send(b.id, "two");
    expect(context.scheduler.cancel(queued.queued!.itemId)).toBe(true);
    await context.flush();
    expect(context.started).toEqual([a.id]);
    expect(context.events.at(-1)).toMatchObject({ sessionId: b.id, type: "turn.dequeued", payload: { reason: "cancelled" } });
  });

  it("内部调用方（房间任务、委派）可以等到轮到再返回，拿到回合", async () => {
    const context = setup(1);
    const a = context.newSession("A");
    const b = context.newSession("B");
    await context.send(a.id, "one");
    let resolved = false;
    const waiting = context.send(b.id, "two", { source: "delegate", label: "补测试", waitForTurn: true }).then((accepted) => {
      resolved = true;
      return accepted;
    });
    await context.flush();
    expect(resolved).toBe(false);
    expect(context.scheduler.snapshot().queued[0]).toMatchObject({ source: "delegate", label: "补测试" });
    context.scheduler.turnEnded(a.id, "turn-1");
    expect((await waiting).turnRef?.turnId).toBe("turn-2");
  });

  it("轮到时按会话现在的样子开：排队期间改了权限用新的；被删除或归档就不开，记 turn.dequeued；开起来记 reason=started", async () => {
    const context = setup(1);
    const a = context.newSession("A");
    const b = context.newSession("B");
    const c = context.newSession("C");
    await context.send(a.id, "one");
    const queuedB = await context.send(b.id, "two");
    await context.send(c.id, "three");
    const current = context.sessions.getById(b.id)!;
    context.sessions.update(b.id, current.version, { approvalMode: "ask" });
    const cs = context.sessions.getById(c.id)!;
    context.sessions.updateState(c.id, cs.version, "archived");
    context.scheduler.turnEnded(a.id, "turn-1");
    await context.flush();
    expect(context.started).toEqual([a.id, b.id]);
    expect(context.modes.at(-1)).toBe("ask");
    expect(context.events.find((event) => event.sessionId === b.id && event.type === "turn.dequeued")?.payload).toMatchObject({
      clientTurnId: queuedB.clientTurnId,
      reason: "started",
      turnId: "turn-2",
    });
    context.scheduler.turnEnded(b.id, "turn-2");
    await context.flush();
    expect(context.started).toEqual([a.id, b.id]);
    expect(context.events.find((event) => event.sessionId === c.id && event.type === "turn.dequeued")?.payload).toMatchObject({ reason: "archived" });
  });

  it("会话里有排队项时再发的消息排在它后面（不插到前面并入当前回合）；等待中被取消也记 turn.dequeued", async () => {
    const context = setup(1);
    const a = context.newSession("A");
    const b = context.newSession("B");
    await context.send(a.id, "one");
    await context.send(b.id, "two");
    const third = await context.send(b.id, "three");
    expect(third.queued).toBeDefined();
    expect(context.scheduler.snapshot().queued.map((item) => item.sessionId)).toEqual([b.id, b.id]);

    const room = context.newSession("Room");
    const waiting = context.send(room.id, "four", { waitForTurn: true, source: "room" }).catch((error: unknown) => error);
    await context.flush();
    context.scheduler.cancelSession(room.id);
    expect(await waiting).toBeInstanceOf(Error);
    expect(context.events.filter((event) => event.sessionId === room.id).at(-1)).toMatchObject({ type: "turn.dequeued", payload: { reason: "cancelled" } });
  });
});

describe("重启后给排队中的消息收尾", () => {
  it("排队之后没有出队（含开起来了）、开不起来记录的都记一笔：同一会话排着两条也都收；会自动重排的记 requeued，并带回内容", () => {
    const record = (seq: number, sessionId: string, type: string, payload: JsonValue) =>
      ({ seq, eventId: "e" + String(seq), sessionId, sessionThreadId: "st-" + sessionId, source: "x", type, payload, threadRef: { runtimeId: "r", runtimeKind: "codex", threadId: "t" }, turnRef: null, ts: seq, dedupeKey: null, createdAt: seq }) as never;
    const appended: Array<{ sessionId: string; payload: JsonValue }> = [];
    const closed = closeQueuedAfterRestart(
      {
        listQueueEvents: () => [
          record(2, "s1", "turn.queued", { clientTurnId: "c1", queueItemId: "q1", source: "user" }),
          record(4, "s1", "turn.queued", { clientTurnId: "c1b", queueItemId: "q1b", source: "user" }),
          record(5, "s2", "turn.queued", { clientTurnId: "c2", queueItemId: "q2", source: "user" }),
          record(6, "s2", "turn.dequeued", { clientTurnId: "c2", reason: "started", turnId: "t2" }),
          record(7, "s3", "turn.queued", { clientTurnId: "c3", queueItemId: "q3", source: "user" }),
          record(8, "s3", "turn.dequeued", { clientTurnId: "c3", reason: "cancelled" }),
          record(10, "child", "turn.queued", { clientTurnId: "c4", queueItemId: "q4", source: "delegate" }),
        ],
        // 只给委派的取内容。
        submittedContent: (sessionId: string, clientTurnId: string) => (sessionId === "child" && clientTurnId === "c4" ? [{ type: "text", text: "委派任务" }] : null),
      },
      { append: (input: { sessionId: string; event: { payload: JsonValue } }) => appended.push({ sessionId: input.sessionId, payload: input.event.payload }) } as never,
      (message) => message.source === "delegate",
    );
    expect(appended).toEqual([
      { sessionId: "s1", payload: { clientTurnId: "c1", queueItemId: "q1", reason: "restart" } },
      { sessionId: "s1", payload: { clientTurnId: "c1b", queueItemId: "q1b", reason: "restart" } },
      { sessionId: "child", payload: { clientTurnId: "c4", queueItemId: "q4", reason: "requeued" } },
    ]);
    expect(closed.find((message) => message.sessionId === "child")).toEqual({ sessionId: "child", clientTurnId: "c4", source: "delegate", content: [{ type: "text", text: "委派任务" }] });
  });

  it("按 clientTurnId 从真账本取回已提交消息的内容（SQLite json_extract）", () => {
    const database = openBetterSqlite3Database(":memory:");
    runMigrations(database);
    closers.push(() => database.close());
    const project = new ProjectRepository(database).create({ name: "p", rootPath: "/tmp/suduo-requeue", rootPathKey: "/tmp/suduo-requeue" });
    const session = new SessionRepository(database).create({ projectId: project.id, title: "子任务", state: "active" });
    const events = new EventRepository(database);
    const append = (clientTurnId: string, text: string) =>
      events.append({ sessionId: session.id, source: "test", type: "message.submitted", payload: { clientTurnId, content: [{ type: "text", text }] }, threadRef: null, turnRef: null, ts: 1 });
    append("c1", "任务");
    append("c2", "补充");
    expect(events.submittedContent(session.id, "c2")).toEqual([{ type: "text", text: "补充" }]);
    expect(events.submittedContent(session.id, "nope")).toBeNull();
  });
});

