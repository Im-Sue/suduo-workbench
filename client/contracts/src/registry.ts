import type { AgentRuntime } from "./runtime.js";

export interface RuntimeRegistry {
  register(runtime: AgentRuntime): void;
  get(runtimeId: string): AgentRuntime;
  /** 已注册的全部运行时（多 Agent：每个运行时一条消费循环）。 */
  list(): AgentRuntime[];
  /** 驱动这家 Agent 的运行时；没有注册时返回 null（ADR-0014）。 */
  findByAgent(agentId: string): AgentRuntime | null;
}
