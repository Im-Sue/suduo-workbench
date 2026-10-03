import type { AgentRuntime } from "./runtime.js";

export interface RuntimeRegistry {
  register(runtime: AgentRuntime): void;
  get(runtimeId: string): AgentRuntime;
}
