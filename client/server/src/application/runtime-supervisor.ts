import {
  SUDUO_MCP_TOOL_TIMEOUT_SEC,
  type AgentRuntime,
  type JsonValue,
  type RuntimeRegistry as RuntimeRegistryContract,
  type RuntimeThread,
  type RuntimeToolServer,
  type RuntimeToolSpec,
  type StartThreadResult,
} from "@suduo/client-contracts";
import type { ToolTokenRegistry } from "../infrastructure/mcp/tool-tokens.js";
import { AgentNotReadyError } from "../infrastructure/runtime/agent-not-ready.js";
import type { SessionRecord } from "../infrastructure/db/repositories/session-repository.js";
import type { SessionThreadRecord } from "../infrastructure/db/repositories/session-thread-repository.js";
import { ApiError, IndeterminateOperationError } from "./api-error.js";
import { sessionRuntimeApprovalMode } from "./approval-mode-cap.js";
import type { WorkspaceContext } from "./workspace-context.js";

export class RuntimeSupervisor {
  private readonly readyThreads = new Set<string>();
  private readonly readiness = new Map<string, Promise<void>>();

  constructor(
    private readonly runtimes: RuntimeRegistryContract,
    private readonly approvalModeEnvironment: NodeJS.ProcessEnv = process.env,
    /**
     * SuDuo 本机 MCP 工具服务（ADR-0015）：令牌表与当前地址（本机服务还没监听时为 null）。
     * 不传时一律走 dynamicTools（测试与老调用方）。
     */
    private readonly toolServer: { tokens: ToolTokenRegistry; url: () => string | null } | null = null,
  ) {}

  /**
   * 这次建线程用哪种工具通道（ADR-0015）：运行时支持且工具服务在线时签令牌走 MCP（令牌授予这份工具清单），
   * 否则沿用 dynamicTools。没有工具（项目没关联等）时什么都不挂。
   */
  private toolChannel(
    runtime: AgentRuntime,
    sessionId: string,
    dynamicTools: RuntimeToolSpec[] | undefined,
  ): { params: { toolServer?: RuntimeToolServer; dynamicTools?: RuntimeToolSpec[] }; mcpTools: string[] | null } {
    if (dynamicTools === undefined || dynamicTools.length === 0) {
      return { params: dynamicTools === undefined ? {} : { dynamicTools }, mcpTools: null };
    }
    const toolNames = dynamicTools.map((tool) => tool.name);
    const toolServer = runtime.supportsToolServer === true ? this.issueToolServer(sessionId, toolNames) : null;
    return toolServer === null
      ? { params: { dynamicTools }, mcpTools: null }
      : { params: { toolServer }, mcpTools: toolNames };
  }

  /** 工具服务在线时给会话签令牌（作废旧的）；没在监听时返回 null。 */
  private issueToolServer(sessionId: string, toolNames: readonly string[]): RuntimeToolServer | null {
    const url = this.toolServer?.url() ?? null;
    if (this.toolServer === null || url === null) {
      return null;
    }
    return {
      url,
      token: this.toolServer.tokens.issue(sessionId, toolNames, SUDUO_MCP_TOOL_TIMEOUT_SEC),
      toolTimeoutSec: SUDUO_MCP_TOOL_TIMEOUT_SEC,
    };
  }

  /**
   * 驱动这家 Agent 的运行时 id（ADR-0014）。没有注册（配置表里有、但这个版本还没接上它的通道，
   * 或 Agent 不存在）时报 400，让调用方说清楚是哪家 Agent 用不了。
   */
  runtimeIdForAgent(agentId: string): string {
    const runtime = this.runtimes.findByAgent(agentId);
    if (!runtime) {
      throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.agentUnavailable(agentId));
    }
    return runtime.runtimeId;
  }

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
    const tools = this.toolChannel(runtime, input.session.id, input.dynamicTools);
    try {
      const started = await runtime.startThread({
        mode: "create",
        sessionId: input.session.id,
        projectRoot: input.workspace.executionRoot,
        workspaceRoots: [input.workspace.executionRoot],
        approvalMode: sessionRuntimeApprovalMode(input.session, this.approvalModeEnvironment),
        ...(input.developerInstructions === undefined
          ? {}
          : { developerInstructions: input.developerInstructions }),
        ...tools.params,
      });
      return tools.mcpTools === null ? started : markToolChannel(started, tools.mcpTools);
    } catch (error) {
      if (error instanceof AgentNotReadyError) {
        throw agentNotReady(error);
      }
      throw new IndeterminateOperationError(
        (t) => t.session.threadCreateIndeterminate,
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
        const tools = this.toolChannel(runtime, input.session.id, setup?.dynamicTools);
        rebuilt = await runtime.startThread({
          mode: "create",
          sessionId: input.session.id,
          projectRoot: input.workspace.executionRoot,
          workspaceRoots: [input.workspace.executionRoot],
          approvalMode: sessionRuntimeApprovalMode(input.session, this.approvalModeEnvironment),
          ...(setup?.developerInstructions === undefined
            ? {}
            : { developerInstructions: setup.developerInstructions }),
          ...tools.params,
        });
        if (tools.mcpTools !== null) {
          rebuilt = markToolChannel(rebuilt, tools.mcpTools);
        }
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
        (t) => t.session.runtimeUnavailable(runtimeId),
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
    // 用 MCP 的线程续接时按记下的工具清单重签令牌并重新注入（ADR-0015）；老线程的 dynamicTools 由 Codex 自己恢复。
    const toolNames = toolServerTools(input.binding.metadata);
    const toolServer = toolNames === null ? null : this.issueToolServer(input.session.id, toolNames);
    if (toolNames !== null && toolServer === null) {
      // 工具服务还没在监听：现在续接会挂不上工具，而续接过的线程之后不会再续接。先不续接、不记为就绪，
      // 下次用到时再来（不抛错：抛错会让发消息那条路改为重建线程、丢掉历史）。
      return;
    }
    // 说明不进 Agent 自己会话记录的运行时（Claude 的系统提示追加）把说明记在线程元数据里，续接时带回去。
    const instructions = recordedInstructions(input.binding.metadata);
    try {
      await runtime.startThread({
        mode: "resume",
        sessionId: input.session.id,
        threadRef: input.binding.threadRef,
        projectRoot: input.workspace.executionRoot,
        workspaceRoots: [input.workspace.executionRoot],
        approvalMode: sessionRuntimeApprovalMode(input.session, this.approvalModeEnvironment),
        ...(toolServer === null ? {} : { toolServer }),
        ...(instructions === null ? {} : { developerInstructions: instructions }),
      });
      this.readyThreads.add(key);
    } catch (error) {
      throw new IndeterminateOperationError((t) => t.session.threadResumeFailed, {
        cause: error,
      });
    }
  }
}

function threadKey(runtimeId: string, threadId: string): string {
  return runtimeId + ":" + threadId;
}

/**
 * 线程元数据里记下「用 SuDuo MCP 工具服务」与这个线程的工具清单，续接时据此重签令牌
 * （相当于 Codex 把 dynamicTools 存在线程里）。老线程没有这个标记。
 */
const TOOL_CHANNEL_KEY = "suDuoToolChannel";
const TOOL_NAMES_KEY = "suDuoTools";

/** 线程用 MCP 工具服务时返回它的工具清单，否则 null。 */
export function toolServerTools(metadata: JsonValue): string[] | null {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata) || metadata[TOOL_CHANNEL_KEY] !== "mcp") {
    return null;
  }
  const names = metadata[TOOL_NAMES_KEY];
  return Array.isArray(names) ? names.filter((name): name is string => typeof name === "string") : null;
}

/** 运行时记在线程元数据里的 SuDuo 说明（Claude 运行时用 suDuoInstructions 键）。 */
function recordedInstructions(metadata: JsonValue): string | null {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = metadata["suDuoInstructions"];
  return typeof value === "string" && value !== "" ? value : null;
}

export function usesToolServer(metadata: JsonValue): boolean {
  return toolServerTools(metadata) !== null;
}

function markToolChannel(result: StartThreadResult, toolNames: string[]): StartThreadResult {
  const mark = (thread: RuntimeThread): RuntimeThread => ({
    ...thread,
    metadata: {
      ...(thread.metadata !== null && typeof thread.metadata === "object" && !Array.isArray(thread.metadata) ? thread.metadata : {}),
      [TOOL_CHANNEL_KEY]: "mcp",
      [TOOL_NAMES_KEY]: toolNames,
    },
  });
  const primaryId = result.primaryThread.threadRef.threadId;
  return {
    primaryThread: mark(result.primaryThread),
    threads: result.threads.map((thread) => (thread.threadRef.threadId === primaryId ? mark(thread) : thread)),
  };
}

/** Agent 没装或没登录：400 说明原因（前置条件不满足），details 带 agentId 与 reason 给界面做修复入口。 */
export function agentNotReady(error: AgentNotReadyError): ApiError {
  return new ApiError(
    400,
    "AGENT_NOT_READY",
    (t) => (error.reason === "auth_required" ? t.session.agentAuthRequired(error.agentName) : t.session.agentNotInstalled(error.agentName)),
    { agentId: error.agentId, reason: error.reason },
    { cause: error },
  );
}
