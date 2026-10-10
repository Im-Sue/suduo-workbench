import type {
  AgentRuntime,
  RuntimeRegistry as RuntimeRegistryContract,
} from "@suduo/client-contracts";

export class RuntimeRegistry implements RuntimeRegistryContract {
  private readonly runtimes = new Map<string, AgentRuntime>();

  register(runtime: AgentRuntime): void {
    if (this.runtimes.has(runtime.runtimeId)) {
      throw new Error("duplicate runtime id: " + runtime.runtimeId);
    }
    const agentId = agentIdOf(runtime);
    for (const existing of this.runtimes.values()) {
      if (agentIdOf(existing) === agentId) {
        throw new Error("duplicate runtime for agent: " + agentId);
      }
    }
    this.runtimes.set(runtime.runtimeId, runtime);
  }

  get(runtimeId: string): AgentRuntime {
    const runtime = this.runtimes.get(runtimeId);
    if (!runtime) {
      throw new Error("runtime not registered: " + runtimeId);
    }
    return runtime;
  }

  list(): AgentRuntime[] {
    return [...this.runtimes.values()];
  }

  findByAgent(agentId: string): AgentRuntime | null {
    for (const runtime of this.runtimes.values()) {
      if (agentIdOf(runtime) === agentId) {
        return runtime;
      }
    }
    return null;
  }
}

/** 运行时驱动的 Agent：显式声明的 agentId；老的 Codex 运行时没写时按 runtimeKind 视为 codex。 */
export function agentIdOf(runtime: AgentRuntime): string {
  return runtime.agentId ?? (runtime.runtimeKind === "codex" ? "codex" : runtime.runtimeKind);
}
