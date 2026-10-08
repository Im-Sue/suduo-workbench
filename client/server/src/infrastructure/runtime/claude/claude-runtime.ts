import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  CanUseTool,
  McpServerConfig,
  Options,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  SUDUO_MCP_SERVER_NAME,
  type AgentRuntime,
  type ApprovalOption,
  type ApproveInput,
  type ApproveResult,
  type InterruptInput,
  type JsonValue,
  type RuntimeApprovalMode,
  type RuntimeEventDraft,
  type RuntimeInput,
  type RuntimeSubscribeOptions,
  type RuntimeToolServer,
  type StartThreadInput,
  type StartThreadResult,
  type StartTurnInput,
  type StartTurnResult,
  type ThreadRef,
} from "@suduo/client-contracts";
import { withLoopbackNoProxy } from "../../mcp/loopback-no-proxy.js";
import { AgentNotReadyError } from "../agent-not-ready.js";
import { EventChannel } from "../event-channel.js";
import { claudePermissionOptions, sameQueryShape } from "./claude-permissions.js";
import { ClaudeTurnTranslator, type TranslatedEvent } from "./claude-translator.js";

export const CLAUDE_RUNTIME_ID = "claude-local";
export const CLAUDE_RUNTIME_KIND = "claude-sdk";
export const CLAUDE_AGENT_ID = "claude-code";

/** 线程元数据里记 SuDuo 说明的键（续接时监督器带回来）。 */
export const THREAD_INSTRUCTIONS_KEY = "suDuoInstructions";

/** SDK 里用到的两个函数（测试换成假的）。 */
export interface ClaudeSdk {
  query(params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): Query;
  /** 这个 Claude 会话的记录是否已存在（决定续接还是用指定 ID 新开）。 */
  sessionExists(sessionId: string, cwd: string): Promise<boolean>;
}

export interface ClaudeRuntimeOptions {
  /** 本机安装的官方 claude（ADR-0016：只驱动用户自己装的、未修改的 CLI）；找不到为 null。 */
  resolveExecutable(): string | null;
  /** 交给 claude 的环境（已去掉父会话标识、带上出网代理设置）；每次启动查询时取。 */
  env(): Record<string, string>;
  sdk?: ClaudeSdk;
  /** Claude 报登录失效时回调（把这家 Agent 标成需要登录）。 */
  onAuthRequired?(): void;
  /** 没有回合在跑多久后关掉查询（下个回合续接）；默认 10 分钟。 */
  idleMs?: number;
  log?(line: Record<string, unknown>): void;
}

interface PendingApproval {
  resolve(result: PermissionResult): void;
  toolUseId: string;
  input: Record<string, unknown>;
  suggestions: PermissionUpdate[];
  connectionId: string;
}

interface ClaudeSession {
  sessionId: string;
  threadId: string;
  cwd: string;
  approvalMode: RuntimeApprovalMode;
  developerInstructions: string | undefined;
  toolServer: RuntimeToolServer | null;
  /** undefined = 不管（用 Claude 自己的默认）；null = 跟随默认；字符串 = 指定。 */
  model: string | null | undefined;
  query: Query | null;
  input: InputQueue | null;
  connectionId: string;
  translator: ClaudeTurnTranslator;
  /** 活着的查询启动时用的档位（只读、完全访问要按启动参数重启）。 */
  queryMode: RuntimeApprovalMode | null;
  /** 查询正在启动（同一会话只启动一条，并发的回合等它）。 */
  starting: Promise<InputQueue> | null;
  /** 正在跑的回合；Claude 一次只跑一个，后来的排在 queued 里（SuDuo 侧本来也会排队）。 */
  activeTurnId: string | null;
  queued: QueuedTurn[];
  approvals: Map<string, PendingApproval>;
  /** 最近一次 claude 的错误输出（启动失败时给出原因）。 */
  stderr: string[];
  idleTimer: NodeJS.Timeout | null;
}

/** 档位与模型在回合真正开始时才生效（不改正在跑的回合，与 Codex 按回合下发一致）。 */
interface QueuedTurn {
  turnId: string;
  message: SDKUserMessage;
  approvalMode: RuntimeApprovalMode;
  model: string | null | undefined;
}

/**
 * Claude Code 运行时（ADR-0014，技术设计 4.1、4.2；S0 实测）：经官方 Agent SDK 驱动用户本机的 claude，
 * 每个会话一条长寿命流式查询（同一查询连续多回合，中断一回合后照常），审批走 canUseTool，
 * SuDuo 工具走本机 MCP（ADR-0015）。一个会话的查询出错只影响这个会话（ADR-0017 故障隔离），
 * 事件流本身不结束。
 */
export class ClaudeRuntime implements AgentRuntime {
  readonly runtimeId = CLAUDE_RUNTIME_ID;
  readonly runtimeKind = CLAUDE_RUNTIME_KIND;
  readonly agentId = CLAUDE_AGENT_ID;
  readonly supportsToolServer = true;

  private readonly sessions = new Map<string, ClaudeSession>();
  private readonly channel = new EventChannel<RuntimeEventDraft>();
  private readonly instanceId = randomUUID().slice(0, 8);
  private ordinal = 0;
  private sdkPromise: Promise<ClaudeSdk> | null = null;

  constructor(private readonly options: ClaudeRuntimeOptions) {}

  async startThread(input: StartThreadInput): Promise<StartThreadResult> {
    if (this.options.resolveExecutable() === null) {
      throw new AgentNotReadyError(CLAUDE_AGENT_ID, "Claude Code", "not_installed", "claude is not on PATH");
    }
    const threadId = input.mode === "resume" ? input.threadRef.threadId : randomUUID();
    const existing = this.sessions.get(threadId);
    const session: ClaudeSession = existing ?? {
      sessionId: input.sessionId,
      threadId,
      cwd: input.projectRoot,
      approvalMode: input.approvalMode,
      developerInstructions: input.developerInstructions,
      toolServer: input.toolServer ?? null,
      model: undefined,
      query: null,
      input: null,
      connectionId: "",
      translator: new ClaudeTurnTranslator({ threadId, cwd: input.projectRoot }),
      queryMode: null,
      starting: null,
      activeTurnId: null,
      queued: [],
      approvals: new Map(),
      stderr: [],
      idleTimer: null,
    };
    if (existing !== undefined) {
      if (input.toolServer !== undefined) {
        existing.toolServer = input.toolServer;
        // 续接时令牌重签了：活着的查询换上新令牌（旧的已作废）。
        await existing.query?.setMcpServers(this.mcpServers(existing)).catch((error: unknown) => this.log({ event: "claude.mcp_update_failed", message: messageOf(error) }));
      }
    }
    this.sessions.set(threadId, session);
    const threadRef = this.threadRef(threadId);
    if (input.mode === "create") {
      this.emit(session, [{ type: "thread.started", payload: { thread: { id: threadId } } }]);
    }
    // Claude 的系统提示追加不进会话记录：记在线程元数据里，本机服务重启后续接时由监督器带回来。
    const metadata = {
      agentId: CLAUDE_AGENT_ID,
      cwd: input.projectRoot,
      ...(session.developerInstructions === undefined ? {} : { [THREAD_INSTRUCTIONS_KEY]: session.developerInstructions }),
    };
    const thread = { threadRef, role: "primary", metadata };
    return { primaryThread: thread, threads: [thread] };
  }

  async startTurn(input: StartTurnInput): Promise<StartTurnResult> {
    const session = this.sessionOf(input.threadRef);
    const turn: QueuedTurn = {
      turnId: randomUUID(),
      message: { type: "user", message: { role: "user", content: await contentBlocks(input.input) }, parent_tool_use_id: null },
      approvalMode: input.approvalMode,
      model: input.model,
    };
    if (session.activeTurnId === null) {
      this.dispatch(session, turn);
    } else {
      session.queued.push(turn);
    }
    return { turnRef: { threadId: session.threadId, turnId: turn.turnId }, acceptedAt: Date.now() };
  }

  async approve(input: ApproveInput): Promise<ApproveResult> {
    const session = this.sessionOf(input.threadRef);
    const pending = session.approvals.get(input.approvalRef);
    if (pending === undefined) {
      throw new Error("Claude approvalRef is not pending: " + input.approvalRef);
    }
    session.approvals.delete(input.approvalRef);
    switch (input.decision) {
      case "accept":
        pending.resolve({ behavior: "allow", updatedInput: pending.input });
        break;
      case "acceptForSession":
        // 只在本会话里不再问：只收 Claude 建议里的规则与目录，一律改记到 session（不写用户的设置文件）。
        pending.resolve({ behavior: "allow", updatedInput: pending.input, updatedPermissions: sessionRules(pending.suggestions) });
        break;
      case "acceptAlways":
        pending.resolve({ behavior: "allow", updatedInput: pending.input, updatedPermissions: pending.suggestions.filter((suggestion) => suggestion.type !== "setMode") });
        break;
      case "decline":
      case "declineAlways":
        session.translator.markDeclined(pending.toolUseId);
        pending.resolve({ behavior: "deny", message: "The user declined this action." });
        break;
      case "cancel":
        session.translator.markDeclined(pending.toolUseId);
        session.translator.markInterruptRequested();
        pending.resolve({ behavior: "deny", message: "The user declined this action and stopped the turn.", interrupt: true });
        break;
    }
    return { acknowledged: true };
  }

  async interrupt(input: InterruptInput): Promise<void> {
    const session = this.sessionOf(input.threadRef);
    if (session.activeTurnId !== input.turnId) {
      const queued = session.queued.find((entry) => entry.turnId === input.turnId);
      if (queued === undefined) {
        // 不认识的回合（已结束，或本机服务重启前的回合）：按「已经停了」报，中断服务据此补终态。
        throw new Error("no active turn " + input.turnId);
      }
      // 排队中的回合：拿掉，并给它一个终态（账本里已有这条消息）。
      session.queued = session.queued.filter((entry) => entry !== queued);
      this.emitRaw(session, { type: "turn.interrupted", payload: { threadId: session.threadId, turn: { id: queued.turnId, status: "interrupted", error: null } } });
      return;
    }
    session.translator.markInterruptRequested();
    if (session.query === null) {
      // 查询还在启动：直接收口；启动完成后这一回合的消息不再发出。
      this.finishTurn(session, session.translator.abortTurn("interrupted before the query started"));
      return;
    }
    await session.query.interrupt();
  }

  subscribe(options: RuntimeSubscribeOptions): AsyncIterable<RuntimeEventDraft> {
    return this.channel.iterate(options.signal);
  }

  /** 关掉所有查询（本机服务退出时）。 */
  close(): void {
    for (const session of this.sessions.values()) {
      this.closeQuery(session);
    }
  }

  private dispatch(session: ClaudeSession, turn: QueuedTurn): void {
    if (session.idleTimer !== null) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    const turnId = turn.turnId;
    session.activeTurnId = turnId;
    this.emit(session, session.translator.beginTurn(turnId));
    void (async () => {
      await this.applyTurnSettings(session, turn);
      const input = await this.ensureQuery(session);
      if (session.activeTurnId === turnId) input.push(turn.message);
    })().catch((error: unknown) => {
      if (session.activeTurnId !== turnId) return;
      this.finishTurn(session, session.translator.abortTurn(this.startFailure(session, error)));
    });
  }

  /** 回合开始时让查询用上这个回合的档位与模型（跨只读、完全访问要重启查询，续接不丢历史）。 */
  private async applyTurnSettings(session: ClaudeSession, turn: QueuedTurn): Promise<void> {
    session.approvalMode = turn.approvalMode;
    const modelChanged = turn.model !== undefined && turn.model !== session.model;
    if (modelChanged) session.model = turn.model;
    const live = session.query;
    if (live === null || session.queryMode === null) return;
    if (!sameQueryShape(session.queryMode, turn.approvalMode)) {
      this.closeQuery(session);
      return;
    }
    if (session.queryMode !== turn.approvalMode) {
      await this.control(session, (query) => query.setPermissionMode(claudePermissionOptions(turn.approvalMode).permissionMode));
      session.queryMode = turn.approvalMode;
    }
    if (modelChanged) {
      await this.control(session, (query) => query.setModel(turn.model ?? undefined));
    }
  }

  /** 回合收口：发出事件，接着跑排队的下一个；都跑完了开始计闲置。 */
  private finishTurn(session: ClaudeSession, events: TranslatedEvent[]): void {
    this.emit(session, events);
    if (session.translator.authFailed) {
      this.options.onAuthRequired?.();
    }
    session.activeTurnId = null;
    const next = session.queued.shift();
    if (next !== undefined) {
      this.dispatch(session, next);
    } else {
      this.scheduleIdle(session);
    }
  }

  private scheduleIdle(session: ClaudeSession): void {
    if (session.idleTimer !== null) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      session.idleTimer = null;
      // 闲置太久关掉查询（claude 进程常驻占内存）；下个回合续接。
      if (session.activeTurnId === null && session.queued.length === 0 && session.starting === null) this.closeQuery(session);
    }, this.options.idleMs ?? 10 * 60_000);
    session.idleTimer.unref?.();
  }

  /** 同一会话只启动一条查询：并发的回合（启动中被中断后紧接着的下一条）等同一个。 */
  private ensureQuery(session: ClaudeSession): Promise<InputQueue> {
    if (session.query !== null && session.input !== null) {
      return Promise.resolve(session.input);
    }
    session.starting ??= this.startQuery(session).finally(() => {
      session.starting = null;
    });
    return session.starting;
  }

  private async startQuery(session: ClaudeSession): Promise<InputQueue> {
    const executable = this.options.resolveExecutable();
    if (executable === null) {
      throw new Error("Claude Code CLI (claude) is not installed or not on PATH");
    }
    const sdk = await this.sdk();
    const resume = await sdk.sessionExists(session.threadId, session.cwd).catch(() => false);
    const permissions = claudePermissionOptions(session.approvalMode);
    const connectionId = randomUUID();
    const input = new InputQueue();
    session.stderr = [];
    const options: Options = {
      cwd: session.cwd,
      pathToClaudeCodeExecutable: executable,
      env: withLoopbackNoProxy(this.options.env()),
      // 已有记录就续接；还没有（新会话，或建好后还没跑过回合）就用这个 ID 新开，线程 ID 前后一致。
      ...(resume ? { resume: session.threadId } : { sessionId: session.threadId }),
      permissionMode: permissions.permissionMode,
      ...(permissions.allowDangerouslySkipPermissions === true ? { allowDangerouslySkipPermissions: true } : {}),
      settingSources: permissions.settingSources,
      strictMcpConfig: permissions.strictMcpConfig,
      allowedTools: permissions.allowedTools,
      disallowedTools: permissions.disallowedTools,
      includePartialMessages: true,
      systemPrompt:
        session.developerInstructions === undefined
          ? { type: "preset", preset: "claude_code" }
          : { type: "preset", preset: "claude_code", append: session.developerInstructions },
      mcpServers: this.mcpServers(session),
      canUseTool: this.canUseTool(session, connectionId),
      ...(typeof session.model === "string" ? { model: session.model } : {}),
      stderr: (data: string) => {
        session.stderr.push(data);
        if (session.stderr.length > 40) session.stderr.shift();
      },
    };
    const query = sdk.query({ prompt: input, options });
    session.query = query;
    session.input = input;
    session.connectionId = connectionId;
    session.queryMode = session.approvalMode;
    void this.pump(session, query, connectionId);
    return input;
  }

  private async pump(session: ClaudeSession, query: Query, connectionId: string): Promise<void> {
    let failure: unknown = null;
    try {
      for await (const message of query) {
        if (session.connectionId !== connectionId) break;
        const events = session.translator.translate(message);
        if ((message as { type?: unknown }).type === "result") {
          this.finishTurn(session, events);
        } else {
          this.emit(session, events);
        }
      }
    } catch (error) {
      failure = error;
    }
    if (session.connectionId !== connectionId) {
      return;
    }
    // 查询结束（我们关掉的、进程退出或出错）：这条查询上的审批作废，正在跑的回合收口。
    session.query = null;
    session.input = null;
    for (const [approvalRef, pending] of session.approvals) {
      if (pending.connectionId === connectionId) session.approvals.delete(approvalRef);
    }
    this.emitRaw(session, { type: "runtime.connection-closed", payload: { connectionId } });
    if (session.activeTurnId !== null) {
      this.finishTurn(session, session.translator.abortTurn(this.startFailure(session, failure ?? new Error("Claude Code exited"))));
    }
  }

  private canUseTool(session: ClaudeSession, connectionId: string): CanUseTool {
    return (toolName, input, options) => {
      if (toolName === "AskUserQuestion") {
        // 选择题式提问的界面还没有（S5）：让它在回复里直接问。
        return Promise.resolve({ behavior: "deny", message: "Ask the user in your reply instead; this client can't show multiple-choice questions." });
      }
      const approvalRef = randomUUID();
      const suggestions = options.suggestions ?? [];
      const described = describePermission(toolName, input, {
        cwd: session.cwd,
        toolUseId: options.toolUseID,
        ...(options.title === undefined ? {} : { title: options.title }),
        ...(options.blockedPath === undefined ? {} : { blockedPath: options.blockedPath }),
        ...(options.decisionReason === undefined ? {} : { decisionReason: options.decisionReason }),
      });
      const choices: ApprovalOption[] = [
        { id: "accept", decision: "accept" },
        ...(sessionRules(suggestions).length > 0 && options.suppressAlwaysAllowRule !== true ? [{ id: "acceptForSession", decision: "acceptForSession" } as const] : []),
        { id: "decline", decision: "decline" },
        { id: "cancel", decision: "cancel" },
      ];
      return new Promise<PermissionResult>((resolve) => {
        session.approvals.set(approvalRef, { resolve, toolUseId: options.toolUseID, input, suggestions, connectionId });
        options.signal.addEventListener(
          "abort",
          () => {
            if (!session.approvals.delete(approvalRef)) return;
            resolve({ behavior: "deny", message: "The request was withdrawn." });
            // Claude 撤回了这次请求（回合被中断等）：确认卡作废。
            this.emitRaw(session, { type: "approval.withdrawn", payload: { approvalRef, reason: "Claude withdrew this permission request" } });
          },
          { once: true },
        );
        this.emit(session, [
          {
            type: "approval.requested",
            payload: {
              kind: described.kind,
              approvalRef,
              connectionId,
              requestId: options.requestId,
              nativeMethod: "claude/canUseTool",
              request: described.request,
              subject: described.subject,
              options: choices as unknown as JsonValue,
              display: described.display,
            },
          },
        ]);
      });
    };
  }

  private mcpServers(session: ClaudeSession): Record<string, McpServerConfig> {
    const server = session.toolServer;
    if (server === null) return {};
    return {
      [SUDUO_MCP_SERVER_NAME]: {
        type: "http",
        url: server.url,
        headers: { Authorization: `Bearer ${server.token}` },
        // 写工具会挂起等用户确认；服务端在它到点前转草稿（ADR-0015）。
        timeout: server.toolTimeoutSec * 1000,
      },
    };
  }

  /** 对活着的查询发控制请求（回合开始前）；被拒（如模型名不认）就按新参数重启查询，不让这次发送失败。 */
  private async control(session: ClaudeSession, request: (query: Query) => Promise<void>): Promise<void> {
    const query = session.query;
    if (query === null) return;
    try {
      await request(query);
    } catch (error) {
      this.log({ event: "claude.control_failed", message: messageOf(error) });
      this.closeQuery(session);
    }
  }

  private closeQuery(session: ClaudeSession): void {
    const query = session.query;
    session.connectionId = "";
    session.queryMode = null;
    session.query = null;
    session.input?.end();
    session.input = null;
    query?.close();
  }

  private startFailure(session: ClaudeSession, error: unknown): string {
    const detail = session.stderr.join("").trim().split("\n").slice(-5).join("\n");
    return [messageOf(error), detail].filter((part) => part !== "").join("\n");
  }

  private sessionOf(threadRef: ThreadRef): ClaudeSession {
    const session = this.sessions.get(threadRef.threadId);
    if (session === undefined) {
      throw new Error("Claude thread is not loaded: " + threadRef.threadId);
    }
    return session;
  }

  private threadRef(threadId: string): ThreadRef {
    return { runtimeId: this.runtimeId, runtimeKind: this.runtimeKind, threadId };
  }

  private emit(session: ClaudeSession, events: TranslatedEvent[]): void {
    for (const event of events) {
      this.emitRaw(session, event);
    }
  }

  private emitRaw(session: ClaudeSession, event: TranslatedEvent): void {
    this.ordinal += 1;
    const turnId = turnIdOf(event.payload) ?? session.activeTurnId;
    this.channel.push({
      source: "runtime:" + this.runtimeId,
      type: event.type,
      payload: event.payload,
      threadRef: this.threadRef(session.threadId),
      turnRef: turnId === null ? null : { threadId: session.threadId, turnId },
      ts: Date.now(),
      dedupeKey: `claude:${this.instanceId}:${String(this.ordinal)}`,
      sessionHint: session.sessionId,
    });
  }

  private sdk(): Promise<ClaudeSdk> {
    if (this.options.sdk !== undefined) return Promise.resolve(this.options.sdk);
    // 用到时才加载 SDK（1 MB 多），不拖慢本机服务启动。
    this.sdkPromise ??= import("@anthropic-ai/claude-agent-sdk").then((module) => ({
      query: (params) => module.query(params),
      sessionExists: async (sessionId, cwd) => (await module.getSessionInfo(sessionId, { dir: cwd })) !== undefined,
    }));
    return this.sdkPromise;
  }

  private log(line: Record<string, unknown>): void {
    this.options.log?.(line);
  }
}

/** 审批卡的内容：沿用 Codex 审批的 request 字段（现有审批坞照常显示），另给中立字段。 */
export function describePermission(
  toolName: string,
  input: Record<string, unknown>,
  context: { cwd: string; toolUseId: string; title?: string; blockedPath?: string; decisionReason?: string },
): { kind: "command" | "file-change" | "other"; subject: "command" | "file" | "permission" | "tool"; request: JsonValue; display: JsonValue } {
  const reason = context.title ?? context.decisionReason;
  const withReason = <T extends Record<string, JsonValue>>(value: T): T => (reason === undefined ? value : { ...value, reason });
  if (toolName === "Bash") {
    // 命令要写到某个路径时 Claude 会带 blockedPath：仍按命令卡显示，路径放进显示内容。
    const command = typeof input["command"] === "string" ? input["command"] : "";
    const description = typeof input["description"] === "string" ? input["description"] : reason;
    const paths = context.blockedPath === undefined ? {} : { paths: [context.blockedPath] };
    return {
      kind: "command",
      subject: "command",
      request: { command, cwd: context.cwd, ...(description === undefined ? {} : { reason: description }) },
      display: { command, cwd: context.cwd, ...paths, ...(description === undefined ? {} : { reason: description }) },
    };
  }
  if (context.blockedPath !== undefined && !FILE_TOOLS.has(toolName)) {
    return {
      kind: "other",
      subject: "permission",
      request: withReason({ toolName, path: context.blockedPath }),
      display: withReason({ toolName, paths: [context.blockedPath] }),
    };
  }
  if (FILE_TOOLS.has(toolName)) {
    const filePath = typeof input["file_path"] === "string" ? input["file_path"] : typeof input["notebook_path"] === "string" ? input["notebook_path"] : "";
    return {
      kind: "file-change",
      subject: "file",
      // itemId：审批坞从同一步的改动卡里取文件与增删行数。
      request: withReason({ itemId: context.toolUseId, path: filePath }),
      display: withReason({ paths: [filePath] }),
    };
  }
  const summary = toolSummary(toolName, input);
  return {
    kind: "other",
    subject: "tool",
    request: withReason({ command: summary, toolName }),
    display: withReason({ toolName, command: summary }),
  };
}

const FILE_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

/**
 * 「本会话同意」能带回给 Claude 的建议：只要规则与目录，改记到 session。不收切换模式的建议
 * （收了会话会悄悄进 acceptEdits，SuDuo 这边还显示「询问」）。
 */
export function sessionRules(suggestions: readonly PermissionUpdate[]): PermissionUpdate[] {
  return suggestions
    .filter((suggestion) => suggestion.type === "addRules" || suggestion.type === "addDirectories")
    .map((suggestion) => ({ ...suggestion, destination: "session" }));
}

function toolSummary(toolName: string, input: Record<string, unknown>): string {
  if (toolName.startsWith("mcp__")) {
    const [, server = "", ...rest] = toolName.split("__");
    return `${server} · ${rest.join("__")}`;
  }
  const detail = ["url", "query", "file_path", "path", "pattern"].map((key) => input[key]).find((value): value is string => typeof value === "string");
  return detail === undefined ? toolName : `${toolName} ${detail}`;
}

/** SuDuo 的输入 → Claude 的消息内容块。 */
async function contentBlocks(inputs: readonly RuntimeInput[]): Promise<Exclude<SDKUserMessage["message"]["content"], string>> {
  const blocks: Exclude<SDKUserMessage["message"]["content"], string> = [];
  for (const input of inputs) {
    switch (input.type) {
      case "text":
        blocks.push({ type: "text", text: input.text });
        break;
      case "local-image": {
        const data = await readFile(input.path);
        blocks.push({ type: "image", source: { type: "base64", media_type: imageMediaType(input.path), data: data.toString("base64") } });
        break;
      }
      case "image-url": {
        const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.*)$/s.exec(input.url);
        blocks.push(
          match
            ? { type: "image", source: { type: "base64", media_type: match[1] as ImageMediaType, data: match[2]! } }
            : { type: "image", source: { type: "url", url: input.url } },
        );
        break;
      }
      case "skill":
        // Codex 的技能：告诉 Claude 去读那份说明照做（Claude 自己的技能由它自己发现）。
        blocks.push({ type: "text", text: `Use the "${input.name}" skill: read ${input.path} and follow it.` });
        break;
    }
  }
  return blocks;
}

type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

function imageMediaType(file: string): ImageMediaType {
  switch (path.extname(file).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "image/png";
  }
}

function turnIdOf(payload: JsonValue): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (typeof payload["turnId"] === "string") return payload["turnId"];
  const turn = payload["turn"];
  if (turn !== null && typeof turn === "object" && !Array.isArray(turn) && typeof turn["id"] === "string") return turn["id"];
  return null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 推给长寿命查询的用户消息队列（SDK 的流式输入）。 */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly pending: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private ended = false;

  push(message: SDKUserMessage): void {
    this.pending.push(message);
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (!this.ended) {
      const next = this.pending.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = null;
    }
  }
}
