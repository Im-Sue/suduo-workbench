import { randomUUID } from "node:crypto";
import type {
  RuntimeToolServer,
  AgentRuntime,
  ApproveInput,
  ApproveResult,
  CodexModelOptionDto,
  CodexTransportFactory,
  InterruptInput,
  JsonRpcId,
  JsonValue,
  Locale,
  RespondToolCallInput,
  RpcConnection,
  RuntimeEventDraft,
  RuntimeNoticePayload,
  RuntimeSecurityPolicy,
  RuntimeSkill,
  RuntimeSubscribeOptions,
  StartThreadInput,
  StartThreadResult,
  StartTurnInput,
  StartTurnResult,
  ThreadRef,
} from "@suduo/client-contracts";
import { RUNTIME_APPROVAL_MODE_POLICIES, SUDUO_MCP_SERVER_NAME } from "@suduo/client-contracts";
import {
  isApprovalServerRequest,
  mapApprovalDecision,
  normalizeApprovalRequest,
  type PendingNativeApproval,
} from "./codex-approval-mapper.js";
import {
  extractThreadRef,
  extractTurnRef,
  normalizeCodexNotification,
} from "./codex-event-normalizer.js";
import { mapRuntimeInputs } from "./codex-input-mapper.js";
import { withLoopbackNoProxy } from "../../mcp/loopback-no-proxy.js";
import {
  CodexThreadModelTracker,
  createCodexModelDefaults,
  parseCodexModelCatalog,
  type CodexModelDefaults,
} from "./codex-model-overrides.js";
import { initializeCodexConnection } from "../../transport/stdio-codex-transport.js";
import { StdioRpcConnection } from "../../transport/rpc-connection.js";
import { messagesFor } from "../../../i18n/messages/index.js";

/**
 * Windows 下 PowerShell 5.1 的 Get-Content/Out-File 默认按系统 ANSI 代码页读写，
 * 读 UTF-8 中文文件会得到乱码（模型连自己的 SKILL.md 都会读花）。
 * 这里通过 developerInstructions 让模型显式指定 UTF-8，避免要求用户改系统区域设置。
 * 和需求卡一样按会话的语言写（中英双语 S7）；不是 Windows 时为 null。
 */
export function windowsEncodingInstructions(locale: Locale, platform: NodeJS.Platform = process.platform): string | null {
  return platform === "win32" ? messagesFor(locale).roomPrompt.runtime.windowsEncoding : null;
}

/**
 * 会话记下的语言查不到时用中文：迁移 017 之前的会话都是中文（与 sessions.locale 的默认值一致），
 * 也是未注入 `sessionLocale` 时（测试）的旧行为。
 */
const DEFAULT_SESSION_LOCALE: Locale = "zh-CN";

/** 全局默认模型 / 强度的缓存时长；配置写入与重连会提前清空。 */
const MODEL_DEFAULTS_TTL_MS = 60_000;

/** 会影响「全局默认模型 / 推理强度」的配置键前缀（model、model_reasoning_effort、model_provider(s)、profile(s)）。 */
const MODEL_DEFAULT_KEY_PREFIXES = ["model", "profile"] as const;

export interface CodexRuntimeOptions {
  transport: CodexTransportFactory;
  codexBin: string;
  env?: Record<string, string>;
  runtimeId?: string;
  /**
   * 会话的语言（`sessions.locale`）：回给 Codex 的说明（Windows 编码说明、「不支持」的报错）按它写。
   * 不传或查不到时按中文。
   */
  sessionLocale?: (sessionId: string) => Locale | null;
  /** 本机平台，默认 `process.platform`（测试用）。 */
  platform?: NodeJS.Platform;
}

export class CodexRuntime implements AgentRuntime {
  readonly runtimeId: string;
  readonly runtimeKind = "codex";
  /** 能接 SuDuo 本机 MCP 工具服务（ADR-0015，S0 实测：线程级配置覆盖注入、续接换令牌都成立）。 */
  readonly supportsToolServer = true;
  private readonly transport: CodexTransportFactory;
  private readonly codexBin: string;
  private readonly env: Record<string, string>;
  private readonly connectionAbort = new AbortController();
  private readonly sessionLocale: ((sessionId: string) => Locale | null) | null;
  private readonly platform: NodeJS.Platform;
  private readonly threadSessions = new Map<string, string>();
  /**
   * 这条连接上已加载的线程，与它们建线程 / 续接时的参数（多 Agent S5）。Codex 对已加载的线程再 resume
   * 不会套用新的线程级配置（实测：令牌、关掉 MCP 都不生效），要先 thread/unsubscribe 让它卸载再 resume。
   */
  private readonly loadedThreads = new Map<string, { connectionId: string; input: StartThreadInput; readonly: boolean }>();
  /** 被我们卸载、还没续接成功的线程（续接失败时下个回合再续）：线程 id → 连接 id 与续接参数。 */
  private readonly unloadedThreads = new Map<string, { connectionId: string; input: StartThreadInput }>();
  private readonly pendingApprovals = new Map<string, PendingNativeApproval>();
  /** 还没回包的客户端自定义工具调用（ADR-0008），按 callRef 索引。 */
  private readonly pendingToolCalls = new Map<string, PendingToolCall>();
  private connection: RpcConnection | null = null;
  private extraSkillRoots: string[] = [];
  private connectionPromise: Promise<RpcConnection> | null = null;
  private pendingSessionId: string | null = null;
  private inboundOrdinal = 0;
  /** 会话级模型 / 推理强度的粘性覆盖追踪（按线程记上次实际下发的值）。 */
  private readonly threadModels = new CodexThreadModelTracker();
  private modelDefaultsCache: {
    key: string;
    at: number;
    value: Promise<CodexModelDefaults | null>;
  } | null = null;

  constructor(options: CodexRuntimeOptions) {
    this.runtimeId = options.runtimeId ?? "codex-local";
    this.transport = options.transport;
    this.codexBin = options.codexBin;
    this.env = options.env ?? currentEnvironment();
    this.sessionLocale = options.sessionLocale ?? null;
    this.platform = options.platform ?? process.platform;
  }

  async startThread(input: StartThreadInput): Promise<StartThreadResult> {
    const security = RUNTIME_APPROVAL_MODE_POLICIES[input.approvalMode];
    assertM1SecurityPolicy(security);
    const connection = await this.ensureConnection();
    if (input.mode === "resume" && this.loadedThreads.get(input.threadRef.threadId)?.connectionId === connection.connectionId) {
      // 这条连接上已加载：先卸载，新的令牌与 MCP 开关才会生效。
      await connection.request("thread/unsubscribe", { threadId: input.threadRef.threadId }, { timeoutMs: 10_000 }).catch((error: unknown) => {
        console.warn(JSON.stringify({ event: "codex.thread_unsubscribe_failed", threadId: input.threadRef.threadId, message: String(error) }));
      });
      this.loadedThreads.delete(input.threadRef.threadId);
      this.unloadedThreads.set(input.threadRef.threadId, { connectionId: connection.connectionId, input });
    }
    this.pendingSessionId = input.sessionId;
    try {
      // 上层业务指令（如需求包摘要）与本机环境指令（Windows 编码，按会话的语言）合并下发。
      const developerInstructions = [
        input.developerInstructions,
        windowsEncodingInstructions(this.localeOfSession(input.sessionId), this.platform),
      ]
        .filter((part): part is string => typeof part === "string" && part !== "")
        .join("\n\n");
      const common = {
        cwd: input.projectRoot,
        runtimeWorkspaceRoots: input.workspaceRoots,
        approvalPolicy: security.approvalPolicy,
        approvalsReviewer: security.approvalsReviewer,
        sandbox: security.sandbox.mode,
        ...(developerInstructions === "" ? {} : { developerInstructions }),
        // 房间 Agent 档（关掉所有者的 MCP）与 SuDuo 工具服务：建线程与续接都要带（续接不带的话 MCP 会重新启动）。
        ...threadConfig(
          input.approvalMode === "readonly" ? await this.externalToolsOff(connection, input.projectRoot) : null,
          input.toolServer ?? null,
        ),
      };
      const result = await connection.request(
        input.mode === "create" ? "thread/start" : "thread/resume",
        input.mode === "create"
          ? { ...common, ...dynamicToolsParam(input.dynamicTools) }
          : {
              ...common,
              threadId: input.threadRef.threadId,
              initialTurnsPage: {
                limit: 10,
                itemsView: "summary",
              },
            },
        {
          timeoutMs: 30_000,
        },
      );
      const resultObject = requireObject(result, "thread response");
      const thread = requireObject(resultObject["thread"], "thread");
      const threadId = requireString(thread["id"], "thread.id");
      const threadRef = this.threadRef(threadId);
      this.threadSessions.set(threadId, input.sessionId);
      this.loadedThreads.set(threadId, { connectionId: connection.connectionId, input, readonly: input.approvalMode === "readonly" });
      this.unloadedThreads.delete(threadId);
      // thread/start|resume 回报线程当前生效的模型与推理强度，作为粘性覆盖判断的起点。
      this.threadModels.recordThreadStart({
        connectionId: connection.connectionId,
        threadId,
        mode: input.mode,
        model: nonEmptyString(resultObject["model"]),
        effort: nonEmptyString(resultObject["reasoningEffort"]),
      });
      const runtimeThread = {
        threadRef,
        role: "primary",
        metadata: thread,
      };
      return {
        primaryThread: runtimeThread,
        threads: [runtimeThread],
      };
    } finally {
      this.pendingSessionId = null;
    }
  }

  async startTurn(input: StartTurnInput): Promise<StartTurnResult> {
    const security = RUNTIME_APPROVAL_MODE_POLICIES[input.approvalMode];
    assertM1SecurityPolicy(security);
    let connection = await this.ensureConnection();
    const loaded = this.loadedThreads.get(input.threadRef.threadId);
    const unloaded = this.unloadedThreads.get(input.threadRef.threadId);
    const reload =
      loaded !== undefined && loaded.connectionId === connection.connectionId && loaded.readonly !== (input.approvalMode === "readonly")
        ? loaded.input
        : unloaded !== undefined && unloaded.connectionId === connection.connectionId
          ? unloaded.input
          : null;
    if (reload !== null) {
      // 跨了只读：所有者的 MCP 与连接器在只读时要关、回来要开，这是线程级配置，只能卸载后重新续接才生效。
      // 上次卸载后续接失败的线程也在这里续上。
      await this.startThread({ ...reload, mode: "resume", threadRef: input.threadRef, approvalMode: input.approvalMode });
      connection = await this.ensureConnection();
    }
    this.threadSessions.set(input.threadRef.threadId, input.sessionId);
    const modelPlan = await this.threadModels.plan({
      connectionId: connection.connectionId,
      threadId: input.threadRef.threadId,
      model: input.model,
      effort: input.reasoningEffort,
      loadDefaults: () => this.resolveModelDefaults(connection, input.projectRoot),
    });
    for (const warning of modelPlan.warnings) {
      console.warn(JSON.stringify({
        event: "codex.turn_model_default_unresolved",
        sessionId: input.sessionId,
        threadId: input.threadRef.threadId,
        message: warning,
      }));
    }
    const overrides = modelPlan.overrides;
    let result: JsonValue;
    try {
      result = await connection.request(
        "turn/start",
        {
          threadId: input.threadRef.threadId,
          clientUserMessageId: input.clientTurnId,
          input: mapRuntimeInputs(input.input),
          cwd: input.projectRoot,
          runtimeWorkspaceRoots: input.workspaceRoots,
          // 审批与沙箱每回合都显式下发，粘性覆盖始终等于会话当前审批档。
          approvalPolicy: security.approvalPolicy,
          approvalsReviewer: security.approvalsReviewer,
          sandboxPolicy:
            security.sandbox.mode === "danger-full-access"
              ? { type: "dangerFullAccess" }
              : {
                  type: sandboxPolicyType(security.sandbox.mode),
                  networkAccess: security.sandbox.networkAccess,
                },
          // 模型 / 推理强度只在需要改变线程现值时下发（见 CodexThreadModelTracker）。
          ...(overrides.model === undefined ? {} : { model: overrides.model }),
          ...(overrides.effort === undefined ? {} : { effort: overrides.effort }),
        },
        {
          timeoutMs: 180_000,
        },
      );
    } catch (error) {
      this.threadModels.markUncertain(
        connection.connectionId,
        input.threadRef.threadId,
        overrides,
      );
      throw error;
    }
    this.threadModels.recordSent(
      connection.connectionId,
      input.threadRef.threadId,
      overrides,
    );
    const turn = requireObject(
      requireObject(result, "turn response")["turn"],
      "turn",
    );
    return {
      turnRef: {
        threadId: input.threadRef.threadId,
        turnId: requireString(turn["id"], "turn.id"),
      },
      acceptedAt: Date.now(),
    };
  }

  async approve(input: ApproveInput): Promise<ApproveResult> {
    const connection = await this.ensureConnection();
    const pending = this.pendingApprovals.get(input.approvalRef);
    if (!pending) {
      throw new Error("Codex approvalRef is not pending: " + input.approvalRef);
    }
    if (pending.connectionId !== connection.connectionId) {
      throw new Error("Codex approval belongs to a stale connection");
    }
    if (pending.threadRef.threadId !== input.threadRef.threadId) {
      throw new Error("Codex approval thread mismatch");
    }
    await connection.respond(
      pending.requestId,
      mapApprovalDecision(pending.nativeMethod, input.decision, pending.requestedPermissions),
    );
    this.pendingApprovals.delete(input.approvalRef);
    return { acknowledged: true };
  }

  isToolCallPending(callRef: string): boolean {
    const pending = this.pendingToolCalls.get(callRef);
    return pending !== undefined && this.connection?.connectionId === pending.connectionId;
  }

  async respondToolCall(input: RespondToolCallInput): Promise<{ delivered: boolean }> {
    const pending = this.pendingToolCalls.get(input.callRef);
    if (!pending) {
      return { delivered: false };
    }
    // 先摘掉再回包：Codex 收到回包后会发 serverRequest/resolved，不能再被当成「撤回」。
    this.pendingToolCalls.delete(input.callRef);
    const connection = this.connection;
    if (!connection || connection.connectionId !== pending.connectionId) {
      return { delivered: false };
    }
    await connection.respond(pending.requestId, {
      contentItems: input.contentItems,
      success: input.success,
    });
    return { delivered: true };
  }

  async interrupt(input: InterruptInput): Promise<void> {
    const connection = await this.ensureConnection();
    await connection.request(
      "turn/interrupt",
      {
        threadId: input.threadRef.threadId,
        turnId: input.turnId,
      },
      {
        timeoutMs: 20_000,
      },
    );
  }

  async *subscribe(
    options: RuntimeSubscribeOptions,
  ): AsyncIterable<RuntimeEventDraft> {
    const connection = await this.ensureConnection();
    let connectionFailed = false;
    try {
      for await (const message of connection.messages({
        signal: options.signal,
      })) {
        this.inboundOrdinal += 1;
        if (message.kind === "response") {
          continue;
        }
        if (isApprovalServerRequest(message)) {
          const threadRef = extractThreadRef(this.runtimeId, message.params);
          if (!threadRef) {
            // 同样要回包，免得 Codex 一直等：认不出属于哪个会话的审批按拒绝处理。
            // 认不出会话也就拿不到会话的语言，写英文。
            await answerWithError(connection, message.id, -32602, "SuDuo can't tell which session this approval request belongs to");
            yield this.runtimeErrorEvent(
              connection.connectionId,
              "approval request missing thread reference",
            );
            continue;
          }
          const approvalRef = randomUUID();
          const normalized = normalizeApprovalRequest({
            message,
            approvalRef,
            connectionId: connection.connectionId,
          });
          this.pendingApprovals.set(approvalRef, {
            approvalRef,
            connectionId: connection.connectionId,
            requestId: message.id,
            nativeMethod: message.method,
            threadRef,
            ...(message.method === "item/permissions/requestApproval"
              ? { requestedPermissions: asRecord(message.params)["permissions"] ?? {} }
              : {}),
          });
          yield {
            source: "runtime:" + this.runtimeId,
            type: "approval.requested",
            payload: normalized.payload,
            threadRef,
            turnRef: extractTurnRef(message.params),
            ts: Date.now(),
            dedupeKey:
              connection.connectionId + ":" + String(this.inboundOrdinal),
            ...this.sessionHintFor(threadRef.threadId),
          };
          continue;
        }
        if (message.kind === "server-request" && message.method === "item/tool/call") {
          const params = asRecord(message.params);
          const threadRef = extractThreadRef(this.runtimeId, message.params);
          if (!threadRef) {
            await answerWithError(connection, message.id, -32602, "SuDuo can't tell which session this tool call belongs to");
            yield this.runtimeErrorEvent(
              connection.connectionId,
              "tool call request missing thread reference",
            );
            continue;
          }
          const callRef = randomUUID();
          const turnId = typeof params["turnId"] === "string" ? params["turnId"] : null;
          this.pendingToolCalls.set(callRef, {
            callRef,
            connectionId: connection.connectionId,
            requestId: message.id,
            threadRef,
          });
          yield {
            source: "runtime:" + this.runtimeId,
            type: "tool.call-requested",
            payload: {
              callRef,
              connectionId: connection.connectionId,
              requestId: String(message.id),
              callId: typeof params["callId"] === "string" ? params["callId"] : callRef,
              turnId,
              tool: typeof params["tool"] === "string" ? params["tool"] : "",
              arguments: params["arguments"] ?? null,
            },
            threadRef,
            turnRef: extractTurnRef(message.params),
            ts: Date.now(),
            dedupeKey: connection.connectionId + ":" + String(this.inboundOrdinal),
            ...this.sessionHintFor(threadRef.threadId),
          };
          continue;
        }
        if (message.kind === "server-request") {
          const requestThreadRef = extractThreadRef(this.runtimeId, message.params);
          const answered = await answerServerRequest(
            connection,
            message.id,
            message.method,
            this.localeOfThread(requestThreadRef?.threadId),
          );
          if (!answered) {
            // 回了「不支持」：在时间线上说一声，免得用户不知道 Codex 的提问 / 确认被跳过了。
            // 前端按 code + 方法名用看的人的语言渲染；message 是给旧客户端的英文兜底。
            yield {
              source: "runtime:" + this.runtimeId,
              type: "runtime.warning",
              payload: {
                code: "unsupported-request",
                message: unsupportedRequestNotice(message.method),
                params: { method: message.method },
              } satisfies RuntimeNoticePayload,
              threadRef: requestThreadRef,
              turnRef: extractTurnRef(message.params),
              ts: Date.now(),
              dedupeKey: connection.connectionId + ":" + String(this.inboundOrdinal) + ":unsupported",
              ...this.sessionHintFor(requestThreadRef?.threadId),
            };
          }
          yield {
            source: "runtime:" + this.runtimeId,
            type: "runtime.unknown",
            payload: {
              nativeType: message.method,
              requestId: String(message.id),
              params: message.params ?? null,
            },
            threadRef: extractThreadRef(this.runtimeId, message.params),
            turnRef: extractTurnRef(message.params),
            ts: Date.now(),
            dedupeKey:
              connection.connectionId + ":" + String(this.inboundOrdinal),
            ...this.sessionHintFor(
              extractThreadRef(this.runtimeId, message.params)?.threadId,
            ),
          };
          continue;
        }
        const threadRef = extractThreadRef(this.runtimeId, message.params);
        if (message.method === "serverRequest/resolved") {
          // Codex 撤回了一个还没回包的工具调用（回合被中断等）：通知上层作废确认卡。
          const requestId = String(asRecord(message.params)["requestId"] ?? "");
          for (const [callRef, pending] of this.pendingToolCalls) {
            if (
              pending.connectionId === connection.connectionId &&
              String(pending.requestId) === requestId
            ) {
              this.pendingToolCalls.delete(callRef);
              yield {
                source: "runtime:" + this.runtimeId,
                type: "tool.call-cancelled",
                // 原因只记进账本（approval.orphaned），界面不显示。
                payload: { callRef, reason: "Codex withdrew this tool call" },
                threadRef: pending.threadRef,
                turnRef: null,
                ts: Date.now(),
                dedupeKey: connection.connectionId + ":" + String(this.inboundOrdinal) + ":tool-cancelled",
                ...this.sessionHintFor(pending.threadRef.threadId),
              };
            }
          }
        }
        if (message.method === "thread/settings/updated" && threadRef) {
          const settings = asRecord(asRecord(message.params)["threadSettings"]);
          this.threadModels.recordSettings({
            connectionId: connection.connectionId,
            threadId: threadRef.threadId,
            model: settings["model"],
            effort: settings["effort"],
          });
        }
        yield normalizeCodexNotification({
          runtimeId: this.runtimeId,
          connectionId: connection.connectionId,
          ordinal: this.inboundOrdinal,
          message,
          ...this.sessionHintFor(threadRef?.threadId, !THREADLESS_NOTIFICATIONS.has(message.method)),
        });
      }
    } catch (error) {
      connectionFailed = true;
      if (!options.signal.aborted) {
        yield this.runtimeErrorEvent(
          connection.connectionId,
          error instanceof Error ? error.message : String(error),
        );
        // 连接异常断开（如 codex 进程被杀）：对每个受影响会话补发恢复事件。
        // 「会话已恢复」横幅只认 recovery-required——普通模型错误（429 等）
        // 不再触发横幅（2026-07-21 试点误报教训），因此这里必须显式发。
        for (const [threadId, sessionId] of this.threadSessions) {
          this.inboundOrdinal += 1;
          yield {
            source: "runtime:" + this.runtimeId,
            type: "runtime.recovery-required",
            // 前端按 code 用看的人的语言渲染；message 是给旧客户端的英文兜底。
            payload: {
              code: "connection-rebuilt",
              message: "The connection to Codex dropped and was re-established. A turn in progress may have been interrupted.",
            } satisfies RuntimeNoticePayload,
            threadRef: this.threadRef(threadId),
            turnRef: null,
            ts: Date.now(),
            dedupeKey:
              connection.connectionId + ":" + String(this.inboundOrdinal),
            sessionHint: sessionId,
          };
        }
      }
    } finally {
      if (
        connectionFailed &&
        this.connection === connection &&
        !options.signal.aborted
      ) {
        this.connection = null;
        this.pendingApprovals.clear();
        this.pendingToolCalls.clear();
      }
    }
  }

  restoreThreadBinding(threadRef: ThreadRef, sessionId: string): void {
    if (threadRef.runtimeId !== this.runtimeId) {
      throw new Error("cannot restore binding for another runtime");
    }
    this.threadSessions.set(threadRef.threadId, sessionId);
  }

  async close(): Promise<void> {
    this.connectionAbort.abort();
    const connection = this.connection;
    this.connection = null;
    if (connection) {
      await connection.close("CodexRuntime close");
    }
  }

  /**
   * 关闭当前连接但不终止 runtime（与 close 不同）：
   * 消费循环会自愈重建连接，新 codex 进程重读 CODEX_HOME 配置。
   * 用于模型服务配置变更后热生效；进行中的回合会被中断。
   */
  async restartConnection(reason: string): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    this.pendingApprovals.clear();
    this.pendingToolCalls.clear();
    this.modelDefaultsCache = null;
    if (connection) {
      await connection.close(reason);
    }
  }

  /**
   * 房间 Agent 档的线程配置覆盖（ADR-0009「只问答与规划、不挂写工具」）：所有者配置的 MCP server 不受
   * 只读沙箱限制，房间成员不能借共享 Agent 免审批调用它们，逐个关掉；连接器（apps）默认关，
   * 配置里单独开着的也逐个关。按生效配置（含项目级配置）取名字，用嵌套对象覆盖（Codex 深合并，
   * 名字里有点号也不会拆错；已用真实 Codex 0.159.2 验证建线程与续接都生效）。
   * 读不到配置就不建线程：确认不了已关掉，宁可这次任务失败（红线：不可逆对外副作用）。
   */
  private async externalToolsOff(connection: RpcConnection, cwd: string): Promise<Record<string, JsonValue>> {
    let servers: Record<string, JsonValue>;
    let apps: Record<string, JsonValue>;
    try {
      const result = requireObject(
        await connection.request("config/read", { includeLayers: false, cwd }, { timeoutMs: 20_000 }),
        "config/read response",
      );
      const config = requireObject(result["config"], "config/read config");
      servers = objectOrEmpty(config["mcp_servers"]);
      apps = objectOrEmpty(config["apps"]);
    } catch (error) {
      throw new Error(`Couldn't read the Codex config to confirm the owner's MCP tools are turned off: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
    const off = (names: string[]) => Object.fromEntries(names.map((name) => [name, { enabled: false }]));
    return {
      mcp_servers: off(Object.keys(servers)),
      apps: off(["_default", ...Object.keys(apps).filter((name) => name !== "_default")]),
    };
  }

  /** 官方 config/read 面；调用方可保留配置层与字段来源，而不是解析 config.toml。 */
  async configRead(input: {
    includeLayers: boolean;
    cwd?: string;
  }): Promise<{
    config: Record<string, JsonValue>;
    origins: Record<string, JsonValue>;
    layers: Array<{ name: JsonValue; version: string; config: JsonValue }>;
  }> {
    const connection = await this.ensureConnection();
    const result = requireObject(
      await connection.request(
        "config/read",
        {
          includeLayers: input.includeLayers,
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        },
        { timeoutMs: 20_000 },
      ),
      "config/read response",
    );
    const config = requireObject(result["config"], "config/read config");
    const origins = requireObject(result["origins"], "config/read origins");
    const layersValue = result["layers"];
    const layers = Array.isArray(layersValue)
      ? layersValue.map((layer) => {
          const item = requireObject(layer, "config/read layer");
          const version = requireString(item["version"], "config/read layer.version");
          if (!("name" in item) || !("config" in item)) {
            throw new Error("invalid Codex config/read layer");
          }
          return { name: item["name"], version, config: item["config"] };
        })
      : [];
    return { config, origins, layers };
  }

  /** 官方 config/batchWrite 面；以版本号保护并发写入。 */
  async configBatchWrite(input: {
    edits: Array<{
      keyPath: string;
      mergeStrategy: "replace" | "upsert";
      value: JsonValue;
    }>;
    expectedVersion: string;
    reloadUserConfig: boolean;
  }): Promise<{
    status: "ok" | "okOverridden";
    version: string;
    overriddenMetadata: {
      effectiveValue: JsonValue;
      message: string;
      overridingLayer: JsonValue;
    } | null;
  }> {
    const connection = await this.ensureConnection();
    const touchesModelDefaults = input.edits.some((edit) =>
      MODEL_DEFAULT_KEY_PREFIXES.some((prefix) => edit.keyPath.startsWith(prefix)),
    );
    let response: JsonValue;
    try {
      response = await connection.request(
        "config/batchWrite",
        input,
        { timeoutMs: 20_000 },
      );
    } finally {
      // 写入前后都可能有回合解析过默认值：写完（含失败 / 超时）再清，避免把旧配置缓存下来。
      this.modelDefaultsCache = null;
      if (touchesModelDefaults) {
        this.threadModels.markAllUnknown(connection.connectionId);
      }
    }
    const result = requireObject(response, "config/batchWrite response");
    const status = result["status"];
    if (status !== "ok" && status !== "okOverridden") {
      throw new Error("invalid Codex config/batchWrite status");
    }
    const overridden = result["overriddenMetadata"];
    let overriddenMetadata: {
      effectiveValue: JsonValue;
      message: string;
      overridingLayer: JsonValue;
    } | null = null;
    if (overridden !== null && overridden !== undefined) {
      const metadata = requireObject(
        overridden,
        "config/batchWrite overriddenMetadata",
      );
      const message = requireString(
        metadata["message"],
        "config/batchWrite overriddenMetadata.message",
      );
      if (!("effectiveValue" in metadata) || !("overridingLayer" in metadata)) {
        throw new Error("invalid Codex config/batchWrite overriddenMetadata");
      }
      overriddenMetadata = {
        effectiveValue: metadata["effectiveValue"],
        message,
        overridingLayer: metadata["overridingLayer"],
      };
    }
    return {
      status,
      version: requireString(result["version"], "config/batchWrite version"),
      overriddenMetadata,
    };
  }

  /** 官方 model/list 面；不接受也不暂存草稿凭据。 */
  async modelList(input: {
    cursor?: string;
    includeHidden?: boolean;
    limit?: number;
  } = {}): Promise<{ data: JsonValue[]; nextCursor: string | null }> {
    const connection = await this.ensureConnection();
    const result = requireObject(
      await connection.request(
        "model/list",
        input,
        { timeoutMs: 20_000 },
      ),
      "model/list response",
    );
    const data = result["data"];
    if (!Array.isArray(data)) {
      throw new Error("invalid Codex model/list data");
    }
    const nextCursor = result["nextCursor"];
    if (nextCursor !== null && nextCursor !== undefined && typeof nextCursor !== "string") {
      throw new Error("invalid Codex model/list nextCursor");
    }
    return { data, nextCursor: typeof nextCursor === "string" ? nextCursor : null };
  }

  /** 官方 MCP 状态面；详情由 app-server 负责探测，SuDuo 不自建 MCP 客户端。 */
  async mcpServerStatusList(input: {
    cursor?: string;
    limit?: number;
    detail?: "full" | "toolsAndAuthOnly";
  } = {}): Promise<{ data: JsonValue[]; nextCursor: string | null }> {
    const connection = await this.ensureConnection();
    const result = requireObject(
      await connection.request(
        "mcpServerStatus/list",
        input,
        { timeoutMs: 20_000 },
      ),
      "mcpServerStatus/list response",
    );
    const data = result["data"];
    if (!Array.isArray(data)) {
      throw new Error("invalid Codex mcpServerStatus/list data");
    }
    const nextCursor = result["nextCursor"];
    if (nextCursor !== null && nextCursor !== undefined && typeof nextCursor !== "string") {
      throw new Error("invalid Codex mcpServerStatus/list nextCursor");
    }
    return { data, nextCursor: typeof nextCursor === "string" ? nextCursor : null };
  }

  /** 官方 OAuth 登录面；授权 URL 直接透传给调用方。 */
  async mcpServerOauthLogin(input: {
    name: string;
    scopes?: string[];
    timeoutSecs?: number;
  }): Promise<{ authorizationUrl: string }> {
    const connection = await this.ensureConnection();
    const result = requireObject(
      await connection.request(
        "mcpServer/oauth/login",
        input,
        { timeoutMs: 20_000 },
      ),
      "mcpServer/oauth/login response",
    );
    return {
      authorizationUrl: requireString(
        result["authorizationUrl"],
        "mcpServer/oauth/login authorizationUrl",
      ),
    };
  }

  /** 官方 MCP 配置重载面；随后由 status/list 复检实际连通性。 */
  async mcpServerRefresh(): Promise<void> {
    const connection = await this.ensureConnection();
    await connection.request(
      "config/mcpServer/reload",
      undefined,
      { timeoutMs: 20_000 },
    );
  }

  get processId(): number | null {
    return this.connection instanceof StdioRpcConnection
      ? this.connection.pid
      : null;
  }

  killProcessForTest(): void {
    if (!(this.connection instanceof StdioRpcConnection)) {
      throw new Error("active Codex connection is not a stdio process");
    }
    this.connection.kill("SIGKILL");
  }

  private async ensureConnection(): Promise<RpcConnection> {
    if (this.connection) {
      return this.connection;
    }
    if (!this.connectionPromise) {
      this.connectionPromise = this.createConnection();
    }
    try {
      return await this.connectionPromise;
    } finally {
      this.connectionPromise = null;
    }
  }

  private async createConnection(): Promise<RpcConnection> {
    const connection = await this.transport.connect({
      codexBin: this.codexBin,
      env: withLoopbackNoProxy(this.env),
      signal: this.connectionAbort.signal,
    });
    try {
      await initializeCodexConnection(connection, {
        clientName: "suduo",
        clientTitle: "SuDuo",
        clientVersion: "0.1.0",
      });
      this.connection = connection;
      // 重连后必须重放：extraRoots 是连接级状态，丢了 skill 就再次「查无此技能」。
      if (this.extraSkillRoots.length > 0) {
        await this.applyExtraSkillRoots(connection, this.extraSkillRoots);
      }
      return connection;
    } catch (error) {
      await connection.close("initialize failed");
      throw error;
    }
  }

  /** 登记额外 skills 根目录（幂等；内容不变则不重复下发）。 */
  async setExtraSkillRoots(roots: readonly string[]): Promise<void> {
    const next = [...roots].sort();
    if (
      next.length === this.extraSkillRoots.length &&
      next.every((root, index) => root === this.extraSkillRoots[index])
    ) {
      return;
    }
    this.extraSkillRoots = next;
    const connection = await this.ensureConnection();
    await this.applyExtraSkillRoots(connection, next);
  }

  async listSkills(cwd: string): Promise<RuntimeSkill[]> {
    const connection = await this.ensureConnection();
    const result = await connection.request(
      "skills/list",
      { cwds: [cwd], forceReload: true },
      { timeoutMs: 20_000 },
    );
    const data = requireObject(result, "skills response")["data"];
    if (!Array.isArray(data)) {
      return [];
    }
    const skills: RuntimeSkill[] = [];
    for (const entry of data) {
      const list = requireObject(entry, "skills entry")["skills"];
      if (!Array.isArray(list)) {
        continue;
      }
      for (const item of list) {
        const skill = requireObject(item, "skill metadata");
        const name = skill["name"];
        const path = skill["path"];
        if (typeof name !== "string" || typeof path !== "string") {
          continue;
        }
        skills.push({
          name,
          description:
            typeof skill["description"] === "string" ? skill["description"] : "",
          path,
          scope: typeof skill["scope"] === "string" ? skill["scope"] : "user",
          enabled: skill["enabled"] !== false,
        });
      }
    }
    return skills;
  }

  /** 启用/停用 skill（codex 侧持久化；停用可为其余 skill 让出描述预算）。 */
  async setSkillEnabled(name: string, enabled: boolean): Promise<void> {
    const connection = await this.ensureConnection();
    await connection.request(
      "skills/config/write",
      { name, enabled },
      { timeoutMs: 20_000 },
    );
  }

  private async applyExtraSkillRoots(
    connection: RpcConnection,
    roots: readonly string[],
  ): Promise<void> {
    await connection.request(
      "skills/extraRoots/set",
      { extraRoots: [...roots] },
      { timeoutMs: 20_000 },
    );
  }

  /**
   * 全局默认模型 / 推理强度（只在「改回跟随默认」需要回退时才解析）。按连接与工作目录缓存
   * 一分钟；配置写入或重连时清空。解析失败返回 null，由追踪器降级为沿用上次显式值。
   */
  private resolveModelDefaults(
    connection: RpcConnection,
    cwd: string,
  ): Promise<CodexModelDefaults | null> {
    const key = connection.connectionId + "\0" + cwd;
    const cached = this.modelDefaultsCache;
    if (cached && cached.key === key && Date.now() - cached.at < MODEL_DEFAULTS_TTL_MS) {
      return cached.value;
    }
    const value = this.loadModelDefaults(connection, cwd);
    this.modelDefaultsCache = { key, at: Date.now(), value };
    return value;
  }

  private async loadModelDefaults(
    connection: RpcConnection,
    cwd: string,
  ): Promise<CodexModelDefaults | null> {
    let config: Record<string, JsonValue>;
    try {
      const result = requireObject(
        await connection.request(
          "config/read",
          { includeLayers: false, cwd },
          { timeoutMs: 10_000 },
        ),
        "config/read response",
      );
      config = requireObject(result["config"], "config/read config");
    } catch (error) {
      console.warn(JSON.stringify({
        event: "codex.model_defaults_unavailable",
        stage: "config/read",
        message: error instanceof Error ? error.message : String(error),
      }));
      return null;
    }
    const configuredModel = nonEmptyString(config["model"]);
    const configuredEffort = nonEmptyString(config["model_reasoning_effort"]);
    let catalog: CodexModelOptionDto[] = [];
    if (configuredModel === null || configuredEffort === null) {
      try {
        catalog = await this.readModelCatalog(connection);
      } catch (error) {
        // 目录只用来补默认模型与模型自身默认强度；拿不到时退到 thread/start 的回报值。
        console.warn(JSON.stringify({
          event: "codex.model_defaults_unavailable",
          stage: "model/list",
          message: error instanceof Error ? error.message : String(error),
        }));
      }
    }
    return createCodexModelDefaults({ configuredModel, configuredEffort, catalog });
  }

  private async readModelCatalog(
    connection: RpcConnection,
  ): Promise<CodexModelOptionDto[]> {
    const data: JsonValue[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const result = requireObject(
        await connection.request(
          "model/list",
          {
            includeHidden: true,
            limit: 100,
            ...(cursor === undefined ? {} : { cursor }),
          },
          // 回合启动路径上，目录慢时宁可降级也不拖住发送。
          { timeoutMs: 5_000 },
        ),
        "model/list response",
      );
      const items = result["data"];
      if (!Array.isArray(items)) {
        throw new Error("invalid Codex model/list data");
      }
      data.push(...items);
      const next = result["nextCursor"];
      if (typeof next !== "string" || next === "") {
        break;
      }
      cursor = next;
    }
    return parseCodexModelCatalog(data);
  }

  private threadRef(threadId: string): ThreadRef {
    return {
      runtimeId: this.runtimeId,
      runtimeKind: this.runtimeKind,
      threadId,
    };
  }

  /** 会话记下的语言；查不到时按中文（见 DEFAULT_SESSION_LOCALE）。 */
  private localeOfSession(sessionId: string): Locale {
    return this.sessionLocale?.(sessionId) ?? DEFAULT_SESSION_LOCALE;
  }

  /** 线程所属会话的语言；认不出线程属于哪个会话时为 null（回给 Codex 的话写英文）。 */
  private localeOfThread(threadId: string | undefined): Locale | null {
    const sessionId = threadId === undefined ? undefined : this.threadSessions.get(threadId);
    return sessionId === undefined ? null : this.localeOfSession(sessionId);
  }

  /**
   * 没有 threadId 时默认退而挂到正在创建的会话或唯一的会话上；本来就不属于任何会话的全局通知不这样做，
   * 否则 Codex 启动时的配置提醒会混进那个会话的时间线，设置页也收不到。
   */
  private sessionHintFor(threadId: string | undefined, allowFallback = true): {
    sessionHint?: string;
  } {
    const sessionHint =
      (threadId ? this.threadSessions.get(threadId) : undefined) ??
      (allowFallback ? (this.pendingSessionId ?? onlyValue(this.threadSessions.values())) : undefined);
    return sessionHint === undefined ? {} : { sessionHint };
  }

  private runtimeErrorEvent(
    connectionId: string,
    message: string,
  ): RuntimeEventDraft {
    this.inboundOrdinal += 1;
    return {
      source: "runtime:" + this.runtimeId,
      type: "runtime.error",
      payload: { message },
      threadRef: null,
      turnRef: null,
      ts: Date.now(),
      dedupeKey: connectionId + ":" + String(this.inboundOrdinal),
      ...this.sessionHintFor(undefined),
    };
  }
}

/**
 * 允许的策略组合白名单（ask / auto / full 三档 + 房间 Agent 档），杂糅组合一律拒绝。
 * 房间 Agent 档（ADR-0009，`ROOM_AGENT_SECURITY_POLICY`）只用于房间任务会话：只读沙箱、可联网、不审批；
 * 回合里映射成 `sandboxPolicy: {type: "readOnly", networkAccess: true}`。
 */
export function assertM1SecurityPolicy(
  policy: RuntimeSecurityPolicy,
): void {
  if (policy.approvalsReviewer !== "user") {
    throw new Error("approvalsReviewer must be user");
  }
  const ask =
    policy.approvalPolicy === "on-request" &&
    policy.sandbox.mode === "read-only" &&
    policy.sandbox.networkAccess === false;
  const auto =
    policy.approvalPolicy === "on-request" &&
    policy.sandbox.mode === "workspace-write" &&
    policy.sandbox.networkAccess === false;
  const full =
    policy.approvalPolicy === "never" &&
    policy.sandbox.mode === "danger-full-access" &&
    policy.sandbox.networkAccess === true;
  const roomAgent =
    policy.approvalPolicy === "never" &&
    policy.sandbox.mode === "read-only" &&
    policy.sandbox.networkAccess === true;
  if (!ask && !auto && !full && !roomAgent) {
    throw new Error("runtime security policy is not an allowed combination (ask / auto / full / room agent)");
  }
}

function objectOrEmpty(value: JsonValue | undefined): Record<string, JsonValue> {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function sandboxPolicyType(
  mode: RuntimeSecurityPolicy["sandbox"]["mode"],
): "readOnly" | "workspaceWrite" | "dangerFullAccess" {
  if (mode === "workspace-write") {
    return "workspaceWrite";
  }
  if (mode === "danger-full-access") {
    return "dangerFullAccess";
  }
  return "readOnly";
}

function requireObject(
  value: JsonValue | undefined,
  label: string,
): Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid Codex " + label);
  }
  return value;
}

function requireString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string") {
    throw new Error("invalid Codex " + label);
  }
  return value;
}

function nonEmptyString(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return value !== null &&
    value !== undefined &&
    typeof value === "object" &&
    !Array.isArray(value)
    ? value
    : {};
}

function currentEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function onlyValue(values: Iterable<string>): string | undefined {
  const unique = new Set(values);
  return unique.size === 1 ? unique.values().next().value : undefined;
}

/** 本来就不属于任何会话的通知（与 application/codex-global-state 的全局白名单一致，另加用量额度通知）。 */
const THREADLESS_NOTIFICATIONS = new Set([
  "configWarning",
  "remoteControl/status/changed",
  "skills/changed",
  "account/rateLimits/updated",
]);

/**
 * 审批以外的服务端请求：能直接答的就答（currentTime/read，新版模型的「当前时间」工具会用），
 * 其余明确回「不支持」。不回包的话 Codex 会一直等，回合卡住。事件仍照常记为 runtime.unknown。
 * 「不支持」按请求所属会话的语言写；认不出会话（`locale` 为 null）时写英文。
 */
async function answerServerRequest(
  connection: RpcConnection,
  id: JsonRpcId,
  method: string,
  locale: Locale | null,
): Promise<boolean> {
  if (method === "currentTime/read") {
    try {
      await connection.respond(id, { currentTimeAt: Math.floor(Date.now() / 1000) });
    } catch {
      // 连接已断：订阅循环会看到并按断线处理。
    }
    return true;
  }
  await answerWithError(connection, id, -32601, messagesFor(locale ?? "en").roomPrompt.runtime.unsupported(method));
  return false;
}

async function answerWithError(connection: RpcConnection, id: JsonRpcId, code: number, message: string): Promise<void> {
  try {
    await connection.respondError(id, code, message);
  } catch {
    // 连接已断：订阅循环会看到并按断线处理。
  }
}

/**
 * 回了「不支持」的请求在时间线上的说明（Codex 收到后会当作拒绝 / 失败，接着往下做）。
 * 这里只是英文兜底：前端按 code `unsupported-request` 与方法名渲染，分支与这里一致。
 */
function unsupportedRequestNotice(method: string): string {
  if (method === "item/tool/requestUserInput") {
    return "Codex asked you a question, but SuDuo can't answer it here yet, so it was skipped. Codex will keep going.";
  }
  if (method === "mcpServer/elicitation/request") {
    return "Codex asked you to confirm an MCP tool action, but SuDuo doesn't support this kind of confirmation yet, so it was declined for you. Codex will try another way.";
  }
  return "Codex sent a request SuDuo doesn't support yet, so it was skipped. Codex will keep going.";
}

interface PendingToolCall {
  callRef: string;
  connectionId: string;
  requestId: JsonRpcId;
  threadRef: ThreadRef;
}

/** 只在新建线程时下发；为空时不带这个实验字段，旧行为不变。 */
function dynamicToolsParam(
  tools: StartThreadInput["dynamicTools"],
): { dynamicTools?: JsonValue } {
  if (!tools || tools.length === 0) {
    return {};
  }
  return {
    dynamicTools: tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  };
}

/**
 * 线程级配置覆盖（Codex 深合并）：房间档关掉所有者的 MCP 与连接器；SuDuo 工具服务按 S0 实测的配置注入——
 * 带令牌的请求头、长工具超时（写工具会等用户确认）、工具直接放行（不配时 never 档会拒绝调用；
 * 写操作的确认由 SuDuo 自己的确认卡负责）。两者都没有时不下发 config。
 */
export function threadConfig(
  roomOff: Record<string, JsonValue> | null,
  toolServer: RuntimeToolServer | null,
): { config?: Record<string, JsonValue> } {
  if (roomOff === null && toolServer === null) {
    return {};
  }
  const config: Record<string, JsonValue> = { ...(roomOff ?? {}) };
  if (toolServer !== null) {
    const servers = config["mcp_servers"];
    config["mcp_servers"] = {
      ...(servers !== null && typeof servers === "object" && !Array.isArray(servers) ? servers : {}),
      [SUDUO_MCP_SERVER_NAME]: {
        enabled: true,
        url: toolServer.url,
        http_headers: { Authorization: `Bearer ${toolServer.token}` },
        tool_timeout_sec: toolServer.toolTimeoutSec,
        startup_timeout_sec: 20,
        default_tools_approval_mode: "approve",
      },
    };
  }
  return { config };
}
