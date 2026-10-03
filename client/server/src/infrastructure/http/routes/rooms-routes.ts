import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { LocalAgentStateDto } from "@suduo/client-contracts";
import { ApiError } from "../../../application/api-error.js";
import type { RequirementsRemoteClient } from "../../requirements-v2/remote-client.js";

/**
 * 项目聊天房间与共享 Agent 的本机端点（技术设计第七节）：浏览器只访问本机 `/api/v2/*`，
 * 这里一比一转发到远程 `/v2/*`（带本机保存的登录凭证），状态码与正文原样交回。
 * 房间文件上传流式转发；下载透传 Range，原样返回 206 / Content-Range（视频要能拖动播放）。
 * `GET /api/v2/agents/self` 是本机专有端点：本机 Agent 的登记状态与正在执行的任务。
 */
export interface RoomsRouteDependencies {
  remote: Pick<RequirementsRemoteClient, "forward" | "uploadRoomFile" | "downloadRoomFile">;
  agentState(): LocalAgentStateDto;
}

type Method = "GET" | "POST" | "PATCH";

/** 远程文件响应里原样转给浏览器的头（Cache-Control 单独处理）。 */
const FILE_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "content-disposition",
  "etag",
  "last-modified",
  "x-attachment-sha256",
] as const;

/** 上传时原样转给远程的请求头（Content-Type 单独处理）。 */
const UPLOAD_FORWARD_HEADERS = ["content-length", "x-attachment-size", "x-file-size", "idempotency-key"] as const;

export function registerRoomsRoutes(server: FastifyInstance, dependencies: RoomsRouteDependencies): void {
  const remote = dependencies.remote;

  const route = (
    method: Method,
    localPath: string,
    remotePath: (params: Record<string, string>) => string,
    /** bodyless = 远程端点没有请求体（stop / retry / close）：一律不带体与 Content-Type。 */
    options: { query?: boolean; bodyless?: boolean } = {},
  ) => {
    const handler = async (request: FastifyRequest, reply: FastifyReply) => {
      const params = request.params as Record<string, string>;
      const body = method === "GET" || options.bodyless ? undefined : requestBody(request.body);
      const result = await remote.forward({
        method,
        path: remotePath(params),
        ...(options.query ? { query: queryObject(request.query) } : {}),
        ...(body === undefined ? {} : { body }),
      });
      if (result.status === 204 || result.body === null) {
        return reply.code(result.status).send();
      }
      return reply.code(result.status).send(result.body);
    };
    if (method === "GET") server.get(localPath, handler);
    else if (method === "POST") server.post(localPath, handler);
    else server.patch(localPath, handler);
  };
  const id = (params: Record<string, string>, key: string) => encodeURIComponent(params[key] ?? "");

  // 房间
  route("GET", "/api/v2/projects/:projectId/rooms", (p) => `/v2/projects/${id(p, "projectId")}/rooms`);
  route("GET", "/api/v2/requirements/:requirementId/rooms", (p) => `/v2/requirements/${id(p, "requirementId")}/rooms`);
  route("POST", "/api/v2/requirements/:requirementId/rooms", (p) => `/v2/requirements/${id(p, "requirementId")}/rooms`);
  route("GET", "/api/v2/rooms/:roomId", (p) => `/v2/rooms/${id(p, "roomId")}`);
  route("PATCH", "/api/v2/rooms/:roomId", (p) => `/v2/rooms/${id(p, "roomId")}`);
  route("GET", "/api/v2/rooms/:roomId/members", (p) => `/v2/rooms/${id(p, "roomId")}/members`);
  route("POST", "/api/v2/rooms/:roomId/members", (p) => `/v2/rooms/${id(p, "roomId")}/members`);
  route("POST", "/api/v2/rooms/:roomId/read", (p) => `/v2/rooms/${id(p, "roomId")}/read`);
  // 消息
  route("GET", "/api/v2/rooms/:roomId/messages", (p) => `/v2/rooms/${id(p, "roomId")}/messages`, { query: true });
  route("POST", "/api/v2/rooms/:roomId/messages", (p) => `/v2/rooms/${id(p, "roomId")}/messages`);
  route("GET", "/api/v2/rooms/:roomId/messages/search", (p) => `/v2/rooms/${id(p, "roomId")}/messages/search`, {
    query: true,
  });
  // Agent 与共享。登记、心跳只由本机服务自己发（AgentPresence），不给浏览器开代理。
  server.get("/api/v2/agents/self", async () => dependencies.agentState());
  route("GET", "/api/v2/agents", () => "/v2/agents");
  route("GET", "/api/v2/rooms/:roomId/shares", (p) => `/v2/rooms/${id(p, "roomId")}/shares`);
  route("POST", "/api/v2/rooms/:roomId/shares", (p) => `/v2/rooms/${id(p, "roomId")}/shares`);
  route("POST", "/api/v2/agent-shares/:shareId/close", (p) => `/v2/agent-shares/${id(p, "shareId")}/close`, {
    bodyless: true,
  });
  route("GET", "/api/v2/rooms/:roomId/share-requests", (p) => `/v2/rooms/${id(p, "roomId")}/share-requests`);
  route("POST", "/api/v2/rooms/:roomId/share-requests", (p) => `/v2/rooms/${id(p, "roomId")}/share-requests`);
  route(
    "POST",
    "/api/v2/share-requests/:requestId/resolve",
    (p) => `/v2/share-requests/${id(p, "requestId")}/resolve`,
  );
  // 任务：浏览器只看详情、停止、重试；开始 / 进度 / 完成 / 收尾只由本机接收器（RoomAgentRunner）直接调远程。
  route("GET", "/api/v2/agent-runs/:runId", (p) => `/v2/agent-runs/${id(p, "runId")}`);
  for (const action of ["stop", "retry"] as const) {
    route("POST", `/api/v2/agent-runs/:runId/${action}`, (p) => `/v2/agent-runs/${id(p, "runId")}/${action}`, {
      bodyless: true,
    });
  }

  // 房间文件上传：multipart 流式转发（照需求附件上传的写法）。
  server.post<{ Params: { roomId: string }; Body: Readable }>(
    "/api/v2/rooms/:roomId/files",
    async (request, reply) => {
      const contentType = headerValue(request.headers["content-type"]);
      if (!contentType?.toLowerCase().startsWith("multipart/form-data;")) {
        if (request.body instanceof Readable) request.body.resume();
        throw validation("房间文件上传必须使用 multipart/form-data");
      }
      if (!(request.body instanceof Readable)) {
        throw validation("房间文件上传流无效");
      }
      const headers: Record<string, string> = {};
      for (const name of UPLOAD_FORWARD_HEADERS) {
        const value = headerValue(request.headers[name]);
        if (value !== undefined) headers[name] = value;
      }
      const abort = new AbortController();
      request.raw.once("aborted", () => abort.abort());
      reply.raw.once("close", () => abort.abort());
      const result = await remote.uploadRoomFile({
        roomId: request.params.roomId,
        body: request.body,
        contentType,
        headers,
        signal: abort.signal,
      });
      return reply.code(result.status).send(result.body);
    },
  );

  // 房间文件下载 / 内联 / 分段：Range 与 If-Range 透传，206 / 416 原样返回。
  server.get<{ Params: { fileId: string }; Querystring: { disposition?: unknown } }>(
    "/api/v2/room-files/:fileId/content",
    async (request, reply) => {
      const abort = new AbortController();
      reply.raw.once("close", () => abort.abort());
      const disposition = request.query.disposition;
      const range = headerValue(request.headers["range"]);
      const ifRange = headerValue(request.headers["if-range"]);
      const ifNoneMatch = headerValue(request.headers["if-none-match"]);
      const response = await remote.downloadRoomFile(request.params.fileId, {
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
      // 远程内容在本机源下打开：不嗅探类型，脚本一律不跑（视频 / 图片播放不受影响）。
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("Content-Security-Policy", "sandbox");
      // 远程给的是 ETag = sha256 + immutable，原样透传；没有时不缓存。
      reply.header("Cache-Control", response.headers.get("cache-control") ?? "private, no-cache");
      if (!response.body || response.status === 304) {
        await response.body?.cancel().catch(() => undefined);
        return reply.send();
      }
      return reply.send(Readable.fromWeb(response.body as NodeWebReadableStream<Uint8Array>));
    },
  );
}

/** 浏览器没带体就不带（建需求房间、加成员可以不带体）；带了必须是 JSON object。 */
function requestBody(value: unknown): unknown {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw validation("请求体必须是 JSON object");
  }
  return value;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
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

function validation(message: string): ApiError {
  return new ApiError(400, "VALIDATION_ERROR", message);
}
