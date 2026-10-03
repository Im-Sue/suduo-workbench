import type {
  RuntimeRegistry as RuntimeRegistryContract,
  RuntimeToolSpec,
  StartThreadResult,
} from "@suduo/client-contracts";
import type { SessionRecord } from "../infrastructure/db/repositories/session-repository.js";
import type { SessionThreadRecord } from "../infrastructure/db/repositories/session-thread-repository.js";
import { ApiError, IndeterminateOperationError } from "./api-error.js";
import { sessionSecurityPolicy } from "./approval-mode-cap.js";
import type { WorkspaceContext } from "./workspace-context.js";

export class RuntimeSupervisor {
  private readonly readyThreads = new Set<string>();
  private readonly readiness = new Map<string, Promise<void>>();

  constructor(
    private readonly runtimes: RuntimeRegistryContract,
    private readonly approvalModeEnvironment: NodeJS.ProcessEnv = process.env,
  ) {}

  async createPrimaryThread(input: {
    runtimeId: string;
    session: SessionRecord;
    workspace: WorkspaceContext;
    /** 系统级业务指令（如需求卡）；仅新建 thread 需要。 */
    developerInstructions?: string;
    /** 挂到线程上的 SuDuo 工具（ADR-0008）；仅新建 thread 需要，续接时 Codex 自己恢复。 */
    dynamicTools?: RuntimeToolSpec[];
  }): Promise<StartThreadResult> {
    const runtime = this.getRuntime(input.runtimeId);
    try {
      return await runtime.startThread({
        mode: "create",
        sessionId: input.session.id,
        projectRoot: input.workspace.executionRoot,
        workspaceRoots: [input.workspace.executionRoot],
        security: sessionSecurityPolicy(input.session, this.approvalModeEnvironment),
        ...(input.developerInstructions === undefined
          ? {}
          : { developerInstructions: input.developerInstructions }),
        ...(input.dynamicTools === undefined ? {} : { dynamicTools: input.dynamicTools }),
      });
    } catch (error) {
      throw new IndeterminateOperationError(
        "创建 runtime thread 的结果不确定",
        { cause: error },
      );
    }
  }

  async ensureReady(input: {
    session: SessionRecord;
    workspace: WorkspaceContext;
    binding: SessionThreadRecord;
  }): Promise<void> {
    const key = threadKey(input.binding.threadRef.runtimeId, input.binding.threadRef.threadId);
    if (this.readyThreads.has(key)) {
      return;
    }
    const existing = this.readiness.get(key);
    if (existing) {
      await existing;
      return;
    }
    const operation = this.resume(input, key);
    this.readiness.set(key, operation);
    try {
      await operation;
    } finally {
      this.readiness.delete(key);
    }
  }

  /**
   * ensureReady 的自愈版：resume 失败（rollout 缺失/损坏）时重建全新 thread。
   * 返回 null=原 thread 可用；返回 StartThreadResult=已重建，调用方负责改绑与入账。
   * 重建也失败则抛出原始 resume 错误（说明 runtime 本身不可用）。
   */
  async ensureReadyOrRebuild(input: {
    session: SessionRecord;
    workspace: WorkspaceContext;
    binding: SessionThreadRecord;
    /**
     * 重建是全新 thread（历史丢失），需求会话要重新给需求卡与工具。只在真的要重建时
     * 才调用（生成需求卡要查远程）。
     */
    rebuildSetup?: () => Promise<{ developerInstructions?: string; dynamicTools?: RuntimeToolSpec[] } | null>;
  }): Promise<StartThreadResult | null> {
    try {
      await this.ensureReady(input);
      return null;
    } catch (resumeError) {
      let rebuilt: StartThreadResult;
      try {
        const setup = (await input.rebuildSetup?.().catch(() => null)) ?? null;
        const runtime = this.getRuntime(input.binding.threadRef.runtimeId);
        rebuilt = await runtime.startThread({
          mode: "create",
          sessionId: input.session.id,
          projectRoot: input.workspace.executionRoot,
          workspaceRoots: [input.workspace.executionRoot],
          security: sessionSecurityPolicy(input.session, this.approvalModeEnvironment),
          ...(setup?.developerInstructions === undefined
            ? {}
            : { developerInstructions: setup.developerInstructions }),
          ...(setup?.dynamicTools === undefined ? {} : { dynamicTools: setup.dynamicTools }),
        });
      } catch {
        throw resumeError;
      }
      this.markReady(rebuilt);
      return rebuilt;
    }
  }

  markReady(result: StartThreadResult): void {
    for (const thread of result.threads) {
      this.readyThreads.add(
        threadKey(thread.threadRef.runtimeId, thread.threadRef.threadId),
      );
    }
  }

  markUnavailable(runtimeId: string): void {
    for (const key of [...this.readyThreads]) {
      if (key.startsWith(runtimeId + ":")) {
        this.readyThreads.delete(key);
      }
    }
  }

  private getRuntime(runtimeId: string) {
    try {
      return this.runtimes.get(runtimeId);
    } catch (error) {
      throw new ApiError(
        503,
        "RUNTIME_UNAVAILABLE",
        "runtime 不可用: " + runtimeId,
        undefined,
        { cause: error },
      );
    }
  }

  private async resume(
    input: {
      session: SessionRecord;
      workspace: WorkspaceContext;
      binding: SessionThreadRecord;
    },
    key: string,
  ): Promise<void> {
    const runtime = this.getRuntime(input.binding.threadRef.runtimeId);
    try {
      await runtime.startThread({
        mode: "resume",
        sessionId: input.session.id,
        threadRef: input.binding.threadRef,
        projectRoot: input.workspace.executionRoot,
        workspaceRoots: [input.workspace.executionRoot],
        security: sessionSecurityPolicy(input.session, this.approvalModeEnvironment),
      });
      this.readyThreads.add(key);
    } catch (error) {
      throw new IndeterminateOperationError("恢复 runtime thread 失败", {
        cause: error,
      });
    }
  }
}

function threadKey(runtimeId: string, threadId: string): string {
  return runtimeId + ":" + threadId;
}
