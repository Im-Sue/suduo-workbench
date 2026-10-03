import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { JsonValue, ThreadRef, TurnRef } from "@suduo/client-contracts";
import type { RequirementDto } from "@suduo/cloud-contracts";
import { reduceSessionRunStatuses } from "../src/application/session-run-status-reducer.js";
import { SessionRunStatusService } from "../src/application/session-run-status-service.js";
import { openBetterSqlite3Database } from "../src/infrastructure/db/better-sqlite3-database.js";
import { runMigrations } from "../src/infrastructure/db/migration-runner.js";
import { ApprovalRepository } from "../src/infrastructure/db/repositories/approval-repository.js";
import { EventRepository } from "../src/infrastructure/db/repositories/event-repository.js";
import { ProjectRepository } from "../src/infrastructure/db/repositories/project-repository.js";
import { RequirementSessionRefRepository } from "../src/infrastructure/db/repositories/requirement-session-ref-repository.js";
import { SessionRepository } from "../src/infrastructure/db/repositories/session-repository.js";
import { SessionThreadRepository } from "../src/infrastructure/db/repositories/session-thread-repository.js";
import { RequirementsCredentialStore } from "../src/infrastructure/requirements-v2/credential-store.js";
import { RequirementsRemoteClient } from "../src/infrastructure/requirements-v2/remote-client.js";
import { RequirementsSettingsStore } from "../src/infrastructure/requirements-v2/settings-store.js";

const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("工作台本机读模型能力", () => {
  it("批量运行态归约与逐会话 SessionRunStatusService 完全一致", () => {
    const context = createDatabaseContext();
    try {
      const project = context.projects.create(projectInput("run-status"));
      const running = context.sessions.create(sessionInput(project.id, "运行中", 400));
      const failed = context.sessions.create(sessionInput(project.id, "上一回合失败", 300));
      const idle = context.sessions.create(sessionInput(project.id, "空闲", 200));
      const noEvents = context.sessions.create(sessionInput(project.id, "无事件", 100));

      appendTurn(context.events, running.id, "turn.started", turnRef("running"), {});
      appendTurn(context.events, failed.id, "turn.started", turnRef("failed"), {});
      appendTurn(context.events, failed.id, "turn.completed", turnRef("failed"), {
        turn: { status: "failed" },
      });
      appendTurn(context.events, idle.id, "turn.started", turnRef("idle"), {});
      appendTurn(context.events, idle.id, "turn.completed", turnRef("idle"), {
        turn: { status: "completed" },
      });

      const legacy = new SessionRunStatusService(
        context.projects,
        context.sessions,
        context.events,
        context.approvals,
      ).list(project.id);
      const sessionIds = legacy.items.map((item) => item.sessionId);
      const reduced = reduceSessionRunStatuses(
        sessionIds,
        context.events.listRunStatusEventsForSessions(sessionIds),
      );
      const pending = context.approvals.countPendingGroupedBySession();
      const batched = {
        items: context.sessions.listByProject(project.id).map((session) => {
          const summary = reduced.get(session.id);
          if (!summary) throw new Error("batch reduction omitted a requested session");
          return {
            sessionId: session.id,
            running: summary.running,
            pendingApprovals: pending.get(session.id) ?? 0,
            lastTurnOutcome: summary.lastTurnOutcome,
            lastActivityAt: session.lastActivityAt,
          };
        }),
      };

      expect(batched).toEqual(legacy);
      expect(batched.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ sessionId: running.id, running: true, lastTurnOutcome: null }),
        expect.objectContaining({ sessionId: failed.id, running: false, lastTurnOutcome: "failed" }),
        expect.objectContaining({ sessionId: idle.id, running: false, lastTurnOutcome: "completed" }),
        expect.objectContaining({ sessionId: noEvents.id, running: false, lastTurnOutcome: null }),
      ]));
    } finally {
      context.database.close();
    }
  });

  it("待审批 SQL 分组与逐会话计数一致，并命中现有部分索引", () => {
    const context = createDatabaseContext();
    try {
      const project = context.projects.create(projectInput("approvals"));
      const first = context.sessions.create(sessionInput(project.id, "first", 100));
      const second = context.sessions.create(sessionInput(project.id, "second", 200));
      createPendingApproval(context, first.id, "first-pending", "pending");
      createPendingApproval(context, first.id, "first-deciding", "deciding");
      createPendingApproval(context, second.id, "second-pending", "pending");

      const grouped = context.approvals.countPendingGroupedBySession();
      expect(grouped).toEqual(new Map([
        [first.id, 2],
        [second.id, 1],
      ]));
      for (const session of [first, second]) {
        expect(grouped.get(session.id)).toBe(
          context.approvals.countPendingBySession(session.id),
        );
      }

      const plan = context.database
        .prepare(
          [
            "EXPLAIN QUERY PLAN SELECT session_id, COUNT(*) AS count FROM approvals",
            "WHERE status IN ('pending', 'deciding') GROUP BY session_id",
          ].join(" "),
        )
        .all<{ detail: string }>()
        .map((row) => row.detail);
      expect(plan).toContain("SEARCH approvals USING INDEX idx_approvals_pending (status=?)");
    } finally {
      context.database.close();
    }
  });

  it("跨项目 ref 全量读取与活跃会话时间排序正确", () => {
    const context = createDatabaseContext();
    try {
      const firstProject = context.projects.create(projectInput("first-project"));
      const secondProject = context.projects.create(projectInput("second-project"));
      const oldest = context.sessions.create(sessionInput(firstProject.id, "最旧", 100));
      const newest = context.sessions.create(sessionInput(secondProject.id, "最新", 500));
      const middle = context.sessions.create(sessionInput(firstProject.id, "中间", 300));
      const archived = context.sessions.create(
        sessionInput(secondProject.id, "已归档", 900),
      );
      expect(context.sessions.updateState(archived.id, archived.version, "archived", { now: 901 }))
        .toBe(true);
      context.refs.create(refInput(oldest.id, "remote-first", "requirement-first", 100));
      context.refs.create(refInput(newest.id, "remote-second", "requirement-second", 200));

      expect(context.refs.listAll().map((item) => item.remoteProjectId)).toEqual([
        "remote-second",
        "remote-first",
      ]);
      expect(context.sessions.listActiveByLastActivity(2).map((item) => item.id)).toEqual([
        newest.id,
        middle.id,
      ]);
      expect(context.sessions.listActiveByLastActivity(10).map((item) => item.id)).not.toContain(
        archived.id,
      );
    } finally {
      context.database.close();
    }
  });
});

describe("工作台远程客户端", () => {
  it("stats、审计 projectId 与 101 个需求的分批请求均正确", async () => {
    const requests: URL[] = [];
    const client = authenticatedRemoteClient(async (input) => {
      const url = requestUrl(input);
      requests.push(url);
      if (url.pathname === "/v2/requirements") {
        return jsonResponse({
          items: (url.searchParams.get("ids") ?? "")
            .split(",")
            .filter(Boolean)
            .map(requirementDto),
        });
      }
      if (url.pathname.endsWith("/stats")) {
        return jsonResponse({ statusCounts: {}, staleRequirements: [], transitions: [] });
      }
      return jsonResponse({ items: [], nextCursor: null });
    });
    const ids = Array.from({ length: 101 }, (_, index) => `requirement-${String(index)}`);

    await client.getProjectStats("project one", {
      window: "7d",
      tz: "America/Chicago",
    });
    await client.listAudit({ projectId: "project-filter" });
    const requirements = await client.listRequirementsByIds(ids, { concurrency: 2 });

    expect(requirements.map((item) => item.id)).toEqual(ids);
    const batchSizes = requests
      .filter((url) => url.pathname === "/v2/requirements")
      .map((url) => (url.searchParams.get("ids") ?? "").split(",").length);
    expect(batchSizes.sort((left, right) => left - right)).toEqual([1, 100]);
    const stats = requests.find((url) => url.pathname.endsWith("/stats"));
    expect(stats?.pathname).toBe("/v2/projects/project%20one/stats");
    expect(stats?.searchParams.get("window")).toBe("7d");
    expect(stats?.searchParams.get("tz")).toBe("America/Chicago");
    expect(requests.find((url) => url.pathname === "/v2/audit")?.searchParams.get("projectId"))
      .toBe("project-filter");
  });

  it("任一批远程失败时拒绝整个批量调用", async () => {
    let requestCount = 0;
    const client = authenticatedRemoteClient(async (input) => {
      requestCount += 1;
      const url = requestUrl(input);
      if (url.pathname === "/v2/requirements" && requestCount === 2) {
        return jsonResponse({ error: { code: "INTERNAL_ERROR" } }, 500);
      }
      return jsonResponse({
        items: (url.searchParams.get("ids") ?? "")
          .split(",")
          .filter(Boolean)
          .map(requirementDto),
      });
    });

    await expect(
      client.listRequirementsByIds(
        Array.from({ length: 101 }, (_, index) => `failing-${String(index)}`),
      ),
    ).rejects.toMatchObject({ statusCode: 500, code: "INTERNAL_ERROR" });
    expect(requestCount).toBe(2);
  });
});

function createDatabaseContext() {
  const database = openBetterSqlite3Database(":memory:");
  runMigrations(database);
  return {
    database,
    projects: new ProjectRepository(database),
    sessions: new SessionRepository(database),
    threads: new SessionThreadRepository(database),
    events: new EventRepository(database),
    approvals: new ApprovalRepository(database),
    refs: new RequirementSessionRefRepository(database),
  };
}

function projectInput(name: string) {
  return {
    name,
    rootPath: `/tmp/${name}`,
    rootPathKey: `/tmp/${name}`,
    now: 1,
  };
}

function sessionInput(projectId: string, title: string, now: number) {
  return { projectId, title, state: "active" as const, now };
}

function refInput(
  sessionId: string,
  remoteProjectId: string,
  remoteRequirementId: string,
  now: number,
) {
  return {
    sessionId,
    remoteProjectId,
    remoteRequirementId,
    requirementVersion: 1,
    materialPath: `materials/${remoteRequirementId}`,
    manifestSha256: "a".repeat(64),
    now,
  };
}

function appendTurn(
  events: EventRepository,
  sessionId: string,
  type: "turn.started" | "turn.completed",
  turn: TurnRef,
  payload: JsonValue,
): void {
  events.append({
    sessionId,
    source: "runtime:codex-local",
    type,
    payload,
    threadRef: threadRef(turn.threadId),
    turnRef: turn,
    ts: Date.now(),
  });
}

function createPendingApproval(
  context: ReturnType<typeof createDatabaseContext>,
  sessionId: string,
  key: string,
  status: "pending" | "deciding",
): void {
  const thread = context.threads.attach({
    sessionId,
    threadRef: threadRef(`approval-${key}`),
    ordinal: context.threads.listBySession(sessionId).length,
    primary: false,
  });
  const event = context.events.append({
    sessionId,
    sessionThreadId: thread.id,
    source: "runtime:codex-local",
    type: "approval.requested",
    payload: {},
    threadRef: thread.threadRef,
    turnRef: null,
    ts: Date.now(),
    dedupeKey: key,
  }).event;
  const approval = context.approvals.createPending({
    id: `approval-${key}`,
    sessionId,
    sessionThreadId: thread.id,
    source: "runtime:codex-local",
    kind: "command",
    runtimeConnectionId: "connection",
    runtimeRequestId: key,
    runtimeApprovalRef: key,
    dedupeKey: key,
    requestPayload: {},
    requestEventSeq: event.seq,
    requestedAt: event.ts,
  });
  if (status === "deciding") {
    expect(context.approvals.markDeciding(approval.id, approval.version, "accept")).toBe(true);
  }
}

function threadRef(threadId: string): ThreadRef {
  return { runtimeId: "codex-local", runtimeKind: "codex", threadId };
}

function turnRef(turnId: string): TurnRef {
  return { threadId: `thread-${turnId}`, turnId: `turn-${turnId}` };
}

function authenticatedRemoteClient(fetchImplementation: typeof fetch): RequirementsRemoteClient {
  const directory = mkdtempSync(join(tmpdir(), "suduo-my-workbench-remote-"));
  temporaryPaths.push(directory);
  const settings = new RequirementsSettingsStore(directory);
  const credentials = new RequirementsCredentialStore(directory);
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
  return new RequirementsRemoteClient(settings, credentials, fetchImplementation);
}

function requestUrl(input: RequestInfo | URL): URL {
  return new URL(input instanceof Request ? input.url : input.toString());
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requirementDto(id: string): RequirementDto {
  const user = {
    id: "fixture-user",
    displayName: "Fixture User",
  };
  return {
    id,
    projectId: "fixture-project",
    number: 1,
    title: id,
    summary: id,
    status: "draft",
    assignee: null,
    commentCount: 0,
    attachmentCount: 0,
    createdBy: user,
    updatedBy: user,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 1,
  };
}
