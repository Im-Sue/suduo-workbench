import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import type {
  CreateSessionRequest,
  EventEnvelope,
  InterruptRequest,
  JsonValue,
  Locale,
  SendMessageAccepted,
  SendMessageRequest,
  SessionDto,
} from "@suduo/client-contracts";
import {
  ROOM_SSE_EVENT_NAME,
  agentRunProgressFallback,
  agentRunReasonFallback,
  type AgentDto,
  type AgentRunProgressRequest,
  type AgentRunReason,
  type AgentRunSummaryDto,
  type AgentRunTextParams,
  type FinishAgentRunRequest,
  type RoomDto,
  type RoomEventDto,
  type RoomMessageDto,
} from "@suduo/cloud-contracts";
import type { EventRepository } from "../../infrastructure/db/repositories/event-repository.js";
import type { ProjectRepository } from "../../infrastructure/db/repositories/project-repository.js";
import type {
  RoomTaskSessionRecord,
  RoomTaskSessionRepository,
} from "../../infrastructure/db/repositories/room-task-session-repository.js";
import type { SessionKind, SessionRepository } from "../../infrastructure/db/repositories/session-repository.js";
import type { WorkspaceMappingRepository } from "../../infrastructure/db/repositories/workspace-mapping-repository.js";
import type { RequirementsRemoteClient } from "../../infrastructure/requirements-v2/remote-client.js";
import { messagesFor, type ServerMessages } from "../../i18n/messages/index.js";
import { errorTextOf, renderText, type ErrorText } from "../api-error.js";
import type { RemoteEventsSignal } from "../remote-events-hub.js";
import { toolFormat } from "../session-tools/format.js";
import type { RoomSetupInput, ThreadSetup } from "../session-tools/session-context.js";
import { buildRoomTurnInput, rebuiltTopicSection, roomTaskTitle } from "./context.js";
import {
  RunProgressTracker,
  compactRunEvents,
  describeTurnFailure,
  summaryOf,
  withoutNul,
} from "./progress.js";

/**
 * 房间任务接收器（技术设计 4.2）：在所有者本机串行执行派给本机 Agent 的 @ 任务。
 *
 * 任务来源：上游推送的 `room.run`（agent = 本机 Agent）+ 登记 / 重连 / 每分钟定时拉 `GET /v2/agent-runs`；
 * 按远程的排队顺序一次只跑一个。
 *
 * 执行：start（started=false 跳过）→ 找 / 建房间任务会话（一个话题一个 Codex 线程，只读 + 联网 + 不审批）→
 * 发回合输入 → 每 3 秒回写进度 → 回合结束回写回答与执行过程。收到 stopRequested 就中断本回合。
 *
 * 进度与原因只回写 code + 参数（文字列是英文兜底），房间里的人各按自己的语言看（中英双语技术设计 §4.3）；
 * 替 Agent 写进房间的固定文字（无文字回答的占位、回答超长的省略说明、执行过程的截断后缀）与原因里的报错原文
 * 按所有者的界面语言写。
 *
 * 每次同步都对一遍远程「执行中」的任务，任务不会卡在执行中 / 排队中：
 * - 本机正在跑的：顺带拿到停止请求（推送丢了也不至于等到判定卡死）；
 * - 本进程开始过、结果没回写成功的：重发结果；
 * - 不是本进程开始的：本机服务重启前中断的，标失败（执行中断）。
 * 开始失败（远程暂不可用）的任务仍是排队中，按退避安排下一次同步再取。
 */

export type RoomRunnerRemote = Pick<
  RequirementsRemoteClient,
  | "listAgentRuns"
  | "startAgentRun"
  | "getRoom"
  | "getProject"
  | "getRequirement"
  | "listRoomMessages"
  | "progressAgentRun"
  | "completeAgentRun"
  | "finishAgentRun"
>;

export interface RoomAgentRunnerDependencies {
  remote: RoomRunnerRemote;
  /** 本机登记了的 Agent（Codex 加上共享过的其他家，多 Agent S6）。 */
  presence: { currentAgents(): AgentDto[]; agentById(agentId: string): AgentDto | null };
  /**
   * 这一种 Agent 能不能在讨论里执行（配置表：接上了、做得到只读、没停用；ADR-0009 只读红线）。不能时返回原因，
   * 任务以「没能在本机开始执行」收尾。登记时已把关，这里是执行前的最后一道（配置表或设置之后可能改了）。
   */
  agentProblem?(kind: string): ErrorText | null;
  hub: { subscribe(listener: (signal: RemoteEventsSignal) => void): () => void };
  mappings: Pick<WorkspaceMappingRepository, "getByRemoteProjectId">;
  projects: Pick<ProjectRepository, "getById">;
  roomTasks: Pick<RoomTaskSessionRepository, "get" | "upsert" | "recordTrigger">;
  sessionRecords: Pick<SessionRepository, "getById">;
  sessions: {
    create(
      projectId: string,
      input: CreateSessionRequest,
      setup: ThreadSetup,
      options: { kind?: SessionKind; locale: Locale },
    ): Promise<SessionDto>;
  };
  messages: { send(sessionId: string, input: SendMessageRequest, idempotencyKey: string): Promise<SendMessageAccepted> };
  interrupts: { interrupt(sessionId: string, input: InterruptRequest): Promise<unknown> };
  events: Pick<EventRepository, "maxSeq" | "listAfter" | "hasTurnTerminal">;
  broker: { subscribe(sessionId: string, listener: (event: EventEnvelope<string, JsonValue>) => void): () => void };
  context: { roomSetup(input: RoomSetupInput): Promise<ThreadSetup> };
  /** 所有者的界面语言（本机记下的界面语言，没记下过时用中文）；每次写文字时现取。 */
  ownerLocale(): Locale;
  /** 进度回写间隔，默认 3 秒。 */
  progressIntervalMs?: number;
  /** 每几次进度回写顺带一次执行过程（执行中也能看详情），默认 5（约 15 秒）。 */
  eventsEveryTicks?: number;
  /** 本会话多久没有任何新事件就判定卡死（运行时连接丢了等），默认 20 分钟。 */
  stallMs?: number;
  /** 发出中断后等终态的最长时间，默认 30 秒。 */
  stopGraceMs?: number;
  /** 回写失败的重试间隔。 */
  reportRetryMs?: readonly number[];
  /** 定时同步的间隔（对账执行中 / 补拉排队），默认 60 秒；0 = 不定时。 */
  syncIntervalMs?: number;
  /** 开始任务失败后安排同步重取的退避间隔。 */
  startRetryMs?: readonly number[];
  now?(): number;
  log?(line: Record<string, unknown>): void;
}

type ReportResult = "delivered" | "rejected" | "unavailable";

type Outcome =
  /** 本机服务在执行中退出：不回写，下次启动时把它标失败（执行中断）。 */
  | { kind: "abandoned" }
  | { kind: "completed"; reply: string; events: Array<EventEnvelope<string, JsonValue>> }
  | { kind: "failed"; reason: AgentRunReason; events?: Array<EventEnvelope<string, JsonValue>> }
  | { kind: "stopped"; reason: AgentRunReason; events?: Array<EventEnvelope<string, JsonValue>> };

interface ActiveRun {
  run: AgentRunSummaryDto;
  sessionId: string | null;
  turnId: string | null;
  stopRequested: boolean;
  interruptSent: boolean;
  /** 执行中收到停止时唤醒等待（还没发回合时直接以「已停止」收尾）。 */
  onStop: (() => void) | null;
  /** 本机服务退出：放弃等待。 */
  abandon: (() => void) | null;
}

const EVENTS_PAGE = 500;
/** 远程单条消息正文上限（契约 ROOM_MESSAGE_BODY_MAX_LENGTH）与原因 / 进度的上限。 */
const REPLY_MAX = 100_000;
const REASON_MAX = 2_000;
const EVENTS_MAX = 20_000;

export class RoomAgentRunner {
  private readonly queue = new Map<string, AgentRunSummaryDto>();
  private active: ActiveRun | null = null;
  private pumping = false;
  private syncing: Promise<void> | null = null;
  private syncAgain = false;
  /** 本进程开始过的任务：远程仍是执行中却不在本机跑的，按此区分「没回写成功」与「重启前中断」。 */
  private readonly startedHere = new Set<string>();
  /** 本进程发过 start 的任务（含响应丢了、不知道远程是否已开始的）。 */
  private readonly startAttempted = new Set<string>();
  /** 正在 start 的任务：start 已在远程生效、响应还没回来时，同步不能把它当成重启前中断的。 */
  private starting: string | null = null;
  /** 本进程已经回写收尾的任务：同步拿到的「执行中」列表是旧快照，不能再给它们补一次失败。 */
  private readonly settled = new Set<string>();
  /** 结果没回写成功的任务（不带执行过程），下次同步再发。 */
  private readonly unreported = new Map<string, Exclude<Outcome, { kind: "abandoned" }>>();
  private unsubscribe: (() => void) | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private startFailures = 0;
  private stopped = false;
  private readonly progressIntervalMs: number;
  private readonly eventsEveryTicks: number;
  private readonly stallMs: number;
  private readonly stopGraceMs: number;
  private readonly reportRetryMs: readonly number[];
  private readonly syncIntervalMs: number;
  private readonly startRetryMs: readonly number[];
  private readonly now: () => number;

  constructor(private readonly deps: RoomAgentRunnerDependencies) {
    this.progressIntervalMs = deps.progressIntervalMs ?? 3_000;
    this.eventsEveryTicks = deps.eventsEveryTicks ?? 5;
    this.stallMs = deps.stallMs ?? 20 * 60_000;
    this.stopGraceMs = deps.stopGraceMs ?? 30_000;
    this.reportRetryMs = deps.reportRetryMs ?? [2_000, 5_000];
    this.syncIntervalMs = deps.syncIntervalMs ?? 60_000;
    this.startRetryMs = deps.startRetryMs ?? [5_000, 15_000, 30_000, 60_000];
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    this.stopped = false;
    this.unsubscribe ??= this.deps.hub.subscribe((signal) => this.onSignal(signal));
    if (this.syncTimer === null && this.syncIntervalMs > 0) {
      this.syncTimer = setInterval(() => void this.sync(), this.syncIntervalMs);
      this.syncTimer.unref();
    }
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.syncTimer !== null) clearInterval(this.syncTimer);
    this.syncTimer = null;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.queue.clear();
    this.active?.abandon?.();
  }

  /** 所有者视角（`GET /api/v2/agents/self`）：正在执行的任务与排队数。 */
  status(): { activeRun: AgentRunSummaryDto | null; queuedRuns: number } {
    return { activeRun: this.active?.run ?? null, queuedRuns: this.queue.size };
  }

  /** 本机 Agent 登记成功 / 上游重连后 / 定时：对账执行中的任务，拉排队任务。 */
  sync(): Promise<void> {
    if (this.syncing !== null) {
      this.syncAgain = true;
      return this.syncing;
    }
    const run = async () => {
      do {
        this.syncAgain = false;
        await this.syncOnce();
      } while (this.syncAgain && !this.stopped);
    };
    this.syncing = run().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async syncOnce(): Promise<void> {
    const agents = this.deps.presence.currentAgents();
    if (agents.length === 0 || this.stopped) {
      return;
    }
    try {
      // 先重发没回写成功的结果（远程 complete / finish 是合并语义：已完成的原样返回，
      // 被远程判离线收尾的也会改成本机的真实结果）。
      for (const [runId, pending] of [...this.unreported]) {
        if (this.stopped) return;
        const result = await this.deliver(runId, pending, { retry: false });
        if (result !== "unavailable") {
          this.unreported.delete(runId);
          this.settled.add(runId);
        }
        this.log({ event: "suduo.room_run.report_retried", runId, result });
      }
    } catch (error) {
      this.log({ event: "suduo.room_run.sync_failed", message: logMessageOf(error) });
    }
    // 各家各自对账：一家失败不挡后面的。
    for (const agent of agents) {
      if (this.stopped) return;
      try {
        await this.syncAgent(agent);
      } catch (error) {
        this.log({ event: "suduo.room_run.sync_failed", agentId: agent.id, message: logMessageOf(error) });
      }
    }
    this.pump();
  }

  /** 一家 Agent 的对账：执行中的任务本机没在跑就收尾，排队的入队（本机共享了几家就各对一遍，多 Agent S6）。 */
  private async syncAgent(agent: AgentDto): Promise<void> {
    const running = await this.deps.remote.listAgentRuns({ agentId: agent.id, status: "running" });
    for (const run of running.items) {
      if (this.stopped) return;
      if (
        run.agent.id !== agent.id ||
        run.id === this.starting ||
        this.unreported.has(run.id) ||
        this.settled.has(run.id)
      ) {
        continue;
      }
      if (run.id === this.active?.run.id) {
        // 推送丢了也能拿到停止请求。
        this.accept(run, agent.id);
        continue;
      }
      const reason: AgentRunReason = {
        code: this.startedHere.has(run.id)
          ? "result_not_delivered"
          : this.startAttempted.has(run.id)
            ? "start_connection_lost"
            : "local_service_restarted",
        params: {},
      };
      const result = await this.deliver(run.id, { kind: "failed", reason }, { retry: false });
      if (result !== "unavailable") this.settled.add(run.id);
      this.log({ event: "suduo.room_run.failed", runId: run.id, roomId: run.roomId, reason: reason.code, result });
    }
    const queued = await this.deps.remote.listAgentRuns({ agentId: agent.id, status: "queued" });
    for (const run of queued.items) {
      this.accept(run, agent.id);
    }
  }

  private onSignal(signal: RemoteEventsSignal): void {
    if (signal.type === "connected") {
      // 断线期间的 room.run 可能漏了：按 REST 补拉排队任务。
      void this.sync();
      return;
    }
    if (signal.event.event !== ROOM_SSE_EVENT_NAME) {
      return;
    }
    let event: RoomEventDto;
    try {
      event = JSON.parse(signal.event.data) as RoomEventDto;
    } catch {
      return;
    }
    if (event.type !== "room.run" || event.run === undefined) {
      return;
    }
    const agent = this.deps.presence.agentById(event.run.agent.id);
    if (agent === null) {
      return;
    }
    this.accept(event.run, agent.id);
    this.pump();
  }

  /** 一条任务的最新状态：排队中入队；不再排队就出队；执行中的收到停止就中断。 */
  private accept(run: AgentRunSummaryDto, agentId: string): void {
    if (run.agent.id !== agentId) {
      return;
    }
    const active = this.active;
    if (active !== null && active.run.id === run.id) {
      active.run = run;
      if (run.stopRequested || run.status === "stopped") {
        this.requestStop(active);
      }
      return;
    }
    if (run.status === "queued" && !run.stopRequested) {
      this.queue.set(run.id, run);
    } else {
      this.queue.delete(run.id);
    }
  }

  private pump(): void {
    if (this.pumping || this.stopped) {
      return;
    }
    this.pumping = true;
    void (async () => {
      try {
        for (;;) {
          if (this.stopped) break;
          const next = this.nextQueued();
          if (next === null) break;
          this.queue.delete(next.id);
          await this.execute(next).catch((error: unknown) => {
            this.log({ event: "suduo.room_run.unexpected", runId: next.id, message: logMessageOf(error) });
          });
        }
      } finally {
        this.pumping = false;
        if (!this.stopped && this.queue.size > 0) {
          this.pump();
        }
      }
    })();
  }

  /** 按远程的排队顺序（前面还有几个）取下一个；同位置按创建时间。 */
  private nextQueued(): AgentRunSummaryDto | null {
    let best: AgentRunSummaryDto | null = null;
    for (const run of this.queue.values()) {
      if (best === null || compareQueued(run, best) < 0) {
        best = run;
      }
    }
    return best;
  }

  private async execute(queued: AgentRunSummaryDto): Promise<void> {
    const agent = this.deps.presence.agentById(queued.agent.id);
    if (agent === null) {
      return;
    }
    let started;
    this.starting = queued.id;
    this.startAttempted.add(queued.id);
    try {
      started = await this.deps.remote.startAgentRun(queued.id);
    } catch (error) {
      // 开始不了（远程暂不可用）：任务仍是排队中，按退避安排一次同步再取。
      this.log({ event: "suduo.room_run.start_failed", runId: queued.id, message: logMessageOf(error) });
      this.scheduleRetrySync();
      return;
    } finally {
      this.starting = null;
    }
    this.startFailures = 0;
    if (started.started) {
      this.startedHere.add(queued.id);
      // 同一任务被重试后又开始了：上一次没回写成功的旧结果作废，不能拿来覆盖这一次。
      this.unreported.delete(queued.id);
      this.settled.delete(queued.id);
    }
    if (!started.started) {
      // 已不是排队中（被停止、重试合并或别处开始了）：合并语义，跳过。
      this.log({ event: "suduo.room_run.skipped", runId: queued.id, status: started.run.status });
      return;
    }
    const startedAt = this.now();
    const active: ActiveRun = {
      run: started.run,
      sessionId: null,
      turnId: null,
      stopRequested: started.run.stopRequested,
      interruptSent: false,
      onStop: null,
      abandon: null,
    };
    this.active = active;
    this.log({ event: "suduo.room_run.started", runId: queued.id, roomId: queued.roomId });
    let outcome: Outcome;
    try {
      outcome = await this.runTurn(active, agent);
    } catch (error) {
      outcome = { kind: "failed", reason: { code: "run_error", params: { detail: this.errorDetail(error) } } };
    }
    if (outcome.kind === "abandoned" || this.stopped) {
      this.active = null;
      this.log({ event: "suduo.room_run.abandoned", runId: active.run.id });
      return;
    }
    try {
      await this.report(active.run.id, outcome);
    } finally {
      this.active = null;
    }
    this.log({
      event: `suduo.room_run.${outcome.kind}`,
      runId: active.run.id,
      roomId: active.run.roomId,
      sessionId: active.sessionId,
      durationMs: this.now() - startedAt,
      ...(outcome.kind === "failed" || outcome.kind === "stopped" ? { reason: outcome.reason.code } : {}),
    });
  }

  private async runTurn(active: ActiveRun, agent: AgentDto): Promise<Outcome> {
    const run = active.run;
    if (active.stopRequested) {
      return { kind: "stopped", reason: { code: "stopped_before_start", params: {} } };
    }
    const problem = this.deps.agentProblem?.(agent.kind) ?? null;
    if (problem !== null) {
      return { kind: "failed", reason: { code: "local_start_failed", params: { detail: renderText(problem, this.ownerMessages()) } } };
    }
    const room = await this.deps.remote.getRoom(run.roomId);
    const mapping = this.deps.mappings.getByRemoteProjectId(room.projectId);
    const project = mapping === null ? null : this.deps.projects.getById(mapping.localProjectId);
    if (project === null || project.state !== "active") {
      return { kind: "failed", reason: { code: "no_local_folder", params: {} } };
    }
    const rootOk = await stat(project.rootPath).then((info) => info.isDirectory(), () => false);
    if (!rootOk) {
      return { kind: "failed", reason: { code: "local_folder_unavailable", params: { path: project.rootPath } } };
    }

    const thread = await this.loadThread(room.id, run.threadRootId);
    const trigger = thread.find((message) => message.id === run.triggerMessageId) ?? null;
    if (trigger === null) {
      return { kind: "failed", reason: { code: "trigger_message_missing", params: {} } };
    }

    const record = await this.ensureSession(room, run, agent, project, thread, trigger);
    active.sessionId = record.sessionId;
    if (active.stopRequested) {
      return { kind: "stopped", reason: { code: "stopped_before_start", params: {} } };
    }
    // 回合输入里 SuDuo 的框架文字按任务会话记下的语言（与固定层一致）。
    const locale = this.deps.sessionRecords.getById(record.sessionId)?.locale ?? this.deps.ownerLocale();

    const mode = record.lastTriggerSeq > 0 ? "continue" : "new";
    let neighbors: RoomMessageDto[] = [];
    let neighborsUnavailable: string | undefined;
    if (mode === "new") {
      try {
        neighbors = (await this.deps.remote.listRoomMessages(room.id, { before: trigger.seq, limit: 20 })).items;
      } catch (error) {
        neighborsUnavailable = toolFormat(locale).reasonOf(error);
      }
    }
    const input = buildRoomTurnInput({
      locale,
      mode,
      trigger,
      threadBefore: thread.filter((message) => message.seq < trigger.seq),
      neighbors,
      ...(neighborsUnavailable === undefined ? {} : { neighborsUnavailable }),
      lastTriggerSeq: record.lastTriggerSeq,
      selfAgentId: agent.id,
    });
    return this.executeTurn(active, record.sessionId, input.text, trigger.seq, room.name);
  }

  /** 找这个话题的房间任务会话；没有（或已删除 / 归档）就新建一个隐藏会话。 */
  private async ensureSession(
    room: RoomDto,
    run: AgentRunSummaryDto,
    agent: AgentDto,
    project: { id: string; name: string; rootPath: string },
    thread: readonly RoomMessageDto[],
    trigger: RoomMessageDto,
  ): Promise<RoomTaskSessionRecord> {
    const existing = this.deps.roomTasks.get(agent.id, room.id, run.threadRootId);
    if (existing !== null && this.deps.sessionRecords.getById(existing.sessionId)?.state === "active") {
      return existing;
    }
    // 任务会话的语言 = 所有者此刻的界面语言：固定层与工具说明按它写，记进会话，重建线程时沿用。
    const locale = this.deps.ownerLocale();
    const { setup, requirementVersion } = await this.buildSetup(room, agent, agent.kind, project, locale);
    const root = thread.find((message) => message.id === run.threadRootId) ?? trigger;
    // 用被 @ 的那家 Agent 开房间任务会话（云端的种类就是本机配置表的 Agent id，多 Agent S6）。
    const session = await this.deps.sessions.create(
      project.id,
      // 显式要只读档：做不到只读的 Agent 在建会话时就被拒（room_task 运行时本来也固定只读）。
      { title: roomTaskTitle(room.name, root.body, locale), purpose: "general", agentId: agent.kind, approvalMode: "readonly" },
      setup,
      { kind: "room_task", locale },
    );
    return this.deps.roomTasks.upsert({
      agentId: agent.id,
      roomId: room.id,
      threadRootId: run.threadRootId,
      sessionId: session.id,
      remoteProjectId: room.projectId,
      roomName: room.name,
      requirementId: room.requirement?.id ?? null,
      requirementVersion,
      lastTriggerSeq: 0,
      lastRunId: null,
      createdAt: this.now(),
    });
  }

  /** 固定层（developerInstructions）与工具清单；需求房间取需求卡（查不到给最小的说明，工具照挂）。 */
  private async buildSetup(
    room: RoomDto,
    agent: Pick<AgentDto, "owner" | "deviceName"> | null,
    agentKind: string,
    project: { name: string; rootPath: string },
    locale: Locale,
  ): Promise<{ setup: ThreadSetup; requirementVersion: number | null }> {
    let requirement: RoomSetupInput["requirement"] = null;
    let requirementVersion: number | null = null;
    if (room.requirement !== null) {
      try {
        const detail = await this.deps.remote.getRequirement(room.requirement.id);
        requirement = { detail };
        requirementVersion = detail.version;
      } catch (error) {
        requirement = { ref: room.requirement, error };
      }
    }
    const projectName =
      room.kind === "project_default"
        ? room.name
        : await this.deps.remote.getProject(room.projectId).then((value) => value.name, () => project.name);
    const setup = await this.deps.context.roomSetup({
      locale,
      projectRoot: project.rootPath,
      ownerName: agent?.owner.displayName ?? messagesFor(locale).roomPrompt.setup.ownerFallback,
      agentKind,
      deviceName: agent?.deviceName ?? messagesFor(locale).roomPrompt.setup.deviceFallback,
      projectName,
      roomName: room.name,
      requirement,
    });
    return { setup, requirementVersion };
  }

  /**
   * 房间任务会话的线程续接失败、要重建全新线程时（SessionContextService.rebuildSetup 调用）：
   * 重新生成固定层与工具。房间查不到返回 null，由调用方给最小开场。
   */
  async rebuildSetup(record: RoomTaskSessionRecord): Promise<ThreadSetup | null> {
    const session = this.deps.sessionRecords.getById(record.sessionId);
    const project = session === null ? null : this.deps.projects.getById(session.projectId);
    if (project === null) {
      return null;
    }
    const room = await this.deps.remote.getRoom(record.roomId).catch(() => null);
    if (room === null) {
      return null;
    }
    const locale = session?.locale ?? this.deps.ownerLocale();
    const { setup } = await this.buildSetup(
      room,
      this.deps.presence.agentById(record.agentId),
      session?.agentId ?? "codex",
      project,
      locale,
    );
    if (record.lastTriggerSeq <= 0) {
      return setup;
    }
    // 这一回合已按「续接」组装（只有上次被 @ 之后的新消息）：把之前的话题消息补进新线程的固定层。
    const history = await this.loadThread(room.id, record.threadRootId).catch(
      (error: unknown) => ({ unavailable: toolFormat(locale).reasonOf(error) }),
    );
    return {
      ...setup,
      developerInstructions: `${setup.developerInstructions}\n\n${rebuiltTopicSection(history, record.lastTriggerSeq, record.agentId, locale)}`,
    };
  }

  /** 话题全部消息（根 + 回复），按序号升序；最多往前翻 3 页。 */
  private async loadThread(roomId: string, threadRootId: string): Promise<RoomMessageDto[]> {
    const collected = new Map<string, RoomMessageDto>();
    let before: number | undefined;
    for (let page = 0; page < 3; page += 1) {
      const response = await this.deps.remote.listRoomMessages(roomId, {
        threadRootId,
        limit: 200,
        ...(before === undefined ? {} : { before }),
      });
      for (const message of response.items) {
        collected.set(message.id, message);
      }
      if (!response.hasMoreBefore || response.items.length === 0) {
        break;
      }
      before = Math.min(...response.items.map((message) => message.seq));
    }
    return [...collected.values()].sort((a, b) => a.seq - b.seq);
  }

  private async executeTurn(
    active: ActiveRun,
    sessionId: string,
    text: string,
    triggerSeq: number,
    roomName: string,
  ): Promise<Outcome> {
    const runId = active.run.id;
    const tracker = new RunProgressTracker();
    const buffered: Array<EventEnvelope<string, JsonValue>> = [];
    let turnId: string | null = null;
    let clientTurnId: string | null = null;
    let lastEventAt = this.now();
    let resolveTerminal: (event: EventEnvelope<string, JsonValue> | null) => void = () => undefined;
    const terminal = new Promise<EventEnvelope<string, JsonValue> | null>((resolve) => {
      resolveTerminal = resolve;
    });
    active.abandon = () => resolveTerminal(null);
    const consider = (event: EventEnvelope<string, JsonValue>) => {
      if (event.turnRef?.turnId !== turnId) return;
      tracker.observe(event);
      if (isTerminal(event.type)) resolveTerminal(event);
    };
    // 先订阅再发：回合的事件可能比 send 返回还早到。
    const unsubscribe = this.deps.broker.subscribe(sessionId, (event) => {
      lastEventAt = this.now();
      if (turnId === null) {
        buffered.push(event);
      } else {
        consider(event);
      }
    });
    const startSeq = this.deps.events.maxSeq(sessionId);
    let stopTimer: NodeJS.Timeout | null = null;
    let ticker: NodeJS.Timeout | null = null;
    try {
      let accepted: SendMessageAccepted;
      try {
        accepted = await this.deps.messages.send(
          sessionId,
          { content: [{ type: "text", text }] },
          `room-run:${runId}:${randomUUID()}`,
        );
      } catch (error) {
        return { kind: "failed", reason: { code: "local_start_failed", params: { detail: this.errorDetail(error) } } };
      }
      turnId = accepted.turnRef.turnId;
      clientTurnId = accepted.clientTurnId ?? null;
      active.turnId = turnId;
      this.deps.roomTasks.recordTrigger(sessionId, { triggerSeq, runId, roomName });
      for (const event of buffered.splice(0)) consider(event);

      // 停止：发中断；等不到终态也按「已停止」收尾。
      active.onStop = () => {
        if (stopTimer !== null) return;
        stopTimer = setTimeout(() => resolveTerminal(null), this.stopGraceMs);
        stopTimer.unref();
      };
      if (active.stopRequested) {
        this.requestStop(active);
      }

      let ticks = 0;
      let lastProgress: string | null = null;
      let lastEventsCount = -1;
      ticker = setInterval(() => {
        if (this.stopped) {
          resolveTerminal(null);
          return;
        }
        try {
          tick();
        } catch (error) {
          this.log({ event: "suduo.room_run.tick_failed", runId, message: logMessageOf(error) });
        }
      }, this.progressIntervalMs);
      ticker.unref();
      const tick = () => {
        ticks += 1;
        // 兜底：broker 漏了终态就从账本里认。
        if (turnId !== null && this.deps.events.hasTurnTerminal(sessionId, turnId)) {
          const found = this.turnEvents(sessionId, startSeq).find(
            (event) => event.turnRef?.turnId === turnId && isTerminal(event.type),
          );
          if (found) resolveTerminal(found);
        }
        if (this.now() - lastEventAt > this.stallMs) {
          this.log({ event: "suduo.room_run.stalled", runId, sessionId });
          resolveTerminal(null);
          return;
        }
        const progress = progressFields(tracker);
        const withEvents = ticks % this.eventsEveryTicks === 0;
        const events = withEvents ? this.collectEvents(sessionId, startSeq, { turnId, clientTurnId }) : null;
        const eventsChanged = events !== null && events.length !== lastEventsCount;
        if (progress.progress === lastProgress && !eventsChanged) return;
        lastProgress = progress.progress;
        if (events !== null) lastEventsCount = events.length;
        void this.deps.remote
          .progressAgentRun(runId, { ...progress, ...(eventsChanged && events !== null ? { events } : {}) })
          .then((run) => {
            if (this.active === active && (run.stopRequested || run.status === "stopped")) {
              this.requestStop(active);
            }
          })
          .catch((error: unknown) => {
            this.log({ event: "suduo.room_run.progress_failed", runId, message: logMessageOf(error) });
          });
      };

      const ended = await terminal;
      if (this.stopped) {
        return { kind: "abandoned" };
      }
      const events = this.collectEvents(sessionId, startSeq, { turnId, clientTurnId });
      if (ended === null) {
        if (active.stopRequested) {
          return { kind: "stopped", reason: { code: "stopped_while_running", params: {} }, events };
        }
        await this.interruptQuietly(sessionId, turnId);
        return {
          kind: "failed",
          reason: { code: "stalled", params: { minutes: Math.round(this.stallMs / 60_000) } },
          events,
        };
      }
      if (ended.type === "turn.interrupted") {
        return {
          kind: "stopped",
          reason: { code: active.stopRequested ? "stopped_while_running" : "interrupted_locally", params: {} },
          events,
        };
      }
      if (ended.type === "turn.start-failed" || turnStatus(ended.payload) === "failed") {
        return { kind: "failed", reason: describeTurnFailure(ended.payload), events };
      }
      const reply = lastAgentMessage(this.turnEvents(sessionId, startSeq), turnId);
      return {
        kind: "completed",
        reply: reply.trim() === "" ? this.ownerMessages().room.noTextReply : reply,
        events,
      };
    } finally {
      unsubscribe();
      active.onStop = null;
      active.abandon = null;
      if (ticker !== null) clearInterval(ticker);
      if (stopTimer !== null) clearTimeout(stopTimer);
    }
  }

  private requestStop(active: ActiveRun): void {
    active.stopRequested = true;
    if (active.sessionId === null || active.turnId === null || active.interruptSent) {
      return;
    }
    active.interruptSent = true;
    active.onStop?.();
    void this.interruptQuietly(active.sessionId, active.turnId);
  }

  private async interruptQuietly(sessionId: string, turnId: string): Promise<void> {
    try {
      await this.deps.interrupts.interrupt(sessionId, { turnId });
    } catch (error) {
      this.log({ event: "suduo.room_run.interrupt_failed", sessionId, message: logMessageOf(error) });
    }
  }

  private turnEvents(sessionId: string, startSeq: number): Array<EventEnvelope<string, JsonValue>> {
    const events: Array<EventEnvelope<string, JsonValue>> = [];
    let after = startSeq;
    while (events.length < EVENTS_MAX) {
      const page = this.deps.events.listAfter(sessionId, after, EVENTS_PAGE);
      if (page.length === 0) break;
      for (const record of page) {
        events.push({
          schemaVersion: 1,
          seq: record.seq,
          eventId: record.eventId,
          sessionId: record.sessionId,
          source: record.source,
          type: record.type,
          payload: record.payload,
          threadRef: record.threadRef,
          turnRef: record.turnRef,
          ts: record.ts,
        });
      }
      after = page.at(-1)!.seq;
      if (page.length < EVENTS_PAGE) break;
    }
    return events;
  }

  /**
   * 本回合的执行过程：只取 turnId 对得上的事件。房间任务会话里所有者自己发的消息（会话页只读，
   * 但旧版本 / 别的入口仍可能发）不属于这次任务，不能传到房间（ADR-0009「私有部分不变」）。
   */
  private collectEvents(
    sessionId: string,
    startSeq: number,
    turn: { turnId: string | null; clientTurnId: string | null },
  ): Array<EventEnvelope<string, JsonValue>> {
    return compactRunEvents(
      this.turnEvents(sessionId, startSeq).filter((event) => belongsToTurn(event, turn)),
      this.ownerMessages(),
    );
  }

  /** 所有者的界面语言的字典：替 Agent 写进房间的固定文字、原因里的报错原文用它。 */
  private ownerMessages(): ServerMessages {
    return messagesFor(this.deps.ownerLocale());
  }

  /** 原因里嵌的报错原文：本机服务的报错按所有者的界面语言，其它（系统、第三方）用原文。 */
  private errorDetail(error: unknown): string {
    return errorTextOf(error)(this.ownerMessages());
  }

  /**
   * 回写结果。带执行过程发不出去时退一步不带执行过程再发一次（完整过程本机会话里有）；
   * 仍因远程暂不可用失败就记下来，下次同步再发——任务不会一直停在执行中。
   */
  private async report(runId: string, outcome: Exclude<Outcome, { kind: "abandoned" }>): Promise<void> {
    let result = await this.deliver(runId, outcome, { retry: true });
    const bare = withoutEvents(outcome);
    if (result !== "delivered" && bare !== outcome) {
      result = await this.deliver(runId, bare, { retry: false });
    }
    if (result === "unavailable") {
      this.unreported.set(runId, bare);
      this.scheduleRetrySync();
    } else {
      this.settled.add(runId);
    }
  }

  /**
   * 发一次结果；`retry` 时远程暂不可用按间隔重试。
   * unavailable = 远程暂不可用，或本机登录失效 / 服务地址变了（重新登录后能发）：记下来重发；
   * rejected = 远程不收（400 / 404 / 413 等：任务不存在、格式不符），重发也没用。
   */
  private async deliver(
    runId: string,
    outcome: Exclude<Outcome, { kind: "abandoned" }>,
    options: { retry: boolean },
  ): Promise<ReportResult> {
    const attempt = () =>
      outcome.kind === "completed"
        ? this.deps.remote.completeAgentRun(runId, {
            replyBody: clipReply(withoutNul(outcome.reply), this.ownerMessages()),
            summary: withoutNul(summaryOf(outcome.reply)),
            events: outcome.events,
          })
        : this.deps.remote.finishAgentRun(runId, {
            status: outcome.kind,
            ...reasonFields(outcome.reason),
            ...(outcome.events === undefined ? {} : { events: outcome.events }),
          });
    const waits = options.retry ? this.reportRetryMs : [];
    for (let index = 0; ; index += 1) {
      try {
        await attempt();
        return "delivered";
      } catch (error) {
        const wait = waits[index];
        const rejected = isRejected(error);
        if (wait === undefined || rejected) {
          this.log({ event: "suduo.room_run.report_failed", runId, kind: outcome.kind, message: logMessageOf(error) });
          if (!rejected) {
            return "unavailable";
          }
          if (outcome.kind === "completed" && !isNotFound(error)) {
            // 远程不收这个回答（例如格式不符）：改成失败收尾，任务不至于一直停在执行中。
            return this.deliver(
              runId,
              {
                kind: "failed",
                reason: { code: "reply_rejected", params: { detail: this.errorDetail(error) } },
                events: outcome.events,
              },
              options,
            );
          }
          return "rejected";
        }
        await new Promise((resolve) => setTimeout(resolve, wait).unref());
      }
    }
  }

  /** 开始 / 回写失败后按退避安排一次同步（定时同步之外更快地重取）；已安排过就不重复。 */
  private scheduleRetrySync(): void {
    if (this.retryTimer !== null || this.stopped) {
      return;
    }
    const wait = this.startRetryMs[Math.min(this.startFailures, this.startRetryMs.length - 1)] ?? 60_000;
    this.startFailures += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.sync();
    }, wait);
    this.retryTimer.unref();
  }

  private log(line: Record<string, unknown>): void {
    (this.deps.log ?? ((value) => console.info(JSON.stringify(value))))(line);
  }
}

function clipText(text: string, limit: number): string {
  const characters = Array.from(text);
  return characters.length > limit ? characters.slice(0, limit - 1).join("") + "…" : text;
}

function clipReply(reply: string, t: ServerMessages): string {
  if (reply.length <= REPLY_MAX) return reply;
  const note = t.room.replyClipped;
  return reply.slice(0, REPLY_MAX - note.length) + note;
}

/** 进度回写的字段：英文兜底文字 + code + 计数（没有计数时不带参数）。 */
function progressFields(tracker: RunProgressTracker): AgentRunProgressRequest {
  const { code, params } = tracker.progress();
  return {
    progress: withoutNul(agentRunProgressFallback(code, params)),
    progressCode: code,
    ...(Object.keys(params).length === 0 ? {} : { progressParams: params }),
  };
}

/**
 * 原因回写的字段：code + 参数 + 英文兜底文字（中英双语技术设计 §4.3）。
 * 参数里的字符串（报错原文、路径）去掉 NUL、截到远程的上限；兜底文字按截过的参数生成，再截到上限。
 */
function reasonFields(reason: AgentRunReason): Pick<FinishAgentRunRequest, "reason" | "reasonCode" | "reasonParams"> {
  const params: AgentRunTextParams = {};
  for (const [key, value] of Object.entries(reason.params as AgentRunTextParams)) {
    params[key] = typeof value === "string" ? clipText(withoutNul(value), REASON_MAX) : value;
  }
  const clipped = { ...reason, params } as AgentRunReason;
  return {
    reason: clipText(withoutNul(agentRunReasonFallback(clipped.code, clipped.params)), REASON_MAX),
    reasonCode: reason.code,
    ...(Object.keys(params).length === 0 ? {} : { reasonParams: params }),
  };
}

function compareQueued(a: AgentRunSummaryDto, b: AgentRunSummaryDto): number {
  const pa = a.queuePosition ?? Number.MAX_SAFE_INTEGER;
  const pb = b.queuePosition ?? Number.MAX_SAFE_INTEGER;
  if (pa !== pb) return pa - pb;
  return Date.parse(a.createdAt) - Date.parse(b.createdAt);
}

function isTerminal(type: string): boolean {
  return type === "turn.completed" || type === "turn.interrupted" || type === "turn.start-failed";
}

function turnStatus(payload: JsonValue): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const turn = payload["turn"];
  if (turn === null || typeof turn !== "object" || Array.isArray(turn)) return null;
  return typeof turn["status"] === "string" ? turn["status"] : null;
}

/** 本回合最后一条完整的助手消息（item.completed 里的 agentMessage）。 */
function lastAgentMessage(events: ReadonlyArray<EventEnvelope<string, JsonValue>>, turnId: string | null): string {
  let reply = "";
  for (const event of events) {
    if (event.type !== "item.completed" || event.turnRef?.turnId !== turnId) continue;
    const payload = event.payload;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) continue;
    const item = payload["item"];
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    if (item["type"] === "agentMessage" && typeof item["text"] === "string" && item["text"].trim() !== "") {
      reply = item["text"];
    }
  }
  return reply;
}

/** 本回合的事件；用户消息（message.submitted）还没有 turnRef，按 clientTurnId 认。 */
function belongsToTurn(
  event: EventEnvelope<string, JsonValue>,
  turn: { turnId: string | null; clientTurnId: string | null },
): boolean {
  if (event.turnRef !== null && event.turnRef !== undefined) {
    return event.turnRef.turnId === turn.turnId;
  }
  const payload = event.payload;
  return (
    event.type === "message.submitted" &&
    turn.clientTurnId !== null &&
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    payload["clientTurnId"] === turn.clientTurnId
  );
}

function withoutEvents(outcome: Exclude<Outcome, { kind: "abandoned" }>): Exclude<Outcome, { kind: "abandoned" }> {
  if (outcome.events === undefined || outcome.events.length === 0) return outcome;
  return outcome.kind === "completed" ? { ...outcome, events: [] } : { kind: outcome.kind, reason: outcome.reason };
}

/** 远程没有这条任务（或已不归本机 Agent）：结果不用再发。 */
function isNotFound(error: unknown): boolean {
  return (error as { statusCode?: unknown }).statusCode === 404;
}

/**
 * 远程明确不收（重发也没用）。登录失效（401 / 403）与本机报的「未配置 / 服务地址已变更」（409）
 * 不算：重新登录后能发，按暂不可用记下来重发。
 */
function isRejected(error: unknown): boolean {
  const { statusCode: status, code } = error as { statusCode?: unknown; code?: unknown };
  if (code === "AUTH_INVALID" || code === "REMOTE_SERVICE_NOT_CONFIGURED") return false;
  return (
    typeof status === "number" &&
    status >= 400 &&
    status < 500 &&
    status !== 401 &&
    status !== 403 &&
    status !== 408 &&
    status !== 409 &&
    status !== 429
  );
}

/** 日志里的报错说明：本机日志不翻译，`ApiError` 等按字典生成的取英文，其它用原文。 */
function logMessageOf(error: unknown): string {
  return errorTextOf(error)(messagesFor("en"));
}
