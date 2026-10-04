import type { Locale } from "@suduo/client-contracts";
import type { FastifyInstance } from "fastify";
import { ApiError } from "../../../application/api-error.js";
import type {
  CreateMcpServerInput,
  McpListResult,
  McpUpdateResult,
  UpdateMcpServerInput,
} from "../../../application/mcp-service.js";

export interface McpRouteService {
  list(): Promise<McpListResult>;
  /** locale：返回说明（message）用的语言。 */
  create(input: CreateMcpServerInput, locale: Locale): Promise<McpUpdateResult>;
  get(name: string): Promise<unknown>;
  update(name: string, input: UpdateMcpServerInput, locale: Locale): Promise<McpUpdateResult>;
  remove(name: string): Promise<{ removed: true }>;
  login(
    name: string,
    input?: { scopes?: string[]; timeoutSeconds?: number },
  ): Promise<{ authorizationUrl: string }>;
  logout(name: string): Promise<{ loggedOut: true }>;
  refresh(): Promise<McpListResult>;
}

export interface McpRouteDependencies {
  /** optional 保持既有 HTTP 测试工厂兼容；生产中央装配始终提供。 */
  mcp?: McpRouteService;
}

export function registerMcpRoutes(
  server: FastifyInstance,
  dependencies: Required<McpRouteDependencies>,
): void {
  server.get("/api/v1/mcp/servers", async () => dependencies.mcp.list());

  server.post("/api/v1/mcp/servers", async (request) =>
    dependencies.mcp.create(requireObject<CreateMcpServerInput>(request.body), request.locale),
  );

  server.get<{ Params: { name: string } }>(
    "/api/v1/mcp/servers/:name",
    async (request) => dependencies.mcp.get(request.params.name),
  );

  server.patch<{ Params: { name: string } }>(
    "/api/v1/mcp/servers/:name",
    async (request) =>
      dependencies.mcp.update(
        request.params.name,
        requireObject<UpdateMcpServerInput>(request.body),
        request.locale,
      ),
  );

  server.delete<{ Params: { name: string } }>(
    "/api/v1/mcp/servers/:name",
    async (request) => dependencies.mcp.remove(request.params.name),
  );

  server.post<{ Params: { name: string } }>(
    "/api/v1/mcp/servers/:name/login",
    async (request) =>
      dependencies.mcp.login(
        request.params.name,
        request.body === undefined
          ? undefined
          : requireObject<{ scopes?: string[]; timeoutSeconds?: number }>(request.body),
      ),
  );

  server.post<{ Params: { name: string } }>(
    "/api/v1/mcp/servers/:name/logout",
    async (request) => dependencies.mcp.logout(request.params.name),
  );

  server.post("/api/v1/mcp/refresh", async () => dependencies.mcp.refresh());
}

function requireObject<T>(value: unknown): T {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", (t) => t.http.bodyMustBeObject);
  }
  return value as T;
}
