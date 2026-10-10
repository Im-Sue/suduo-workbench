import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentRuntime,
  ApproveResult,
  RuntimeEventDraft,
  StartThreadResult,
  StartTurnResult,
} from "@suduo/client-contracts";
import { openBetterSqlite3Database } from "../src/infrastructure/db/better-sqlite3-database.js";
import { runMigrations } from "../src/infrastructure/db/migration-runner.js";
import { ProjectRepository } from "../src/infrastructure/db/repositories/project-repository.js";
import { SessionRepository } from "../src/infrastructure/db/repositories/session-repository.js";
import { AgentNotReadyError } from "../src/infrastructure/runtime/agent-not-ready.js";
import { RuntimeRegistry, agentIdOf } from "../src/infrastructure/runtime/runtime-registry.js";
import { createMinimalHttpContext, postJson } from "./helpers/minimal-http-context.js";

/** 多 Agent S1-3：会话记住所用 Agent（迁移 019），创建会话按 Agent 找运行时（ADR-0014）。 */

class FakeRuntime implements AgentRuntime {
  private threads = 0;
  readonly agentId?: string;
  constructor(
    readonly runtimeId: string,
    readonly runtimeKind: string,
    agentId?: string,
  ) {
    if (agentId !== undefined) this.agentId = agentId;
  }
  async startThread(): Promise<StartThreadResult> {
    this.threads += 1;
    const thread = { threadRef: { runtimeId: this.runtimeId, runtimeKind: this.runtimeKind, threadId: `thread-${String(this.threads)}` }, role: "primary" as const, metadata: {} };
    return { primaryThread: thread, threads: [thread] };
  }
  async startTurn(): Promise<StartTurnResult> {
    return { turnRef: { threadId: "thread-1", turnId: "turn-1" }, acceptedAt: Date.now() };
  }
  async approve(): Promise<ApproveResult> {
    return { acknowledged: true };
  }
  async interrupt(): Promise<void> {}
  async *subscribe(): AsyncIterable<RuntimeEventDraft> {}
}

describe("运行时注册表按 Agent 查找", () => {
  it("老 Codex 运行时不写 agentId 也视为 codex；同一家 Agent 不能注册两个运行时", () => {
    const registry = new RuntimeRegistry();
    const codex = new FakeRuntime("codex-local", "codex");
    const claude = new FakeRuntime("claude-code", "claude-sdk", "claude-code");
    registry.register(codex);
    registry.register(claude);
    expect(agentIdOf(codex)).toBe("codex");
    expect(registry.findByAgent("codex")).toBe(codex);
    expect(registry.findByAgent("claude-code")).toBe(claude);
    expect(registry.findByAgent("gemini")).toBeNull();
    expect(registry.list()).toEqual([codex, claude]);
    expect(() => registry.register(new FakeRuntime("codex-2", "codex"))).toThrow(/duplicate runtime for agent/);
  });
});

describe("迁移 019：会话的 Agent 与会话图字段", () => {
  it("存量与新建的 Codex 会话 agent_id 为 codex；指定 Agent 时写入", () => {
    const database = openBetterSqlite3Database(":memory:");
    runMigrations(database);
    const project = new ProjectRepository(database).create({ rootPath: "/tmp/p", rootPathKey: "/tmp/p", name: "p" });
    const sessions = new SessionRepository(database);
    const codex = sessions.create({ projectId: project.id, title: "a" });
    const claude = sessions.create({ projectId: project.id, title: "b", agentId: "claude-code" });
    expect(codex.agentId).toBe("codex");
    expect(claude.agentId).toBe("claude-code");
    const columns = database.prepare("PRAGMA table_info(sessions)").all<{ name: string }>().map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining([
      "agent_id",
      "parent_session_id",
      "root_session_id",
      "relation",
      "relation_meta_json",
      "workspace_path",
      "rules_version",
    ]));
    expect(() =>
      database.prepare("UPDATE sessions SET relation = 'sibling' WHERE id = @id").run({ id: codex.id }),
    ).toThrow();
    database.close();
  });
});

describe("创建会话按 Agent 找运行时", () => {
  const contexts: Array<ReturnType<typeof createMinimalHttpContext>> = [];
  afterEach(async () => {
    for (const context of contexts.splice(0)) await context.close();
  });

  it("不传 agentId 为 codex；指定没接上的 Agent 报 400 并说清是哪家", async () => {
    const context = createMinimalHttpContext(new FakeRuntime("codex-local", "codex"));
    contexts.push(context);
    const base = await context.listen();
    const project = await postJson(base, "/api/v1/projects", "project-key", { rootPath: context.projectRoot, name: "p" });
    const projectId = ((await project.json()) as { id: string }).id;

    const plain = await postJson(base, `/api/v1/projects/${projectId}/sessions`, "s1", {});
    expect(plain.status).toBe(201);
    expect(((await plain.json()) as { agentId: string }).agentId).toBe("codex");

    const explicit = await postJson(base, `/api/v1/projects/${projectId}/sessions`, "s2", { agentId: "codex" });
    expect(explicit.status, await explicit.clone().text()).toBe(201);

    const unavailable = await postJson(base, `/api/v1/projects/${projectId}/sessions`, "s3", { agentId: "claude-code" });
    expect(unavailable.status).toBe(400);
    const body = (await unavailable.json()) as { error: { message: string } };
    expect(body.error.message).toContain("claude-code");

    const wrongType = await postJson(base, `/api/v1/projects/${projectId}/sessions`, "s4", { agentId: 7 });
    expect(wrongType.status).toBe(400);
  });
});

describe("Agent 没装或没登录（多 Agent S4）", () => {
  const contexts: Array<ReturnType<typeof createMinimalHttpContext>> = [];
  afterEach(async () => {
    for (const context of contexts.splice(0)) await context.close();
  });

  class NotReadyRuntime extends FakeRuntime {
    override async startThread(): Promise<StartThreadResult> {
      throw new AgentNotReadyError("codex", "Codex", "auth_required", "Authentication required");
    }
  }

  it("开会话报 400 AGENT_NOT_READY，说清怎么修，带 agentId 与原因；不留出错的会话", async () => {
    const context = createMinimalHttpContext(new NotReadyRuntime("codex-local", "codex"));
    contexts.push(context);
    const base = await context.listen();
    const project = await postJson(base, "/api/v1/projects", "project-key", { rootPath: context.projectRoot, name: "p" });
    const projectId = ((await project.json()) as { id: string }).id;
    const response = await postJson(base, `/api/v1/projects/${projectId}/sessions`, "s1", {});
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; message: string; details: Record<string, unknown> } };
    expect(body.error).toMatchObject({ code: "AGENT_NOT_READY", details: { agentId: "codex", reason: "auth_required" } });
    expect(body.error.message).toContain("还没登录");
    const listed = (await (await fetch(`${base}/api/v1/projects/${projectId}/sessions`, { headers: { origin: base } })).json()) as { items: unknown[] };
    expect(listed.items).toEqual([]);
  });
});

describe("开会话时选审批档与模型；只读档（多 Agent S5）", () => {
  const contexts: Array<ReturnType<typeof createMinimalHttpContext>> = [];
  afterEach(async () => {
    for (const context of contexts.splice(0)) await context.close();
  });

  it("建会话带审批档、模型、推理强度；只读能选能切回；做不到只读的 Agent 报 400", async () => {
    const codex = new FakeRuntime("codex-local", "codex");
    const context = createMinimalHttpContext(codex);
    contexts.push(context);
    const base = await context.listen();
    const project = await postJson(base, "/api/v1/projects", "project-key", { rootPath: context.projectRoot, name: "p" });
    const projectId = ((await project.json()) as { id: string }).id;

    const created = await postJson(base, `/api/v1/projects/${projectId}/sessions`, "s1", { approvalMode: "readonly", model: "gpt-x", reasoningEffort: "high" });
    expect(created.status, await created.clone().text()).toBe(201);
    const session = (await created.json()) as { id: string; approvalMode: string; model: string; reasoningEffort: string };
    expect(session).toMatchObject({ approvalMode: "readonly", model: "gpt-x", reasoningEffort: "high" });

    const patch = (body: unknown, key: string) =>
      fetch(`${base}/api/v1/sessions/${session.id}`, { method: "PATCH", headers: { origin: base, "idempotency-key": key, "content-type": "application/json" }, body: JSON.stringify(body) });
    const back = await patch({ approvalMode: "auto" }, "p1");
    expect(((await back.json()) as { approvalMode: string }).approvalMode).toBe("auto");
    const again = await patch({ approvalMode: "readonly" }, "p2");
    expect(((await again.json()) as { approvalMode: string }).approvalMode).toBe("readonly");
    expect((await patch({ approvalMode: "nope" }, "p3")).status).toBe(400);

    const sessions = new SessionRepository(context.database);
    const gemini = sessions.create({ projectId, title: "g", agentId: "gemini" });
    const refused = await fetch(`${base}/api/v1/sessions/${gemini.id}`, { method: "PATCH", headers: { origin: base, "idempotency-key": "p4", "content-type": "application/json" }, body: JSON.stringify({ approvalMode: "readonly" }) });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toContain("Gemini CLI");
  });
});
