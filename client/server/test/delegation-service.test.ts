import { afterEach, describe, expect, it } from "vitest";
import type { EventEnvelope, JsonValue, RuntimeApprovalMode, SessionDto } from "@suduo/client-contracts";
import { DelegationService } from "../src/application/collab/delegation-service.js";
import { DelegationTools } from "../src/application/collab/delegation-tools.js";
import { stableClientTurnId } from "../src/application/message-service.js";
import type { ProjectedRound } from "../src/application/context/session-projection.js";
import { EventBroker } from "../src/application/event-broker.js";
import { openBetterSqlite3Database } from "../src/infrastructure/db/better-sqlite3-database.js";
import { runMigrations } from "../src/infrastructure/db/migration-runner.js";
import { DelegationRepository } from "../src/infrastructure/db/repositories/delegation-repository.js";
import { ProjectRepository } from "../src/infrastructure/db/repositories/project-repository.js";
import { SessionRepository } from "../src/infrastructure/db/repositories/session-repository.js";

/** 委派（多 Agent 协作 S8，需求 4.3 / 4.11）：建子会话、跟着子回合、等待、交回、取消、重启收尾。 */

const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

function round(patch: Partial<ProjectedRound> = {}): ProjectedRound {
  return {
    index: 1,
    seq: 1,
    startedAt: 1,
    userText: "补测试",
    attachmentCount: 0,
    status: "completed",
    error: null,
    answer: null,
    commands: [],
    tools: [],
    files: [],
    webSearches: [],
    ...patch,
  };
}

function setup(options: { parentMode?: RuntimeApprovalMode; queued?: boolean } = {}) {
  const database = openBetterSqlite3Database(":memory:");
  runMigrations(database);
  closers.push(() => database.close());
  const projects = new ProjectRepository(database);
  const sessions = new SessionRepository(database);
  const delegations = new DelegationRepository(database);
  const project = projects.create({ name: "p", rootPath: "/tmp/suduo-delegation", rootPathKey: "/tmp/suduo-delegation" });
  const parent = sessions.create({ projectId: project.id, title: "主会话", state: "active", agentId: "gemini", approvalMode: options.parentMode ?? "auto" });
  const broker = new EventBroker();
  const ledger: Array<{ sessionId: string; type: string; payload: JsonValue }> = [];
  const sent: Array<{ sessionId: string; text: string; source?: string }> = [];
  const children: Array<{ agentId: string; approvalMode: RuntimeApprovalMode; task: string }> = [];
  const rounds = new Map<string, ProjectedRound[]>();
  const running = new Set<string>();
  const lent: string[] = [];
  /** 发给各会话的消息的 clientTurnId（按发送先后）。 */
  const keys: Array<{ sessionId: string; clientTurnId: string }> = [];
  const cancelled: string[] = [];
  const interrupted: Array<[string, string]> = [];
  let clock = 1_000;
  const service = new DelegationService({
    delegations,
    sessions,
    threads: { getPrimary: (sessionId) => ({ id: "binding-" + sessionId, threadRef: { runtimeId: "r", runtimeKind: "codex", threadId: "t-" + sessionId } }) as never },
    approvals: { countPendingBySession: (sessionId) => (sessionId.startsWith("waiting") ? 1 : 0) },
    ledger: {
      append: (input: { sessionId: string; event: { type: string; payload: JsonValue } }) => {
        ledger.push({ sessionId: input.sessionId, type: input.event.type, payload: input.event.payload });
        return { seq: ledger.length } as never;
      },
    } as never,
    broker,
    messages: {
      send: async (sessionId, input, key, sendOptions) => {
        keys.push({ sessionId, clientTurnId: stableClientTurnId(sessionId, key) });
        const first = input.content[0];
        sent.push({ sessionId, text: first?.type === "text" ? first.text : "", ...(sendOptions.source === undefined ? {} : { source: sendOptions.source }) });
        return options.queued === true && sendOptions.source === "delegate"
          ? { turnRef: null, queued: { itemId: "q1", position: 1 } }
          : { turnRef: { turnId: "turn-x" } };
      },
    },
    clientTurnId: stableClientTurnId,
    mergesIntoRunningTurn: (sessionId) => sessions.getById(sessionId)?.agentId === "codex",
    interrupt: async (sessionId, turnId) => {
      interrupted.push([sessionId, turnId]);
    },
    scheduler: {
      sessionRunning: (sessionId) => running.has(sessionId),
      cancel: (itemId) => {
        cancelled.push(itemId);
        return true;
      },
      queuePosition: () => 1,
      lend: (sessionId) => {
        lent.push(sessionId);
        return () => lent.splice(lent.indexOf(sessionId), 1);
      },
    },
    rounds: (sessionId) => rounds.get(sessionId) ?? [],
    createChild: async ({ parent: source, agentId, approvalMode, task }) => {
      children.push({ agentId, approvalMode, task });
      const child = sessions.create({
        projectId: source.projectId,
        title: task,
        state: "active",
        agentId,
        graph: { parentSessionId: source.id, rootSessionId: source.id, relation: "delegate" },
      });
      return { id: child.id } as SessionDto;
    },
    agentProblem: (agentId) => (agentId === "cursor" ? "Cursor CLI 在设置里停用了" : null),
    agentName: (agentId) => ({ gemini: "Gemini CLI", "claude-code": "Claude Code", codex: "Codex" })[agentId] ?? agentId,
    now: () => (clock += 1),
    log: () => undefined,
  });
  const childEvent = (childId: string, type: string, payload: JsonValue = {}) =>
    broker.publish({ seq: 1, eventId: "e", sessionId: childId, source: "test", type, payload, threadRef: null, turnRef: { threadId: "t", turnId: "turn-x" }, ts: 1 } as EventEnvelope<string, JsonValue>);
  const cards = (delegationId: string) =>
    ledger.filter((entry) => entry.type === "delegation.updated" && (entry.payload as { id: string }).id === delegationId).map((entry) => (entry.payload as { status: string }).status);
  const flush = async () => {
    for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const clientOf = (sessionId: string, index = -1) => keys.filter((entry) => entry.sessionId === sessionId).at(index)!.clientTurnId;
  return { service, sessions, delegations, parent, broker, ledger, sent, children, rounds, running, lent, cancelled, interrupted, keys, clientOf, childEvent, cards, flush };
}

describe("委派", () => {
  it("建子会话（权限取低的）、首条消息是任务与相关文件、回合经调度；发起会话的时间线记卡片", async () => {
    const context = setup({ parentMode: "ask" });
    const delegation = await context.service.start({
      parentSessionId: context.parent.id,
      agentId: "claude-code",
      task: "给导出接口补集成测试",
      files: ["src/export.ts"],
      approvalMode: "full",
      origin: "agent",
    });
    expect(context.children).toEqual([{ agentId: "claude-code", approvalMode: "ask", task: "给导出接口补集成测试" }]);
    expect(context.sent[0]).toMatchObject({ sessionId: delegation.childSessionId, text: "给导出接口补集成测试\n\n相关文件：\n- src/export.ts", source: "delegate" });
    expect(delegation).toMatchObject({ status: "running", agentName: "Claude Code", origin: "agent", delivered: false, childTitle: "给导出接口补集成测试" });
    expect(context.cards(delegation.id)).toEqual(["queued", "running"]);
  });

  it("名额满了：委派排队；排着的那条开起来后运行中", async () => {
    const context = setup({ queued: true });
    const delegation = await context.service.start({ parentSessionId: context.parent.id, agentId: "codex", task: "跑测试", origin: "user" });
    expect(delegation.status).toBe("queued");
    const child = delegation.childSessionId!;
    context.childEvent(child, "turn.dequeued", { clientTurnId: context.clientOf(child), reason: "started", turnId: "turn-x" });
    expect(context.service.get(delegation.id).status).toBe("running");
  });

  it("深度 1：子会话不能再委派；Agent 不能委派、任务为空都报错", async () => {
    const context = setup();
    const first = await context.service.start({ parentSessionId: context.parent.id, agentId: "codex", task: "a", origin: "agent" });
    await expect(context.service.start({ parentSessionId: first.childSessionId!, agentId: "codex", task: "b", origin: "agent" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(context.service.start({ parentSessionId: context.parent.id, agentId: "cursor", task: "b", origin: "agent" })).rejects.toMatchObject({ code: "AGENT_NOT_READY" });
    await expect(context.service.start({ parentSessionId: context.parent.id, agentId: "codex", task: "  ", origin: "agent" })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("子回合完成：组装结果（最终回答、改动文件与增删），正在等的发起 Agent 直接拿到；等待到点返回进度", async () => {
    const context = setup();
    const delegation = await context.service.start({ parentSessionId: context.parent.id, agentId: "claude-code", task: "补测试", origin: "agent" });
    const child = delegation.childSessionId!;
    context.rounds.set(child, [round({ commands: [{ command: "pnpm test", exitCode: 0, output: "" }] })]);
    const early = await context.service.wait(delegation.id, 10);
    expect(early.finished).toBe(false);

    // 发起 Agent 在自己的回合里等着。
    context.running.add(context.parent.id);
    const waiting = context.service.wait(delegation.id, 60_000);
    context.rounds.set(child, [
      // 新建文件给的是全文（按整份计），修改给的是统一 diff（按行首符号计）。
      round({ answer: "补了 3 个用例，都通过", files: [{ path: "test/export.test.ts", kind: "add", diff: "a\nb\n" }, { path: "src/export.ts", kind: "update", diff: "@@ -1 +1 @@\n-x\n+y\n" }] }),
    ]);
    context.childEvent(child, "turn.completed", { turn: { id: "turn-x", status: "completed" } });
    const { delegation: done, finished } = await waiting;
    expect(finished).toBe(true);
    expect(done).toMatchObject({
      status: "completed",
      delivered: true,
      result: {
        finalMessage: "补了 3 个用例，都通过",
        changedFiles: [
          { path: "test/export.test.ts", kind: "add" },
          { path: "src/export.ts", kind: "update" },
        ],
        additions: 3,
        deletions: 1,
      },
    });
  });

  it("工具：等待到点给进度、完成给结果；只能操作自己发起的委派", async () => {
    const context = setup();
    const tools = new DelegationTools({
      service: context.service,
      agents: () => [{ id: "claude-code", displayName: "Claude Code", runtimeAvailable: true, enabled: true, status: "ready" }] as never,
      usage: () => ({ running: 1, queued: 0, limit: 2 }),
    });
    const ctx = { sessionId: context.parent.id, locale: "zh-CN" as const, projectRoot: "/tmp", remoteProjectId: "p", requirement: null };
    const text = (result: { contentItems: ReadonlyArray<{ type: string; text?: string }> }) =>
      result.contentItems.map((item) => (item.type === "inputText" ? (item.text ?? "") : "")).join("\n");
    expect(text(tools.agentList(ctx))).toBe("可以委派的 Agent：\n- claude-code（Claude Code）· 就绪 · 运行中 1/2");
    const started = text(await tools.start(ctx, { agentId: "claude-code", task: "补测试" }));
    const id = /委派 ID：(\S+)（/u.exec(started)?.[1];
    expect(started).toContain("已委派给 Claude Code");
    context.rounds.set(context.service.get(id!).childSessionId!, [round({ commands: [{ command: "pnpm test", exitCode: null, output: "" }] })]);
    const progress = text(await tools.wait(ctx, { delegationId: id, maxSeconds: 1 }, { toolTimeoutSec: 31 }));
    expect(progress).toContain("进度：已做 1 步，最近：pnpm test");
    expect(progress).toContain("还没完成，可以再等，或先做别的。");
    expect(text(await tools.cancel({ ...ctx, sessionId: "other" }, { delegationId: id }))).toContain("没有 ID 为");
    expect((await tools.start(ctx, { agentId: "nope", task: "x" })).success).toBe(false);
  });

  it("自动交回：发起会话空着就开新一轮交回；发起回合还在跑就等它结束再交回；没勾就等用户点", async () => {
    const context = setup();
    const auto = await context.service.start({ parentSessionId: context.parent.id, agentId: "codex", task: "跑测试", autoHandback: true, origin: "agent" });
    context.rounds.set(auto.childSessionId!, [round({ answer: "全过了" })]);
    context.running.add(context.parent.id);
    context.childEvent(auto.childSessionId!, "turn.completed", { turn: { status: "completed" } });
    await context.flush();
    expect(context.sent.filter((entry) => entry.sessionId === context.parent.id)).toHaveLength(0);
    context.running.delete(context.parent.id);
    context.broker.publish({ seq: 2, eventId: "p", sessionId: context.parent.id, source: "test", type: "turn.completed", payload: {}, threadRef: null, turnRef: null, ts: 1 } as EventEnvelope<string, JsonValue>);
    await context.flush();
    const handback = context.sent.filter((entry) => entry.sessionId === context.parent.id);
    expect(handback).toHaveLength(1);
    expect(handback[0]!.text).toContain("委派结果（Codex：「跑测试」· 已完成）：");
    expect(handback[0]!.text).toContain("全过了");
    expect(context.service.get(auto.id).delivered).toBe(true);

    const manual = await context.service.start({ parentSessionId: context.parent.id, agentId: "codex", task: "看日志", origin: "user" });
    context.childEvent(manual.childSessionId!, "turn.completed", { turn: { status: "completed" } });
    await context.flush();
    expect(context.service.get(manual.id)).toMatchObject({ status: "completed", delivered: false });
    await context.service.handback(manual.id);
    expect(context.service.get(manual.id).delivered).toBe(true);
  });

  it("取消：排队中的出队、运行中的中断子回合，记为已取消（中断事件晚到也不改）；停止级联取消发起会话的全部", async () => {
    const context = setup();
    const first = await context.service.start({ parentSessionId: context.parent.id, agentId: "codex", task: "一", origin: "agent" });
    const second = await context.service.start({ parentSessionId: context.parent.id, agentId: "codex", task: "二", origin: "agent" });
    const cancelled = await context.service.cancel(first.id);
    expect(cancelled.status).toBe("cancelled");
    // 只停委派自己的回合。
    expect(context.interrupted).toEqual([[first.childSessionId, "turn-x"]]);
    context.childEvent(first.childSessionId!, "turn.interrupted");
    expect(context.service.get(first.id).status).toBe("cancelled");

    const all = await context.service.cancelAllForParent(context.parent.id);
    expect(all.map((item) => item.id)).toEqual([second.id]);
    expect(context.service.get(second.id).status).toBe("cancelled");
  });

  it("删除子会话（需求 R11）：往下的会话含孙辈；没做完的委派先取消；删后卡片显示子会话已删除，结果照留", async () => {
    const context = setup();
    const done = await context.service.start({ parentSessionId: context.parent.id, agentId: "codex", task: "一", origin: "agent" });
    context.rounds.set(done.childSessionId!, [round({ answer: "补好了" })]);
    context.childEvent(done.childSessionId!, "turn.completed", { turn: { status: "completed" } });
    const busy = await context.service.start({ parentSessionId: context.parent.id, agentId: "codex", task: "二", origin: "agent" });
    const grandchild = context.sessions.create({
      projectId: context.parent.projectId,
      title: "接着做",
      state: "active",
      agentId: "codex",
      graph: { parentSessionId: busy.childSessionId!, rootSessionId: context.parent.id, relation: "continue" },
    });
    expect(context.sessions.listDescendantIds(context.parent.id).sort()).toEqual([done.childSessionId, busy.childSessionId, grandchild.id].sort());

    const targets = [done.childSessionId!, busy.childSessionId!];
    await context.service.beforeSessionsDeleted(targets);
    expect(context.service.get(busy.id).status).toBe("cancelled");
    expect(context.interrupted).toEqual([[busy.childSessionId, "turn-x"]]);
    expect(context.service.get(done.id).status).toBe("completed");
    for (const id of targets) context.sessions.updateState(id, context.sessions.getById(id)!.version, "deleted");
    context.service.afterSessionsDeleted(targets);
    const last = context.ledger.filter((entry) => entry.type === "delegation.updated" && (entry.payload as { id: string }).id === done.id).at(-1)!.payload;
    expect(last).toMatchObject({ childSessionId: null, status: "completed", result: { finalMessage: "补好了" } });
    expect(context.sessions.listDescendantIds(context.parent.id)).toEqual([]);
  });

  it("发起回合停了：等待立即返回、不记已交回（留给自动交回或卡片上的按钮）", async () => {
    const context = setup();
    const delegation = await context.service.start({ parentSessionId: context.parent.id, agentId: "codex", task: "一", origin: "agent" });
    context.running.add(context.parent.id);
    const waiting = context.service.wait(delegation.id, 60_000);
    context.running.delete(context.parent.id);
    context.broker.publish({ seq: 3, eventId: "pi", sessionId: context.parent.id, source: "test", type: "turn.interrupted", payload: {}, threadRef: null, turnRef: null, ts: 1 } as EventEnvelope<string, JsonValue>);
    expect((await waiting).finished).toBe(false);
    context.childEvent(delegation.childSessionId!, "turn.completed", { turn: { status: "completed" } });
    expect(context.service.get(delegation.id)).toMatchObject({ status: "completed", delivered: false });
    expect((await context.service.wait(delegation.id, 10)).delegation.delivered).toBe(false);
  });

  it("委派结束后用户在子会话里接着聊：后续回合不改委派的状态与结果、不触发自动交回；停止子回合记为已取消", async () => {
    const context = setup();
    const auto = await context.service.start({ parentSessionId: context.parent.id, agentId: "codex", task: "跑测试", autoHandback: true, origin: "agent" });
    const child = auto.childSessionId!;
    context.rounds.set(child, [round({ answer: "全过了" })]);
    context.childEvent(child, "turn.completed", { turn: { status: "completed" } });
    await context.flush();
    const handbacks = () => context.sent.filter((entry) => entry.sessionId === context.parent.id).length;
    expect(handbacks()).toBe(1);
    context.childEvent(child, "turn.started");
    context.childEvent(child, "turn.completed", { turn: { status: "failed", error: { message: "boom" } } });
    await context.flush();
    expect(context.service.get(auto.id)).toMatchObject({ status: "completed", result: { finalMessage: "全过了" }, delivered: true });
    expect(handbacks()).toBe(1);

    // 子会话页 / 运行面板上停掉子回合：发起者收到「已取消」，不交回。
    const other = await context.service.start({ parentSessionId: context.parent.id, agentId: "codex", task: "二", autoHandback: true, origin: "agent" });
    context.childEvent(other.childSessionId!, "turn.interrupted");
    await context.flush();
    expect(context.service.get(other.id).status).toBe("cancelled");
    expect(handbacks()).toBe(1);
  });

  it("建子会话期间被叫停：不再发任务；发出去之后才发现被叫停：停掉刚开的回合，状态不改回运行中", async () => {
    const context = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = (context.service as unknown as { deps: { createChild: (input: never) => Promise<SessionDto> } }).deps.createChild;
    (context.service as unknown as { deps: { createChild: (input: never) => Promise<SessionDto> } }).deps.createChild = async (input) => {
      await gate;
      return original(input);
    };
    const starting = context.service.start({ parentSessionId: context.parent.id, agentId: "codex", task: "慢", origin: "user" });
    await context.flush();
    const id = context.delegations.listByParent(context.parent.id)[0]!.id;
    await context.service.cancel(id);
    release();
    const result = await starting;
    expect(result.status).toBe("cancelled");
    expect(context.sent).toHaveLength(0);

    // 发消息途中被叫停（取消时回合还没开起来）。
    const deps = (context.service as unknown as { deps: { messages: { send: (...args: never[]) => Promise<unknown> } } }).deps;
    const send = deps.messages.send;
    let delegationId = "";
    deps.messages.send = async (...args: never[]) => {
      await context.service.cancel(delegationId);
      return send(...args);
    };
    const pendingStart = context.service.start({ parentSessionId: context.parent.id, agentId: "codex", task: "快", origin: "user" });
    await Promise.resolve();
    delegationId = context.delegations.listByParent(context.parent.id).find((record) => record.task === "快")!.id;
    const raced = await pendingStart;
    expect(raced.status).toBe("cancelled");
    expect(context.interrupted).toContainEqual([raced.childSessionId, "turn-x"]);
  });

  it("补充消息让委派回到运行中；重启时没做完的标已中断", async () => {
    const context = setup();
    const delegation = await context.service.start({ parentSessionId: context.parent.id, agentId: "codex", task: "一", origin: "agent" });
    context.childEvent(delegation.childSessionId!, "turn.completed", { turn: { status: "completed" } });
    const resumed = await context.service.send(delegation.id, "再加一个边界用例");
    expect(resumed).toMatchObject({ status: "running", delivered: false });
    expect(context.sent.at(-1)).toMatchObject({ sessionId: delegation.childSessionId, text: "再加一个边界用例" });
    context.service.recoverAfterRestart();
    expect(context.service.get(delegation.id)).toMatchObject({ status: "interrupted", error: "本机服务重启前没完成" });
  });

  it("重启时排队中的委派重新排队：重启前排着、委派发的那几条在开始监听后重发；用户自己排的不算", async () => {
    const context = setup({ queued: true });
    const delegation = await context.service.start({ parentSessionId: context.parent.id, agentId: "codex", task: "排着", origin: "agent" });
    expect(delegation.status).toBe("queued");
    const child = delegation.childSessionId!;
    expect(context.service.willRequeue(child)).toBe(true);
    const before = context.sent.length;
    context.service.recoverAfterRestart([
      { sessionId: child, source: "delegate", content: [{ type: "text", text: "排着" }] },
      { sessionId: child, source: "user", content: [{ type: "text", text: "用户自己的" }] },
    ]);
    expect(context.sent.length).toBe(before);
    await context.service.requeueAfterRestart();
    expect(context.sent.slice(before)).toEqual([{ sessionId: child, text: "排着", source: "delegate" }]);
    expect(context.service.get(delegation.id).status).toBe("queued");
    // 重发的这条排上、开起来、做完：委派完成。
    context.childEvent(child, "turn.dequeued", { clientTurnId: context.clientOf(child), reason: "started", turnId: "turn-x" });
    expect(context.service.get(delegation.id).status).toBe("running");
    context.childEvent(child, "turn.started");
    context.childEvent(child, "turn.completed", { turn: { status: "completed" } });
    expect(context.service.get(delegation.id).status).toBe("completed");
  });

  it("委派的消息都结束才算做完：排着的补充消息、会话内排着的下一轮都算它的；用户在子会话里自己排的消息被取消不影响委派", async () => {
    const context = setup();
    const delegation = await context.service.start({ parentSessionId: context.parent.id, agentId: "claude-code", task: "一", origin: "agent" });
    const child = delegation.childSessionId!;
    // 第一轮还在跑时补充：Claude 会话内排着，回执给的是下一轮的回合 ID。
    const deps = (context.service as unknown as { deps: { messages: { send: (...args: never[]) => Promise<unknown> } } }).deps;
    const send = deps.messages.send;
    deps.messages.send = async (...args: never[]) => {
      await send(...args);
      return { turnRef: { turnId: "turn-2" } };
    };
    await context.service.send(delegation.id, "再补一个");
    deps.messages.send = send;
    const turn = (turnId: string) => ({ threadId: "t", turnId });
    const publish = (type: string, turnId: string | null, payload: JsonValue = {}) =>
      context.broker.publish({ seq: 1, eventId: "e", sessionId: child, source: "test", type, payload, threadRef: null, turnRef: turnId === null ? null : turn(turnId), ts: 1 } as EventEnvelope<string, JsonValue>);
    publish("turn.completed", "turn-x", { turn: { status: "completed" } });
    expect(context.service.get(delegation.id).status).toBe("running");
    // 用户自己在子会话里排的一条被取消：不是委派的，不影响。
    publish("turn.queued", null, { clientTurnId: "user-own" });
    publish("turn.dequeued", null, { clientTurnId: "user-own", reason: "cancelled" });
    expect(context.service.get(delegation.id).status).toBe("running");
    context.rounds.set(child, [round({ answer: "两件都好了" })]);
    publish("turn.started", "turn-2");
    publish("turn.completed", "turn-2", { turn: { status: "completed" } });
    expect(context.service.get(delegation.id)).toMatchObject({ status: "completed", result: { finalMessage: "两件都好了" } });
  });

  it("排着的委派轮到了、回合还在开时被叫停：开起来就停掉；发起 Agent 等结果时让出名额", async () => {
    const context = setup({ queued: true });
    const delegation = await context.service.start({ parentSessionId: context.parent.id, agentId: "codex", task: "排着", origin: "agent" });
    context.running.add(context.parent.id);
    const waiting = context.service.wait(delegation.id, 60_000);
    expect(context.lent).toEqual([context.parent.id]);
    await context.service.cancel(delegation.id);
    expect((await waiting).delegation.status).toBe("cancelled");
    expect(context.lent).toEqual([]);
    // 只撤委派自己排着的那一项。
    expect(context.cancelled).toEqual(["q1"]);
    // 取消时它其实已经轮到、正在开（撤不掉），随后开起来：开起来就停。
    const child = delegation.childSessionId!;
    context.childEvent(child, "turn.dequeued", { clientTurnId: context.clientOf(child), reason: "started", turnId: "turn-o" });
    await context.flush();
    expect(context.interrupted).toContainEqual([child, "turn-o"]);
  });

  it("Codex 子会话在回合进行中收到补充：消息并入进行中的一轮（回执给的回合 ID 不会出现），以 userMessage 证据对上；这一轮结束委派就做完", async () => {
    const context = setup();
    const delegation = await context.service.start({ parentSessionId: context.parent.id, agentId: "codex", task: "一", origin: "agent" });
    const child = delegation.childSessionId!;
    const deps = (context.service as unknown as { deps: { messages: { send: (...args: never[]) => Promise<unknown> } } }).deps;
    const send = deps.messages.send;
    deps.messages.send = async (...args: never[]) => {
      await send(...args);
      return { turnRef: { turnId: "phantom" } };
    };
    await context.service.send(delegation.id, "顺便再看一下");
    deps.messages.send = send;
    context.childEvent(child, "item.completed", { item: { type: "userMessage", clientId: context.clientOf(child) } });
    context.rounds.set(child, [round({ answer: "都看了" })]);
    context.childEvent(child, "turn.completed", { turn: { status: "completed" } });
    expect(context.service.get(delegation.id)).toMatchObject({ status: "completed", result: { finalMessage: "都看了" } });
  });

  it("Codex 并入进行中一轮后一直没等到证据（那一轮被停掉）：子会话空下来后一起收掉，不会永远运行中", async () => {
    const context = setup();
    const delegation = await context.service.start({ parentSessionId: context.parent.id, agentId: "codex", task: "一", origin: "agent" });
    const child = delegation.childSessionId!;
    context.running.add(child);
    const deps = (context.service as unknown as { deps: { messages: { send: (...args: never[]) => Promise<unknown> } } }).deps;
    const send = deps.messages.send;
    deps.messages.send = async (...args: never[]) => {
      await send(...args);
      return { turnRef: { turnId: "ghost" } };
    };
    await context.service.send(delegation.id, "顺便");
    deps.messages.send = send;
    context.running.delete(child);
    context.childEvent(child, "turn.interrupted");
    await context.flush();
    expect(context.service.get(delegation.id).status).toBe("cancelled");
  });

  it("还有别的消息在做时补充发送失败：状态不变，但报错给调用方", async () => {
    const context = setup();
    const delegation = await context.service.start({ parentSessionId: context.parent.id, agentId: "claude-code", task: "一", origin: "agent" });
    const deps = (context.service as unknown as { deps: { messages: { send: (...args: never[]) => Promise<unknown> } } }).deps;
    deps.messages.send = async () => {
      throw new Error("Claude Code 没响应");
    };
    await expect(context.service.send(delegation.id, "再补一个")).rejects.toThrow("Claude Code 没响应");
    expect(context.service.get(delegation.id)).toMatchObject({ status: "running", error: null });
  });

  it("取消委派不中断用户在子会话里自己的回合（委派的补充只是并入了那一轮）；排着的补充被撤、主任务那轮已做完时算做完", async () => {
    const context = setup();
    const delegation = await context.service.start({ parentSessionId: context.parent.id, agentId: "codex", task: "一", origin: "agent" });
    const child = delegation.childSessionId!;
    context.childEvent(child, "turn.completed", { turn: { status: "completed" } });
    expect(context.service.get(delegation.id).status).toBe("completed");
    // 用户自己在子会话里开了一轮；这时补充并入那一轮（证据指向用户的回合）。
    context.running.add(child);
    const deps = (context.service as unknown as { deps: { messages: { send: (...args: never[]) => Promise<unknown> } } }).deps;
    const send = deps.messages.send;
    deps.messages.send = async (...args: never[]) => {
      await send(...args);
      return { turnRef: { turnId: "ghost" } };
    };
    await context.service.send(delegation.id, "顺便");
    deps.messages.send = send;
    context.broker.publish({ seq: 1, eventId: "u", sessionId: child, source: "test", type: "item.completed", payload: { item: { type: "userMessage", clientId: context.clientOf(child) } }, threadRef: null, turnRef: { threadId: "t", turnId: "user-turn" }, ts: 1 } as unknown as EventEnvelope<string, JsonValue>);
    const before = context.interrupted.length;
    await context.service.cancel(delegation.id);
    expect(context.interrupted.slice(before)).toEqual([]);
    expect(context.service.get(delegation.id).status).toBe("cancelled");

    // 结局汇总：主任务那轮做完了，排着的补充被撤 → 做完。
    const other = setup({ queued: false });
    const second = await other.service.start({ parentSessionId: other.parent.id, agentId: "claude-code", task: "二", origin: "agent" });
    const otherDeps = (other.service as unknown as { deps: { messages: { send: (...args: never[]) => Promise<unknown> } } }).deps;
    const otherSend = otherDeps.messages.send;
    otherDeps.messages.send = async (...args: never[]) => {
      await otherSend(...args);
      return { turnRef: null, queued: { itemId: "q9", position: 1 } };
    };
    await other.service.send(second.id, "补充");
    const otherChild = second.childSessionId!;
    other.childEvent(otherChild, "turn.completed", { turn: { status: "completed" } });
    expect(other.service.get(second.id).status).toBe("running");
    other.childEvent(otherChild, "turn.dequeued", { clientTurnId: other.clientOf(otherChild), reason: "cancelled" });
    expect(other.service.get(second.id).status).toBe("completed");
  });

  it("委派的消息还排着时，用户在子会话里自己的回合先开、先结束：不当成委派的", async () => {
    const context = setup({ queued: true });
    const delegation = await context.service.start({ parentSessionId: context.parent.id, agentId: "codex", task: "排着", origin: "agent" });
    const child = delegation.childSessionId!;
    const publish = (type: string, turnId: string | null, payload: JsonValue = {}) =>
      context.broker.publish({ seq: 1, eventId: "e", sessionId: child, source: "test", type, payload, threadRef: null, turnRef: turnId === null ? null : { threadId: "t", turnId }, ts: 1 } as EventEnvelope<string, JsonValue>);
    publish("turn.started", "user-turn");
    publish("turn.completed", "user-turn", { turn: { status: "completed" } });
    expect(context.service.get(delegation.id).status).toBe("queued");
    publish("turn.dequeued", null, { clientTurnId: context.clientOf(child), reason: "started", turnId: "d-turn" });
    publish("turn.started", "d-turn");
    expect(context.service.get(delegation.id).status).toBe("running");
    publish("turn.completed", "d-turn", { turn: { status: "completed" } });
    expect(context.service.get(delegation.id).status).toBe("completed");
  });

  it("回合的开始、结束先于发送回执到达：回执来了再认", async () => {
    const context = setup();
    const deps = (context.service as unknown as { deps: { messages: { send: (...args: never[]) => Promise<unknown> } } }).deps;
    const send = deps.messages.send;
    let childId = "";
    deps.messages.send = async (...args: never[]) => {
      await send(...args);
      childId = args[0] as unknown as string;
      context.childEvent(childId, "turn.started");
      context.childEvent(childId, "turn.completed", { turn: { status: "completed" } });
      return { turnRef: { turnId: "turn-x" } };
    };
    const delegation = await context.service.start({ parentSessionId: context.parent.id, agentId: "codex", task: "快", origin: "agent" });
    expect(delegation.status).toBe("completed");
  });
});
