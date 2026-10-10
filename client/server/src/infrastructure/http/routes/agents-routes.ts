import type { FastifyInstance } from "fastify";
import type { AgentLoginResultDto, CodexModelOptionDto, CodexModelsResponse, UpdateAgentSettingsRequest } from "@suduo/client-contracts";
import type { AgentCatalogService } from "../../../application/agents/agent-catalog-service.js";
import { agentModelOptions } from "../../../application/agents/agent-models.js";
import type { OpenTerminal } from "../../../application/agents/terminal-login.js";
import { ApiError } from "../../../application/api-error.js";

export interface AgentsRouteDependencies {
  /** 多 Agent（ADR-0014）；optional 保持旧 HTTP 测试工厂兼容。 */
  agents?: AgentCatalogService;
  openTerminal?: OpenTerminal;
  /** Codex 的 model/list 投影（Codex 会话的模型选择器）。 */
  codexModelOptions?: () => Promise<CodexModelOptionDto[]>;
}

export function registerAgentsRoutes(server: FastifyInstance, dependencies: AgentsRouteDependencies): void {
  const agents = dependencies.agents;
  if (!agents) {
    return;
  }
  // ?wait=false：不等检测，先回缓存与「检测中」（界面轮询补状态）；默认等全部检测完（兼容 S1 的调用方）。
  server.get<{ Querystring: { wait?: string } }>("/api/v1/agents", async (request) =>
    request.query.wait === "false" ? agents.listNow() : agents.list(),
  );

  server.post<{ Params: { agentId: string } }>("/api/v1/agents/:agentId/recheck", async (request) =>
    agents.recheck(request.params.agentId),
  );

  server.post<{ Params: { agentId: string } }>("/api/v1/agents/:agentId/login", async (request): Promise<AgentLoginResultDto> => {
    const command = agents.loginCommand(request.params.agentId);
    const opened = dependencies.openTerminal ? await dependencies.openTerminal(command) : false;
    return { opened, command };
  });

  // 会话级模型选择器按 Agent 取选项（与 /api/v1/codex/models 同形）。
  server.get<{ Params: { agentId: string } }>("/api/v1/agents/:agentId/models", async (request): Promise<CodexModelsResponse> => {
    agents.descriptor(request.params.agentId);
    const items = await agentModelOptions(request.params.agentId, dependencies.codexModelOptions ?? (async () => []));
    return { models: items.map((item) => item.id), items };
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
