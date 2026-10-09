import { describe, expect, it, vi } from "vitest";
import type { EventEnvelope, JsonValue, RuntimeEventDraft } from "@suduo/client-contracts";
import { EventLedger } from "../src/application/event-ledger.js";
import { canonicalJson, hashIdempotencyRequest } from "../src/application/idempotency.js";
import { openBetterSqlite3Database } from "../src/infrastructure/db/better-sqlite3-database.js";
import { loadM1Migrations, runMigrations } from "../src/infrastructure/db/migration-runner.js";
import { ApprovalRepository } from "../src/infrastructure/db/repositories/approval-repository.js";
import { EventRepository } from "../src/infrastructure/db/repositories/event-repository.js";
import { IdempotencyRepository } from "../src/infrastructure/db/repositories/idempotency-repository.js";
import { ProjectRepository } from "../src/infrastructure/db/repositories/project-repository.js";
import { SessionRepository } from "../src/infrastructure/db/repositories/session-repository.js";
import { SessionThreadRepository } from "../src/infrastructure/db/repositories/session-thread-repository.js";
import { RequirementSessionRefRepository } from "../src/infrastructure/db/repositories/requirement-session-ref-repository.js";

describe("T2 SQLite 存储层", () => {
  it("执行迁移并支持项目、会话与 1:N thread", () => {
    const context = createContext();
    try {
      expect(context.firstMigration.appliedVersions).toEqual([1, 2, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);
      const project = context.projects.create({ name: "sample", rootPath: "/tmp/sample", rootPathKey: "/tmp/sample" });
      const session = context.sessions.create({ projectId: project.id, title: "Gate A" });
      const primary = context.threads.attach({ sessionId: session.id, threadRef: codexThread("thread-primary") });
      expect(context.threads.getPrimary(session.id)?.id).toBe(primary.id);
    } finally { context.database.close(); }
  });

  it("将含存量 requirement session ref 的 v10 本机库升级为 observation 四态", () => {
    const database = openBetterSqlite3Database(":memory:");
    try {
      runMigrations(
        database,
        loadM1Migrations().filter((migration) => migration.version < 11),
        () => 1,
      );
      const project = new ProjectRepository(database).create({
        name: "legacy",
        rootPath: "/tmp/legacy",
        rootPathKey: "/tmp/legacy",
      });
      const session = new SessionRepository(database).create({
        projectId: project.id,
        title: "legacy",
      });
      database
        .prepare(
          [
            "INSERT INTO v2_requirement_session_refs",
            "(session_id, remote_project_id, remote_requirement_id, requirement_version, material_path, manifest_sha256, created_at)",
            "VALUES (@sessionId, @projectId, @requirementId, 1, @materialPath, @manifestSha256, 1)",
          ].join(" "),
        )
        .run({
          sessionId: session.id,
          projectId: "11111111-1111-4111-8111-111111111111",
          requirementId: "22222222-2222-4222-8222-222222222222",
          materialPath: "/tmp/legacy-material",
          manifestSha256: "a".repeat(64),
        });

      expect(runMigrations(database, undefined, () => 2).appliedVersions).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);
      expect(
        database
          .prepare(
            [
              "SELECT anchor_state, audit_anchor_created_at, audit_anchor_id, observation_sha256, observation_state, observation_last_success_at, observation_failure_reason",
              "FROM v2_requirement_session_refs WHERE session_id = @sessionId",
            ].join(" "),
          )
          .get({ sessionId: session.id }),
      ).toEqual({
        anchor_state: "unknown",
        audit_anchor_created_at: null,
        audit_anchor_id: null,
        observation_sha256: null,
        observation_state: "unknown",
        observation_last_success_at: null,
        observation_failure_reason: null,
      });
      // 015：旧会话保留快照路径并标为 legacy（不再刷新，界面提示新建）。
      expect(new RequirementSessionRefRepository(database).getBySessionId(session.id)).toMatchObject({
        materialPath: "/tmp/legacy-material",
        contextMode: "legacy",
      });
    } finally { database.close(); }
  });

  it("事件事务提交后才发布，并按 after=seq 去重读取", () => {
    const context = createPopulatedContext();
    const published: EventEnvelope<string, JsonValue>[] = [];
    const ledger = new EventLedger(context.database, context.events, context.approvals, { publish: (event) => published.push(event) });
    try {
      const first = ledger.append({ sessionId: context.sessionId, sessionThreadId: context.sessionThreadId, event: runtimeEvent("message.delta", "connection:1", { text: "a" }) });
      const duplicate = ledger.append({ sessionId: context.sessionId, sessionThreadId: context.sessionThreadId, event: runtimeEvent("message.delta", "connection:1", { text: "a" }) });
      expect(duplicate.seq).toBe(first.seq);
      expect(published).toHaveLength(1);
    } finally { context.database.close(); }
  });

  it("审批请求与事件原子落库", () => {
    const context = createPopulatedContext();
    const ledger = new EventLedger(context.database, context.events, context.approvals, { publish: () => undefined });
    try {
      const requested = ledger.appendApprovalRequested({ sessionId: context.sessionId, sessionThreadId: context.sessionThreadId, kind: "command", runtimeConnectionId: "connection", runtimeRequestId: "41", runtimeApprovalRef: "opaque", event: runtimeEvent("approval.requested", "connection:41", { approvalRef: "opaque", kind: "command" }) });
      expect(requested.approval.status).toBe("pending");
    } finally { context.database.close(); }
  });

  it("archivedAt 只在进入 archived 时设置，已归档 PATCH 不延长保留期", () => {
    const context = createContext();
    try {
      const project = context.projects.create({
        name: "retention",
        rootPath: "/tmp/retention",
        rootPathKey: "/tmp/retention",
      });
      const created = context.sessions.create({
        projectId: project.id,
        title: "需求会话",
        state: "active",
        now: 1,
      });
      expect(context.sessions.updateState(created.id, created.version, "archived", { now: 10 })).toBe(true);
      const firstArchived = context.sessions.getById(created.id)!;
      expect(firstArchived.archivedAt).toBe(10);

      expect(context.sessions.update(firstArchived.id, firstArchived.version, { title: "归档后改名" }, { now: 20 })).toBe(true);
      const patchedArchived = context.sessions.getById(created.id)!;
      expect(patchedArchived.archivedAt).toBe(10);

      expect(context.sessions.updateState(patchedArchived.id, patchedArchived.version, "active", { now: 30 })).toBe(true);
      const restored = context.sessions.getById(created.id)!;
      expect(restored.archivedAt).toBeNull();
      expect(context.sessions.updateState(restored.id, restored.version, "archived", { now: 40 })).toBe(true);
      expect(context.sessions.getById(created.id)?.archivedAt).toBe(40);
    } finally { context.database.close(); }
  });

  it("幂等请求哈希稳定并区分 replay/conflict", () => {
    const context = createContext();
    try {
      const left = { b: 2, a: { z: true, y: [1, 2] } } satisfies JsonValue;
      const right = { a: { y: [1, 2], z: true }, b: 2 } satisfies JsonValue;
      expect(canonicalJson(left)).toBe(canonicalJson(right));
      const hash = hashIdempotencyRequest(left);
      expect(context.idempotency.claim("message", "key", hash, 1000, 1).kind).toBe("started");
      expect(context.idempotency.claim("message", "key", hash, 1000, 2).kind).toBe("replay");
    } finally { context.database.close(); }
  });

  it("拒绝包含旧迁移记录的数据库", () => {
    // 这句报错按系统语言（中英双语 S8）；这里固定中文，英文见 cli-i18n.test.ts。
    vi.stubEnv("SUDUO_LOCALE", "zh-CN");
    const database = openBetterSqlite3Database(":memory:");
    try {
      database.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          applied_at INTEGER NOT NULL
        ) STRICT;
        INSERT INTO schema_migrations (version, name, applied_at)
        VALUES (1, 'm1_initial', 1), (2, 'approval_modes', 1), (9, 'v2_requirements_local_state', 1);
      `);

      expect(() => runMigrations(database)).toThrow(
        "检测到旧数据库迁移版本 [9]；按 D4 删除本机数据库后重建。",
      );
    } finally { database.close(); vi.unstubAllEnvs(); }
  });
});

function createContext() {
  const database = openBetterSqlite3Database(":memory:");
  return { database, firstMigration: runMigrations(database, undefined, () => 1), projects: new ProjectRepository(database), sessions: new SessionRepository(database), threads: new SessionThreadRepository(database), events: new EventRepository(database), approvals: new ApprovalRepository(database), idempotency: new IdempotencyRepository(database) };
}

function createPopulatedContext() {
  const context = createContext();
  const project = context.projects.create({ name: "sample", rootPath: "/tmp/sample", rootPathKey: "/tmp/sample" });
  const session = context.sessions.create({ projectId: project.id, title: "Gate A", state: "active" });
  const thread = context.threads.attach({ sessionId: session.id, threadRef: codexThread("thread-1") });
  return { ...context, sessionId: session.id, sessionThreadId: thread.id };
}

function codexThread(threadId: string) { return { runtimeId: "codex-local", runtimeKind: "codex", threadId }; }
function runtimeEvent(type: string, dedupeKey: string, payload: JsonValue): RuntimeEventDraft { return { source: "runtime:codex-local", type, payload, threadRef: codexThread("thread-1"), turnRef: { threadId: "thread-1", turnId: "turn-1" }, ts: Date.now(), dedupeKey }; }
