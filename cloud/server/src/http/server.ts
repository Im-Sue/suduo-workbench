import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { Readable } from "node:stream";
import jwt from "@fastify/jwt";
import type {
  AuthSessionDto,
  ArtifactVersionDetailDto,
  CreateCommentRequest,
  CreateProjectRequest,
  CreateRequirementRequest,
  ListAuditQuery,
  ListProjectsQuery,
  ListRequirementActivityQuery,
  ListRequirementsByIdsQuery,
  ListRequirementsQuery,
  LoginRequest,
  AttachmentMutationResponse,
  PublishArtifactVersionRequest,
  MarkRequirementReadRequest,
  ProjectStatsQuery,
  RegisterRequest,
  RequirementsCursorQuery,
  RequirementsHealthDto,
  UpdateProjectRequest,
  UpdateRequirementRequest,
} from "@suduo/cloud-contracts";
import {
  REQUIREMENTS_V2_SCHEMAS,
  ROOM_SSE_EVENT_NAME,
  type RoomEventDto,
} from "@suduo/cloud-contracts";
import Fastify, {
  type FastifyInstance,
} from "fastify";
import type { AuthService } from "../application/auth-service.js";
import type { AttachmentService } from "../application/attachment-service.js";
import type { ArtifactVersionService } from "../application/artifact-version-service.js";
import type { CollaborationService } from "../application/collaboration-service.js";
import type { RequirementsEventHub } from "../application/event-hub.js";
import {
  ApplicationError,
  errorResponse,
} from "../application/errors.js";
import type { RoomsModule } from "../application/rooms/module.js";
import type { RequirementsServiceConfig } from "../config.js";
import type { AttachmentStorage } from "../infrastructure/attachment-storage.js";
import type { Database } from "../infrastructure/database.js";
import { currentSchemaVersion } from "../infrastructure/migration-runner.js";
import { actorId, downloadDisposition, headerValue, idSchema } from "./http-helpers.js";
import { singleMultipartFile } from "./multipart.js";
import { registerAgentRunRoutes } from "./routes/agent-runs-routes.js";
import { registerAgentRoutes } from "./routes/agents-routes.js";
import { registerRoomRoutes } from "./routes/rooms-routes.js";

interface AuthTokenClaims {
  sub: string;
  loginName: string;
  exp?: number;
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: AuthTokenClaims;
    user: AuthTokenClaims;
  }
}

export interface HttpServerDependencies {
  config: RequirementsServiceConfig;
  database: Database;
  auth: AuthService;
  collaboration: CollaborationService;
  attachments: AttachmentService;
  artifactVersions: ArtifactVersionService;
  attachmentStorage: AttachmentStorage;
  events: RequirementsEventHub;
  /** 项目聊天房间与共享 Agent；不给时不注册房间路由，`/v2/events` 只推需求事件。 */
  rooms?: RoomsModule;
}

const PUBLIC_ROUTES = new Set([
  "GET /v2/health",
  "POST /v2/auth/register",
  "POST /v2/auth/login",
]);

export async function buildHttpServer(
  dependencies: HttpServerDependencies,
): Promise<FastifyInstance> {
  const {
    config,
    database,
    auth,
    collaboration,
    attachments,
    artifactVersions,
    attachmentStorage,
    events,
    rooms,
  } = dependencies;
  const liveEventResponses = new Set<ServerResponse>();
  const server = Fastify({
    logger: config.logger
      ? {
          redact: {
            paths: ["req.headers.authorization", "req.body.password"],
            censor: "[REDACTED]",
          },
        }
      : false,
  });
  server.addContentTypeParser(/^multipart\/form-data(?:;.*)?$/iu, (_request, payload, done) => {
    done(null, payload);
  });

  await server.register(jwt, {
    secret: config.authSecret,
    sign: {
      expiresIn: config.authTtlSeconds,
      iss: config.authIssuer,
      aud: config.authAudience,
    },
    verify: {
      allowedIss: config.authIssuer,
      allowedAud: config.authAudience,
    },
  });

  server.addHook("onRequest", async (request) => {
    const routeKey = `${request.method} ${request.url.split("?", 1)[0] ?? request.url}`;
    if (PUBLIC_ROUTES.has(routeKey)) return;
    const authorization = request.headers.authorization;
    if (!authorization) {
      throw new ApplicationError(401, "AUTH_REQUIRED", "Sign in required");
    }
    try {
      await request.jwtVerify();
    } catch (error) {
      throw new ApplicationError(401, "AUTH_INVALID", "Your sign-in is invalid or has expired", undefined, {
        cause: error,
      });
    }
  });

  server.setErrorHandler((error, request, reply) => {
    if (error instanceof ApplicationError) {
      void reply.code(error.statusCode).send(errorResponse(error, request.id));
      return;
    }
    if (isValidationError(error)) {
      void reply.code(400).send(
        errorResponse(
          new ApplicationError(400, "VALIDATION_ERROR", "Invalid request parameters", {
            issues: error.validation,
          }),
          request.id,
        ),
      );
      return;
    }
    request.log.error(error);
    void reply.code(500).send(
      errorResponse(
        new ApplicationError(500, "INTERNAL_ERROR", "The server failed to process the request"),
        request.id,
      ),
    );
  });

  server.get("/v2/health", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    try {
      await database.query("SELECT 1");
      const schemaVersion = await currentSchemaVersion(database.pool);
      const health: RequirementsHealthDto = {
        service: "suduo-requirements-service",
        status: "ok",
        version: config.version ?? "dev",
        database: { status: "ok", schemaVersion },
        uptimeMs: Math.round(process.uptime() * 1_000),
      };
      return health;
    } catch (error) {
      request.log.warn({ error }, "database health check failed");
      return reply.code(503).send(
        errorResponse(
          new ApplicationError(
            503,
            "DEPENDENCY_UNAVAILABLE",
            "Database is unavailable",
          ),
          request.id,
        ),
      );
    }
  });

  server.post<{ Body: RegisterRequest }>(
    "/v2/auth/register",
    { schema: { body: REQUIREMENTS_V2_SCHEMAS.register } },
    async (request, reply) => {
      const user = await auth.register(request.body);
      return reply.code(201).send(authSession(server, config, user));
    },
  );

  server.post<{ Body: LoginRequest }>(
    "/v2/auth/login",
    { schema: { body: REQUIREMENTS_V2_SCHEMAS.login } },
    async (request) => {
      const user = await auth.login(request.body);
      return authSession(server, config, user);
    },
  );

  server.get("/v2/auth/me", async (request) =>
    auth.currentUser(actorId(request)),
  );

  // 续期：用当前有效令牌换一个新令牌（本机服务在过期前 1 小时调用，共享期间保持登录）。
  server.post("/v2/auth/refresh", async (request) =>
    authSession(server, config, await auth.currentUser(actorId(request))),
  );

  server.post<{ Body: CreateProjectRequest }>(
    "/v2/projects",
    { schema: { body: REQUIREMENTS_V2_SCHEMAS.createProject } },
    async (request, reply) => {
      const project = await collaboration.createProject(actorId(request), request.body);
      events.publish({ type: "project.changed", projectId: project.id });
      return reply.code(201).send(project);
    },
  );

  server.get<{ Querystring: ListProjectsQuery }>(
    "/v2/projects",
    { schema: { querystring: REQUIREMENTS_V2_SCHEMAS.listProjects } },
    async (request) => collaboration.listProjects(request.query),
  );

  server.get<{ Params: { projectId: string } }>(
    "/v2/projects/:projectId",
    { schema: { params: idSchema("projectId") } },
    async (request) => collaboration.getProject(request.params.projectId),
  );

  server.get<{
    Params: { projectId: string };
    Querystring: ProjectStatsQuery;
  }>(
    "/v2/projects/:projectId/stats",
    {
      schema: {
        params: idSchema("projectId"),
        querystring: REQUIREMENTS_V2_SCHEMAS.projectStats,
      },
    },
    async (request) =>
      collaboration.getProjectStats(request.params.projectId, request.query),
  );

  server.patch<{
    Params: { projectId: string };
    Body: UpdateProjectRequest;
  }>(
    "/v2/projects/:projectId",
    {
      schema: {
        params: idSchema("projectId"),
        body: REQUIREMENTS_V2_SCHEMAS.updateProject,
      },
    },
    async (request) => {
      const { project, changed } = await collaboration.updateProject(
        actorId(request),
        request.params.projectId,
        request.body,
      );
      if (changed) events.publish({ type: "project.changed", projectId: project.id });
      return project;
    },
  );

  server.post<{
    Params: { projectId: string };
    Body: CreateRequirementRequest;
  }>(
    "/v2/projects/:projectId/requirements",
    {
      schema: {
        params: idSchema("projectId"),
        body: REQUIREMENTS_V2_SCHEMAS.createRequirement,
      },
    },
    async (request, reply) => {
      const requirement = await collaboration.createRequirement(
        actorId(request),
        request.params.projectId,
        request.body,
      );
      events.publish({
        type: "requirement.changed",
        projectId: requirement.projectId,
        requirementId: requirement.id,
        requirementVersion: requirement.version,
      });
      return reply.code(201).send(requirement);
    },
  );

  server.get<{
    Params: { projectId: string };
    Querystring: ListRequirementsQuery;
  }>(
    "/v2/projects/:projectId/requirements",
    {
      schema: {
        params: idSchema("projectId"),
        querystring: REQUIREMENTS_V2_SCHEMAS.listRequirements,
      },
    },
    async (request) =>
      collaboration.listRequirements(
        actorId(request),
        request.params.projectId,
        request.query,
      ),
  );

  server.get<{ Params: { projectId: string; number: number } }>(
    "/v2/projects/:projectId/requirements/by-number/:number",
    { schema: { params: REQUIREMENTS_V2_SCHEMAS.requirementByNumberParams } },
    async (request) =>
      collaboration.getRequirementByNumber(
        request.params.projectId,
        request.params.number,
      ),
  );

  server.get("/v2/users", async () => collaboration.listUsers());

  server.get<{ Querystring: ListRequirementsByIdsQuery }>(
    "/v2/requirements",
    { schema: { querystring: REQUIREMENTS_V2_SCHEMAS.listRequirementsByIds } },
    async (request) => collaboration.listRequirementsByIds(request.query),
  );

  server.get<{ Params: { requirementId: string } }>(
    "/v2/requirements/:requirementId",
    { schema: { params: idSchema("requirementId") } },
    async (request) =>
      collaboration.getRequirement(request.params.requirementId),
  );

  // 已读位置：打开需求详情时调用。幂等、只往后挪；不产生审计与事件（个人状态）。
  server.put<{ Params: { requirementId: string }; Body: MarkRequirementReadRequest | undefined }>(
    "/v2/requirements/:requirementId/read",
    // 请求体可以没有（按现在记）：不挂 body schema，upTo 在服务里校验。
    { schema: { params: idSchema("requirementId") } },
    async (request, reply) => {
      await collaboration.markRequirementRead(actorId(request), request.params.requirementId, request.body ?? {});
      return reply.status(204).send();
    },
  );

  server.get<{ Params: { requirementId: string } }>(
    "/v2/requirements/:requirementId/artifact-versions",
    { schema: { params: idSchema("requirementId") } },
    async (request) => artifactVersions.list(request.params.requirementId),
  );

  server.post<{
    Params: { requirementId: string };
    Body: PublishArtifactVersionRequest;
  }>(
    "/v2/requirements/:requirementId/artifact-versions",
    {
      schema: {
        params: idSchema("requirementId"),
        body: REQUIREMENTS_V2_SCHEMAS.publishArtifactVersion,
      },
    },
    async (request, reply) => {
      const result = await artifactVersions.publish(
        actorId(request),
        request.params.requirementId,
        request.body,
      );
      events.publish({
        type: "artifact.published",
        projectId: result.projectId,
        requirementId: result.artifactVersion.requirementId,
        requirementVersion: result.requirementVersion,
      });
      return reply.code(201).send(result.artifactVersion satisfies ArtifactVersionDetailDto);
    },
  );

  server.get<{ Params: { versionId: string } }>(
    "/v2/artifact-versions/:versionId",
    { schema: { params: idSchema("versionId") } },
    async (request) => artifactVersions.getDetail(request.params.versionId),
  );

  server.get<{
    Params: { versionId: string; fileId: string };
  }>(
    "/v2/artifact-versions/:versionId/files/:fileId/content",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["versionId", "fileId"],
          properties: {
            versionId: { type: "string", format: "uuid" },
            fileId: { type: "string", format: "uuid" },
          },
        },
      },
    },
    async (request, reply) => {
      const file = await artifactVersions.getFileForDownload(
        request.params.versionId,
        request.params.fileId,
      );
      const stream = await attachmentStorage.open(file.storageKey);
      reply.headers({
        "Cache-Control": "no-store",
        "Content-Type": "application/octet-stream",
        "Content-Length": String(file.sizeBytes),
        "Content-Disposition": downloadDisposition(file.fileName),
        "X-Content-Type-Options": "nosniff",
        "X-Attachment-Sha256": file.sha256,
      });
      return reply.send(stream);
    },
  );

  server.patch<{
    Params: { requirementId: string };
    Body: UpdateRequirementRequest;
  }>(
    "/v2/requirements/:requirementId",
    {
      schema: {
        params: idSchema("requirementId"),
        body: REQUIREMENTS_V2_SCHEMAS.updateRequirement,
      },
    },
    async (request) => {
      const { requirement, changed } = await collaboration.updateRequirement(
        actorId(request),
        request.params.requirementId,
        request.body,
      );
      if (changed) {
        events.publish({
          type: "requirement.changed",
          projectId: requirement.projectId,
          requirementId: requirement.id,
          requirementVersion: requirement.version,
        });
      }
      return requirement;
    },
  );

  server.post<{
    Params: { requirementId: string };
    Body: CreateCommentRequest;
  }>(
    "/v2/requirements/:requirementId/comments",
    {
      schema: {
        params: idSchema("requirementId"),
        body: REQUIREMENTS_V2_SCHEMAS.createComment,
      },
    },
    async (request, reply) => {
      const comment = await collaboration.createComment(
        actorId(request),
        request.params.requirementId,
        request.body,
      );
      const requirement = await collaboration.getRequirement(comment.requirementId);
      events.publish({
        type: "comment.created",
        projectId: requirement.projectId,
        requirementId: requirement.id,
        requirementVersion: requirement.version,
      });
      return reply.code(201).send(comment);
    },
  );

  server.get<{
    Params: { requirementId: string };
    Querystring: RequirementsCursorQuery;
  }>(
    "/v2/requirements/:requirementId/comments",
    {
      schema: {
        params: idSchema("requirementId"),
        querystring: REQUIREMENTS_V2_SCHEMAS.cursorQuery,
      },
    },
    async (request) =>
      collaboration.listComments(request.params.requirementId, request.query),
  );

  server.get<{
    Params: { requirementId: string };
    Querystring: ListRequirementActivityQuery;
  }>(
    "/v2/requirements/:requirementId/activity",
    {
      schema: {
        params: idSchema("requirementId"),
        querystring: REQUIREMENTS_V2_SCHEMAS.cursorQuery,
      },
    },
    async (request) =>
      collaboration.listRequirementActivity(request.params.requirementId, request.query),
  );

  server.get<{ Querystring: ListAuditQuery }>(
    "/v2/audit",
    { schema: { querystring: REQUIREMENTS_V2_SCHEMAS.listAudit } },
    async (request) => collaboration.listAudit(request.query),
  );

  server.get<{ Params: { requirementId: string } }>(
    "/v2/requirements/:requirementId/attachments",
    { schema: { params: idSchema("requirementId") } },
    async (request) => attachments.list(request.params.requirementId),
  );

  server.post<{ Params: { requirementId: string }; Body: Readable }>(
    "/v2/requirements/:requirementId/attachments",
    { schema: { params: idSchema("requirementId") } },
    async (request, reply) => {
      const contentType = headerValue(request.headers["content-type"]);
      if (!contentType || !(request.body instanceof Readable)) {
        throw new ApplicationError(400, "ATTACHMENT_INVALID", "A multipart attachment file is required");
      }
      let uploadMetadata: {
        attachmentId: string;
        declaredSize?: number;
      };
      try {
        uploadMetadata = {
          attachmentId: attachmentOperationKey(request.headers["idempotency-key"]),
          ...optionalAttachmentSize(request.headers["x-attachment-size"]),
        };
      } catch (error) {
        request.body.resume();
        throw error;
      }
      const file = await singleMultipartFile(request.body, contentType, config.maxAttachmentBytes);
      let result;
      try {
        result = await attachments.upload({
          actorId: actorId(request),
          requirementId: request.params.requirementId,
          stream: file.stream,
          fileName: file.filename,
          contentType: file.mimeType,
          ...uploadMetadata,
          beforeCommit: () => file.completion,
        });
      } catch (error) {
        file.cancel();
        throw error;
      }
      events.publish({
        type: "attachment.changed",
        projectId: result.projectId,
        requirementId: result.attachment.requirementId,
        requirementVersion: result.requirementVersion,
      });
      return reply.code(201).send({
        attachment: result.attachment,
        requirementVersion: result.requirementVersion,
      } satisfies AttachmentMutationResponse);
    },
  );

  server.get<{ Params: { attachmentId: string } }>(
    "/v2/attachments/:attachmentId/content",
    { schema: { params: idSchema("attachmentId") } },
    async (request, reply) => {
      const result = await attachments.download(actorId(request), request.params.attachmentId);
      reply.headers({
        "Cache-Control": "no-store",
        "Content-Type": "application/octet-stream",
        "Content-Length": String(result.attachment.sizeBytes),
        "Content-Disposition": downloadDisposition(result.attachment.fileName),
        "X-Content-Type-Options": "nosniff",
        "X-Attachment-Sha256": result.attachment.sha256,
      });
      return reply.send(result.stream);
    },
  );

  server.delete<{ Params: { attachmentId: string } }>(
    "/v2/attachments/:attachmentId/content",
    { schema: { params: idSchema("attachmentId") } },
    async (request, reply) => {
      const result = await attachments.delete(
        actorId(request),
        request.params.attachmentId,
      );
      if (result.cleanupFailed) {
        request.log.warn(
          { attachmentId: request.params.attachmentId },
          "attachment physical cleanup deferred",
        );
      }
      events.publish({
        type: "attachment.changed",
        projectId: result.projectId,
        requirementId: result.attachment.requirementId,
        requirementVersion: result.requirementVersion,
      });
      return reply.send({
        attachment: result.attachment,
        requirementVersion: result.requirementVersion,
      } satisfies AttachmentMutationResponse);
    },
  );

  if (rooms !== undefined) {
    registerRoomRoutes(server, rooms);
    registerAgentRoutes(server, rooms);
    registerAgentRunRoutes(server, rooms);
  }

  /**
   * 推送：需求事件格式不变（默认 message 事件、uuid id、只提示刷新）；
   * 房间事件是命名事件 `room`，id 为进程内单调序号，带内容。
   * `ready` 帧带 epoch；请求带 `Last-Event-ID`（房间事件序号）且 `?epoch=` 与当前一致时，补发缓冲里更大的 id。
   */
  server.get("/v2/events", async (request, reply) => {
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const realtime = rooms?.realtime;
    const write = (frame: string) => {
      if (raw.writableEnded || raw.destroyed) return;
      raw.write(frame);
      // 慢消费者：积压过多时断开，由客户端重连补拉（房间事件带正文，单帧可能超过默认水位，不能按 write() 的返回值断开）。
      if (raw.writableLength > SSE_MAX_BUFFERED_BYTES) raw.end();
    };
    write(`retry: 2000\nevent: ready\ndata: ${realtime === undefined ? "{}" : JSON.stringify({ epoch: realtime.epoch })}\n\n`);
    liveEventResponses.add(raw);
    const unsubscribe = events.subscribe((event) => {
      write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    let unsubscribeRooms = () => {};
    if (realtime !== undefined) {
      const writeRoom = (event: RoomEventDto) => {
        write(`id: ${event.id}\nevent: ${ROOM_SSE_EVENT_NAME}\ndata: ${JSON.stringify(event)}\n\n`);
      };
      // 补发与订阅在同一个同步段内完成，期间不会有新事件插进来。
      const lastEventId = parseLastEventId(headerValue(request.headers["last-event-id"]));
      const clientEpoch = (request.query as Record<string, unknown> | undefined)?.["epoch"];
      if (lastEventId !== null && clientEpoch === realtime.epoch) {
        for (const event of realtime.eventsAfter(lastEventId)) writeRoom(event);
      }
      const unsubscribeRealtime = realtime.subscribe(writeRoom);
      unsubscribeRooms = () => {
        unsubscribeRealtime();
      };
    }
    const heartbeat = setInterval(() => {
      write(": heartbeat\n\n");
    }, 15_000);
    heartbeat.unref();
    const cancelAuthExpiration = closeWhenTokenExpires(raw, request.user.exp);
    await new Promise<void>((resolve) => {
      request.raw.once("close", resolve);
      raw.once("close", resolve);
    });
    clearInterval(heartbeat);
    cancelAuthExpiration();
    unsubscribe();
    unsubscribeRooms();
    liveEventResponses.delete(raw);
  });

  server.addHook("preClose", async () => {
    for (const response of liveEventResponses) response.end();
    liveEventResponses.clear();
  });

  server.addHook("onClose", async () => {
    await rooms?.sweeper.stop();
    await attachments.close();
  });

  return server;
}

/** 单条 SSE 连接允许积压的字节数，超过即断开（客户端会重连补拉）。 */
const SSE_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

/** 只认数字序号（房间事件的 id）；需求事件的 uuid id 不参与补发。 */
function parseLastEventId(value: string | undefined): number | null {
  if (value === undefined || !/^\d{1,15}$/u.test(value.trim())) return null;
  return Number(value.trim());
}

function isValidationError(error: unknown): error is { validation: unknown } {
  return error instanceof Error && "validation" in error;
}

function optionalAttachmentSize(
  value: string | string[] | undefined,
): { declaredSize?: number } {
  if (value === undefined) return {};
  const raw = Array.isArray(value) ? value[0] : value;
  const size = Number(raw);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new ApplicationError(400, "ATTACHMENT_INVALID", "Invalid X-Attachment-Size");
  }
  return { declaredSize: size };
}

function attachmentOperationKey(value: string | string[] | undefined): string {
  if (value === undefined) return randomUUID();
  const rendered = Array.isArray(value) ? value[0] : value;
  if (
    rendered === undefined ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(rendered)
  ) {
    throw new ApplicationError(400, "ATTACHMENT_INVALID", "Idempotency-Key must be a UUID");
  }
  return rendered.toLowerCase();
}



function closeWhenTokenExpires(
  response: ServerResponse,
  expiresAtSeconds: number | undefined,
): () => void {
  let timer: NodeJS.Timeout | null = null;
  const schedule = () => {
    const remaining = (expiresAtSeconds ?? 0) * 1_000 - Date.now();
    if (remaining <= 0) {
      response.end();
      return;
    }
    timer = setTimeout(schedule, Math.min(remaining, 2_147_483_647));
    timer.unref();
  };
  schedule();
  return () => {
    if (timer !== null) clearTimeout(timer);
  };
}



function authSession(
  server: FastifyInstance,
  config: RequirementsServiceConfig,
  user: Awaited<ReturnType<AuthService["currentUser"]>>,
): AuthSessionDto {
  const expiresAt = new Date(Date.now() + config.authTtlSeconds * 1_000);
  return {
    accessToken: server.jwt.sign({
      sub: user.id,
      loginName: user.loginName,
    }),
    tokenType: "Bearer",
    expiresAt: expiresAt.toISOString(),
    user,
  };
}
