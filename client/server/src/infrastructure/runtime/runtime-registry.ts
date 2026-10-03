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
    this.runtimes.set(runtime.runtimeId, runtime);
  }

  get(runtimeId: string): AgentRuntime {
    const runtime = this.runtimes.get(runtimeId);
    if (!runtime) {
      throw new Error("runtime not registered: " + runtimeId);
    }
    return runtime;
  }
}
