import { describe, expect, it } from "vitest";
import type {
  RuntimeApprovalMode,
  RuntimeRegistry,
  StartThreadInput,
  StartThreadResult,
} from "@suduo/client-contracts";
import type { EventLedger } from "../src/application/event-ledger.js";
import { MessageService } from "../src/application/message-service.js";
import { RuntimeSupervisor } from "../src/application/runtime-supervisor.js";
import { SessionService } from "../src/application/session-service.js";
import { sharedWorkspace } from "../src/application/workspace-context.js";
import { openBetterSqlite3Database } from "../src/infrastructure/db/better-sqlite3-database.js";
import { runMigrations } from "../src/infrastructure/db/migration-runner.js";
import { ProjectRepository, type ProjectRecord } from "../src/infrastructure/db/repositories/project-repository.js";
import { SessionRepository, type SessionRecord } from "../src/infrastructure/db/repositories/session-repository.js";
import { SessionThreadRepository, type SessionThreadRecord } from "../src/infrastructure/db/repositories/session-thread-repository.js";

const THREAD_RESULT: StartThreadResult = {
  primaryThread: {
    threadRef: { runtimeId: "codex-local", runtimeKind: "codex", threadId: "thread-new" },
    role: "primary",
    metadata: null,
  },
  threads: [
    {
      threadRef: { runtimeId: "codex-local", runtimeKind: "codex", threadId: "thread-new" },
      role: "primary",
      metadata: null,
    },
  ],
};

describe("审批档部署上限", () => {
  it("cap=auto 时创建会话持久化 auto，PATCH full 返回 409", async () => {
    const context = createSessionContext({ SUDUO_MAX_APPROVAL_MODE: "auto" });
    try {
      const created = await context.service.create(context.project.id, { title: "受限会话" }, {}, { locale: "zh-CN" });
      expect(created.approvalMode).toBe("auto");
      expect(context.sessions.getById(created.id)?.approvalMode).toBe("auto");
      await expect(
        context.service.update(created.id, created.version, { approvalMode: "full" }),
      ).rejects.toMatchObject({
        statusCode: 409,
        message: "审批模式已被部署上限 SUDUO_MAX_APPROVAL_MODE 锁定",
      });
      expect(context.sessions.getById(created.id)?.approvalMode).toBe("auto");
      expect(context.startInputs[0]?.approvalMode).toEqual("auto");
    } finally {
      context.database.close();
    }
  });

  it("存量 full 会话只在运行时 clamp，解除 cap 后恢复 full", async () => {
    const database = openBetterSqlite3Database(":memory:");
    runMigrations(database);
    const projects = new ProjectRepository(database);
    const sessions = new SessionRepository(database);
    const project = projects.create({
      name: "legacy",
      rootPath: "/tmp/legacy-approval-cap",
      rootPathKey: "/tmp/legacy-approval-cap",
    });
    const legacy = sessions.create({
      projectId: project.id,
      title: "已有 full 会话",
      state: "active",
      approvalMode: "full",
    });
    const environment: NodeJS.ProcessEnv = { SUDUO_MAX_APPROVAL_MODE: "auto" };
    const runtime = makeSupervisor(environment);
    try {
      await runtime.supervisor.createPrimaryThread({
        runtimeId: "codex-local",
        session: legacy,
        workspace: sharedWorkspace(project, legacy.id),
      });
      expect(runtime.inputs[0]?.approvalMode).toEqual("auto");
      expect(sessions.getById(legacy.id)?.approvalMode).toBe("full");

      delete environment["SUDUO_MAX_APPROVAL_MODE"];
      await runtime.supervisor.createPrimaryThread({
        runtimeId: "codex-local",
        session: legacy,
        workspace: sharedWorkspace(project, legacy.id),
      });
      expect(runtime.inputs[1]?.approvalMode).toEqual("full");
      expect(sessions.getById(legacy.id)?.approvalMode).toBe("full");
    } finally {
      database.close();
    }
  });

  it("未设上限时，runtime 三处与 message 一处保持 full 原策略", async () => {
    const environment: NodeJS.ProcessEnv = {};
    const runtime = makeSupervisor(environment, { resumeFails: true });
    const session = fullSession();
    const workspace = sharedWorkspace(fullProject(), session.id);
    const binding = primaryBinding(session.id);

    await runtime.supervisor.createPrimaryThread({
      runtimeId: "codex-local",
      session,
      workspace,
    });
    await runtime.supervisor.ensureReadyOrRebuild({ session, workspace, binding });
    expect(runtime.inputs).toHaveLength(3);
    expect(runtime.inputs.map((input) => input.approvalMode)).toEqual([
      "full",
      "full",
      "full",
    ]);

    const message = createMessageContext(environment);
    try {
      await message.service.send(
        message.session.id,
        { content: [{ type: "text", text: "继续" }] },
        "approval-cap-message",
      );
      expect(message.approvalMode).toEqual("full");
    } finally {
      message.database.close();
    }
  });
});

function createSessionContext(environment: NodeJS.ProcessEnv) {
  const database = openBetterSqlite3Database(":memory:");
  runMigrations(database);
  const projects = new ProjectRepository(database);
  const sessions = new SessionRepository(database);
  const threads = new SessionThreadRepository(database);
  const project = projects.create({
    name: "cap",
    rootPath: "/tmp/approval-cap",
    rootPathKey: "/tmp/approval-cap",
  });
  const runtime = makeSupervisor(environment);
  const service = new SessionService(
    database,
    projects,
    sessions,
    threads,
    runtime.supervisor,
    () => "full",
    undefined,
    null,
    environment,
  );
  return { database, sessions, project, service, startInputs: runtime.inputs };
}

function makeSupervisor(
  environment: NodeJS.ProcessEnv,
  options: { resumeFails?: boolean } = {},
) {
  const inputs: StartThreadInput[] = [];
  const registry = {
    get: () => ({
      startThread: async (input: StartThreadInput): Promise<StartThreadResult> => {
        inputs.push(input);
        if (input.mode === "resume" && options.resumeFails) {
          throw new Error("rollout missing");
        }
        return THREAD_RESULT;
      },
    }),
  } as unknown as RuntimeRegistry;
  return { inputs, supervisor: new RuntimeSupervisor(registry, environment) };
}

function createMessageContext(environment: NodeJS.ProcessEnv) {
  const database = openBetterSqlite3Database(":memory:");
  runMigrations(database);
  const projects = new ProjectRepository(database);
  const sessions = new SessionRepository(database);
  const threads = new SessionThreadRepository(database);
  const project = projects.create({
    name: "message",
    rootPath: "/tmp/message-approval-cap",
    rootPathKey: "/tmp/message-approval-cap",
  });
  const session = sessions.create({
    projectId: project.id,
    title: "message",
    state: "active",
    approvalMode: "full",
  });
  threads.attach({ sessionId: session.id, threadRef: primaryBinding(session.id).threadRef });
  let approvalMode: RuntimeApprovalMode | null = null;
  const runtimes = {
    get: () => ({
      startTurn: async (input: { approvalMode: RuntimeApprovalMode }) => {
        approvalMode = input.approvalMode;
        return {
          turnRef: { threadId: "thread-primary", turnId: "turn-1" },
          acceptedAt: 1,
        };
      },
    }),
  } as unknown as RuntimeRegistry;
  const service = new MessageService(
    projects,
    sessions,
    threads,
    runtimes,
    { ensureReadyOrRebuild: async () => null } as unknown as RuntimeSupervisor,
    { append: () => ({ seq: 1 }) } as unknown as EventLedger,
    null,
    undefined,
    null,
    null,
    undefined,
    environment,
  );
  return {
    database,
    session,
    service,
    get approvalMode() {
      return approvalMode;
    },
  };
}

function fullProject(): ProjectRecord {
  return {
    id: "project-full",
    name: "full",
    rootPath: "/tmp/full-approval-cap",
    rootPathKey: "/tmp/full-approval-cap",
    state: "active",
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: null,
    removedAt: null,
    version: 1,
  };
}

function fullSession(): SessionRecord {
  return {
    id: "session-full",
    projectId: "project-full",
    title: "full",
    state: "active",
    purpose: "general",
    approvalMode: "full",
    kind: "normal",
    locale: "zh-CN",
    model: null,
    reasoningEffort: null,
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: null,
    lastActivityAt: null,
    archivedAt: null,
    deletedAt: null,
    error: null,
    version: 1,
  };
}

function primaryBinding(sessionId: string): SessionThreadRecord {
  return {
    id: `binding-${sessionId}`,
    sessionId,
    threadRef: { runtimeId: "codex-local", runtimeKind: "codex", threadId: "thread-primary" },
    role: "primary",
    ordinal: 0,
    primary: true,
    state: "attached",
    metadata: null,
    attachedAt: 1,
    lastSeenAt: 1,
    detachedAt: null,
  };
}
