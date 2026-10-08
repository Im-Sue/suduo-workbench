import { once } from "node:events";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, resolve } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import {
  APPROVAL_DECISIONS,
  isLocale,
  type HealthzResponse,
  type Locale,
  type SuDuoRunMode,
} from "@suduo/client-contracts";
import type {
  CreateProjectRequest,
  CreateSessionRequest,
  DecideApprovalRequest,
  InterruptRequest,
  JsonValue,
  ListApprovalsQuery,
  ListProjectsQuery,
  ListSessionsQuery,
  SendMessageRequest,
  SessionContextDto,
  UpdateProjectRequest,
  GitCheckpointRequest,
  GitRestoreRequest,
  GitSettingsRequest,
  InstallSkillRequest,
  ExistingFilesRequest,
  OpenFileRequest,
  RemoveSkillRequest,
  SetSkillEnabledRequest,
  UpdateSessionRequest,
  UpdateSettingsRequest,
} from "@suduo/client-contracts";
import {
  AUDIT_RESOURCE_TYPES,
  type AuditResourceType,
  type ListAuditQuery,
  type ProjectStatsQuery,
} from "@suduo/cloud-contracts";
import {
  ApiError,
  IndeterminateOperationError,
  errorResponse,
  type ErrorText,
} from "../../application/api-error.js";
import type { ApprovalService } from "../../application/approval-service.js";
import {
  formatSseControlFrame,
  formatSseEvent,
  formatSseHeartbeat,
  type SessionEventStream,
} from "../../application/event-stream.js";
import type { IdempotencyService } from "../../application/idempotency-service.js";
import type { InterruptService } from "../../application/interrupt-service.js";
import type { MessageService } from "../../application/message-service.js";
import type { ProjectService } from "../../application/project-service.js";
import type { SessionService } from "../../application/session-service.js";
import type { SessionRunStatusService } from "../../application/session-run-status-service.js";
import type { GitService } from "../../application/git-service.js";
import type { SettingsService } from "../../application/settings-service.js";
import type { SkillAdminService } from "../../application/skill-admin-service.js";
import type { WorkspaceService } from "../../application/workspace-service.js";
import type { RequirementsV2Service } from "../../application/requirements-v2-service.js";
import type { MyWorkbenchService } from "../../application/my-workbench-service.js";
import type {
  WorkspaceChangeNotice,
  WorkspaceWatcher,
} from "../workspace/workspace-watcher.js";
import type { LoopbackGuard } from "./loopback-guard.js";
import { prepareInlinePreview } from "./attachment-inline-preview.js";
import type { DoctorResult } from "../doctor/doctor-service.js";
import { DOCTOR_PAGE_SCRIPT, renderDoctorPage } from "./doctor-page.js";
import {
  registerCodexStatusRoutes,
  type CodexStatusRouteDependencies,
} from "./routes/codex-status-routes.js";
import {
  registerModelProviderRoutes,
  type ModelProviderRouteDependencies,
} from "./routes/model-provider-routes.js";
import { registerRequirementsSettingsRoutes } from "./routes/requirements-settings-routes.js";
import { registerProjectMappingRoutes } from "./routes/project-mapping-routes.js";
import { registerCodexConfigFileRoutes } from "./routes/codex-config-file-routes.js";
import {
  registerProxySettingsRoutes,
  type ProxySettingsRouteDependencies,
} from "./routes/proxy-settings-routes.js";
import { registerAgentsRoutes, type AgentsRouteDependencies } from "./routes/agents-routes.js";
import {
  registerMcpRoutes,
  type McpRouteDependencies,
} from "./routes/mcp-routes.js";
import {
  registerLocalDirectoryRoutes,
  type LocalDirectoryRouteDependencies,
} from "./routes/local-directory-routes.js";
import { registerSessionListRoutes } from "./routes/session-list-routes.js";
import {
  registerSystemActivityRoutes,
  type SystemActivityRouteDependencies,
} from "./routes/system-activity-routes.js";
import {
  FILE_RESPONSE_HEADERS,
  UPLOAD_FORWARD_HEADERS,
  registerRoomsRoutes,
  type RoomsRouteDependencies,
} from "./routes/rooms-routes.js";
import type { SessionListService } from "../../application/session-list-service.js";
import { registerRequestLocale, requestLocaleOf } from "../../i18n/locale.js";

export interface HttpServerDependencies
  extends CodexStatusRouteDependencies,
    ModelProviderRouteDependencies,
    ProxySettingsRouteDependencies,
    AgentsRouteDependencies,
    McpRouteDependencies,
    LocalDirectoryRouteDependencies,
    SystemActivityRouteDependencies {
  requestGuard: LoopbackGuard;
  idempotency: IdempotencyService;
  projects: ProjectService;
  sessions: SessionService;
  runStatus: SessionRunStatusService;
  messages: MessageService;
  approvals: ApprovalService;
  interrupts: InterruptService;
  eventStream: SessionEventStream;
  workspace: WorkspaceService;
  workspaceWatcher: WorkspaceWatcher;
  git: GitService;
  settings: SettingsService;
  /** T2 V2 BFF 依赖；optional 保持旧 HTTP 测试工厂兼容。 */
  requirementsV2?: RequirementsV2Service;
  /** 工作台聚合及远程 stats 代理；optional 保持旧 HTTP 测试工厂兼容。 */
  myWorkbench?: MyWorkbenchService;
  /** 跨项目会话列表 GET /api/v1/sessions；optional 保持旧 HTTP 测试工厂兼容。 */
  sessionList?: SessionListService;
  /** 项目聊天房间与共享 Agent 的本机端点（一比一转发 + agents/self）；optional 保持旧测试兼容。 */
  rooms?: RoomsRouteDependencies;
  /**
   * 远程推送的单一上游连接（RemoteEventsHub）：`GET /api/v2/events` 订阅它，
   * 不再每个标签页各开一条上游。不传时退回旧的逐连接转发。
   */
  remoteEvents?: {
    assertBrowserCanConnect(): void;
    attachBrowser(response: ServerResponse): () => void;
  };
  /** 会话关联的 SuDuo 上下文 GET /api/v1/sessions/:id/context（ADR-0008）；optional 保持旧测试兼容。 */
  sessionContext?: { describe(sessionId: string): SessionContextDto };
  /** 实际运行时的 CODEX_HOME；配置文件专用打开端点只允许此路径。 */
  codexHome?: string;
  /** 仅供专用 config-file/open 路由测试替换，生产默认走系统打开器。 */
  openCodexConfigFile?(absolutePath: string): Promise<void>;
  skillAdmin: SkillAdminService;
  setSkillEnabled(name: string, enabled: boolean): Promise<void>;
  /** 自检；检查项的名称、结论与处理建议按 locale 生成。 */
  doctor(locale: Locale): Promise<DoctorResult>;
  webRoot: string;
  sseHeartbeatMs?: number;
  logger?: boolean;
  activity?: { touch(): void; retainStream(): () => void };
  requestShutdown?(reason: string): void;
  /** 运行形态与桌面外壳分配的实例标识，随 /healthz 带出（客户端桌面应用技术设计 决策 8）。 */
  runMode?: SuDuoRunMode;
  instanceId?: string;
}

interface OperationResult {
  statusCode: number;
  body: unknown;
  resourceType?: string;
  resourceId?: string;
}

export function buildHttpServer(
  dependencies: HttpServerDependencies,
): FastifyInstance {
  const server = Fastify({
    logger: dependencies.logger ?? false,
  });

  if (dependencies.requirementsV2 || dependencies.rooms) {
    server.addContentTypeParser(/^multipart\/form-data(?:;.*)?$/iu, (_request, payload, done) => {
      done(null, payload);
    });
  }

  server.addHook("onRequest", async (request) => {
    dependencies.requestGuard.guard(request);
    dependencies.activity?.touch();
  });
  registerRequestLocale(server, dependencies.settings);

  server.setErrorHandler((error, request, reply) => {
    const locale = requestLocaleOf(request, dependencies.settings);
    if (error instanceof ApiError) {
      void reply
        .code(error.statusCode)
        .send(errorResponse(error, request.id, locale));
      return;
    }
    request.log.error(error);
    void reply.code(500).send(
      errorResponse(
        new ApiError(
          500,
          "RUNTIME_REQUEST_FAILED",
          (t) => t.common.internalError,
        ),
        request.id,
        locale,
      ),
    );
  });

  server.get("/healthz", async (_request, reply) => {
    const body: HealthzResponse = {
      product: "suduo",
      status: "ok",
      pid: process.pid,
      uptimeMs: Math.round(process.uptime() * 1_000),
      runMode: dependencies.runMode ?? "source",
      ...(dependencies.instanceId === undefined ? {} : { instanceId: dependencies.instanceId }),
    };
    return reply.header("Cache-Control", "no-store").send(body);
  });

  server.post("/api/v1/admin/shutdown", async (_request, reply) => {
    if (!dependencies.requestShutdown) {
      throw new ApiError(
        409,
        "SHUTDOWN_UNAVAILABLE",
        (t) => t.http.shutdownUnavailable,
      );
    }
    setImmediate(() => dependencies.requestShutdown?.("admin shutdown request"));
    return reply.code(202).send({ stopping: true });
  });

  registerRequirementsV2Routes(server, dependencies);
  registerRequirementsSettingsRoutes(server, dependencies);
  registerLocalDirectoryRoutes(server, dependencies);
  registerSystemActivityRoutes(server, dependencies);
  registerCodexStatusRoutes(server, dependencies);
  registerModelProviderRoutes(server, dependencies);
  registerCodexConfigFileRoutes(server, dependencies);
  registerProxySettingsRoutes(server, dependencies);
  registerAgentsRoutes(server, dependencies);
  if (dependencies.mcp) {
    registerMcpRoutes(server, { mcp: dependencies.mcp });
  }
  if (dependencies.sessionList) {
    registerSessionListRoutes(server, { sessionList: dependencies.sessionList });
  }
  if (dependencies.rooms) {
    registerRoomsRoutes(server, dependencies.rooms);
  }
  const remoteEvents = dependencies.remoteEvents;
  if (remoteEvents) {
    // 订阅本机的单一上游连接（技术设计 4.3）：浏览器连接期间 retainStream 由 hub 负责。
    server.get("/api/v2/events", async (_request, reply) => {
      remoteEvents.assertBrowserCanConnect();
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const detach = remoteEvents.attachBrowser(reply.raw);
      await new Promise<void>((resolveWait) => {
        if (reply.raw.destroyed) {
          resolveWait();
          return;
        }
        // 浏览器断开、或 hub 因登录态没了主动结束连接时，响应都会 close。
        reply.raw.once("close", () => resolveWait());
      });
      detach();
      if (!reply.raw.destroyed) {
        reply.raw.end();
      }
    });
  }

  server.post("/api/v1/projects", async (request, reply) =>
    idempotent(request, reply, dependencies.idempotency, "projects:create", request.body, async () => {
      const body = requireObject<CreateProjectRequest>(request.body);
      const project = await dependencies.projects.create(body);
      return {
        statusCode: 201,
        body: project,
        resourceType: "project",
        resourceId: project.id,
      };
    }),
  );

  server.get("/api/v1/projects", async (request) =>
    dependencies.projects.list(projectQuery(request.query)),
  );

  server.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId",
    async (request) => dependencies.projects.get(request.params.projectId),
  );

  server.patch<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId",
    async (request, reply) =>
      idempotent(
        request,
        reply,
        dependencies.idempotency,
        "projects:update:" + request.params.projectId,
        { body: jsonValue(request.body), ifMatch: request.headers["if-match"] ?? null },
        async () => ({
          statusCode: 200,
          body: dependencies.projects.update(
            request.params.projectId,
            parseIfMatch(request.headers["if-match"]),
            requireObject<UpdateProjectRequest>(request.body),
          ),
        }),
      ),
  );

  server.delete<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId",
    async (request, reply) =>
      idempotent(
        request,
        reply,
        dependencies.idempotency,
        "projects:delete:" + request.params.projectId,
        null,
        async () => {
          dependencies.projects.remove(request.params.projectId);
          return { statusCode: 204, body: null };
        },
      ),
  );

  server.post<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/sessions",
    async (request, reply) =>
      idempotent(
        request,
        reply,
        dependencies.idempotency,
        "sessions:create:" + request.params.projectId,
        request.body,
        async () => {
          const session = await dependencies.sessions.create(
            request.params.projectId,
            requireObject<CreateSessionRequest>(request.body ?? {}),
            {},
            { locale: request.locale },
          );
          // 普通会话建好就可能马上开回合：等基线拍完再返回，免得基线拍进模型改过的文件。
          await dependencies.workspace.captureBaselineInBackground(session.id);
          return {
            statusCode: 201,
            body: session,
            resourceType: "session",
            resourceId: session.id,
          };
        },
      ),
  );

  server.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/sessions",
    async (request) =>
      dependencies.sessions.list(
        request.params.projectId,
        sessionQuery(request.query),
      ),
  );

  server.get<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId",
    async (request) => dependencies.sessions.get(request.params.sessionId),
  );

  server.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/sessions/run-status",
    async (request) => dependencies.runStatus.list(request.params.projectId),
  );

  server.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/files",
    async (request) => {
      const query = queryObject(request.query);
      return dependencies.workspace.listDirectory(
        request.params.projectId,
        query["path"] ?? "",
      );
    },
  );

  server.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/files/content",
    async (request) => {
      const path = queryObject(request.query)["path"];
      if (!path) {
        throw validation((t) => t.http.previewPathRequired);
      }
      return dependencies.workspace.readContent(request.params.projectId, path);
    },
  );

  server.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/files/index",
    async (request) => dependencies.workspace.listIndex(request.params.projectId),
  );

  server.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/files/raw",
    async (request, reply) => {
      const path = queryObject(request.query)["path"];
      if (!path) {
        throw validation((t) => t.http.rawPathRequired);
      }
      const file = await dependencies.workspace.resolveRawFile(
        request.params.projectId,
        path,
      );
      return reply
        .type(file.mediaType)
        .header("Content-Length", String(file.size))
        .header("Cache-Control", "no-store")
        .send(createReadStream(file.absolutePath));
    },
  );

  server.get(
    "/api/v1/system/open-targets",
    async () => ({ targets: await dependencies.workspace.listOpenTargets() }),
  );

  server.get("/api/v1/settings", async () => dependencies.settings.get());

  server.patch("/api/v1/settings", async (request) =>
    dependencies.settings.update(
      requireObject<UpdateSettingsRequest>(request.body),
    ),
  );

  server.get("/api/v1/skills/global", async () => ({
    items: await dependencies.skillAdmin.list(),
    root: dependencies.skillAdmin.root(),
  }));

  server.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/skills/catalog",
    async (request) => ({
      items: await dependencies.workspace.skillCatalogFor(
        request.params.projectId,
      ),
    }),
  );

  server.post("/api/v1/skills/enabled", async (request, reply) => {
    const body = requireObject<SetSkillEnabledRequest>(request.body);
    if (typeof body.name !== "string" || body.name === "") {
      throw validation((t) => t.http.skillNameRequired);
    }
    if (typeof body.enabled !== "boolean") {
      throw validation((t) => t.http.mustBeBoolean("enabled"));
    }
    await dependencies.setSkillEnabled(body.name, body.enabled);
    return reply.code(204).send();
  });

  server.post("/api/v1/skills/install", async (request) => {
    const body = requireObject<InstallSkillRequest>(request.body);
    if (body.source !== "zip" && body.source !== "folder") {
      throw validation((t) => t.http.skillSourceInvalid);
    }
    return { skill: await dependencies.skillAdmin.install(body) };
  });

  server.post("/api/v1/skills/remove", async (request, reply) => {
    const body = requireObject<RemoveSkillRequest>(request.body);
    if (typeof body.path !== "string" || body.path === "") {
      throw validation((t) => t.http.uninstallPathRequired);
    }
    await dependencies.skillAdmin.remove(body.path);
    return reply.code(204).send();
  });

  server.post<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/files/open",
    async (request, reply) => {
      const body = requireObject<OpenFileRequest>(request.body);
      if (typeof body.path !== "string" || body.path === "") {
        throw validation((t) => t.http.openPathRequired);
      }
      if (
        body.mode !== "open" &&
        body.mode !== "reveal" &&
        body.mode !== "vscode" &&
        body.mode !== "terminal"
      ) {
        throw validation((t) => t.http.openModeInvalid);
      }
      if (body.line !== undefined && (!Number.isSafeInteger(body.line) || body.line < 1)) {
        throw validation((t) => t.http.lineInvalid);
      }
      await dependencies.workspace.openWithSystem(
        request.params.projectId,
        body.path,
        body.mode,
        body.line,
      );
      return reply.code(204).send();
    },
  );

  server.post<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/files/exists",
    async (request) => {
      const body = requireObject<ExistingFilesRequest>(request.body);
      if (
        !Array.isArray(body.paths) ||
        body.paths.length > EXISTING_FILES_LIMIT ||
        body.paths.some((path) => typeof path !== "string" || path === "" || path.length > 1024)
      ) {
        throw validation((t) => t.http.existingPathsInvalid(EXISTING_FILES_LIMIT));
      }
      return dependencies.workspace.existingFiles(request.params.projectId, body.paths);
    },
  );

  server.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/git/status",
    async (request) => dependencies.git.status(request.params.projectId, request.locale),
  );

  server.post<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/git/init",
    async (request) => dependencies.git.init(request.params.projectId, request.locale),
  );

  server.post<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/git/checkpoint",
    async (request) => {
      const body = requireObject<GitCheckpointRequest>(request.body);
      const checkpoint = await dependencies.git.checkpoint(
        request.params.projectId,
        typeof body.message === "string" ? body.message : undefined,
        request.locale,
      );
      return { checkpoint };
    },
  );

  server.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/git/checkpoints",
    async (request) => ({
      items: await dependencies.git.listCheckpoints(request.params.projectId),
    }),
  );

  server.post<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/git/restore",
    async (request) => {
      const body = requireObject<GitRestoreRequest>(request.body);
      if (typeof body.hash !== "string" || body.hash === "") {
        throw validation((t) => t.http.restoreHashRequired);
      }
      return dependencies.git.restore(request.params.projectId, body.hash, request.locale);
    },
  );

  server.post<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/git/settings",
    async (request) => {
      const body = requireObject<GitSettingsRequest>(request.body);
      if (typeof body.autoCheckpoint !== "boolean") {
        throw validation((t) => t.http.mustBeBoolean("autoCheckpoint"));
      }
      return dependencies.git.updateSettings(request.params.projectId, {
        autoCheckpoint: body.autoCheckpoint,
      }, request.locale);
    },
  );

  server.post<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/attachments",
    async (request, reply) =>
      idempotent(
        request,
        reply,
        dependencies.idempotency,
        "attachments:" + request.params.projectId,
        request.body,
        async () => ({
          statusCode: 201,
          body: await dependencies.workspace.saveAttachment(
            request.params.projectId,
            requireObject<{ mediaType: string; dataBase64: string }>(request.body),
          ),
        }),
      ),
  );

  server.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/skills",
    async (request) => dependencies.workspace.listSkills(request.params.projectId),
  );

  server.get<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/changes",
    async (request) => ({
      ...(await dependencies.workspace.listChanges(request.params.sessionId)),
    }),
  );

  server.get<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/diff",
    async (request) => {
      const path = queryObject(request.query)["path"];
      if (!path) {
        throw validation((t) => t.http.diffPathRequired);
      }
      return dependencies.workspace.diff(request.params.sessionId, path);
    },
  );

  server.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/files/watch",
    async (request, reply) => {
      const releaseStream = dependencies.activity?.retainStream();
      try {
        await streamWorkspaceChanges(
          request,
          reply,
          dependencies.workspaceWatcher,
          request.params.projectId,
          dependencies.workspace.projectRoot(request.params.projectId),
        );
      } finally {
        releaseStream?.();
      }
    },
  );

  server.patch<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId",
    async (request, reply) =>
      idempotent(
        request,
        reply,
        dependencies.idempotency,
        "sessions:update:" + request.params.sessionId,
        { body: jsonValue(request.body), ifMatch: request.headers["if-match"] ?? null },
        async () => ({
          statusCode: 200,
          body: await dependencies.sessions.update(
            request.params.sessionId,
            // ADR-0004：会话改名 / 归档 / 审批档 / 模型等由人仲裁，后写生效；If-Match 即使带了也不比对。
            null,
            requireObject<UpdateSessionRequest>(request.body),
          ),
        }),
      ),
  );

  server.delete<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId",
    async (request, reply) =>
      idempotent(
        request,
        reply,
        dependencies.idempotency,
        "sessions:delete:" + request.params.sessionId,
        null,
        async () => {
          dependencies.sessions.remove(request.params.sessionId);
          return { statusCode: 204, body: null };
        },
      ),
  );

  server.post<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/messages",
    async (request, reply) => {
      const key = requireIdempotencyKey(request);
      return idempotent(
        request,
        reply,
        dependencies.idempotency,
        "messages:" + request.params.sessionId,
        request.body,
        async () => ({
          statusCode: 202,
          body: await dependencies.messages.send(
            request.params.sessionId,
            requireObject<SendMessageRequest>(request.body),
            key,
            { locale: request.locale },
          ),
        }),
        key,
      );
    },
  );

  server.get<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/context",
    async (request) => {
      if (!dependencies.sessionContext) {
        throw new ApiError(503, "DEPENDENCY_UNAVAILABLE", (t) => t.http.sessionContextUnavailable);
      }
      return dependencies.sessionContext.describe(request.params.sessionId);
    },
  );

  server.get<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/approvals",
    async (request) => {
      dependencies.sessions.get(request.params.sessionId);
      return dependencies.approvals.list(
        request.params.sessionId,
        approvalQuery(request.query),
      );
    },
  );

  server.get("/", async (_request, reply) =>
    sendWebFile(reply, dependencies.webRoot, "index.html"),
  );

  // pr9：设置页要把自检结果**内嵌成卡片**而不是跳这个 HTML 页
  //（用户来设置页九成是因为某样东西不工作，把诊断藏在跳转后面方向是反的）。
  // 只加一条 JSON 读取路由，HTML 页原样保留给不开设置页的场景。
  server.get("/api/v1/doctor", async (request) => dependencies.doctor(request.locale));

  server.get("/doctor", async (request, reply) => {
    // 浏览器直接打开的页面不带前端的语言头：?lang= → 已记下的界面语言 → Accept-Language（技术设计 §七）。
    const lang = queryObject(request.query)["lang"];
    const locale = isLocale(lang) ? lang : request.locale;
    const result = await dependencies.doctor(locale);
    return reply
      .header("Cache-Control", "no-store")
      .header(
        "Content-Security-Policy",
        "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      )
      .type("text/html; charset=utf-8")
      .send(renderDoctorPage(result, locale));
  });

  server.get("/doctor/client.js", async (_request, reply) =>
    reply
      .header("Cache-Control", "no-store")
      .type("text/javascript; charset=utf-8")
      .send(DOCTOR_PAGE_SCRIPT),
  );

  server.get<{ Params: { "*": string } }>("/*", async (request, reply) => {
    const path = request.params["*"];
    if (path.startsWith("api/")) {
      throw new ApiError(404, "NOT_FOUND", (t) => t.http.apiRouteNotFound);
    }
    return sendWebFile(
      reply,
      dependencies.webRoot,
      path.startsWith("assets/") || path === "favicon.svg"
        ? path
        : "index.html",
    );
  });

  server.get<{ Params: { approvalId: string } }>(
    "/api/v1/approvals/:approvalId",
    async (request) => dependencies.approvals.get(request.params.approvalId),
  );

  server.post<{ Params: { approvalId: string } }>(
    "/api/v1/approvals/:approvalId/decision",
    async (request, reply) =>
      idempotent(
        request,
        reply,
        dependencies.idempotency,
        "approvals:decision:" + request.params.approvalId,
        request.body,
        async () => {
          const body = requireObject<DecideApprovalRequest>(request.body);
          if (!(APPROVAL_DECISIONS as readonly string[]).includes(body.decision)) {
            throw validation((t) => t.http.decisionInvalid);
          }
          if (body.optionId !== undefined && typeof body.optionId !== "string") {
            throw validation((t) => t.http.optionIdInvalid);
          }
          return {
            statusCode: 200,
            body: await dependencies.approvals.decide(
              request.params.approvalId,
              body,
            ),
          };
        },
      ),
  );

  server.post<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/interrupt",
    async (request, reply) =>
      idempotent(
        request,
        reply,
        dependencies.idempotency,
        "interrupt:" + request.params.sessionId,
        request.body,
        async () => ({
          statusCode: 202,
          body: await dependencies.interrupts.interrupt(
            request.params.sessionId,
            requireObject<InterruptRequest>(request.body ?? {}),
          ),
        }),
      ),
  );

  server.get<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/events/backfill",
    async (request) => {
      // 与 SSE 一致，先确认会话存在，确保 404 语义不变。
      dependencies.sessions.get(request.params.sessionId);
      const query = parseBackfillQuery(request.query);
      return dependencies.eventStream.backfill({
        sessionId: request.params.sessionId,
        ...query,
      });
    },
  );

  server.get<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/events",
    async (request, reply) => {
      dependencies.sessions.get(request.params.sessionId);
      const after = parseAfter(request.query, request.headers["last-event-id"]);
      const releaseStream = dependencies.activity?.retainStream();
      try {
        await streamEvents(
          request,
          reply,
          dependencies.eventStream,
          request.params.sessionId,
          after,
          dependencies.sseHeartbeatMs ?? 15_000,
        );
      } finally {
        releaseStream?.();
      }
    },
  );

  return server;
}

function registerRequirementsV2Routes(
  server: FastifyInstance,
  dependencies: HttpServerDependencies,
): void {
  const service = dependencies.requirementsV2;
  if (!service) {
    return;
  }
  const workbench = dependencies.myWorkbench;

  server.get("/api/v2/requirements/settings", async () => service.settingsView());

  server.put("/api/v2/requirements/settings", async (request) =>
    service.updateSettings(requireObject<{ baseUrl?: unknown }>(request.body)),
  );

  server.post("/api/v2/auth/register", async (request) =>
    service.register(requireObject(request.body)),
  );

  server.post("/api/v2/auth/login", async (request) =>
    service.login(requireObject(request.body)),
  );

  server.post("/api/v2/auth/logout", async (_request, reply) => {
    service.logout();
    return reply.code(204).send();
  });

  server.get("/api/v2/auth/me", async () => service.me());

  server.get("/api/v2/projects", async (request) =>
    service.listProjects(requirementsCursorQuery(request.query, ["includeArchived"])),
  );

  server.post("/api/v2/projects", async (request, reply) =>
    reply.code(201).send(await service.createProject(requireObject(request.body))),
  );

  server.get<{ Params: { projectId: string } }>(
    "/api/v2/projects/:projectId",
    async (request) => service.getProject(request.params.projectId),
  );

  if (workbench) {
    server.get("/api/v2/my/workbench", async (request) => workbench.getWorkbench(request.locale));

    server.get<{ Params: { projectId: string } }>(
      "/api/v2/projects/:projectId/stats",
      async (request) =>
        workbench.getProjectStats(
          request.params.projectId,
          requirementsProjectStatsQuery(request.query),
        ),
    );
  }

  server.patch<{ Params: { projectId: string } }>(
    "/api/v2/projects/:projectId",
    async (request) =>
      service.updateProject(request.params.projectId, requireObject(request.body)),
  );

  server.get<{ Params: { projectId: string } }>(
    "/api/v2/projects/:projectId/requirements",
    async (request) =>
      service.listRequirements(
        request.params.projectId,
        requirementsCursorQuery(request.query, ["status", "search", "assignee", "creator", "priority", "sort"]),
      ),
  );

  server.get<{ Params: { projectId: string; number: string } }>(
    "/api/v2/projects/:projectId/requirements/by-number/:number",
    async (request) =>
      service.getRequirementByNumber(
        request.params.projectId,
        requirementNumberParam(request.params.number),
      ),
  );

  server.get("/api/v2/users", async () => service.listUsers());

  server.post<{ Params: { projectId: string } }>(
    "/api/v2/projects/:projectId/requirements",
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await service.createRequirement(
            request.params.projectId,
            requireObject(request.body),
          ),
        ),
  );

  server.get<{ Params: { requirementId: string } }>(
    "/api/v2/requirements/:requirementId",
    async (request) => service.getRequirement(request.params.requirementId),
  );

  server.patch<{ Params: { requirementId: string } }>(
    "/api/v2/requirements/:requirementId",
    async (request) =>
      service.updateRequirement(
        request.params.requirementId,
        requireObject(request.body),
      ),
  );

  server.put<{ Params: { requirementId: string } }>(
    "/api/v2/requirements/:requirementId/read",
    async (request, reply) => {
      const body = request.body;
      const upTo =
        body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>)["upTo"] : undefined;
      if (upTo !== undefined && typeof upTo !== "string") throw validation((t) => t.http.upToInvalid);
      await service.markRequirementRead(request.params.requirementId, upTo === undefined ? {} : { upTo });
      return reply.status(204).send();
    },
  );

  server.get<{ Params: { requirementId: string } }>(
    "/api/v2/requirements/:requirementId/comments",
    async (request) =>
      service.listComments(
        request.params.requirementId,
        requirementsCursorQuery(request.query, []),
      ),
  );

  server.get<{ Params: { requirementId: string } }>(
    "/api/v2/requirements/:requirementId/activity",
    async (request) =>
      service.listRequirementActivity(
        request.params.requirementId,
        requirementsCursorQuery(request.query, []),
      ),
  );

  server.post<{ Params: { requirementId: string } }>(
    "/api/v2/requirements/:requirementId/comments",
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await service.createComment(
            request.params.requirementId,
            requireObject(request.body),
          ),
        ),
  );

  server.get("/api/v2/audit", async (request) =>
    service.listAudit(requirementsAuditQuery(request.query)),
  );

  server.get<{ Params: { requirementId: string } }>(
    "/api/v2/requirements/:requirementId/attachments",
    async (request) => service.listAttachments(request.params.requirementId),
  );

  server.get<{ Params: { requirementId: string } }>(
    "/api/v2/requirements/:requirementId/artifact-versions",
    async (request) => service.listArtifactVersions(request.params.requirementId),
  );

  server.get<{ Params: { versionId: string } }>(
    "/api/v2/artifact-versions/:versionId",
    async (request) => service.getArtifactVersion(request.params.versionId),
  );

  server.get<{
    Params: { versionId: string; fileId: string };
    Querystring: { disposition?: unknown };
  }>(
    "/api/v2/artifact-versions/:versionId/files/:fileId/content",
    async (request, reply) => {
      const abort = new AbortController();
      reply.raw.once("close", () => abort.abort());
      const response = await service.downloadArtifactVersionFile(
        request.params.versionId,
        request.params.fileId,
        abort.signal,
      );
      return sendRemoteFile(reply, response, {
        missingBodyMessage: (t) => t.http.remoteArtifactFileBodyMissing,
        inline: request.query.disposition === "inline",
      });
    },
  );

  // 评论文件（需求附件评论文件与优先级 4.2）：上传流式转发、状态码原样交回；下载透传 Range 与内联（同房间文件）。
  server.post<{ Params: { requirementId: string }; Body: Readable }>(
    "/api/v2/requirements/:requirementId/comment-files",
    async (request, reply) => {
      const contentType = headerValue(request.headers["content-type"]);
      if (!contentType?.toLowerCase().startsWith("multipart/form-data;")) {
        if (request.body instanceof Readable) request.body.resume();
        throw validation((t) => t.http.uploadMustBeMultipart);
      }
      if (!(request.body instanceof Readable)) {
        throw validation((t) => t.http.uploadStreamInvalid);
      }
      const headers: Record<string, string> = {};
      for (const name of UPLOAD_FORWARD_HEADERS) {
        const value = headerValue(request.headers[name]);
        if (value !== undefined) headers[name] = value;
      }
      const abort = new AbortController();
      request.raw.once("aborted", () => abort.abort());
      reply.raw.once("close", () => abort.abort());
      const result = await service.uploadCommentFile({
        requirementId: request.params.requirementId,
        body: request.body,
        contentType,
        headers,
        signal: abort.signal,
      });
      return reply.code(result.status).send(result.body);
    },
  );

  server.get<{ Params: { fileId: string }; Querystring: { disposition?: unknown } }>(
    "/api/v2/comment-files/:fileId/content",
    async (request, reply) => {
      const abort = new AbortController();
      reply.raw.once("close", () => abort.abort());
      const disposition = request.query.disposition;
      const range = headerValue(request.headers["range"]);
      const ifRange = headerValue(request.headers["if-range"]);
      const ifNoneMatch = headerValue(request.headers["if-none-match"]);
      const response = await service.downloadCommentFile(request.params.fileId, {
        ...(range === undefined ? {} : { range }),
        ...(ifRange === undefined ? {} : { ifRange }),
        ...(ifNoneMatch === undefined ? {} : { ifNoneMatch }),
        ...(disposition === "inline" || disposition === "attachment" ? { disposition } : {}),
        signal: abort.signal,
      });
      reply.code(response.status);
      for (const name of FILE_RESPONSE_HEADERS) {
        const value = response.headers.get(name);
        if (value !== null) reply.header(name, value);
      }
      // 远程内容在本机源下打开：不嗅探类型，脚本一律不跑。
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("Content-Security-Policy", "sandbox");
      reply.header("Cache-Control", response.headers.get("cache-control") ?? "private, no-cache");
      if (!response.body || response.status === 304) {
        await response.body?.cancel().catch(() => undefined);
        return reply.send();
      }
      return reply.send(Readable.fromWeb(response.body as NodeWebReadableStream<Uint8Array>));
    },
  );

  server.get<{ Params: { fileId: string } }>(
    "/api/v2/comment-files/:fileId",
    async (request) => service.getCommentFile(request.params.fileId),
  );

  server.post<{ Params: { fileId: string } }>(
    "/api/v2/comment-files/:fileId/save-as-attachment",
    async (request, reply) => reply.code(201).send(await service.saveCommentFileAsAttachment(request.params.fileId)),
  );

  server.post<{ Params: { requirementId: string }; Body: Readable }>(
    "/api/v2/requirements/:requirementId/attachments",
    async (request, reply) => {
      const contentType = headerValue(request.headers["content-type"]);
      if (!contentType?.toLowerCase().startsWith("multipart/form-data;")) {
        throw validation((t) => t.http.uploadMustBeMultipart);
      }
      if (!(request.body instanceof Readable)) {
        throw validation((t) => t.http.uploadStreamInvalid);
      }
      let idempotencyKey: string;
      try {
        idempotencyKey = requiredUuidHeader(
          "Idempotency-Key",
          request.headers["idempotency-key"],
        );
      } catch (error) {
        request.body.resume();
        throw error;
      }
      const abort = new AbortController();
      request.raw.once("aborted", () => abort.abort());
      reply.raw.once("close", () => abort.abort());
      const mutation = await service.uploadAttachment({
        requirementId: request.params.requirementId,
        body: request.body,
        contentType,
        ...optionalHeader("contentLength", request.headers["content-length"]),
        ...optionalHeader("attachmentSize", request.headers["x-attachment-size"]),
        idempotencyKey,
        signal: abort.signal,
      });
      return reply.code(201).send(mutation);
    },
  );

  server.get<{
    Params: { attachmentId: string };
    Querystring: { disposition?: unknown };
  }>(
    "/api/v2/attachments/:attachmentId/content",
    async (request, reply) => {
      const abort = new AbortController();
      reply.raw.once("close", () => abort.abort());
      const response = await service.downloadAttachment(
        request.params.attachmentId,
        abort.signal,
      );
      return sendRemoteFile(reply, response, {
        missingBodyMessage: (t) => t.http.remoteAttachmentBodyMissing,
        inline: request.query.disposition === "inline",
      });
    },
  );

  server.delete<{ Params: { attachmentId: string } }>(
    "/api/v2/attachments/:attachmentId/content",
    async (request, reply) => {
      return reply.send(
        await service.deleteAttachment({
          attachmentId: request.params.attachmentId,
        }),
      );
    },
  );

  // 没有 RemoteEventsHub 时（旧测试工厂）退回逐连接转发上游。
  if (!dependencies.remoteEvents) server.get("/api/v2/events", async (_request, reply) => {
    const abort = new AbortController();
    const releaseStream = dependencies.activity?.retainStream();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseStream?.();
    };
    reply.raw.once("close", () => abort.abort());
    try {
      const response = await service.openEvents(abort.signal);
      if (!response.body) {
        throw new ApiError(503, "DEPENDENCY_UNAVAILABLE", (t) => t.http.remoteEventsBodyMissing);
      }
      const stream = Readable.fromWeb(
        response.body as NodeWebReadableStream<Uint8Array>,
      );
      stream.once("close", release);
      stream.once("error", release);
      reply.headers({
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      return reply.send(stream);
    } catch (error) {
      release();
      throw error;
    }
  });

  registerProjectMappingRoutes(server, dependencies);

  server.put<{ Params: { projectId: string } }>(
    "/api/v2/projects/:projectId/workspace-mapping",
    async (request) =>
      service.saveMapping(request.params.projectId, requireObject(request.body)),
  );

  server.delete<{ Params: { projectId: string } }>(
    "/api/v2/projects/:projectId/workspace-mapping",
    async (request, reply) => {
      await service.removeMapping(request.params.projectId);
      return reply.code(204).send();
    },
  );

  server.post<{ Params: { requirementId: string } }>(
    "/api/v2/requirements/:requirementId/sessions",
    async (request, reply) => {
      requireEmptyObject(request.body);
      return reply
        .code(201)
        .send(await service.createRequirementSession(request.params.requirementId, request.locale));
    },
  );

  server.get<{ Params: { projectId: string } }>(
    "/api/v2/projects/:projectId/sessions",
    async (request) => ({
      items: await service.listProjectSessions(request.params.projectId),
    }),
  );

  server.post<{ Params: { projectId: string } }>(
    "/api/v2/projects/:projectId/sessions",
    async (request, reply) => {
      requireEmptyObject(request.body);
      return reply
        .code(201)
        .send(await service.createProjectSession(request.params.projectId, request.locale));
    },
  );
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function optionalHeader<TKey extends "contentLength" | "attachmentSize">(
  key: TKey,
  value: string | string[] | undefined,
): Partial<Record<TKey, string>> {
  const rendered = headerValue(value);
  return rendered === undefined ? {} : { [key]: rendered } as Record<TKey, string>;
}

function requiredUuidHeader(
  name: string,
  value: string | string[] | undefined,
): string {
  const rendered = headerValue(value);
  if (
    rendered === undefined ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(rendered)
  ) {
    throw validation((t) => t.http.mustBeUuid(name));
  }
  return rendered.toLowerCase();
}

/**
 * 转发远端附件 / 产物文件。默认按下载（octet-stream + attachment）；`inline` 时仅当
 * 文件是白名单内的安全类型（扩展名与文件头嗅探一致）才内联，否则同样按下载，不报错。
 */
async function sendRemoteFile(
  reply: FastifyReply,
  response: Response,
  options: { missingBodyMessage: ErrorText; inline: boolean },
): Promise<FastifyReply> {
  if (!response.body) {
    throw new ApiError(503, "DEPENDENCY_UNAVAILABLE", options.missingBodyMessage);
  }
  const body = response.body as NodeWebReadableStream<Uint8Array>;
  const remoteDisposition = response.headers.get("content-disposition");
  const preview = options.inline ? await prepareInlinePreview(body, remoteDisposition) : null;
  copyRemoteHeader(response, reply, "content-length");
  copyRemoteHeader(response, reply, "x-attachment-sha256");
  reply.headers(
    preview?.headers ?? {
      "Cache-Control": "no-store",
      "Content-Type": "application/octet-stream",
      "Content-Disposition":
        remoteDisposition !== null && /^attachment(?:;|$)/iu.test(remoteDisposition)
          ? remoteDisposition
          : "attachment",
      "X-Content-Type-Options": "nosniff",
    },
  );
  return reply.send(preview?.stream ?? Readable.fromWeb(body));
}

function copyRemoteHeader(
  response: Response,
  reply: FastifyReply,
  name: "content-length" | "x-attachment-sha256",
): void {
  const value = response.headers.get(name);
  if (value !== null) reply.header(name, value);
}

function requirementsCursorQuery(
  value: unknown,
  allowedExtra: readonly string[],
): Record<string, string | undefined> {
  const query = queryObject(value);
  const allowed = new Set(["cursor", "limit", ...allowedExtra]);
  for (const key of Object.keys(query)) {
    if (!allowed.has(key)) {
      throw validation((t) => t.http.unsupportedQueryParam(key));
    }
  }
  const limit = query["limit"];
  if (limit !== undefined) {
    const number = Number(limit);
    if (!Number.isSafeInteger(number) || number < 1 || number > 100) {
      throw validation((t) => t.http.limitRange(100));
    }
  }
  return query;
}

function requirementNumberParam(value: string): number {
  const number = Number(value);
  if (!/^[1-9][0-9]{0,8}$/u.test(value) || !Number.isSafeInteger(number)) {
    throw validation((t) => t.http.requirementNumberInvalid);
  }
  return number;
}

function requirementsAuditQuery(value: unknown): ListAuditQuery {
  const query = requirementsCursorQuery(value, ["resourceType", "resourceId", "projectId"]);
  const resourceType = query["resourceType"];
  if (resourceType !== undefined && !isAuditResourceType(resourceType)) {
    throw validation((t) => t.http.resourceTypeInvalid);
  }
  return {
    ...(query["cursor"] === undefined ? {} : { cursor: query["cursor"] }),
    ...(query["limit"] === undefined ? {} : { limit: Number(query["limit"]) }),
    ...(resourceType === undefined ? {} : { resourceType }),
    ...(query["resourceId"] === undefined ? {} : { resourceId: query["resourceId"] }),
    ...(query["projectId"] === undefined ? {} : { projectId: query["projectId"] }),
  };
}

function requirementsProjectStatsQuery(value: unknown): ProjectStatsQuery {
  const query = queryObject(value);
  for (const key of Object.keys(query)) {
    // staleDays 是旧版页面带的（停滞已改为按各状态节奏）：升级后仍开着的旧页面不至于整块统计失败，忽略即可。
    if (key !== "window" && key !== "tz" && key !== "staleDays") {
      throw validation((t) => t.http.unsupportedQueryParam(key));
    }
  }
  const window = query["window"];
  if (window !== "7d" && window !== "30d") {
    throw validation((t) => t.http.statsWindowInvalid);
  }
  const tz = query["tz"];
  if (!tz || tz.trim() === "") {
    throw validation((t) => t.http.timeZoneRequired);
  }
  return { window, tz };
}

function isAuditResourceType(value: string): value is AuditResourceType {
  return (AUDIT_RESOURCE_TYPES as readonly string[]).includes(value);
}

async function streamWorkspaceChanges(
  request: FastifyRequest,
  reply: FastifyReply,
  watcher: WorkspaceWatcher,
  projectId: string,
  rootPath: string,
): Promise<void> {
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  const abort = new AbortController();
  request.raw.once("close", () => abort.abort());
  const unsubscribe = watcher.subscribe(projectId, rootPath, (notice) => {
    if (!reply.raw.destroyed) {
      reply.raw.write(formatWorkspaceNotice(notice));
    }
  });
  const heartbeat = setInterval(() => {
    if (!reply.raw.destroyed) {
      reply.raw.write(formatSseHeartbeat());
    }
  }, 15_000);
  heartbeat.unref();
  await new Promise<void>((resolveWait) => {
    abort.signal.addEventListener("abort", () => resolveWait(), { once: true });
  });
  clearInterval(heartbeat);
  unsubscribe();
  if (!reply.raw.destroyed) {
    reply.raw.end();
  }
}

function formatWorkspaceNotice(notice: WorkspaceChangeNotice): string {
  return (
    "event: workspace.changed\n" +
    "data: " +
    JSON.stringify(notice) +
    "\n\n"
  );
}

async function sendWebFile(
  reply: FastifyReply,
  webRoot: string,
  relativePath: string,
) {
  if (relativePath.includes("..") || relativePath.includes("\0")) {
    throw new ApiError(404, "NOT_FOUND", (t) => t.http.staticFileNotFound);
  }
  const absolutePath = resolve(webRoot, relativePath);
  let content: Buffer;
  try {
    content = await readFile(absolutePath);
  } catch (error) {
    throw new ApiError(404, "NOT_FOUND", (t) => t.http.webBuildMissing, undefined, {
      cause: error,
    });
  }
  reply
    .header(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; script-src 'self'",
    )
    .type(staticMediaType(relativePath));
  return reply.send(content);
}

function staticMediaType(path: string): string {
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".woff2": "font/woff2",
      ".woff": "font/woff",
    } as Record<string, string>
  )[extname(path)] ?? "application/octet-stream";
}

async function idempotent(
  request: FastifyRequest,
  reply: FastifyReply,
  service: IdempotencyService,
  scope: string,
  requestValue: unknown,
  operation: () => Promise<OperationResult>,
  knownKey?: string,
) {
  const key = knownKey ?? requireIdempotencyKey(request);
  const begin = service.begin(scope, key, jsonValue(requestValue));
  if (begin.kind === "replay") {
    if (begin.response.statusCode === 204) {
      return reply.code(204).send();
    }
    return reply.code(begin.response.statusCode).send(begin.response.body);
  }
  try {
    const result = await operation();
    service.complete(
      scope,
      key,
      result.statusCode,
      jsonValue(result.body),
      result.resourceType ?? null,
      result.resourceId ?? null,
    );
    if (result.statusCode === 204) {
      return reply.code(204).send();
    }
    return reply.code(result.statusCode).send(result.body);
  } catch (error) {
    if (error instanceof IndeterminateOperationError) {
      service.indeterminate(scope, key);
      throw new ApiError(
        409,
        "IDEMPOTENCY_INDETERMINATE",
        error.text,
        { scope },
        { cause: error },
      );
    }
    if (error instanceof ApiError) {
      service.fail(
        scope,
        key,
        error.statusCode,
        // 重放时原样返回这一份：同一个幂等键是同一个界面的重试，语言不会变。
        jsonValue(errorResponse(error, request.id, request.locale)),
      );
    }
    throw error;
  }
}

async function streamEvents(
  request: FastifyRequest,
  reply: FastifyReply,
  eventStream: SessionEventStream,
  sessionId: string,
  after: number,
  heartbeatMs: number,
): Promise<void> {
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  reply.raw.write("retry: 3000\n\n");
  const abort = new AbortController();
  request.raw.once("close", () => abort.abort());
  const heartbeat = setInterval(() => {
    if (!reply.raw.destroyed) {
      reply.raw.write(formatSseHeartbeat());
    }
  }, heartbeatMs);
  heartbeat.unref();
  try {
    for await (const frame of eventStream.open({
      sessionId,
      after,
      signal: abort.signal,
    })) {
      await writeWithTimeout(
        reply.raw,
        frame.kind === "event" ? formatSseEvent(frame.event) : formatSseControlFrame(frame),
      );
    }
  } finally {
    clearInterval(heartbeat);
    abort.abort();
    if (!reply.raw.destroyed) {
      reply.raw.end();
    }
  }
}

async function writeWithTimeout(
  response: ServerResponse,
  chunk: string,
): Promise<void> {
  if (response.write(chunk)) {
    return;
  }
  await Promise.race([
    once(response, "drain"),
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("SSE client blocked for 30 seconds")),
        30_000,
      );
      timer.unref();
    }),
  ]);
}

function requireIdempotencyKey(request: FastifyRequest): string {
  const value = request.headers["idempotency-key"];
  if (typeof value !== "string" || value.length === 0) {
    throw validation((t) => t.http.idempotencyKeyRequired);
  }
  return value;
}

function requireObject<T>(value: unknown): T {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw validation((t) => t.http.bodyMustBeObject);
  }
  return value as T;
}

function requireEmptyObject(value: unknown): Record<string, never> {
  const body = requireObject<Record<string, never>>(
    value === undefined ? {} : value,
  );
  if (Object.keys(body).length > 0) {
    throw validation((t) => t.http.bodyMustBeEmpty);
  }
  return body;
}

function parseIfMatch(value: string | string[] | undefined): number {
  if (typeof value !== "string") {
    throw validation((t) => t.http.ifMatchRequired);
  }
  const match = /^"([1-9][0-9]*)"$/.exec(value);
  const version = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(version)) {
    throw validation((t) => t.http.ifMatchFormat);
  }
  return version;
}

function projectQuery(value: unknown): ListProjectsQuery {
  const query = queryObject(value);
  const state = query["state"];
  if (
    state !== undefined &&
    state !== "active" &&
    state !== "removed" &&
    state !== "all"
  ) {
    throw validation((t) => t.http.projectStateInvalid);
  }
  return {
    ...(state === undefined ? {} : { state }),
    ...cursorQuery(query),
  };
}

function sessionQuery(value: unknown): ListSessionsQuery {
  const query = queryObject(value);
  const state = query["state"];
  if (
    state !== undefined &&
    state !== "active" &&
    state !== "archived" &&
    state !== "deleted" &&
    state !== "all"
  ) {
    throw validation((t) => t.http.sessionStateInvalid);
  }
  return {
    ...(state === undefined ? {} : { state }),
    ...cursorQuery(query),
  };
}

function approvalQuery(value: unknown): ListApprovalsQuery {
  const query = queryObject(value);
  const status = query["status"];
  if (
    status !== undefined &&
    status !== "pending" &&
    status !== "history" &&
    status !== "all"
  ) {
    throw validation((t) => t.http.approvalStatusInvalid);
  }
  return {
    ...(status === undefined ? {} : { status }),
    ...cursorQuery(query),
  };
}

function cursorQuery(query: Record<string, string | undefined>) {
  const cursor = query["cursor"];
  const rawLimit = query["limit"];
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  return {
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  };
}

/**
 * 游标优先级（PR3）：有效的 `Last-Event-ID` 优先于 `?after=`。
 * 前端固定带着首次打开时的 `?after=`，而原生 EventSource 自动重连会原样带回这个旧
 * query、同时附上它记住的最新 `Last-Event-ID`；query 优先会让重连从旧游标整段重放。
 * header 只在自动重连时出现（新建 EventSource 不带），所以它总是更新的那个；
 * header 不是合法整数时回落到 query。
 */
function parseAfter(
  queryValue: unknown,
  lastEventId: string | string[] | undefined,
): number {
  const query = queryObject(queryValue);
  const fromHeader =
    typeof lastEventId === "string" ? parseCursor(lastEventId) : null;
  if (fromHeader !== null) {
    return fromHeader;
  }
  const value = query["after"] ?? "0";
  const after = parseCursor(value);
  if (after === null) {
    throw validation((t) => t.http.nonNegativeInteger("after/Last-Event-ID"));
  }
  return after;
}

function parseCursor(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor) || cursor < 0 || String(cursor) !== value) {
    return null;
  }
  return cursor;
}

const MAX_BACKFILL_LIMIT = 500;
/** 一次最多确认多少个路径是否存在。 */
const EXISTING_FILES_LIMIT = 200;

function parseBackfillQuery(queryValue: unknown): {
  after: number;
  until: number;
  limit: number;
} {
  const query = queryObject(queryValue);
  const after = parseNonNegativeInteger(query["after"] ?? "0", "after");
  if (query["until"] === undefined) {
    throw validation((t) => t.http.untilRequired);
  }
  const until = parseNonNegativeInteger(query["until"], "until");
  const limit = parseNonNegativeInteger(query["limit"] ?? String(MAX_BACKFILL_LIMIT), "limit");
  if (until < after) {
    throw validation((t) => t.http.untilBeforeAfter);
  }
  if (limit < 1 || limit > MAX_BACKFILL_LIMIT) {
    throw validation((t) => t.http.limitRange(MAX_BACKFILL_LIMIT));
  }
  return { after, until, limit };
}

function parseNonNegativeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || String(parsed) !== value) {
    throw validation((t) => t.http.nonNegativeInteger(name));
  }
  return parsed;
}

function queryObject(value: unknown): Record<string, string | undefined> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const result: Record<string, string | undefined> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      result[key] = item;
    }
  }
  return result;
}

function jsonValue(value: unknown): JsonValue {
  if (value === undefined) {
    return null;
  }
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function validation(message: ErrorText): ApiError {
  return new ApiError(400, "VALIDATION_ERROR", message);
}
