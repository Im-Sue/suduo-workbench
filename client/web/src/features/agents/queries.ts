import { queryOptions } from "@tanstack/react-query";
import type { AgentDto, AgentStatus } from "@suduo/client-contracts";
import { api } from "../../api/client.js";

export const localAgentsKey = ["local-agents"] as const;

/**
 * 本机 AI Agent 的列表与状态（多 Agent，ADR-0014）。服务端不等检测、先回「检测中」，
 * 这里在还有没检测完的 Agent 时每秒轮询一次，把状态补上。
 */
export const localAgentsQuery = queryOptions({
  queryKey: localAgentsKey,
  queryFn: () => api.listLocalAgents(),
  staleTime: 30_000,
  refetchInterval: (query) => (query.state.data?.agents.some((agent) => agent.status === "checking") === true ? 1_000 : false),
});

export const agentModelsQuery = (agentId: string) =>
  queryOptions({
    queryKey: ["agent-models", agentId] as const,
    queryFn: () => api.agentModels(agentId),
    staleTime: 5 * 60_000,
  });

/** 能开工的状态：就绪，或已安装（登录状态第一次开工时确认）。 */
const USABLE: ReadonlySet<AgentStatus> = new Set(["ready", "installed"]);

export function isUsable(agent: AgentDto): boolean {
  return agent.runtimeAvailable && agent.enabled && USABLE.has(agent.status);
}

/** 上次开工用的 Agent（只是本机的便利记忆，读写失败就当没有）。 */
const LAST_AGENT_KEY = "suduo.lastAgentId";

export function lastAgentId(): string | null {
  try {
    return window.localStorage.getItem(LAST_AGENT_KEY);
  } catch {
    return null;
  }
}

export function rememberAgent(agentId: string): void {
  try {
    window.localStorage.setItem(LAST_AGENT_KEY, agentId);
  } catch {
    // 存不了就算了：下次按默认 Agent 选。
  }
}

/** 开工时默认选哪家：上次用的（还能用的话）→ 设置里的默认 → 第一家能用的。 */
export function preferredAgent(agents: readonly AgentDto[], defaultAgentId: string, last: string | null = lastAgentId()): AgentDto | null {
  const usable = agents.filter(isUsable);
  return usable.find((agent) => agent.id === last) ?? usable.find((agent) => agent.id === defaultAgentId) ?? usable[0] ?? null;
}
