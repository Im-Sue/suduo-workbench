import type { FastifyInstance } from "fastify";
import type { AgentLoginResultDto, UpdateAgentSettingsRequest } from "@suduo/client-contracts";
import type { AgentCatalogService } from "../../../application/agents/agent-catalog-service.js";
import type { OpenTerminal } from "../../../application/agents/terminal-login.js";
import { ApiError } from "../../../application/api-error.js";

export interface AgentsRouteDependencies {
  /** 多 Agent（ADR-0014）；optional 保持旧 HTTP 测试工厂兼容。 */
  agents?: AgentCatalogService;
  openTerminal?: OpenTerminal;
}

export function registerAgentsRoutes(server: FastifyInstance, dependencies: AgentsRouteDependencies): void {
  const agents = dependencies.agents;
  if (!agents) {
    return;
  }
  server.get("/api/v1/agents", async () => agents.list());

  server.post<{ Params: { agentId: string } }>("/api/v1/agents/:agentId/recheck", async (request) =>
    agents.recheck(request.params.agentId),
  );

  server.post<{ Params: { agentId: string } }>("/api/v1/agents/:agentId/login", async (request): Promise<AgentLoginResultDto> => {
    const command = agents.loginCommand(request.params.agentId);
    const opened = dependencies.openTerminal ? await dependencies.openTerminal(command) : false;
    return { opened, command };
  });

  server.get("/api/v1/settings/agents", async () => agents.settings());

  server.put("/api/v1/settings/agents", async (request) => {
    const body = request.body;
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new ApiError(400, "VALIDATION_ERROR", (t) => t.http.bodyMustBeObject);
    }
    return agents.updateSettings(body as UpdateAgentSettingsRequest);
  });
}
