import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import type * as acp from "@agentclientprotocol/sdk";
import {
  SUDUO_MCP_SERVER_NAME,
  type AgentRuntime,
  type ApprovalDecision,
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
import { acpProfile, pickMode, type AcpProfile } from "./acp-profiles.js";
import { AcpTurnTranslator, editPaths, type TranslatedEvent } from "./acp-translator.js";

export const ACP_RUNTIME_KIND = "acp";

export function acpRuntimeId(agentId: string): string {
  return "acp-" + agentId;
}

export interface AcpRuntimeOptions {
  agentId: string;
  /** 时间线上不认识的工具显示成「调用 <名字> · 工具」。 */
  agentName: string;
  /** 启动这家 Agent 的命令（配置表的启动参数）；没装为 null。 */
  launch(): { file: string; args: string[] } | null;
  /** 交给 Agent 的环境（已去掉父会话标识、带上出网代理设置）。 */
  env(): Record<string, string>;
  profile?: AcpProfile;
  /** Agent 报需要登录时回调（把这家 Agent 标成需要登录）。 */
  onAuthRequired?(): void;
  /** 正常建好或续接上会话时回调（之前记的「需要登录」作废）。 */
  onReady?(): void;
  /** 没有回合在跑多久后关掉进程（下次用到时再启动并续接）；默认 10 分钟。 */
  idleMs?: number;
  /** 启动、建会话的超时；默认 90 秒（Node 写的 CLI 首次启动慢）。 */
  startTimeoutMs?: number;
  log?(line: Record<string, unknown>): void;
}

interface AgentProcess {
  child: ChildProcess;
  connection: acp.ClientSideConnection;
  init: acp.InitializeResponse;
  connectionId: string;
  stderr: string[];
  closed: boolean;
  /** 按档位加的环境（改档位要重启进程）。 */
  envKey: string;
}

interface PendingPermission {
  resolve(response: acp.RequestPermissionResponse): void;
  options: acp.PermissionOption[];
  toolCallId: string;
  connectionId: string;
}

interface AcpSession {
  sessionId: string;
  /** = Agent 的会话 ID。 */
  threadId: string;
  cwd: string;
  approvalMode: RuntimeApprovalMode;
  /** 这个会话还没把 SuDuo 的说明交给 Agent（ACP 没有系统提示参数，放在第一条消息前）。 */
  instructions: string | null;
  toolServer: RuntimeToolServer | null;
  process: AgentProcess | null;
  translator: AcpTurnTranslator;
  activeTurnId: string | null;
  /** 档位在回合真正开始时才生效（不改正在跑的回合，与 Codex 按回合下发一致）。 */
  queued: Array<{ turnId: string; input: RuntimeInput[]; approvalMode: RuntimeApprovalMode }>;
  approvals: Map<string, PendingPermission>;
  modes: { kind: "modes" | "config"; configId: string | null; available: string[] } | null;
  appliedMode: string | null;
  /** 进程正在启动并续接（同一会话只启动一个，并发的回合等它）。 */
  loading: Promise<AgentProcess> | null;
  restartBeforeNextTurn: boolean;
  idleTimer: NodeJS.Timeout | null;
}

/** ACP 的审批选项 → SuDuo 的决策。 */
const DECISION_BY_KIND: Record<acp.PermissionOptionKind, ApprovalDecision> = {
  allow_once: "accept",
  allow_always: "acceptAlways",
  reject_once: "decline",
  reject_always: "declineAlways",
};

/**
 * 标准 ACP 运行时（ADR-0014，技术设计 4.1、4.2；S0 实测）：每个 Agent 一个运行时实例，每个 SuDuo 会话一个
 * Agent 进程（会话之间互不影响，ADR-0017），闲置时关掉、用到时再启动并续接（`session/load` 或 `session/resume`）。
 * 线程 ID 就是 Agent 的会话 ID：建线程时就启动进程并 `session/new`，没登录在这一步就报出来。
 */
export class AcpRuntime implements AgentRuntime {
  readonly runtimeId: string;
  readonly runtimeKind = ACP_RUNTIME_KIND;
  readonly agentId: string;
  readonly supportsToolServer = true;

  private readonly sessions = new Map<string, AcpSession>();
  private readonly channel = new EventChannel<RuntimeEventDraft>();
  private readonly instanceId = randomUUID().slice(0, 8);
  private readonly profile: AcpProfile;
  private ordinal = 0;
  private sdkPromise: Promise<typeof acp> | null = null;

  constructor(private readonly options: AcpRuntimeOptions) {
    this.agentId = options.agentId;
    this.runtimeId = acpRuntimeId(options.agentId);
    this.profile = options.profile ?? acpProfile(options.agentId);
  }

  async startThread(input: StartThreadInput): Promise<StartThreadResult> {
    if (input.mode === "resume") {
      const existing = this.sessions.get(input.threadRef.threadId);
      if (existing !== undefined) {
        if (input.toolServer !== undefined && input.toolServer.token !== existing.toolServer?.token) {
          // 令牌重签了：ACP 只在建会话 / 续接时收 MCP 配置，下个回合重启进程续接。
          existing.toolServer = input.toolServer;
          this.restartLater(existing);
        }
        return this.threadResult(existing);
      }
      const session = this.newSession(input.sessionId, input.threadRef.threadId, input, null);
      this.sessions.set(session.threadId, session);
      return this.threadResult(session);
    }
    const launched = await this.startProcess(input.projectRoot, input.approvalMode);
    try {
      const created = await this.timed(
        launched.connection.newSession({ cwd: input.projectRoot, mcpServers: this.mcpServers(launched, input.toolServer ?? null) }),
        "session/new",
      );
      this.options.onReady?.();
      const session = this.newSession(input.sessionId, created.sessionId, input, input.developerInstructions ?? null);
      session.process = launched;
      session.modes = modesOf(created);
      this.sessions.set(session.threadId, session);
      await this.applyMode(session);
      this.emit(session, [{ type: "thread.started", payload: { thread: { id: session.threadId } } }]);
      this.warnIfNoTools(session, launched);
      this.scheduleIdle(session);
      return this.threadResult(session);
    } catch (error) {
      this.kill(launched);
      throw this.explain(error, launched);
    }
  }

  async startTurn(input: StartTurnInput): Promise<StartTurnResult> {
    const session = this.sessionOf(input.threadRef);
    const turn = { turnId: randomUUID(), input: input.input, approvalMode: input.approvalMode };
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
      throw new Error("ACP permission request is not pending: " + input.approvalRef);
    }
    session.approvals.delete(input.approvalRef);
    if (input.decision === "cancel") {
      session.translator.markDeclined(pending.toolCallId);
      session.translator.markInterruptRequested();
      pending.resolve({ outcome: { outcome: "cancelled" } });
      await this.cancel(session);
      return { acknowledged: true };
    }
    const option = pending.options.find((candidate) => candidate.optionId === input.optionId) ?? optionFor(pending.options, input.decision);
    if (option === undefined) {
      throw new Error("no ACP permission option for decision " + input.decision);
    }
    if (option.kind === "reject_once" || option.kind === "reject_always") {
      session.translator.markDeclined(pending.toolCallId);
    }
    pending.resolve({ outcome: { outcome: "selected", optionId: option.optionId } });
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
      session.queued = session.queued.filter((entry) => entry !== queued);
      this.emitRaw(session, { type: "turn.interrupted", payload: { threadId: session.threadId, turn: { id: queued.turnId, status: "interrupted", error: null } } });
      return;
    }
    session.translator.markInterruptRequested();
    await this.cancel(session);
  }

  subscribe(options: RuntimeSubscribeOptions): AsyncIterable<RuntimeEventDraft> {
    return this.channel.iterate(options.signal);
  }

  close(): void {
    for (const session of this.sessions.values()) {
      if (session.idleTimer !== null) clearTimeout(session.idleTimer);
      if (session.process !== null) this.kill(session.process);
    }
  }

  private dispatch(session: AcpSession, turn: { turnId: string; input: RuntimeInput[]; approvalMode: RuntimeApprovalMode }): void {
    if (session.idleTimer !== null) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    const turnId = turn.turnId;
    const current = () => session.activeTurnId === turnId;
    session.activeTurnId = turnId;
    this.emit(session, session.translator.beginTurn(turnId));
    void (async () => {
      if (turn.approvalMode !== session.approvalMode) {
        const envChanged = this.envKey(turn.approvalMode) !== this.envKey(session.approvalMode);
        session.approvalMode = turn.approvalMode;
        session.appliedMode = null;
        // 启动环境随档位变（OpenCode 的权限规则）：这时没有回合在跑，直接重启进程。
        if (envChanged && session.process !== null) this.kill(session.process);
      }
      const agent = await this.ensureLoaded(session);
      if (!current()) return;
      await this.applyMode(session);
      if (!current()) return;
      const prompt = await promptBlocks(turn.input, session.instructions, agent.init);
      // 每个等待之后都看一眼：启动或续接期间被中断的回合，消息不再发出（否则 Agent 会在时间线外干活）。
      if (!current()) return;
      session.instructions = null;
      const response = await agent.connection.prompt({ sessionId: session.threadId, prompt });
      if (!current()) return;
      this.finishTurn(session, session.translator.finishTurn(response.stopReason, (response.usage ?? null) as JsonValue));
    })().catch((error: unknown) => {
      if (!current()) return;
      this.finishTurn(session, session.translator.abortTurn(messageOf(this.explain(error, session.process, "prompt"))));
    });
  }

  private finishTurn(session: AcpSession, events: TranslatedEvent[]): void {
    this.emit(session, events);
    session.activeTurnId = null;
    if (session.restartBeforeNextTurn) {
      session.restartBeforeNextTurn = false;
      if (session.process !== null) this.kill(session.process);
    }
    const next = session.queued.shift();
    if (next !== undefined) {
      this.dispatch(session, next);
    } else {
      this.scheduleIdle(session);
    }
  }

  /** 进程没在跑就启动并续接这个会话（闲置关掉后、本机服务重启后、改了启动环境后）；同一会话只启动一个。 */
  private ensureLoaded(session: AcpSession): Promise<AgentProcess> {
    if (session.process !== null && !session.process.closed) {
      return Promise.resolve(session.process);
    }
    session.loading ??= this.load(session).finally(() => {
      session.loading = null;
    });
    return session.loading;
  }

  private async load(session: AcpSession): Promise<AgentProcess> {
    const agent = await this.startProcess(session.cwd, session.approvalMode);
    try {
      const capabilities = agent.init.agentCapabilities;
      const mcpServers = this.mcpServers(agent, session.toolServer);
      let response: { modes?: acp.SessionModeState | null; configOptions?: acp.SessionConfigOption[] | null };
      if (capabilities?.loadSession === true) {
        // 续接时 Agent 会把历史回放成 session/update：回合外的更新翻译器不处理，不会重复进账本。
        response = (await this.timed(agent.connection.loadSession({ sessionId: session.threadId, cwd: session.cwd, mcpServers }), "session/load")) ?? {};
      } else if (capabilities?.sessionCapabilities?.resume !== undefined && capabilities.sessionCapabilities.resume !== null) {
        response = await this.timed(agent.connection.resumeSession({ sessionId: session.threadId, cwd: session.cwd, mcpServers }), "session/resume");
      } else {
        throw new Error(`${this.options.agentName} can't resume a previous session`);
      }
      this.options.onReady?.();
      session.process = agent;
      session.modes = modesOf(response);
      session.appliedMode = null;
      this.warnIfNoTools(session, agent);
      return agent;
    } catch (error) {
      this.kill(agent);
      throw error;
    }
  }

  private async startProcess(cwd: string, mode: RuntimeApprovalMode): Promise<AgentProcess> {
    const launch = this.options.launch();
    if (launch === null) {
      throw new AgentNotReadyError(this.agentId, this.options.agentName, "not_installed", "not on PATH");
    }
    const sdk = await this.sdk();
    const extraEnv = this.profile.env?.(mode) ?? {};
    const env = { ...withLoopbackNoProxy(this.options.env()), ...extraEnv };
    const windowsScript = process.platform === "win32" && /\.(cmd|bat)$/i.test(launch.file);
    // cmd.exe 的 /s 会去掉整行首尾各一个引号：整行外面再包一层，路径里有空格也不会被拆开。
    const child = windowsScript
      ? spawn("cmd.exe", ["/d", "/s", "/c", `"${[launch.file, ...launch.args].map(quoteWindows).join(" ")}"`], { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: true })
      : spawn(launch.file, launch.args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const connectionId = randomUUID();
    const stderr: string[] = [];
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr.push(chunk);
      if (stderr.length > 40) stderr.shift();
    });
    const stream = sdk.ndJsonStream(Writable.toWeb(child.stdin!), Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>);
    const connection = new sdk.ClientSideConnection(() => this.client(connectionId), stream);
    const agent: AgentProcess = { child, connection, init: { protocolVersion: sdk.PROTOCOL_VERSION }, connectionId, stderr, closed: false, envKey: this.envKey(mode) };
    const exited = new Promise<never>((_, reject) => {
      child.once("error", (error) => reject(error));
      child.once("exit", (code, signal) => reject(new Error(`${this.options.agentName} exited (${String(code ?? signal)})`)));
    });
    exited.catch(() => undefined);
    child.once("exit", () => this.onExit(agent));
    child.once("error", () => this.onExit(agent));
    agent.init = await this.timed(
      Promise.race([
        connection.initialize({
          protocolVersion: sdk.PROTOCOL_VERSION,
          // 文件与终端由 Agent 自己处理（SuDuo 不代读写）；权限请求照常交给 SuDuo。
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: "suduo", title: "SuDuo", version: "0" },
        }),
        exited,
      ]),
      "initialize",
    ).catch((error: unknown) => {
      this.kill(agent);
      throw this.explain(error, agent);
    });
    return agent;
  }

  /** Agent 不支持经 HTTP 接 MCP：这个会话用不了 SuDuo 的需求工具，说一声（原因写英文，只给诊断）。 */
  private warnIfNoTools(session: AcpSession, agent: AgentProcess): void {
    if (session.toolServer === null || agent.init.agentCapabilities?.mcpCapabilities?.http === true) return;
    this.emitRaw(session, { type: "runtime.warning", payload: { message: `SuDuo tools unavailable: ${this.options.agentName} does not support MCP over HTTP`, code: "suduo-tools-unavailable" } });
  }

  private client(connectionId: string): acp.Client {
    return {
      sessionUpdate: async (notification) => {
        const session = this.sessions.get(notification.sessionId);
        if (session === undefined || session.process?.connectionId !== connectionId) return;
        this.emit(session, session.translator.translate(notification.update as unknown as JsonValue));
      },
      requestPermission: (request) => this.requestPermission(connectionId, request),
    };
  }

  /** 档位策略能直接答的就答（只读拒写、完全访问放行、自动档放行编辑）；其余交给用户。 */
  private requestPermission(connectionId: string, request: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const session = this.sessions.get(request.sessionId);
    const cancelled: acp.RequestPermissionResponse = { outcome: { outcome: "cancelled" } };
    if (session === undefined || session.process?.connectionId !== connectionId) {
      return Promise.resolve(cancelled);
    }
    const kind = request.toolCall.kind ?? "other";
    const readKinds = new Set(["read", "search", "fetch", "think"]);
    // 自动档只放行工作目录里的编辑（越界照样问；看不出改哪些文件也问）。
    const touched = editPaths(request.toolCall, session.cwd);
    const insideCwd = touched.length > 0 && touched.every((target) => isInside(session.cwd, target));
    const allow = optionFor(request.options, "accept") ?? request.options.find((option) => option.kind === "allow_always");
    const reject = optionFor(request.options, "decline") ?? request.options.find((option) => option.kind === "reject_always");
    const answer = (option: acp.PermissionOption | undefined) => Promise.resolve(option === undefined ? cancelled : { outcome: { outcome: "selected" as const, optionId: option.optionId } });
    switch (session.approvalMode) {
      case "readonly":
        if (readKinds.has(kind)) return answer(allow);
        session.translator.markDeclined(request.toolCall.toolCallId);
        return answer(reject);
      case "full":
        return answer(allow);
      case "auto":
        if (readKinds.has(kind) || (kind === "edit" && insideCwd)) return answer(allow);
        break;
      case "ask":
        break;
    }
    const approvalRef = randomUUID();
    const described = describeAcpPermission(request, session.cwd);
    const choices: ApprovalOption[] = [
      ...request.options.map((option) => ({ id: option.optionId, decision: DECISION_BY_KIND[option.kind], label: option.name })),
      { id: "cancel", decision: "cancel" },
    ];
    return new Promise<acp.RequestPermissionResponse>((resolve) => {
      session.approvals.set(approvalRef, { resolve, options: request.options, toolCallId: request.toolCall.toolCallId, connectionId });
      this.emit(session, [
        {
          type: "approval.requested",
          payload: {
            kind: described.kind,
            approvalRef,
            connectionId,
            requestId: request.toolCall.toolCallId,
            nativeMethod: "session/request_permission",
            request: described.request,
            subject: described.subject,
            options: choices as unknown as JsonValue,
            display: described.display,
          },
        },
      ]);
    });
  }

  /** 取消当前回合：ACP 要求先把还在等的权限请求都答成 cancelled。 */
  private async cancel(session: AcpSession): Promise<void> {
    for (const [approvalRef, pending] of session.approvals) {
      session.approvals.delete(approvalRef);
      pending.resolve({ outcome: { outcome: "cancelled" } });
      this.emitRaw(session, { type: "approval.withdrawn", payload: { approvalRef, reason: "the turn was cancelled" } });
    }
    const agent = session.process;
    if (agent === null || agent.closed) {
      if (session.activeTurnId !== null) this.finishTurn(session, session.translator.abortTurn("cancelled before the agent started"));
      return;
    }
    await agent.connection.cancel({ sessionId: session.threadId }).catch((error: unknown) => this.log({ event: "acp.cancel_failed", agent: this.agentId, message: messageOf(error) }));
  }

  private async applyMode(session: AcpSession): Promise<void> {
    const agent = session.process;
    if (agent === null || session.modes === null) return;
    const wanted = pickMode(session.modes.available, this.profile.modes[session.approvalMode]);
    if (wanted === null || wanted === session.appliedMode) return;
    try {
      if (session.modes.kind === "modes") {
        await agent.connection.setSessionMode({ sessionId: session.threadId, modeId: wanted });
      } else if (session.modes.configId !== null) {
        await agent.connection.setSessionConfigOption({ sessionId: session.threadId, configId: session.modes.configId, value: wanted });
      }
      session.appliedMode = wanted;
    } catch (error) {
      this.log({ event: "acp.set_mode_failed", agent: this.agentId, mode: wanted, message: messageOf(error) });
    }
  }

  private onExit(agent: AgentProcess): void {
    if (agent.closed) return;
    agent.closed = true;
    for (const session of this.sessions.values()) {
      if (session.process !== agent) continue;
      session.process = null;
      for (const [approvalRef, pending] of session.approvals) {
        if (pending.connectionId === agent.connectionId) session.approvals.delete(approvalRef);
      }
      this.emitRaw(session, { type: "runtime.connection-closed", payload: { connectionId: agent.connectionId } });
      // 正在跑的回合由 prompt 的报错收口（见 dispatch）。
    }
  }

  private mcpServers(agent: AgentProcess, toolServer: RuntimeToolServer | null): acp.McpServer[] {
    if (toolServer === null || agent.init.agentCapabilities?.mcpCapabilities?.http !== true) return [];
    return [{ type: "http", name: SUDUO_MCP_SERVER_NAME, url: toolServer.url, headers: [{ name: "Authorization", value: `Bearer ${toolServer.token}` }] }];
  }

  private restartLater(session: AcpSession): void {
    if (session.process === null) return;
    if (session.activeTurnId === null) this.kill(session.process);
    else session.restartBeforeNextTurn = true;
  }

  private scheduleIdle(session: AcpSession): void {
    if (session.idleTimer !== null) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      session.idleTimer = null;
      if (session.activeTurnId === null && session.process !== null) this.kill(session.process);
    }, this.options.idleMs ?? 10 * 60_000);
    session.idleTimer.unref?.();
  }

  private kill(agent: AgentProcess): void {
    if (!agent.closed) {
      if (process.platform === "win32" && agent.child.pid !== undefined) {
        // 经 cmd.exe 启动时只杀 cmd.exe 杀不到 Agent 本身：连同子进程一起结束。
        spawn("taskkill", ["/pid", String(agent.child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => undefined);
      } else {
        agent.child.kill("SIGTERM");
      }
    }
    this.onExit(agent);
  }

  private envKey(mode: RuntimeApprovalMode): string {
    return JSON.stringify(this.profile.env?.(mode) ?? {});
  }

  /**
   * 报错里带上 Agent 的错误输出；认出需要登录时回调并给出「没登录」。回合中的报错只认协议的
   * auth_required 错误码（说明文字里带「key」「login」的可能是额度之类，不能当成没登录）。
   */
  private explain(error: unknown, agent: AgentProcess | null, phase: "start" | "prompt" = "start"): Error {
    if (error instanceof AgentNotReadyError) return error;
    const message = messageOf(error);
    const detail = agent === null ? "" : agent.stderr.join("").trim().split("\n").slice(-5).join("\n");
    const full = [message, detail].filter((part) => part !== "").join("\n");
    if (phase === "prompt" ? errorCode(error) === -32000 : isAuthError(error)) {
      this.options.onAuthRequired?.();
      return new AgentNotReadyError(this.agentId, this.options.agentName, "auth_required", full);
    }
    return new Error(full);
  }

  private timed<T>(promise: Promise<T>, label: string): Promise<T> {
    const ms = this.options.startTimeoutMs ?? 90_000;
    let timer: NodeJS.Timeout | null = null;
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${this.options.agentName}: ${label} timed out after ${String(Math.round(ms / 1000))}s`)), ms);
        timer.unref?.();
      }),
    ]).finally(() => {
      if (timer !== null) clearTimeout(timer);
    });
  }

  private newSession(sessionId: string, threadId: string, input: StartThreadInput, instructions: string | null): AcpSession {
    return {
      sessionId,
      threadId,
      cwd: input.projectRoot,
      approvalMode: input.approvalMode,
      instructions,
      toolServer: input.toolServer ?? null,
      process: null,
      translator: new AcpTurnTranslator({ threadId, cwd: input.projectRoot, agentName: this.options.agentName }),
      activeTurnId: null,
      queued: [],
      approvals: new Map(),
      modes: null,
      appliedMode: null,
      loading: null,
      restartBeforeNextTurn: false,
      idleTimer: null,
    };
  }

  private threadResult(session: AcpSession): StartThreadResult {
    const thread = { threadRef: this.threadRef(session.threadId), role: "primary", metadata: { agentId: this.agentId, cwd: session.cwd } };
    return { primaryThread: thread, threads: [thread] };
  }

  private sessionOf(threadRef: ThreadRef): AcpSession {
    const session = this.sessions.get(threadRef.threadId);
    if (session === undefined) {
      throw new Error(`${this.options.agentName} thread is not loaded: ${threadRef.threadId}`);
    }
    return session;
  }

  private threadRef(threadId: string): ThreadRef {
    return { runtimeId: this.runtimeId, runtimeKind: this.runtimeKind, threadId };
  }

  private emit(session: AcpSession, events: TranslatedEvent[]): void {
    for (const event of events) this.emitRaw(session, event);
  }

  private emitRaw(session: AcpSession, event: TranslatedEvent): void {
    this.ordinal += 1;
    const turnId = turnIdOf(event.payload) ?? session.activeTurnId;
    this.channel.push({
      source: "runtime:" + this.runtimeId,
      type: event.type,
      payload: event.payload,
      threadRef: this.threadRef(session.threadId),
      turnRef: turnId === null ? null : { threadId: session.threadId, turnId },
      ts: Date.now(),
      dedupeKey: `${this.runtimeId}:${this.instanceId}:${String(this.ordinal)}`,
      sessionHint: session.sessionId,
    });
  }

  private sdk(): Promise<typeof acp> {
    this.sdkPromise ??= import("@agentclientprotocol/sdk");
    return this.sdkPromise;
  }

  private log(line: Record<string, unknown>): void {
    this.options.log?.(line);
  }
}

/** 审批卡的内容：沿用 Codex 审批的 request 字段，另给中立字段。 */
export function describeAcpPermission(
  request: acp.RequestPermissionRequest,
  cwd: string,
): { kind: "command" | "file-change" | "other"; subject: "command" | "file" | "tool"; request: JsonValue; display: JsonValue } {
  const tool = request.toolCall;
  const raw = (tool.rawInput ?? {}) as Record<string, unknown>;
  const title = tool.title ?? "";
  if (tool.kind === "execute") {
    const command = typeof raw["command"] === "string" ? raw["command"] : Array.isArray(raw["command"]) ? raw["command"].map(String).join(" ") : title;
    return { kind: "command", subject: "command", request: { command, cwd, reason: title }, display: { command, cwd, reason: title } };
  }
  if (tool.kind === "edit" || tool.kind === "delete" || tool.kind === "move") {
    const paths = editPaths(tool, cwd);
    return {
      kind: "file-change",
      subject: "file",
      request: { itemId: tool.toolCallId, ...(paths[0] === undefined ? {} : { path: paths[0] }), reason: title },
      display: { paths, reason: title },
    };
  }
  return { kind: "other", subject: "tool", request: { command: title, toolName: tool.kind ?? "other" }, display: { toolName: tool.kind ?? "other", command: title } };
}

function optionFor(options: readonly acp.PermissionOption[], decision: ApprovalDecision): acp.PermissionOption | undefined {
  const kind: acp.PermissionOptionKind | undefined =
    decision === "accept" || decision === "acceptForSession"
      ? "allow_once"
      : decision === "acceptAlways"
        ? "allow_always"
        : decision === "decline"
          ? "reject_once"
          : decision === "declineAlways"
            ? "reject_always"
            : undefined;
  return kind === undefined ? undefined : options.find((option) => option.kind === kind);
}

function modesOf(response: { modes?: acp.SessionModeState | null; configOptions?: acp.SessionConfigOption[] | null } | null | undefined): AcpSession["modes"] {
  const modes = response?.modes;
  if (modes !== undefined && modes !== null && modes.availableModes.length > 0) {
    return { kind: "modes", configId: null, available: modes.availableModes.map((mode) => mode.id) };
  }
  const option = (response?.configOptions ?? []).find((candidate) => candidate.category === "mode");
  if (option !== undefined && option.type === "select") {
    const values = option.options.flatMap((entry) => ("value" in entry ? [entry.value] : "options" in entry ? entry.options.map((inner) => inner.value) : []));
    return { kind: "config", configId: option.id, available: values };
  }
  return null;
}

/** SuDuo 的输入 → ACP 的消息内容块；第一条消息前放 SuDuo 的说明（ACP 没有系统提示参数）。 */
async function promptBlocks(inputs: readonly RuntimeInput[], instructions: string | null, init: acp.InitializeResponse): Promise<acp.ContentBlock[]> {
  const blocks: acp.ContentBlock[] = [];
  if (instructions !== null && instructions.trim() !== "") {
    blocks.push({ type: "text", text: `<suduo_context>\n${instructions}\n</suduo_context>` });
  }
  const images = init.agentCapabilities?.promptCapabilities?.image === true;
  for (const input of inputs) {
    switch (input.type) {
      case "text":
        blocks.push({ type: "text", text: input.text });
        break;
      case "local-image":
        if (images) {
          const data = await readFile(input.path);
          blocks.push({ type: "image", data: data.toString("base64"), mimeType: imageMimeType(input.path) });
        } else {
          blocks.push({ type: "text", text: `(Image attached at ${input.path}; this agent can't view images directly.)` });
        }
        break;
      case "image-url": {
        const match = /^data:(image\/[a-z+.-]+);base64,(.*)$/is.exec(input.url);
        if (images && match) blocks.push({ type: "image", data: match[2]!, mimeType: match[1]! });
        else blocks.push({ type: "text", text: `(Image: ${input.url.startsWith("data:") ? "attached" : input.url})` });
        break;
      }
      case "skill":
        blocks.push({ type: "text", text: `Use the "${input.name}" skill: read ${input.path} and follow it.` });
        break;
    }
  }
  return blocks;
}

function imageMimeType(file: string): string {
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

/** ACP 的「需要登录」：错误码 -32000（auth_required）或说明里带登录、密钥字样（S0：Gemini、Qwen、Copilot）。 */
export function isAuthError(error: unknown): boolean {
  if (errorCode(error) === -32000) return true;
  return /authenticat|log ?in|api key|credential|unauthori[sz]ed/i.test(messageOf(error));
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? (error as { code: unknown }).code : null;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function turnIdOf(payload: JsonValue): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (typeof payload["turnId"] === "string") return payload["turnId"];
  const turn = payload["turn"];
  if (turn !== null && typeof turn === "object" && !Array.isArray(turn) && typeof turn["id"] === "string") return turn["id"];
  return null;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error && typeof (error as { message: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return String(error);
}

function quoteWindows(value: string): string {
  return /[\s"&|<>^]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
