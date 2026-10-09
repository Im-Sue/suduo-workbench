import { describe, expect, it } from "vitest";
import type { JsonValue } from "@suduo/client-contracts";
import { EventLedger } from "../src/application/event-ledger.js";
import { SessionListService } from "../src/application/session-list-service.js";
import { openBetterSqlite3Database } from "../src/infrastructure/db/better-sqlite3-database.js";
import { loadM1Migrations, runMigrations } from "../src/infrastructure/db/migration-runner.js";
import { ApprovalRepository } from "../src/infrastructure/db/repositories/approval-repository.js";
import { EventRepository } from "../src/infrastructure/db/repositories/event-repository.js";
import { ProjectRepository } from "../src/infrastructure/db/repositories/project-repository.js";
import { SessionListRepository } from "../src/infrastructure/db/repositories/session-list-repository.js";
import { SessionRepository } from "../src/infrastructure/db/repositories/session-repository.js";
import { SessionThreadRepository } from "../src/infrastructure/db/repositories/session-thread-repository.js";
import { ProjectSessionRefRepository } from "../src/infrastructure/db/repositories/project-session-ref-repository.js";
import { WorkspaceMappingRepository } from "../src/infrastructure/db/repositories/workspace-mapping-repository.js";

function upgradeFrom(version: number) {
  const database = openBetterSqlite3Database(":memory:");
  runMigrations(
    database,
    loadM1Migrations().filter((migration) => migration.version <= version),
    () => 1,
  );
  const project = new ProjectRepository(database).create({ name: "legacy", rootPath: "/tmp/legacy", rootPathKey: "/tmp/legacy" });
  // 旧版本库没有新列：直接用 SQL 插入旧形状的会话行。
  database
    .prepare(
      [
        "INSERT INTO sessions (id, project_id, title, state, created_at, updated_at, last_activity_at, version)",
        "VALUES ('legacy-session', @projectId, 'legacy', 'active', 1, 1, 1, 1)",
      ].join(" "),
    )
    .run({ projectId: project.id });
  return { database, projectId: project.id };
}

describe("018 目录关联按服务器区分、会话记住所属项目", () => {
  it("v17 本机库升级：普通会话按当时的关联补记所属项目，需求 / 房间任务 / 没关联的会话不补；关联保留、服务器待认领、目录可再关联", () => {
    const { database, projectId } = upgradeFrom(17);
    try {
      const projects = new ProjectRepository(database);
      const unmapped = projects.create({ name: "未关联", rootPath: "/tmp/unmapped", rootPathKey: "/tmp/unmapped" });
      const sessions = new SessionRepository(database);
      sessions.create({ id: "plain-mapped", projectId, title: "普通", state: "active", now: 5 });
      sessions.create({ id: "requirement-mapped", projectId, title: "需求", state: "active" });
      sessions.create({ id: "room-mapped", projectId, title: "房间任务", state: "active", kind: "room_task" });
      sessions.create({ id: "plain-unmapped", projectId: unmapped.id, title: "没关联", state: "active" });
      database
        .prepare(
          [
            "INSERT INTO v2_project_workspace_mappings",
            "(remote_project_id, local_project_id, created_at, updated_at, last_validated_at)",
            "VALUES ('proj-a', @projectId, 1, 2, 3)",
          ].join(" "),
        )
        .run({ projectId });
      database
        .prepare(
          [
            "INSERT INTO v2_requirement_session_refs",
            "(session_id, remote_project_id, remote_requirement_id, requirement_version, created_at)",
            "VALUES ('requirement-mapped', 'proj-other', 'req-1', 1, 1)",
          ].join(" "),
        )
        .run();
      database
        .prepare(
          [
            "INSERT INTO room_task_sessions",
            "(agent_id, room_id, thread_root_id, session_id, remote_project_id, room_name, created_at)",
            "VALUES ('agent-1', 'room-1', 'root-1', 'room-mapped', 'proj-a', '默认房间', 1)",
          ].join(" "),
        )
        .run();

      expect(runMigrations(database, undefined, () => 2).appliedVersions).toEqual([18, 19, 20, 21, 22]);

      const refs = new ProjectSessionRefRepository(database);
      expect(refs.getBySessionId("plain-mapped")).toEqual({ sessionId: "plain-mapped", remoteProjectId: "proj-a", createdAt: 5 });
      expect(refs.getBySessionId("legacy-session")?.remoteProjectId).toBe("proj-a");
      expect(refs.getBySessionId("requirement-mapped")).toBeNull();
      expect(refs.getBySessionId("room-mapped")).toBeNull();
      expect(refs.getBySessionId("plain-unmapped")).toBeNull();

      const mappings = new WorkspaceMappingRepository(database);
      expect(mappings.getByRemoteProjectId("proj-a")).toEqual({
        remoteProjectId: "proj-a",
        localProjectId: projectId,
        serverOrigin: null,
        createdAt: 1,
        updatedAt: 2,
        lastValidatedAt: 3,
      });
      // 启动时把存量记为当前服务器；只认领一次。
      expect(mappings.list("https://a.example")).toEqual([]);
      expect(mappings.adoptUnscoped("https://a.example")).toBe(1);
      expect(mappings.adoptUnscoped("https://b.example")).toBe(0);
      expect(mappings.list("https://a.example").map((mapping) => mapping.remoteProjectId)).toEqual(["proj-a"]);
      expect(mappings.list("https://b.example")).toEqual([]);
      // 一个目录可以再关联给另一个项目（唯一约束已去掉）。
      mappings.save({ remoteProjectId: "proj-b", localProjectId: projectId, serverOrigin: "https://a.example" });
      expect(
        mappings.listByLocalProjectId("https://a.example", projectId).map((mapping) => mapping.remoteProjectId).sort(),
      ).toEqual(["proj-a", "proj-b"]);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(runMigrations(database, undefined, () => 3).appliedVersions).toEqual([]);
    } finally {
      database.close();
    }
  });
});

describe("017 会话语言迁移", () => {
  it("v16 本机库升级后存量会话的语言为 zh-CN（它们都是中文说明建的）", () => {
    const { database } = upgradeFrom(16);
    try {
      expect(runMigrations(database, undefined, () => 2).appliedVersions).toEqual([17, 18, 19, 20, 21, 22]);
      expect(new SessionRepository(database).getById("legacy-session")?.locale).toBe("zh-CN");
    } finally {
      database.close();
    }
  });
});

describe("013 会话级模型与推理强度迁移", () => {
  it("v12 本机库升级后存量会话两列为 NULL（跟随全局默认）", () => {
    const { database } = upgradeFrom(12);
    try {
      const result = runMigrations(database, undefined, () => 2);
      expect(result.appliedVersions).toContain(13);
      const session = new SessionRepository(database).getById("legacy-session");
      expect(session).toMatchObject({ model: null, reasoningEffort: null, title: "legacy" });
      // 重复执行是 no-op。
      expect(runMigrations(database, undefined, () => 3).appliedVersions).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("库层只约束长度，档位格式在应用层校验", () => {
    const { database } = upgradeFrom(12);
    try {
      runMigrations(database, undefined, () => 2);
      const write = (model: string | null, effort: string | null) =>
        database
          .prepare("UPDATE sessions SET model = @model, reasoning_effort = @effort WHERE id = 'legacy-session'")
          .run({ model, effort });
      expect(() => write("x".repeat(129), null)).toThrow();
      expect(() => write("", null)).toThrow();
      expect(() => write(null, "")).toThrow();
      expect(() => write("gpt-b", "future-effort")).not.toThrow();
      // 格式合法的新档位（例如 Codex 以后增档）原样读出；格式不合法的读出为 null，不让脏值漏进 DTO。
      expect(new SessionRepository(database).getById("legacy-session")).toMatchObject({ model: "gpt-b", reasoningEffort: "future-effort" });
      write("gpt-b", "Bad Value");
      expect(new SessionRepository(database).getById("legacy-session")).toMatchObject({ reasoningEffort: null });
    } finally {
      database.close();
    }
  });
});

describe("SessionRepository.update 后写生效", () => {
  it("expectedVersion 为 null 时不比对版本；传版本时保持旧的比对语义", () => {
    const database = openBetterSqlite3Database(":memory:");
    try {
      runMigrations(database);
      const project = new ProjectRepository(database).create({ name: "p", rootPath: "/tmp/p", rootPathKey: "/tmp/p" });
      const sessions = new SessionRepository(database);
      const created = sessions.create({ projectId: project.id, title: "s", state: "active" });

      expect(sessions.update(created.id, null, { model: "gpt-b", reasoningEffort: "high" })).toBe(true);
      expect(sessions.update(created.id, null, { reasoningEffort: "low" })).toBe(true);
      const afterLww = sessions.getById(created.id)!;
      expect(afterLww).toMatchObject({ model: "gpt-b", reasoningEffort: "low", version: created.version + 2 });

      expect(sessions.update(created.id, created.version, { title: "stale" })).toBe(false);
      expect(sessions.update(created.id, afterLww.version, { model: null })).toBe(true);
      expect(sessions.getById(created.id)).toMatchObject({ model: null, reasoningEffort: "low", title: "s" });
      expect(sessions.update("missing", null, { model: "gpt-b" })).toBe(false);

      // 已删除是终态：后写生效也不能把并发删除的会话写回来。
      const current = sessions.getById(created.id)!;
      expect(sessions.updateState(created.id, current.version, "deleted")).toBe(true);
      expect(sessions.update(created.id, null, { state: "active" })).toBe(false);
      expect(sessions.getById(created.id)?.state).toBe("deleted");
    } finally {
      database.close();
    }
  });
});

describe("014 会话列表元数据迁移", () => {
  it("存量会话的预览从账本一次性推导，需求快照为 NULL，排序索引就位", () => {
    const { database, projectId } = upgradeFrom(13);
    try {
      const events = new EventRepository(database);
      const sessions = new SessionRepository(database);
      let ordinal = 0;
      // 旧版本没有入账维护：直接写事件表模拟存量账本。
      const append = (sessionId: string, type: string, payload: JsonValue) => {
        ordinal += 1;
        events.append({
          sessionId,
          source: "runtime:codex-local",
          type,
          payload,
          threadRef: null,
          turnRef: null,
          ts: ordinal,
          dedupeKey: "legacy:" + String(ordinal),
        });
      };
      const other = sessions.create({ id: "legacy-user-only", projectId, title: "u", state: "active" });
      const silent = sessions.create({ id: "legacy-silent", projectId, title: "s", state: "active" });
      append("legacy-session", "message.submitted", { content: [{ type: "text", text: "问题" }, { type: "local-image", attachmentId: "a.png" }] });
      append("legacy-session", "message.delta", { text: "答", itemId: "m" });
      append("legacy-session", "item.completed", { item: { type: "agentMessage", id: "m", text: "答案\n\n" + "长".repeat(700) } });
      append("legacy-session", "item.completed", { item: { type: "reasoning", id: "r", summary: [] } });
      // 异形旧数据：content 里混入非对象元素，迁移不能因此失败。
      append(other.id, "message.submitted", { content: ["裸字符串", { type: "text", text: "  最后一句  " }] });
      append(silent.id, "message.submitted", { content: [{ type: "skill", name: "x", path: "/x" }] });
      // 与运行时规则一致：非字符串正文、只有全角空格的消息都不算「一句话」。
      const odd = sessions.create({ id: "legacy-odd", projectId, title: "o", state: "active" });
      append(odd.id, "message.submitted", { content: [{ type: "text", text: "真正的最后一句" }, { type: "text", text: 42 }] });
      append(odd.id, "item.completed", { item: { type: "agentMessage", id: "m2", text: ["数组正文"] } });
      append(odd.id, "message.submitted", { content: [{ type: "text", text: "\u3000\u3000 \u00a0" }] });
      database
        .prepare(
          [
            "INSERT INTO v2_requirement_session_refs",
            "(session_id, remote_project_id, remote_requirement_id, requirement_version, material_path, manifest_sha256, created_at)",
            "VALUES ('legacy-session', @remoteProjectId, @remoteRequirementId, 1, '/tmp/m', @sha, 1)",
          ].join(" "),
        )
        .run({
          remoteProjectId: "11111111-1111-4111-8111-111111111111",
          remoteRequirementId: "22222222-2222-4222-8222-222222222222",
          sha: "a".repeat(64),
        });

      expect(runMigrations(database, undefined, () => 2).appliedVersions).toEqual([14, 15, 16, 17, 18, 19, 20, 21, 22]);

      const row = (id: string) =>
        database
          .prepare("SELECT last_message_role, last_message_text, last_message_seq FROM sessions WHERE id = @id")
          .get<{ last_message_role: string | null; last_message_text: string | null; last_message_seq: number | null }>({ id });
      const legacy = row("legacy-session")!;
      expect(legacy.last_message_role).toBe("assistant");
      expect(legacy.last_message_seq).toBe(3);
      // 库里只留原文前 600 字，超出补 … 作截断标记。
      expect(Array.from(legacy.last_message_text!)).toHaveLength(601);
      expect(legacy.last_message_text!.endsWith("…")).toBe(true);
      expect(row(other.id)).toMatchObject({ last_message_role: "user", last_message_text: "  最后一句  ", last_message_seq: 5 });
      expect(row(silent.id)).toEqual({ last_message_role: null, last_message_text: null, last_message_seq: null });
      expect(row(odd.id)).toEqual({ last_message_role: "user", last_message_text: "真正的最后一句", last_message_seq: 7 });

      // 读取时统一折叠空白并截到 120 字。
      const list = new SessionListService({
        list: new SessionListRepository(database),
        threads: new SessionThreadRepository(database),
        events,
        approvals: new ApprovalRepository(database),
      }).list({}, "zh-CN");
      const byId = new Map(list.items.map((item) => [item.id, item]));
      expect(byId.get("legacy-session")?.preview?.role).toBe("assistant");
      expect(byId.get("legacy-session")?.preview?.text.startsWith("答案 长长")).toBe(true);
      expect(Array.from(byId.get("legacy-session")!.preview!.text)).toHaveLength(121);
      expect(byId.get(other.id)?.preview).toEqual({ role: "user", text: "最后一句" });
      expect(byId.get(silent.id)?.preview).toBeNull();
      expect(byId.get("legacy-session")?.requirement).toEqual({
        remoteRequirementId: "22222222-2222-4222-8222-222222222222",
        number: null,
        title: null,
      });

      const index = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_sessions_list_recent'")
        .get<{ name: string }>();
      expect(index?.name).toBe("idx_sessions_list_recent");

      // 迁移后新入账的事件按序号继续推进预览。
      new EventLedger(database, events, new ApprovalRepository(database), { publish: () => undefined }).append({
        sessionId: silent.id,
        sessionThreadId: null,
        event: {
          source: "suduo:api",
          type: "message.submitted",
          payload: { content: [{ type: "text", text: "新消息" }] },
          threadRef: null,
          turnRef: null,
          ts: 99,
          dedupeKey: "after-migration",
        },
      });
      expect(row(silent.id)).toMatchObject({ last_message_role: "user", last_message_text: "新消息" });
    } finally {
      database.close();
    }
  });
});
