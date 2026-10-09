import { afterEach, describe, expect, it } from "vitest";
import type { AgentRuntime, DelegationDto, StartThreadResult, StartTurnResult } from "@suduo/client-contracts";
import type { DelegationService } from "../src/application/collab/delegation-service.js";
import { SchedulerService } from "../src/application/scheduler/scheduler-service.js";
import { TurnScheduler } from "../src/application/scheduler/turn-scheduler.js";
import { ApprovalRepository } from "../src/infrastructure/db/repositories/approval-repository.js";
import { EventRepository } from "../src/infrastructure/db/repositories/event-repository.js";
import { ProjectRepository } from "../src/infrastructure/db/repositories/project-repository.js";
import { SessionThreadRepository } from "../src/infrastructure/db/repositories/session-thread-repository.js";
import { SessionRepository } from "../src/infrastructure/db/repositories/session-repository.js";
import { createMinimalHttpContext } from "./helpers/minimal-http-context.js";

/** 运行面板与委派的本机接口（多 Agent 协作 S8）。 */

class IdleRuntime implements AgentRuntime {
  readonly runtimeId = "codex-local";
  readonly runtimeKind = "codex";
  async startThread(): Promise<StartThreadResult> {
    throw new Error("unused");
  }
  async startTurn(): Promise<StartTurnResult> {
    throw new Error("unused");
  }
  async approve() {
    return { acknowledged: true };
  }
  async interrupt() {}
  async *subscribe() {}
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

function setup() {
  const scheduler = new TurnScheduler({ limits: () => ({ global: 1, perAgent: () => 1 }) });
  const interrupted: Array<[string, string]> = [];
  const started: Array<Record<string, unknown>> = [];
  const deletedHooks: Array<[string, string[]]> = [];
  const activeChildren = new Map<string, Array<{ childSessionId: string; origin: Record<string, string> }>>();
  const delegations = {
    beforeSessionsDeleted: async (ids: string[]) => {
      deletedHooks.push(["before", ids]);
    },
    afterSessionsDeleted: (ids: string[]) => {
      deletedHooks.push(["after", ids]);
    },
    listByParent: () => [],
    start: async (input: Record<string, unknown>) => {
      started.push(input);
      return { id: "d1", status: "running" } as DelegationDto;
    },
    cancelAllForParent: async () => [],
    cancel: async (id: string) => ({ id, status: "cancelled" }) as DelegationDto,
    handback: async (id: string) => ({ id, delivered: true }) as DelegationDto,
    send: async (id: string) => ({ id, status: "running" }) as DelegationDto,
    activeChildren: (parentSessionId: string) => activeChildren.get(parentSessionId) ?? [],
  } as unknown as DelegationService;
  const context = createMinimalHttpContext(new IdleRuntime(), {
    scheduler: new SchedulerService({
      scheduler,
      sessions: { getById: () => null },
      agentName: (agentId) => (agentId === "codex" ? "Codex" : agentId),
      agentIds: () => ["codex", "claude-code"],
      interrupt: async (sessionId, turnId) => {
        interrupted.push([sessionId, turnId]);
      },
    }),
    delegations,
  });
  closers.push(() => context.close());
  const headers = { host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787" };
  return { context, scheduler, interrupted, started, headers, deletedHooks, activeChildren };
}

describe("运行面板接口", () => {
  it("快照列出运行中、排队中与各家上限；先跑这个、取消排队、停止运行中的（中断它的回合）", async () => {
    const { context, scheduler, interrupted, headers } = setup();
    const running = scheduler.request({ sessionId: "s1", agentId: "codex", source: "user", label: "导出接口" });
    running.started("turn-1");
    const queued = scheduler.request({ sessionId: "s2", agentId: "codex", source: "delegate", label: "补测试" });
    const snapshot = (await context.server.inject({ method: "GET", url: "/api/v1/scheduler", headers: { host: "127.0.0.1:8787" } })).json();
    expect(snapshot).toMatchObject({
      running: [{ id: running.id, agentName: "Codex", label: "导出接口", state: "running", sessionTitle: "导出接口" }],
      queued: [{ id: queued.id, source: "delegate", position: 1 }],
      limits: { global: 1, perAgent: { codex: 1, "claude-code": 1 } },
    });
    expect((await context.server.inject({ method: "POST", url: `/api/v1/scheduler/${queued.id}/promote`, headers, payload: {} })).statusCode).toBe(200);
    expect((await context.server.inject({ method: "POST", url: `/api/v1/scheduler/${running.id}/cancel`, headers, payload: {} })).statusCode).toBe(200);
    expect(interrupted).toEqual([["s1", "turn-1"]]);
    expect((await context.server.inject({ method: "POST", url: `/api/v1/scheduler/${queued.id}/cancel`, headers, payload: {} })).json().queued).toEqual([]);
    expect((await context.server.inject({ method: "POST", url: "/api/v1/scheduler/nope/promote", headers, payload: {} })).statusCode).toBe(404);
  });
});

describe("委派接口", () => {
  it("用户 @ Agent 发起委派（201）；缺 Agent 或任务 400；停止、交回、补充消息、一并停止", async () => {
    const { context, started, headers } = setup();
    const created = await context.server.inject({ method: "POST", url: "/api/v1/sessions/s1/delegations", headers, payload: { agentId: "claude-code", task: "补测试", autoHandback: true } });
    expect(created.statusCode).toBe(201);
    expect(started).toEqual([{ parentSessionId: "s1", agentId: "claude-code", task: "补测试", autoHandback: true, origin: "user" }]);
    expect((await context.server.inject({ method: "POST", url: "/api/v1/sessions/s1/delegations", headers, payload: { task: "x" } })).statusCode).toBe(400);
    expect((await context.server.inject({ method: "POST", url: "/api/v1/sessions/s1/delegations", headers, payload: { agentId: "codex", task: " " } })).statusCode).toBe(400);
    expect((await context.server.inject({ method: "POST", url: "/api/v1/delegations/d1/cancel", headers, payload: {} })).json()).toMatchObject({ status: "cancelled" });
    expect((await context.server.inject({ method: "POST", url: "/api/v1/delegations/d1/handback", headers, payload: {} })).json()).toMatchObject({ delivered: true });
    expect((await context.server.inject({ method: "POST", url: "/api/v1/delegations/d1/messages", headers, payload: { message: "再加一个" } })).statusCode).toBe(200);
    expect((await context.server.inject({ method: "POST", url: "/api/v1/delegations/d1/messages", headers, payload: {} })).statusCode).toBe(400);
    expect((await context.server.inject({ method: "POST", url: "/api/v1/sessions/s1/delegations/cancel-all", headers, payload: {} })).json()).toEqual({ items: [] });
  });
});

describe("删除会话连带往下的会话（需求 R11）", () => {
  it("详情带往下的会话数；不连带只删自己；withChildren=true 连删子孙；前后通知委派", async () => {
    const { context, headers, deletedHooks } = setup();
    const projects = new ProjectRepository(context.database);
    const sessions = new SessionRepository(context.database);
    const project = projects.create({ name: "p", rootPath: context.projectRoot, rootPathKey: context.projectRoot });
    const make = (title: string, parent?: string) =>
      sessions.create({
        projectId: project.id,
        title,
        state: "active",
        ...(parent === undefined ? {} : { graph: { parentSessionId: parent, rootSessionId: parent, relation: "delegate" as const } }),
      });
    const root = make("根");
    const child = make("子", root.id);
    const grandchild = make("孙", child.id);
    const other = make("另一个根");
    const otherChild = make("另一个的子", other.id);
    expect((await context.server.inject({ method: "GET", url: `/api/v1/sessions/${root.id}`, headers: { host: "127.0.0.1:8787" } })).json().links.descendantCount).toBe(2);

    expect((await context.server.inject({ method: "DELETE", url: `/api/v1/sessions/${other.id}`, headers: { ...headers, "idempotency-key": "00000000-0000-4000-8000-0000000000d1" } })).statusCode).toBe(204);
    expect(sessions.getById(otherChild.id)?.state).toBe("active");
    expect((await context.server.inject({ method: "DELETE", url: `/api/v1/sessions/${root.id}?withChildren=true`, headers: { ...headers, "idempotency-key": "00000000-0000-4000-8000-0000000000d2" } })).statusCode).toBe(204);
    expect([root.id, child.id, grandchild.id].map((id) => sessions.getById(id)?.state)).toEqual(["deleted", "deleted", "deleted"]);
    expect(deletedHooks).toEqual([
      ["before", [other.id]],
      ["after", [other.id]],
      ["before", [root.id, child.id, grandchild.id]],
      ["after", [root.id, child.id, grandchild.id]],
    ]);
  });
});

describe("审批坞合并委派子会话的待确认卡（R6）", () => {
  it("发起会话的待审批列表带上没做完的委派子会话的卡片，并标明来源；看历史时不合并", async () => {
    const { context, activeChildren } = setup();
    const projects = new ProjectRepository(context.database);
    const sessions = new SessionRepository(context.database);
    const threads = new SessionThreadRepository(context.database);
    const events = new EventRepository(context.database);
    const approvals = new ApprovalRepository(context.database);
    const project = projects.create({ name: "p", rootPath: context.projectRoot, rootPathKey: context.projectRoot });
    const parent = sessions.create({ projectId: project.id, title: "主会话", state: "active" });
    const child = sessions.create({ projectId: project.id, title: "补测试", state: "active", graph: { parentSessionId: parent.id, rootSessionId: parent.id, relation: "delegate" } });
    const threadRef = { runtimeId: "codex-local", runtimeKind: "codex", threadId: "thread-child" };
    const binding = threads.attach({ sessionId: child.id, threadRef, role: "primary", ordinal: 0, primary: true, metadata: {} });
    const requested = events.append({ sessionId: child.id, sessionThreadId: binding.id, source: "test", type: "approval.requested", payload: {}, threadRef, turnRef: null, ts: 1 });
    approvals.createPending({
      id: "approval-child",
      sessionId: child.id,
      sessionThreadId: binding.id,
      source: "test",
      kind: "command",
      runtimeConnectionId: "c",
      runtimeRequestId: "r",
      runtimeApprovalRef: "ref",
      dedupeKey: "d",
      requestPayload: { command: "pnpm test" },
      requestEventSeq: requested.event.seq,
      requestedAt: 2,
    });
    const origin = { sessionId: child.id, sessionTitle: "补测试", agentName: "Claude Code", delegationId: "d1", task: "补测试" };
    activeChildren.set(parent.id, [{ childSessionId: child.id, origin }]);
    const list = await context.server.inject({ method: "GET", url: `/api/v1/sessions/${parent.id}/approvals`, headers: { host: "127.0.0.1:8787" } });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toMatchObject([{ id: "approval-child", origin }]);
    const history = await context.server.inject({ method: "GET", url: `/api/v1/sessions/${parent.id}/approvals?status=history`, headers: { host: "127.0.0.1:8787" } });
    expect(history.json().items).toEqual([]);
  });
});
