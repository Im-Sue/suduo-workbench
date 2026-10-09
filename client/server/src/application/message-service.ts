import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  type JsonValue,
  type Locale,
  type MessageContent,
  type RuntimeInput,
  type RuntimeNoticePayload,
  type RuntimeRegistry as RuntimeRegistryContract,
  type RuntimeToolSpec,
  type SendMessageAccepted,
  type SendMessageRequest,
  type StartThreadResult,
} from "@suduo/client-contracts";
import type { EventLedger } from "./event-ledger.js";
import type { EventRecord, EventRepository } from "../infrastructure/db/repositories/event-repository.js";
import type { GitService } from "./git-service.js";
import type { ProjectRepository } from "../infrastructure/db/repositories/project-repository.js";
import type { SessionRepository } from "../infrastructure/db/repositories/session-repository.js";
import type {
  SessionThreadRecord,
  SessionThreadRepository,
} from "../infrastructure/db/repositories/session-thread-repository.js";
import { ApiError, IndeterminateOperationError } from "./api-error.js";
import type { RuntimeSupervisor } from "./runtime-supervisor.js";
import { WorkspaceContextResolver } from "./workspace-context.js";
import { sessionRuntimeApprovalMode } from "./approval-mode-cap.js";
import { sessionHandles } from "./context/session-handles.js";
import { SchedulerCancelledError, type SchedulerSource, type TurnScheduler, type TurnTicket } from "./scheduler/turn-scheduler.js";
import { toolServerTools } from "./runtime-supervisor.js";
import { messagesFor } from "../i18n/messages/index.js";
import type { SkillRootsProvider } from "./skill-roots.js";

export class MessageService {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly sessions: SessionRepository,
    private readonly threads: SessionThreadRepository,
    private readonly runtimes: RuntimeRegistryContract,
    private readonly supervisor: RuntimeSupervisor,
    private readonly ledger: EventLedger,
    /** resume 失败、重建全新线程时重新生成需求卡与工具（ADR-0008）；不传则重建为普通线程。 */
    private readonly threadSetup: { rebuildSetup(sessionId: string): Promise<{ developerInstructions?: string; dynamicTools?: RuntimeToolSpec[] } | null> } | null,
    private readonly skillRoots: SkillRootsProvider = { roots: () => [] },
    private readonly git: GitService | null = null,
    /** 发消息前把 skills 根目录同步进 runtime 注册表（否则 skill 引用被静默忽略）。 */
    private readonly syncSkillRoots: ((projectRoot: string) => Promise<void>) | null = null,
    private readonly workspaces: WorkspaceContextResolver = new WorkspaceContextResolver(),
    private readonly approvalModeEnvironment: NodeJS.ProcessEnv = process.env,
  ) {}

  /** 本机回合调度（多 Agent 协作 S8）；没接时不限并发（测试与老调用方）。 */
  private scheduler: TurnScheduler | null = null;

  setScheduler(scheduler: TurnScheduler): void {
    this.scheduler = scheduler;
  }

  async send(
    sessionId: string,
    input: SendMessageRequest,
    idempotencyKey: string,
    /**
     * locale：回合前自动存档的提交标题用的语言（发消息的请求的语言）；房间任务不传，用记下的界面语言。
     * source / label：在本机队列与运行面板里的来源与说明（多 Agent 协作 S8）。
     * waitForTurn：名额满了时等到轮到再返回（房间任务、委派等内部调用方）；不传时先返回「排队中」，轮到了再开回合。
     */
    options: { locale?: Locale; source?: SchedulerSource; label?: string; waitForTurn?: boolean } = {},
  ): Promise<SendMessageAccepted> {
    if (!Array.isArray(input.content)) {
      throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.contentNotArray);
    }
    const session = this.sessions.getById(sessionId);
    if (!session) {
      throw new ApiError(404, "NOT_FOUND", (t) => t.session.notFound);
    }
    if (session.state !== "active") {
      throw new ApiError(
        409,
        "VERSION_CONFLICT",
        (t) => t.session.notActive,
        { state: session.state },
      );
    }
    const project = this.projects.getById(session.projectId);
    if (!project || project.state !== "active") {
      throw new ApiError(409, "VERSION_CONFLICT", (t) => t.session.projectUnavailable);
    }
    // 会话在哪个目录干活：并行试做的版本在自己的 worktree 里（S10），其余在项目目录。
    const workspace = this.workspaces.forSession(project, sessionId);
    // 回合前自动存档（按项目开关；失败不阻塞发消息）。房间任务是只读沙箱，不会改文件，不存档；
    // 试做版本不动原工作目录，也不存档（它的改动在自己的分支上，采用时由 SuDuo 提交）。
    const checkpoints = session.kind !== "room_task" && workspace.mode === "shared";
    if (checkpoints) {
      await this.git?.autoCheckpoint(project.id, project.rootPath, options.locale);
    }
    let binding = this.route(sessionId, input);
    // resume 失败时自动重建 thread（F3 承诺：会话必须能继续新回合）。
    const threadSetup = this.threadSetup;
    const rebuilt = await this.supervisor.ensureReadyOrRebuild({
      session,
      workspace,
      binding,
      ...(threadSetup === null
        ? {}
        : { rebuildSetup: () => threadSetup.rebuildSetup(sessionId) }),
    });
    if (rebuilt) {
      binding = this.rebindPrimary(sessionId, binding, rebuilt);
    }
    const runtimeInput = await mapContent(
      input.content,
      project.rootPath,
      this.skillRoots.roots(),
    );
    // 消息里引用了本机别的会话（suduo://session/<ID>，多 Agent 协作 S7）：告诉 Agent 用 SuDuo 工具读，
    // 别当网址去打开。只加给 Agent，账本里的消息照原样；这个线程没有会话工具时不加（说了也用不了）。
    if (sessionHandles(input.content).length > 0 && toolServerTools(binding.metadata)?.includes("suduo_session_read") === true) {
      runtimeInput.push({ type: "text", text: messagesFor(session.locale).sessionContext.handleHint });
    }
    if (runtimeInput.some((item) => item.type === "skill")) {
      // 失败不阻塞发送：至少让消息发出去，而不是整条消息卡住。
      await this.syncSkillRoots?.(project.rootPath).catch(() => undefined);
    }
    const clientTurnId = stableClientTurnId(sessionId, idempotencyKey);
    const submitted = this.ledger.append({
      sessionId,
      sessionThreadId: binding.id,
      event: {
        source: "suduo:api",
        type: "message.submitted",
        payload: {
          content: input.content,
          clientTurnId,
        },
        threadRef: binding.threadRef,
        turnRef: null,
        ts: Date.now(),
        dedupeKey: "message:" + sessionId + ":" + idempotencyKey,
      },
    });
    const threadBinding = binding;
    /**
     * 开回合。queuedEarlier：在本机队列里等过——轮到时按会话现在的样子开（排队期间改了权限 / 模型、被删除或归档都要算数），
     * 回合前存档也在这时补一次。
     */
    const startNow = async (ticket: TurnTicket | null, queuedEarlier = false): Promise<SendMessageAccepted> => {
      let current = session;
      if (queuedEarlier) {
        const fresh = this.sessions.getById(sessionId);
        const freshProject = this.projects.getById(project.id);
        if (fresh === null || fresh.state !== "active" || freshProject === null || freshProject.state !== "active") {
          ticket?.release();
          throw new QueuedSessionGoneError(fresh?.state ?? "deleted");
        }
        current = fresh;
        if (checkpoints) {
          await this.git?.autoCheckpoint(project.id, project.rootPath, options.locale);
        }
      }
      let turn;
      try {
        turn = await this.runtimes.get(threadBinding.threadRef.runtimeId).startTurn({
          sessionId,
          threadRef: threadBinding.threadRef,
          clientTurnId,
          input: runtimeInput,
          projectRoot: workspace.executionRoot,
          workspaceRoots: [workspace.executionRoot],
          // 房间任务会话固定为只读档（Codex 换算为只读 + 联网 + 不审批）；其余按会话审批档。
          approvalMode: sessionRuntimeApprovalMode(current, this.approvalModeEnvironment),
          // 审批档每回合都显式下发；模型 / 推理强度只在需要改变时由 runtime 下发
          // （null = 跟随全局默认，粘性覆盖的回退由 runtime 负责）。
          model: current.model,
          reasoningEffort: current.reasoningEffort,
        });
      } catch (error) {
        ticket?.release();
        throw new IndeterminateOperationError((t) => t.session.turnStartIndeterminate, {
          cause: error,
        });
      }
      ticket?.started(turn.turnRef.turnId);
      if (queuedEarlier && ticket !== null) {
        // 排队的这一条开起来了：界面据此撤掉排队提示（按 clientTurnId 对上，不靠回合开始事件猜）。
        this.appendQueueEvent(sessionId, threadBinding, "turn.dequeued", { clientTurnId, queueItemId: ticket.id, reason: "started", turnId: turn.turnRef.turnId });
      }
      this.sessions.touchActivity(sessionId, turn.acceptedAt);
      return {
        sessionId,
        messageEventSeq: submitted.seq,
        threadRef: threadBinding.threadRef,
        turnRef: turn.turnRef,
        acceptedAt: turn.acceptedAt,
        // 归属关联键：前端用它在事件流里找 userMessage item，而不是用上面的 turnRef。
        clientTurnId,
      };
    };

    // 本机调度（多 Agent 协作 S8，需求 4.11）：会话里已有回合在跑、又没有排队项时，这条由运行时并入或排在会话内，
    // 不另占名额（运行时自己接着开的回合开始时由调度器补登记）；有排队项时排在它后面，保持先后。
    const scheduler = this.scheduler;
    if (scheduler === null || (scheduler.sessionRunning(sessionId) && !scheduler.sessionPending(sessionId))) {
      return startNow(null);
    }
    const ticket = scheduler.request({
      sessionId,
      agentId: session.agentId,
      source: options.source ?? "user",
      label: options.label ?? session.title,
    });
    if (ticket.immediate) {
      return startNow(ticket);
    }
    if (options.waitForTurn === true) {
      try {
        await ticket.admitted;
      } catch (error) {
        this.appendQueueEvent(sessionId, threadBinding, "turn.dequeued", { clientTurnId, queueItemId: ticket.id, reason: cancelReason(error) });
        throw error;
      }
      try {
        return await startNow(ticket, true);
      } catch (error) {
        if (!(error instanceof QueuedSessionGoneError)) throw error;
        this.appendQueueEvent(sessionId, threadBinding, "turn.dequeued", { clientTurnId, queueItemId: ticket.id, reason: error.state });
        throw new ApiError(409, "VERSION_CONFLICT", (t) => t.session.notActive, { state: error.state });
      }
    }
    // 排队不拒绝：先告诉界面排在第几位，轮到了再开回合；排队中被取消就记一笔。
    const position = scheduler.position(ticket.id) ?? 1;
    this.appendQueueEvent(sessionId, threadBinding, "turn.queued", {
      clientTurnId,
      queueItemId: ticket.id,
      position,
      agentId: session.agentId,
      source: options.source ?? "user",
    });
    void ticket.admitted.then(
      () =>
        startNow(ticket, true).catch((error: unknown) => {
          if (error instanceof QueuedSessionGoneError) {
            // 排队期间会话被删除或归档：不开回合，记一笔。
            this.appendQueueEvent(sessionId, threadBinding, "turn.dequeued", { clientTurnId, queueItemId: ticket.id, reason: error.state });
            return;
          }
          this.appendQueueEvent(sessionId, threadBinding, "turn.start-failed", {
            clientTurnId,
            error: { message: error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error) },
          });
        }),
      (error: unknown) => {
        this.appendQueueEvent(sessionId, threadBinding, "turn.dequeued", { clientTurnId, queueItemId: ticket.id, reason: cancelReason(error) });
      },
    );
    return {
      sessionId,
      messageEventSeq: submitted.seq,
      threadRef: threadBinding.threadRef,
      turnRef: null,
      acceptedAt: Date.now(),
      clientTurnId,
      queued: { itemId: ticket.id, position },
    };
  }

  /** 排队相关的账本事件（不属于任何回合）。 */
  private appendQueueEvent(sessionId: string, binding: SessionThreadRecord, type: string, payload: JsonValue): void {
    this.ledger.append({
      sessionId,
      sessionThreadId: binding.id,
      event: {
        source: "suduo:scheduler",
        type,
        payload,
        threadRef: binding.threadRef,
        turnRef: null,
        ts: Date.now(),
      },
    });
  }

  /** resume 失败重建后：老绑定标记 detached，新 thread 挂为 primary 并入账告知前端。 */
  private rebindPrimary(
    sessionId: string,
    oldBinding: SessionThreadRecord,
    started: StartThreadResult,
  ): SessionThreadRecord {
    this.threads.markDetached(oldBinding.id);
    let primaryRecord: SessionThreadRecord | null = null;
    for (const [offset, runtimeThread] of started.threads.entries()) {
      const isPrimary =
        runtimeThread.threadRef.runtimeId ===
          started.primaryThread.threadRef.runtimeId &&
        runtimeThread.threadRef.threadId ===
          started.primaryThread.threadRef.threadId;
      const record = this.threads.attach({
        sessionId,
        threadRef: runtimeThread.threadRef,
        role: runtimeThread.role,
        ordinal: oldBinding.ordinal + offset + 1,
        primary: isPrimary,
        metadata: runtimeThread.metadata,
      });
      if (isPrimary) {
        primaryRecord = record;
      }
    }
    if (!primaryRecord) {
      throw new IndeterminateOperationError((t) => t.session.rebuiltWithoutPrimary);
    }
    const now = Date.now();
    this.ledger.append({
      sessionId,
      sessionThreadId: primaryRecord.id,
      event: {
        source: "suduo:api",
        type: "thread.attached",
        payload: {
          reason: "resume-failed-rebuilt",
          previousThreadId: oldBinding.threadRef.threadId,
        },
        threadRef: primaryRecord.threadRef,
        turnRef: null,
        ts: now,
        dedupeKey: `rebind:${oldBinding.id}:${primaryRecord.threadRef.threadId}`,
      },
    });
    this.ledger.append({
      sessionId,
      sessionThreadId: primaryRecord.id,
      event: {
        source: "suduo:api",
        type: "runtime.warning",
        // 前端按 code 用看的人的语言渲染；message 是给旧客户端的英文兜底。
        payload: {
          code: "thread-rebuilt",
          message:
            "This session's earlier context couldn't be restored, so a new thread was started to continue. The AI no longer remembers the earlier conversation, but the conversation history and file changes are all kept.",
        } satisfies RuntimeNoticePayload,
        threadRef: primaryRecord.threadRef,
        turnRef: null,
        ts: now,
        dedupeKey: `rebind-warn:${oldBinding.id}`,
      },
    });
    return primaryRecord;
  }

  private route(sessionId: string, input: SendMessageRequest): SessionThreadRecord {
    if (input.targetThreadRef) {
      const binding = this.threads.getBySessionAndThreadRef(
        sessionId,
        input.targetThreadRef,
      );
      if (!binding || binding.state !== "attached") {
        throw new ApiError(404, "NOT_FOUND", (t) => t.session.targetThreadNotBound);
      }
      return binding;
    }
    const primaries = this.threads
      .listBySession(sessionId)
      .filter((binding) => binding.primary && binding.state === "attached");
    if (primaries.length === 0) {
      throw new ApiError(
        409,
        "SESSION_HAS_NO_PRIMARY_THREAD",
        (t) => t.session.noPrimaryThread,
      );
    }
    if (primaries.length !== 1) {
      throw new ApiError(
        409,
        "SESSION_PRIMARY_THREAD_AMBIGUOUS",
        (t) => t.session.primaryThreadAmbiguousRouting,
      );
    }
    return primaries[0] as SessionThreadRecord;
  }
}

async function mapContent(
  content: readonly MessageContent[],
  projectRoot: string,
  skillRoots: readonly string[],
): Promise<RuntimeInput[]> {
  if (content.length === 0 || content.length > 64) {
    throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.contentCount);
  }
  let totalText = 0;
  const result: RuntimeInput[] = [];
  for (const item of content) {
    if (item === null || typeof item !== "object") {
      throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.contentItemInvalid);
    }
    if (item.type === "text") {
      if (typeof item.text !== "string") {
        throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.textNotString);
      }
      totalText += item.text.length;
      if (item.text.length === 0) {
        throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.textEmpty);
      }
      result.push(item);
      continue;
    }
    if (item.type === "image-url") {
      if (typeof item.url !== "string") {
        throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.imageUrlNotString);
      }
      let protocol: string;
      try {
        protocol = new URL(item.url).protocol;
      } catch (error) {
        throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.imageUrlInvalid, undefined, {
          cause: error,
        });
      }
      if (protocol !== "http:" && protocol !== "https:") {
        throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.imageUrlProtocol);
      }
      result.push(item);
      continue;
    }
    if (item.type === "local-image") {
      if (typeof item.attachmentId !== "string") {
        throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.attachmentIdNotString);
      }
      if (!/^[A-Za-z0-9._-]{1,200}$/.test(item.attachmentId)) {
        throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.attachmentIdInvalid);
      }
      const path = await requireContainedFile(
        resolve(projectRoot, ".suduo", "attachments", item.attachmentId),
        projectRoot,
      );
      result.push({
        type: "local-image",
        path,
        ...(item.detail === undefined ? {} : { detail: item.detail }),
      });
      continue;
    }
    if (
      item.type !== "skill" ||
      typeof item.name !== "string" ||
      typeof item.path !== "string"
    ) {
      throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.contentTypeUnsupported);
    }
    const path = await requireSkillFile(item.path, projectRoot, skillRoots);
    result.push({ type: "skill", name: item.name, path });
  }
  if (totalText > 200_000) {
    throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.textTooLong);
  }
  return result;
}

async function requireSkillFile(
  path: string,
  projectRoot: string,
  configuredRoots: readonly string[],
): Promise<string> {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.skillPathNotAbsolute);
  }
  try {
    const resolvedPath = await realpath(path);
    if (!(await stat(resolvedPath)).isFile() || !resolvedPath.endsWith("SKILL.md")) {
      throw new Error("not a SKILL.md file");
    }
    const roots = [
      resolve(projectRoot, ".codex", "skills"),
      resolve(projectRoot, ".agents", "skills"),
      ...configuredRoots,
    ];
    for (const root of roots) {
      try {
        const resolvedRoot = await realpath(root);
        const rel = relative(resolvedRoot, resolvedPath);
        if (!rel.startsWith("..") && !isAbsolute(rel)) {
          return resolvedPath;
        }
      } catch {
        // Missing optional skill roots are ignored.
      }
    }
    throw new Error("skill outside configured roots");
  } catch (error) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      (t) => t.session.skillNotAllowed,
      undefined,
      { cause: error },
    );
  }
}

async function requireContainedFile(path: string, root: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.localPathNotAbsolute);
  }
  try {
    const [resolvedPath, resolvedRoot] = await Promise.all([
      realpath(path),
      realpath(root),
    ]);
    const rel = relative(resolvedRoot, resolvedPath);
    if (rel.startsWith("..") || isAbsolute(rel) || !(await stat(resolvedPath)).isFile()) {
      throw new Error("outside project or not a file");
    }
    return resolvedPath;
  } catch (error) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      (t) => t.session.localFileNotFound,
      undefined,
      { cause: error },
    );
  }
}

/** 发消息时生成的关联键（幂等键稳定映射；委派据此认出自己发给子会话的消息）。 */
export function stableClientTurnId(sessionId: string, key: string): string {
  return createHash("sha256")
    .update("suduo-turn\0" + sessionId + "\0" + key)
    .digest("hex");
}

function cancelReason(error: unknown): string {
  return error instanceof SchedulerCancelledError ? error.reason : "cancelled";
}

/** 排队的消息轮到时会话已经不能用了（删除 / 归档 / 项目不可用）。 */
class QueuedSessionGoneError extends Error {
  constructor(readonly state: string) {
    super("session no longer active: " + state);
    this.name = "QueuedSessionGoneError";
  }
}

/** 重启前还排着、没发出的一条消息（委派据此重新排队）。 */
export interface ClosedQueuedMessage {
  sessionId: string;
  clientTurnId: string;
  /** 排队时的来源（user / delegate / room …）。 */
  source: string;
  content: MessageContent[] | null;
}

/**
 * 本机服务启动时给重启前还在排队的消息收尾（多 Agent 协作 S8，技术设计 2.7「主会话的排队回合重启后不恢复，提示重发」）：
 * 队列只在内存里；`turn.queued` 之后没有出队（含「开起来了」）、开不起来记录的，记一笔「重启没发出」。
 * 会被自动重新排队的（委派，`willRequeue`）记为 requeued，界面不叫人重发。
 */
export function closeQueuedAfterRestart(
  events: Pick<EventRepository, "listQueueEvents" | "submittedContent">,
  ledger: Pick<EventLedger, "append">,
  willRequeue: (message: ClosedQueuedMessage) => boolean = () => false,
): ClosedQueuedMessage[] {
  const open = new Map<string, EventRecord>();
  for (const event of events.listQueueEvents()) {
    const payload = event.payload !== null && typeof event.payload === "object" && !Array.isArray(event.payload) ? event.payload : {};
    const clientTurnId = typeof payload["clientTurnId"] === "string" ? payload["clientTurnId"] : null;
    if (clientTurnId === null) continue;
    if (event.type === "turn.queued") {
      open.set(clientTurnId, event);
    } else {
      open.delete(clientTurnId);
    }
  }
  const closed: ClosedQueuedMessage[] = [];
  for (const [clientTurnId, queued] of open) {
    const payload = queued.payload as Record<string, JsonValue>;
    const source = typeof payload["source"] === "string" ? payload["source"] : "user";
    // 只有委派的要重发，才去取内容。
    const content = source === "delegate" ? events.submittedContent(queued.sessionId, clientTurnId) : null;
    const message: ClosedQueuedMessage = {
      sessionId: queued.sessionId,
      clientTurnId,
      source,
      content: Array.isArray(content) && content.length > 0 ? (content as unknown as MessageContent[]) : null,
    };
    ledger.append({
      sessionId: queued.sessionId,
      sessionThreadId: queued.sessionThreadId,
      event: {
        source: "suduo:scheduler",
        type: "turn.dequeued",
        payload: { clientTurnId, queueItemId: payload["queueItemId"] ?? null, reason: willRequeue(message) ? "requeued" : "restart" },
        threadRef: queued.threadRef,
        turnRef: null,
        ts: Date.now(),
        dedupeKey: "queue-restart:" + clientTurnId,
      },
    });
    closed.push(message);
  }
  return closed;
}
