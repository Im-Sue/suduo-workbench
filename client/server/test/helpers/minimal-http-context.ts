import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime, EventEnvelope, JsonValue } from "@suduo/client-contracts";
import { ApprovalService } from "../../src/application/approval-service.js";
import { CodexGlobalState } from "../../src/application/codex-global-state.js";
import { EventBroker } from "../../src/application/event-broker.js";
import { EventLedger } from "../../src/application/event-ledger.js";
import { SessionEventStream } from "../../src/application/event-stream.js";
import { GitService } from "../../src/application/git-service.js";
import { IdempotencyService } from "../../src/application/idempotency-service.js";
import { InterruptService } from "../../src/application/interrupt-service.js";
import { MessageService } from "../../src/application/message-service.js";
import { ModelProviderService } from "../../src/application/model-provider-service.js";
import { ProjectService } from "../../src/application/project-service.js";
import { ProxyConnectivityService } from "../../src/application/proxy-connectivity-service.js";
import { RuntimeEventIngestor } from "../../src/application/runtime-event-ingestor.js";
import { RuntimeSupervisor } from "../../src/application/runtime-supervisor.js";
import { SessionRunStatusService } from "../../src/application/session-run-status-service.js";
import { SessionListService } from "../../src/application/session-list-service.js";
import { SessionListRepository } from "../../src/infrastructure/db/repositories/session-list-repository.js";
import { SessionService } from "../../src/application/session-service.js";
import { SettingsService } from "../../src/application/settings-service.js";
import { SkillAdminService } from "../../src/application/skill-admin-service.js";
import { WorkspaceService } from "../../src/application/workspace-service.js";
import { openBetterSqlite3Database } from "../../src/infrastructure/db/better-sqlite3-database.js";
import { runMigrations } from "../../src/infrastructure/db/migration-runner.js";
import { ApprovalRepository } from "../../src/infrastructure/db/repositories/approval-repository.js";
import { EventRepository } from "../../src/infrastructure/db/repositories/event-repository.js";
import { IdempotencyRepository } from "../../src/infrastructure/db/repositories/idempotency-repository.js";
import { ProjectRepository } from "../../src/infrastructure/db/repositories/project-repository.js";
import { SessionRepository } from "../../src/infrastructure/db/repositories/session-repository.js";
import { SessionThreadRepository } from "../../src/infrastructure/db/repositories/session-thread-repository.js";
import { buildHttpServer, type HttpServerDependencies } from "../../src/infrastructure/http/http-server.js";
import { LoopbackGuard } from "../../src/infrastructure/http/loopback-guard.js";
import { RuntimeRegistry } from "../../src/infrastructure/runtime/runtime-registry.js";
import { WorkspaceWatcher } from "../../src/infrastructure/workspace/workspace-watcher.js";

/**
 * 只装会话 / 消息 / 中断 / SSE 这条链的最小 HTTP 上下文（不带 requirements-v2 与工作台），
 * 供传输层与归属链路的集成测试在真实 loopback 端口上跑。`http.test.ts` 的完整工厂另有用途，不复用。
 */
export function createMinimalHttpContext(
  runtime: AgentRuntime,
  /** 额外的 HTTP 依赖（如房间路由、远程推送 hub），覆盖默认值。 */
  overrides: Partial<HttpServerDependencies> = {},
) {
  const projectRoot = mkdtempSync(join(tmpdir(), "suduo-minimal-http-"));
  // 基线不能放进 projectRoot：它同时是测试项目的根目录，会被当成项目文件扫进基线。
  const baselineRoot = mkdtempSync(join(tmpdir(), "suduo-minimal-http-baselines-"));
  const database = openBetterSqlite3Database(":memory:");
  runMigrations(database);
  const projects = new ProjectRepository(database);
  const sessions = new SessionRepository(database);
  const threads = new SessionThreadRepository(database);
  const events = new EventRepository(database);
  const approvals = new ApprovalRepository(database);
  const broker = new EventBroker();
  const ledger = new EventLedger(database, events, approvals, broker);
  const registry = new RuntimeRegistry();
  registry.register(runtime);
  const supervisor = new RuntimeSupervisor(registry);
  const sessionService = new SessionService(database, projects, sessions, threads, supervisor);
  const codexGlobalState = new CodexGlobalState();
  const settings = new SettingsService(join(projectRoot, "settings.json"));
  // 测试里的请求默认按中文出错误文字（与前端测试固定 zh-CN 一致）；英文由专门的测试带请求头覆盖。
  settings.rememberLocale("zh-CN");
  const interrupts = new InterruptService(projects, sessions, threads, events, registry, supervisor, ledger);
  const server = buildHttpServer({
    requestGuard: new LoopbackGuard(),
    idempotency: new IdempotencyService(new IdempotencyRepository(database)),
    projects: new ProjectService(projects, sessions),
    sessions: sessionService,
    runStatus: new SessionRunStatusService(projects, sessions, events, approvals),
    sessionList: new SessionListService({ list: new SessionListRepository(database), threads, events, approvals }),
    messages: new MessageService(projects, sessions, threads, registry, supervisor, ledger, null),
    approvals: new ApprovalService(approvals, threads, registry, ledger),
    interrupts,
    eventStream: new SessionEventStream(events, broker),
    codexGlobalState,
    workspace: new WorkspaceService(projects, sessions, { roots: () => [] }, undefined, { baselineRoot }),
    workspaceWatcher: new WorkspaceWatcher(),
    git: new GitService(projects),
    settings,
    modelProvider: new ModelProviderService({
      controlPlane: {
        configRead: async () => ({ config: {}, origins: {}, layers: [] }),
        configBatchWrite: async () => ({ status: "ok", version: "v1", overriddenMetadata: null }),
        modelList: async () => ({ data: [], nextCursor: null }),
      },
      codexBin: "/fixture/codex",
      codexHome: projectRoot,
      cliRunner: async () => ({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }),
    }),
    proxyConnectivity: new ProxyConnectivityService(
      settings,
      { modelGatewayBaseUrl: async () => "https://fixture.test/v1" },
      async () => ({ reachable: true, targetOrigin: "https://fixture.test", statusCode: 401, usingProxy: false, message: "fixture" }),
    ),
    skillAdmin: new SkillAdminService(join(projectRoot, ".test-global-skills")),
    setSkillEnabled: async () => undefined,
    doctor: async () => ({ status: "PASS", codexHome: "/test/.codex", platform: process.platform, mode: "installed", configDir: "/test/.codex", dataDir: "/test/data", port: 8787, checkedAt: "2026-07-12T00:00:00.000Z", checks: [] }),
    webRoot: projectRoot,
    sseHeartbeatMs: 60_000,
    ...overrides,
  });
  return {
    projectRoot,
    database,
    server,
    events,
    ledger,
    interrupts,
    ingestor: new RuntimeEventIngestor(threads, ledger, codexGlobalState),
    /** 真实监听 loopback 临时端口并返回 base URL；用 fetch 而不是 inject，SSE 才是真连接。 */
    async listen(): Promise<string> {
      // 与 http.test.ts 同理：连续绑定 loopback 临时端口偶发拒绝，绑 0.0.0.0 再从 127.0.0.1 访问。
      await server.listen({ host: "0.0.0.0", port: 0 });
      const address = server.server.address();
      if (!address || typeof address === "string") {
        throw new Error("test server did not expose a TCP address");
      }
      return `http://127.0.0.1:${String(address.port)}`;
    },
    async close(): Promise<void> {
      await server.close();
      database.close();
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(baselineRoot, { recursive: true, force: true });
    },
  };
}

/** 带 loopback Origin 与幂等键的写请求。 */
export async function postJson(base: string, url: string, key: string, body: unknown): Promise<Response> {
  return fetch(base + url, {
    method: "POST",
    headers: { origin: base, "idempotency-key": key, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** 建项目 + 会话，返回 sessionId。 */
export async function createProjectAndSession(base: string, projectRoot: string): Promise<{ projectId: string; sessionId: string }> {
  const project = await postJson(base, "/api/v1/projects", "project-key", { rootPath: projectRoot, name: "minimal" });
  if (project.status !== 201) throw new Error(`project create failed: ${String(project.status)}`);
  const projectId = String(((await project.json()) as { id: string }).id);
  const session = await postJson(base, `/api/v1/projects/${projectId}/sessions`, "session-key", {});
  if (session.status !== 201) throw new Error(`session create failed: ${String(session.status)}`);
  return { projectId, sessionId: String(((await session.json()) as { id: string }).id) };
}

export type SseFrame =
  | { kind: "event"; id: string | null; type: string; event: EventEnvelope<string, JsonValue> }
  | { kind: "control"; id: string | null; type: string; data: string };

/**
 * 逐帧读 SSE，并按 EventSource 规范维护 lastEventId：只有帧里出现 `id:` 行才更新，
 * 空 `id:` 会把它清成空串；没有 `data:` 的帧不派发。心跳（`: ping`）与 `retry:` 行忽略。
 */
export class SseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffer = "";
  readonly frames: SseFrame[] = [];
  readonly rawFrames: string[] = [];
  lastEventId: string | null = null;

  constructor(response: Response) {
    if (!response.body) {
      throw new Error("SSE response has no body");
    }
    this.reader = response.body.getReader();
  }

  async readUntil(predicate: (frame: SseFrame) => boolean, timeoutMs = 10_000): Promise<SseFrame[]> {
    const deadline = Date.now() + timeoutMs;
    while (!this.frames.some(predicate)) {
      if (Date.now() > deadline) {
        throw new Error("SSE readUntil timed out");
      }
      const next = await this.reader.read();
      if (next.done) {
        throw new Error("SSE stream ended early");
      }
      this.buffer += new TextDecoder().decode(next.value);
      let boundary = this.buffer.indexOf("\n\n");
      while (boundary >= 0) {
        this.consume(this.buffer.slice(0, boundary));
        this.buffer = this.buffer.slice(boundary + 2);
        boundary = this.buffer.indexOf("\n\n");
      }
    }
    return [...this.frames];
  }

  async cancel(): Promise<void> {
    await this.reader.cancel().catch(() => undefined);
  }

  private consume(frame: string): void {
    this.rawFrames.push(frame);
    const lines = frame.split("\n");
    let id: string | null = null;
    let type = "";
    const data: string[] = [];
    for (const line of lines) {
      if (line.startsWith("id:")) id = line.slice(3).trimStart();
      else if (line.startsWith("event:")) type = line.slice(6).trimStart();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (id !== null) {
      this.lastEventId = id;
    }
    if (data.length === 0) {
      return;
    }
    const joined = data.join("\n");
    if (type === "stream.live") {
      this.frames.push({ kind: "control", id, type, data: joined });
      return;
    }
    if (type !== "") {
      this.frames.push({ kind: "event", id, type, event: JSON.parse(joined) as EventEnvelope<string, JsonValue> });
    }
  }
}
