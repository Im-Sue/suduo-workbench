import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentRuntime,
  ApproveResult,
  JsonValue,
  RuntimeEventDraft,
  SessionListItemDto,
  StartThreadInput,
  StartThreadResult,
  StartTurnResult,
} from "@suduo/client-contracts";
import { EventLedger } from "../src/application/event-ledger.js";
import { RuntimeSupervisor } from "../src/application/runtime-supervisor.js";
import { SessionListService } from "../src/application/session-list-service.js";
import { SessionService } from "../src/application/session-service.js";
import { openBetterSqlite3Database } from "../src/infrastructure/db/better-sqlite3-database.js";
import { runMigrations } from "../src/infrastructure/db/migration-runner.js";
import { ApprovalRepository } from "../src/infrastructure/db/repositories/approval-repository.js";
import { EventRepository } from "../src/infrastructure/db/repositories/event-repository.js";
import { ProjectRepository } from "../src/infrastructure/db/repositories/project-repository.js";
import { RequirementSessionRefRepository } from "../src/infrastructure/db/repositories/requirement-session-ref-repository.js";
import { SessionListRepository, sessionListSql } from "../src/infrastructure/db/repositories/session-list-repository.js";
import { SessionRepository } from "../src/infrastructure/db/repositories/session-repository.js";
import { SessionThreadRepository } from "../src/infrastructure/db/repositories/session-thread-repository.js";
import { WorkspaceMappingRepository } from "../src/infrastructure/db/repositories/workspace-mapping-repository.js";
import { RuntimeRegistry } from "../src/infrastructure/runtime/runtime-registry.js";
import { createMinimalHttpContext } from "./helpers/minimal-http-context.js";

const REMOTE_PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const REMOTE_REQUIREMENT_ID = "22222222-2222-4222-8222-222222222222";

function createContext() {
  const database = openBetterSqlite3Database(":memory:");
  runMigrations(database);
  const projects = new ProjectRepository(database);
  const sessions = new SessionRepository(database);
  const threads = new SessionThreadRepository(database);
  const events = new EventRepository(database);
  const approvals = new ApprovalRepository(database);
  const refs = new RequirementSessionRefRepository(database);
  const mappings = new WorkspaceMappingRepository(database);
  const ledger = new EventLedger(database, events, approvals, { publish: () => undefined });
  const service = new SessionListService({ list: new SessionListRepository(database), threads, events, approvals });
  let ordinal = 0;
  const append = (sessionId: string, type: string, payload: JsonValue, options: { turnId?: string; ts?: number } = {}) => {
    ordinal += 1;
    return ledger.append({
      sessionId,
      sessionThreadId: null,
      event: {
        source: "runtime:codex-local",
        type,
        payload,
        threadRef: { runtimeId: "codex-local", runtimeKind: "codex", threadId: "thread-" + sessionId },
        turnRef: options.turnId === undefined ? null : { threadId: "thread-" + sessionId, turnId: options.turnId },
        ts: options.ts ?? 1_000 + ordinal,
        dedupeKey: "list:" + String(ordinal),
      },
    });
  };
  return { database, projects, sessions, threads, events, approvals, refs, mappings, ledger, service, append };
}

function collectAll(service: SessionListService, state: "active" | "archived" | "all", limit: number): SessionListItemDto[] {
  const all: SessionListItemDto[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 100; guard += 1) {
    const page = service.list({ state, limit, ...(cursor === undefined ? {} : { cursor }) }, "zh-CN");
    all.push(...page.items);
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return all;
}

describe("入账维护最后一句话预览", () => {
  it("用户消息与助手完整回复更新预览，增量与非消息条目不动；助手回复推进最后活动时间", () => {
    const context = createContext();
    try {
      const project = context.projects.create({ name: "p", rootPath: "/tmp/p", rootPathKey: "/tmp/p" });
      const session = context.sessions.create({ projectId: project.id, title: "s", state: "active", now: 10 });
      context.append(session.id, "message.submitted", { content: [{ type: "text", text: "帮我\n改一下" }], clientTurnId: "c" }, { ts: 20 });
      let item = context.service.list({}, "zh-CN").items[0]!;
      expect(item.preview).toEqual({ role: "user", text: "帮我 改一下" });
      expect(item.lastActivityAt).toBe(20);

      context.append(session.id, "message.delta", { text: "好", itemId: "m" }, { ts: 30 });
      context.append(session.id, "item.completed", { item: { type: "reasoning", id: "r", summary: ["想"], content: [] } }, { ts: 31 });
      item = context.service.list({}, "zh-CN").items[0]!;
      expect(item.preview).toEqual({ role: "user", text: "帮我 改一下" });

      context.append(session.id, "item.completed", { item: { type: "agentMessage", id: "m", text: "改好了。" } }, { ts: 40 });
      item = context.service.list({}, "zh-CN").items[0]!;
      expect(item.preview).toEqual({ role: "assistant", text: "改好了。" });
      expect(item.lastActivityAt).toBe(40);
    } finally {
      context.database.close();
    }
  });

  it("只接受更新的事件序号，乱序补写不会回退预览", () => {
    const context = createContext();
    try {
      const project = context.projects.create({ name: "p", rootPath: "/tmp/p", rootPathKey: "/tmp/p" });
      const session = context.sessions.create({ projectId: project.id, title: "s", state: "active" });
      context.sessions.recordLastMessage(session.id, { role: "assistant", text: "新", seq: 10, ts: 100 });
      context.sessions.recordLastMessage(session.id, { role: "user", text: "旧", seq: 5, ts: 50 });
      expect(context.service.list({}, "zh-CN").items[0]?.preview).toEqual({ role: "assistant", text: "新" });
    } finally {
      context.database.close();
    }
  });
});

describe("跨项目会话列表", () => {
  it("按最后活动时间倒序（同刻按 id 升序），键集游标翻页不重不漏", () => {
    const context = createContext();
    try {
      const a = context.projects.create({ name: "A", rootPath: "/tmp/a", rootPathKey: "/tmp/a" });
      const b = context.projects.create({ name: "B", rootPath: "/tmp/b", rootPathKey: "/tmp/b" });
      const ids: string[] = [];
      // 12 个会话分布在两个项目，其中多组共享同一时间戳，考验同刻决胜。
      for (let index = 0; index < 12; index += 1) {
        const session = context.sessions.create({
          id: "session-" + String(index).padStart(2, "0"),
          projectId: index % 2 === 0 ? a.id : b.id,
          title: "s" + String(index),
          state: "active",
          now: 100 + Math.floor(index / 3),
        });
        ids.push(session.id);
      }
      const expected = [...ids].sort((left, right) => {
        const leftKey = 100 + Math.floor(ids.indexOf(left) / 3);
        const rightKey = 100 + Math.floor(ids.indexOf(right) / 3);
        return rightKey - leftKey || left.localeCompare(right);
      });
      for (const limit of [1, 2, 3, 5, 50]) {
        expect(collectAll(context.service, "active", limit).map((item) => item.id)).toEqual(expected);
      }
      const firstPage = context.service.list({ limit: 4 }, "zh-CN");
      expect(firstPage.items.map((item) => item.project.name)).toEqual(
        firstPage.items.map((item) => (Number(item.id.slice(-2)) % 2 === 0 ? "A" : "B")),
      );

      // 翻页途中有会话变活跃：它回到第一页，后续页不重复它。
      const page1 = context.service.list({ limit: 4 }, "zh-CN");
      const moved = expected.at(-1)!;
      context.sessions.touchActivity(moved, 500);
      const rest: string[] = [];
      let cursor = page1.nextCursor;
      while (cursor !== null) {
        const page = context.service.list({ limit: 4, cursor }, "zh-CN");
        rest.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor;
      }
      const seen = [...page1.items.map((item) => item.id), ...rest];
      expect(new Set(seen).size).toBe(seen.length);
      expect(rest).not.toContain(moved);
      expect(context.service.list({ limit: 1 }, "zh-CN").items[0]?.id).toBe(moved);
    } finally {
      context.database.close();
    }
  });

  it("state 过滤：active 含启动中 / 出错，archived 只含归档，all 不含已删除", () => {
    const context = createContext();
    try {
      const project = context.projects.create({ name: "p", rootPath: "/tmp/p", rootPathKey: "/tmp/p" });
      const make = (id: string, state: "starting" | "active" | "error" | "archived" | "deleted", now: number) => {
        const created = context.sessions.create({ id, projectId: project.id, title: id, state: "active", now });
        if (state !== "active") {
          context.sessions.updateState(created.id, created.version, state, { now });
        }
      };
      make("s-active", "active", 1);
      make("s-starting", "starting", 2);
      make("s-error", "error", 3);
      make("s-archived", "archived", 4);
      make("s-deleted", "deleted", 5);
      expect(context.service.list({}, "zh-CN").items.map((item) => item.id)).toEqual(["s-error", "s-starting", "s-active"]);
      expect(context.service.list({ state: "archived" }, "zh-CN").items.map((item) => item.id)).toEqual(["s-archived"]);
      expect(context.service.list({ state: "all" }, "zh-CN").items.map((item) => item.id)).toEqual(["s-archived", "s-error", "s-starting", "s-active"]);
    } finally {
      context.database.close();
    }
  });

  it("项目、远程项目、需求快照与运行态", () => {
    const context = createContext();
    try {
      const mapped = context.projects.create({ name: "映射项目", rootPath: "/tmp/mapped", rootPathKey: "/tmp/mapped" });
      const plain = context.projects.create({ name: "本机项目", rootPath: "/tmp/plain", rootPathKey: "/tmp/plain" });
      context.mappings.save({ remoteProjectId: REMOTE_PROJECT_ID, localProjectId: mapped.id });
      const requirementSession = context.sessions.create({ id: "s-req", projectId: mapped.id, title: "需求会话", state: "active", now: 30 });
      const legacySession = context.sessions.create({ id: "s-legacy", projectId: mapped.id, title: "旧需求会话", state: "active", now: 20 });
      const plainSession = context.sessions.create({ id: "s-plain", projectId: plain.id, title: "普通会话", state: "active", now: 10 });
      const ref = {
        remoteProjectId: REMOTE_PROJECT_ID,
        remoteRequirementId: REMOTE_REQUIREMENT_ID,
        requirementVersion: 1,
        materialPath: "/tmp/material",
        manifestSha256: "a".repeat(64),
      };
      context.refs.create({ ...ref, sessionId: requirementSession.id, requirementNumber: 42, requirementTitle: " 登录页改版 " });
      context.refs.create({ ...ref, sessionId: legacySession.id });

      context.append(requirementSession.id, "turn.started", {}, { turnId: "t1", ts: 31 });
      context.append(
        requirementSession.id,
        "item.started",
        { item: { type: "commandExecution", id: "c1", command: "/bin/zsh -lc \"npm test -- --reporter dot\"" } },
        { turnId: "t1", ts: 33 },
      );
      context.append(legacySession.id, "turn.started", {}, { turnId: "t1", ts: 21 });
      context.append(legacySession.id, "turn.completed", { turn: { id: "t1", status: "failed" } }, { turnId: "t1", ts: 22 });
      context.ledger.appendApprovalRequested({
        sessionId: requirementSession.id,
        sessionThreadId: context.threads.attach({ sessionId: requirementSession.id, threadRef: { runtimeId: "codex-local", runtimeKind: "codex", threadId: "thread-s-req" } }).id,
        kind: "command",
        runtimeConnectionId: "c",
        runtimeRequestId: "1",
        runtimeApprovalRef: "ref-1",
        event: {
          source: "runtime:codex-local",
          type: "approval.requested",
          payload: { kind: "command", approvalRef: "ref-1", request: { threadId: "thread-s-req", turnId: "t1" } },
          threadRef: { runtimeId: "codex-local", runtimeKind: "codex", threadId: "thread-s-req" },
          turnRef: { threadId: "thread-s-req", turnId: "t1" },
          ts: 32,
          dedupeKey: "approval:1",
        },
      });

      const items = new Map(context.service.list({}, "zh-CN").items.map((item) => [item.id, item]));
      expect(items.get("s-req")).toMatchObject({
        title: "需求会话",
        model: null,
        reasoningEffort: null,
        project: { id: mapped.id, name: "映射项目", rootPath: "/tmp/mapped", state: "active", remoteProjectId: REMOTE_PROJECT_ID },
        requirement: { remoteRequirementId: REMOTE_REQUIREMENT_ID, number: 42, title: "登录页改版" },
        preview: null,
        runStatus: { running: true, pendingApprovals: 1, lastTurnOutcome: null, runningSince: 31, activity: "运行命令：npm test -- --reporter dot" },
      });
      expect(items.get("s-req")?.threads).toHaveLength(1);
      expect(items.get("s-legacy")).toMatchObject({
        requirement: { remoteRequirementId: REMOTE_REQUIREMENT_ID, number: null, title: null },
        runStatus: { running: false, pendingApprovals: 0, lastTurnOutcome: "failed", runningSince: null, activity: null },
      });
      expect(items.get("s-plain")).toMatchObject({
        project: { name: "本机项目", remoteProjectId: null },
        requirement: null,
        runStatus: { running: false, pendingApprovals: 0, lastTurnOutcome: null },
      });
      expect(plainSession.id).toBe("s-plain");
    } finally {
      context.database.close();
    }
  });

  it("当前步骤：同一条目完成后显示「刚完成」；完成的思考不显示；只看本轮开始之后的步骤", () => {
    const context = createContext();
    try {
      const project = context.projects.create({ name: "步骤项目", rootPath: "/tmp/steps", rootPathKey: "/tmp/steps" });
      const session = context.sessions.create({ id: "s-steps", projectId: project.id, title: "步骤会话", state: "active", now: 10 });
      const activity = () => context.service.list({}, "zh-CN").items.find((item) => item.id === session.id)?.runStatus.activity;

      // 上一轮留下的命令不算本轮的当前步骤。
      context.append(session.id, "turn.started", {}, { turnId: "t0", ts: 11 });
      context.append(session.id, "item.started", { item: { type: "commandExecution", id: "old", command: "ls" } }, { turnId: "t0", ts: 12 });
      context.append(session.id, "turn.completed", { turn: { id: "t0", status: "completed" } }, { turnId: "t0", ts: 13 });
      context.append(session.id, "turn.started", {}, { turnId: "t1", ts: 20 });
      expect(activity()).toBeNull();

      context.append(session.id, "item.started", { item: { type: "commandExecution", id: "c1", command: "pnpm test" } }, { turnId: "t1", ts: 21 });
      expect(activity()).toBe("运行命令：pnpm test");
      // 别的条目完成不影响；同 id 的完成才算「刚完成」。
      context.append(session.id, "item.completed", { item: { type: "reasoning", id: "other", summary: [], content: [] } }, { turnId: "t1", ts: 22 });
      expect(activity()).toBe("运行命令：pnpm test");
      context.append(session.id, "item.completed", { item: { type: "commandExecution", id: "c1", command: "pnpm test" } }, { turnId: "t1", ts: 23 });
      expect(activity()).toBe("刚完成：运行命令：pnpm test");

      context.append(session.id, "item.started", { item: { type: "reasoning", id: "r1", summary: [], content: [] } }, { turnId: "t1", ts: 24 });
      context.append(session.id, "item.completed", { item: { type: "reasoning", id: "r1", summary: [], content: [] } }, { turnId: "t1", ts: 25 });
      expect(activity()).toBeNull();
    } finally {
      context.database.close();
    }
  });

  it("按远程项目过滤：需求会话按需求所属项目、其余按目录映射，不属于任何项目的不出现；翻页不重不漏", () => {
    const context = createContext();
    try {
      const OTHER_REMOTE_PROJECT_ID = "33333333-3333-4333-8333-333333333333";
      const mapped = context.projects.create({ name: "映射项目", rootPath: "/tmp/mapped", rootPathKey: "/tmp/mapped" });
      const plain = context.projects.create({ name: "本机项目", rootPath: "/tmp/plain", rootPathKey: "/tmp/plain" });
      context.mappings.save({ remoteProjectId: REMOTE_PROJECT_ID, localProjectId: mapped.id });
      for (let index = 0; index < 5; index += 1) {
        context.sessions.create({ id: `s-mapped-${String(index)}`, projectId: mapped.id, title: "目录会话", state: "active", now: 10 + index });
      }
      // 需求会话的需求属于另一个项目（目录后来改关联了）：按需求所属项目算。
      const requirementSession = context.sessions.create({ id: "s-req", projectId: mapped.id, title: "需求会话", state: "active", now: 30 });
      context.refs.create({
        sessionId: requirementSession.id,
        remoteProjectId: OTHER_REMOTE_PROJECT_ID,
        remoteRequirementId: REMOTE_REQUIREMENT_ID,
        requirementVersion: 1,
        materialPath: "/tmp/material",
        manifestSha256: "a".repeat(64),
      });
      context.sessions.create({ id: "s-plain", projectId: plain.id, title: "普通会话", state: "active", now: 40 });

      const ids = (remoteProjectId: string | undefined, limit: number) => {
        const all: string[] = [];
        let cursor: string | undefined;
        for (let guard = 0; guard < 20; guard += 1) {
          const page = context.service.list({
            limit,
            ...(remoteProjectId === undefined ? {} : { remoteProjectId }),
            ...(cursor === undefined ? {} : { cursor }),
          }, "zh-CN");
          all.push(...page.items.map((item) => item.id));
          if (page.nextCursor === null) break;
          cursor = page.nextCursor;
        }
        return all;
      };
      expect(ids(REMOTE_PROJECT_ID, 2)).toEqual(["s-mapped-4", "s-mapped-3", "s-mapped-2", "s-mapped-1", "s-mapped-0"]);
      expect(ids(OTHER_REMOTE_PROJECT_ID, 2)).toEqual(["s-req"]);
      expect(ids("44444444-4444-4444-8444-444444444444", 2)).toEqual([]);
      expect(ids(undefined, 50)).toEqual(["s-plain", "s-req", "s-mapped-4", "s-mapped-3", "s-mapped-2", "s-mapped-1", "s-mapped-0"]);
    } finally {
      context.database.close();
    }
  });

  it("带游标的列表查询按排序索引定位，不回表排序", () => {
    const context = createContext();
    try {
      const plan = (withCursor: boolean, withRemoteProject = false) =>
        context.database
          .prepare("EXPLAIN QUERY PLAN " + sessionListSql(withCursor, withRemoteProject))
          .all<{ detail: string }>({
            states: JSON.stringify(["active"]),
            kind: "normal",
            limit: 10,
            ...(withCursor ? { afterKey: 100, afterId: "x" } : {}),
            ...(withRemoteProject ? { remoteProjectId: REMOTE_PROJECT_ID } : {}),
          })
          .map((row) => row.detail)
          .join("\n");
      for (const withCursor of [false, true]) {
        for (const withRemoteProject of [false, true]) {
          const detail = plan(withCursor, withRemoteProject);
          expect(detail).toContain("idx_sessions_list_recent");
          expect(detail).not.toContain("TEMP B-TREE");
        }
      }
      expect(plan(true)).toMatch(/SEARCH s USING INDEX idx_sessions_list_recent/u);
      expect(plan(true, true)).toMatch(/SEARCH s USING INDEX idx_sessions_list_recent/u);
    } finally {
      context.database.close();
    }
  });

  it("limit 与 cursor 校验", () => {
    const context = createContext();
    try {
      expect(() => context.service.list({ limit: 0 }, "zh-CN")).toThrow("limit");
      expect(() => context.service.list({ limit: 201 }, "zh-CN")).toThrow("limit");
      expect(() => context.service.list({ cursor: "not-a-cursor" }, "zh-CN")).toThrow("cursor");
      expect(() => context.service.list({ cursor: Buffer.from(JSON.stringify(["x", 1])).toString("base64url") }, "zh-CN")).toThrow("cursor");
      expect(context.service.list({}, "zh-CN")).toEqual({ items: [], nextCursor: null });
    } finally {
      context.database.close();
    }
  });
});

class StartingRuntime implements AgentRuntime {
  readonly runtimeId = "codex-local";
  readonly runtimeKind = "codex";
  async startThread(input: StartThreadInput): Promise<StartThreadResult> {
    const thread = { threadRef: { runtimeId: this.runtimeId, runtimeKind: this.runtimeKind, threadId: "thread-" + input.sessionId }, role: "primary", metadata: {} };
    return { primaryThread: thread, threads: [thread] };
  }
  async startTurn(): Promise<StartTurnResult> { throw new Error("unused"); }
  async approve(): Promise<ApproveResult> { return { acknowledged: true }; }
  async interrupt(): Promise<void> { return undefined; }
  async *subscribe(): AsyncIterable<RuntimeEventDraft> { yield* []; }
}

describe("需求会话创建时快照需求编号与标题", () => {
  it("createFromRequirement 写入编号与标题，列表直接读本机", async () => {
    const context = createContext();
    try {
      const project = context.projects.create({ name: "p", rootPath: "/tmp/req", rootPathKey: "/tmp/req" });
      const registry = new RuntimeRegistry();
      registry.register(new StartingRuntime());
      const service = new SessionService(
        context.database,
        context.projects,
        context.sessions,
        context.threads,
        new RuntimeSupervisor(registry),
        undefined,
        undefined,
        context.refs,
      );
      const created = await service.createFromRequirement(project.id, {
        locale: "zh-CN",
        title: "支付回调重试",
        remoteProjectId: REMOTE_PROJECT_ID,
        remoteRequirementId: REMOTE_REQUIREMENT_ID,
        requirementVersion: 3,
        requirementNumber: 7,
        setup: {},
      });
      expect(context.service.list({}, "zh-CN").items.find((item) => item.id === created.id)?.requirement).toEqual({
        remoteRequirementId: REMOTE_REQUIREMENT_ID,
        number: 7,
        title: "支付回调重试",
      });
    } finally {
      context.database.close();
    }
  });
});

describe("GET /api/v1/sessions", () => {
  const contexts: Array<ReturnType<typeof createMinimalHttpContext>> = [];
  afterEach(async () => {
    for (const context of contexts.splice(0)) await context.close();
  });

  it("默认列出活动会话并带元数据；参数非法返回 400；按项目列表保持原形状", async () => {
    const context = createMinimalHttpContext(new StartingRuntime());
    contexts.push(context);
    const host = "127.0.0.1:8787";
    let key = 0;
    const post = (url: string, body: unknown) =>
      context.server.inject({
        method: "POST",
        url,
        headers: { host, origin: `http://${host}`, "idempotency-key": "k" + String(++key), "content-type": "application/json" },
        payload: JSON.stringify(body),
      });
    const project = await post("/api/v1/projects", { rootPath: context.projectRoot, name: "HTTP 项目" });
    const projectId = String(project.json().id);
    const session = await post(`/api/v1/projects/${projectId}/sessions`, { title: "列表会话" });
    expect(session.statusCode).toBe(201);

    const list = await context.server.inject({ method: "GET", url: "/api/v1/sessions", headers: { host } });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({
      nextCursor: null,
      items: [
        {
          id: session.json().id,
          title: "列表会话",
          project: { id: projectId, name: "HTTP 项目", remoteProjectId: null },
          requirement: null,
          preview: null,
          runStatus: { running: false, pendingApprovals: 0, lastTurnOutcome: null },
        },
      ],
    });
    const archived = await context.server.inject({ method: "GET", url: "/api/v1/sessions?state=archived", headers: { host } });
    expect(archived.json().items).toEqual([]);
    const otherProject = await context.server.inject({ method: "GET", url: "/api/v1/sessions?remoteProjectId=proj-x", headers: { host } });
    expect(otherProject.statusCode).toBe(200);
    expect(otherProject.json()).toEqual({ items: [], nextCursor: null });
    for (const query of ["state=deleted", "limit=0", "limit=abc", "cursor=%%%", "remoteProjectId="]) {
      const bad = await context.server.inject({ method: "GET", url: "/api/v1/sessions?" + query, headers: { host } });
      expect(bad.statusCode, query).toBe(400);
    }

    const perProject = await context.server.inject({ method: "GET", url: `/api/v1/projects/${projectId}/sessions`, headers: { host } });
    const legacyItem = perProject.json().items[0] as Record<string, unknown>;
    expect(legacyItem["project"]).toBeUndefined();
    expect(legacyItem["preview"]).toBeUndefined();
    expect(legacyItem).toMatchObject({ id: session.json().id, model: null, reasoningEffort: null });
  });
});
