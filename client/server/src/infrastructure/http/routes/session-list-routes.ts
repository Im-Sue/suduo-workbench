import type { ListAllSessionsQuery } from "@suduo/client-contracts";
import type { FastifyInstance } from "fastify";
import { ApiError } from "../../../application/api-error.js";
import type { SessionListService } from "../../../application/session-list-service.js";

export interface SessionListRouteDependencies {
  sessionList: SessionListService;
}

/** 跨项目会话列表（P3b）：与按项目的 /api/v1/projects/:projectId/sessions 并存，互不影响。 */
export function registerSessionListRoutes(
  server: FastifyInstance,
  dependencies: SessionListRouteDependencies,
): void {
  server.get("/api/v1/sessions", async (request) =>
    dependencies.sessionList.list(parseQuery(request.query), request.locale),
  );
}

function parseQuery(value: unknown): ListAllSessionsQuery {
  const query = queryObject(value);
  const state = query["state"];
  if (state !== undefined && state !== "active" && state !== "archived" && state !== "all") {
    throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.listStateInvalid);
  }
  const kind = query["kind"];
  if (kind !== undefined && kind !== "normal" && kind !== "room_task") {
    throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.listKindInvalid);
  }
  const remoteProjectId = query["remoteProjectId"];
  if (remoteProjectId === "") {
    throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.remoteProjectIdEmpty);
  }
  const limitText = query["limit"];
  let limit: number | undefined;
  if (limitText !== undefined) {
    limit = Number(limitText);
    if (!Number.isSafeInteger(limit) || String(limit) !== limitText) {
      throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.limitNotInteger);
    }
  }
  return {
    ...(state === undefined ? {} : { state }),
    ...(kind === undefined ? {} : { kind }),
    ...(remoteProjectId === undefined ? {} : { remoteProjectId }),
    ...(query["cursor"] === undefined ? {} : { cursor: query["cursor"] }),
    ...(limit === undefined ? {} : { limit }),
  };
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
