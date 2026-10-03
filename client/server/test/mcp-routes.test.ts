import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/application/api-error.js";
import type {
  CreateMcpServerInput,
  McpUpdateResult,
  UpdateMcpServerInput,
} from "../src/application/mcp-service.js";
import type { McpRouteService } from "../src/infrastructure/http/routes/mcp-routes.js";
import { registerMcpRoutes } from "../src/infrastructure/http/routes/mcp-routes.js";

describe("MCP HTTP routes", () => {
  it("八个端点将请求交给 MCP 服务并保持返回形态", async () => {
    const service = new FakeMcpRouteService();
    const server = createServer(service);
    try {
      await expect(server.inject({ method: "GET", url: "/api/v1/mcp/servers" })).resolves.toMatchObject({
        statusCode: 200,
        json: expect.any(Function),
      });
      await expect(
        server.inject({
          method: "POST",
          url: "/api/v1/mcp/servers",
          payload: { name: "fixture", transport: { type: "stdio", command: "node" } },
        }),
      ).resolves.toMatchObject({ statusCode: 200 });
      await expect(
        server.inject({ method: "GET", url: "/api/v1/mcp/servers/fixture" }),
      ).resolves.toMatchObject({ statusCode: 200 });
      await expect(
        server.inject({
          method: "PATCH",
          url: "/api/v1/mcp/servers/fixture",
          payload: { enabled: false },
        }),
      ).resolves.toMatchObject({ statusCode: 200 });
      await expect(
        server.inject({
          method: "POST",
          url: "/api/v1/mcp/servers/fixture/login",
          payload: { scopes: ["tools.read"] },
        }),
      ).resolves.toMatchObject({ statusCode: 200 });
      await expect(
        server.inject({ method: "POST", url: "/api/v1/mcp/servers/fixture/logout" }),
      ).resolves.toMatchObject({ statusCode: 200 });
      await expect(
        server.inject({ method: "DELETE", url: "/api/v1/mcp/servers/fixture" }),
      ).resolves.toMatchObject({ statusCode: 200 });
      await expect(server.inject({ method: "POST", url: "/api/v1/mcp/refresh" })).resolves.toMatchObject({
        statusCode: 200,
      });

      expect(service.calls).toEqual([
        ["list"],
        ["create", "fixture"],
        ["get", "fixture"],
        ["update", "fixture", false],
        ["login", "fixture", ["tools.read"]],
        ["logout", "fixture"],
        ["remove", "fixture"],
        ["refresh"],
      ]);
    } finally {
      await server.close();
    }
  });

  it("请求体不是 object 时返回可读 400", async () => {
    const server = createServer(new FakeMcpRouteService());
    try {
      const response = await server.inject({
        method: "POST",
        url: "/api/v1/mcp/servers",
        payload: [],
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "请求体必须是 JSON object" });
    } finally {
      await server.close();
    }
  });
});

function createServer(service: McpRouteService) {
  const server = Fastify();
  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      void reply.code(error.statusCode).send({ error: error.message });
      return;
    }
    void reply.code(500).send({ error: "unexpected" });
  });
  registerMcpRoutes(server, { mcp: service });
  return server;
}

class FakeMcpRouteService implements McpRouteService {
  calls: unknown[][] = [];

  async list() {
    this.calls.push(["list"]);
    return { items: [], statusAvailable: true };
  }

  async create(input: CreateMcpServerInput): Promise<McpUpdateResult> {
    this.calls.push(["create", input.name]);
    return { server: routeServer(input.name), atomic: true, message: "created" };
  }

  async get(name: string) {
    this.calls.push(["get", name]);
    return { name };
  }

  async update(name: string, input: UpdateMcpServerInput): Promise<McpUpdateResult> {
    this.calls.push(["update", name, input.enabled]);
    return { server: routeServer(name), atomic: true, message: "updated" };
  }

  async remove(name: string) {
    this.calls.push(["remove", name]);
    return { removed: true as const };
  }

  async login(name: string, input?: { scopes?: string[] }) {
    this.calls.push(["login", name, input?.scopes]);
    return { authorizationUrl: "https://login.fixture/authorize" };
  }

  async logout(name: string) {
    this.calls.push(["logout", name]);
    return { loggedOut: true as const };
  }

  async refresh() {
    this.calls.push(["refresh"]);
    return { items: [], statusAvailable: true };
  }
}

function routeServer(name: string) {
  return {
    name,
    transport: "stdio" as const,
    enabled: true,
    command: "node",
    args: [],
    url: null,
    envVars: [],
    bearerTokenEnvVar: null,
    startupTimeoutSeconds: null,
    toolTimeoutSeconds: null,
    status: {
      name,
      startupState: "unknown" as const,
      startupFailureReason: null,
      authenticationStatus: "unknown" as const,
      toolCount: 0,
    },
  };
}
