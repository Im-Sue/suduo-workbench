import type {
  DelegationDto,
  DelegationResultDto,
  DelegationStatus,
  EventEnvelope,
  JsonValue,
  Locale,
  MessageContent,
  RuntimeApprovalMode,
  SessionDto,
} from "@suduo/client-contracts";
import { randomUUID } from "node:crypto";
import { messagesFor, type ServerMessages } from "../../i18n/messages/index.js";
import type { DelegationRecord, DelegationRepository } from "../../infrastructure/db/repositories/delegation-repository.js";
import type { SessionRecord, SessionRepository } from "../../infrastructure/db/repositories/session-repository.js";
import type { SessionThreadRepository } from "../../infrastructure/db/repositories/session-thread-repository.js";
import { ApiError, type ErrorText } from "../api-error.js";
import { sessionRuntimeApprovalMode } from "../approval-mode-cap.js";
import { changedPaths, type ProjectedRound } from "../context/session-projection.js";
import type { EventBroker } from "../event-broker.js";
import type { EventLedger } from "../event-ledger.js";
import type { SchedulerSource } from "../scheduler/turn-scheduler.js";

/**
 * 委派（多 Agent 协作 S8，技术设计 2.10 / 4.4、需求 4.3 / 4.11）：主会话把子任务交给本机另一个 Agent。
 *
 * - 深度 1（R2）：只有主会话（不是委派出来的会话）能委派；子会话拿不到委派工具。
 * - 子会话：同一需求 / 项目、同一代码目录，权限不高于发起会话（R3），首条消息是任务说明；回合经本机调度排队（R4）。
 * - 进度与结果：跟着子会话的回合走；结果 = 最终回答 + 改动文件与增删行数 + 子会话句柄。
 * - 交回：发起 Agent 正在等（delegate_wait）就直接给它；发起回合已结束时，勾了「自动交回」就给发起会话开新一轮，
 *   否则卡片上显示「让原 Agent 继续」由用户决定。
 * - 发起会话的时间线上每次变化记一条 `delegation.updated`（委派卡片取最新的）。
 * - 重启：排队中的重新排队；在跑的标「已中断」并告知发起会话（运行时进程随本机服务重启，回合接不上）。
 */
export interface DelegationDependencies {
  delegations: DelegationRepository;
  sessions: Pick<SessionRepository, "getById">;
  threads: Pick<SessionThreadRepository, "getPrimary">;
  approvals: { countPendingBySession(sessionId: string): number };
  ledger: Pick<EventLedger, "append">;
  broker: Pick<EventBroker, "subscribe">;
  /** 发消息（经本机调度）。 */
  messages: {
    send(
      sessionId: string,
      input: { content: MessageContent[] },
      idempotencyKey: string,
      options: { locale?: Locale; source?: SchedulerSource; label?: string },
    ): Promise<{ turnRef: { turnId: string } | null; queued?: { itemId: string; position: number } }>;
  };
  /** 发消息时的关联键（与消息服务同一算法）：委派发出前先记下，认得出子会话里哪些事件是自己的。 */
  clientTurnId(sessionId: string, idempotencyKey: string): string;
  /** 这个会话的运行时会把回合进行中再发的消息并入那一轮（Codex），而不是排在会话内（Claude、ACP）。 */
  mergesIntoRunningTurn(sessionId: string): boolean;
  interrupt(sessionId: string, turnId: string): Promise<unknown>;
  scheduler: {
    sessionRunning(sessionId: string): boolean;
    /** 撤掉本机队列里的一项（委派自己排着的消息）。 */
    cancel(itemId: string): boolean;
    queuePosition(sessionId: string): number | null;
    /** 发起回合等委派结果时让出名额（子会话要的可能正是同一家的名额）；返回收回的函数。 */
    lend(sessionId: string): () => void;
  };
  /** 子会话的回合（读结果与进度）。 */
  rounds(sessionId: string): ProjectedRound[];
  /** 建子会话：同一需求 / 项目、记下委派关系、带子任务的角色说明，不挂委派工具。 */
  createChild(input: { parent: SessionRecord; agentId: string; approvalMode: RuntimeApprovalMode; locale: Locale; task: string }): Promise<SessionDto>;
  /** 这家 Agent 能不能委派（接上了、没停用）；不能时给原因。 */
  agentProblem(agentId: string): ErrorText | null;
  agentName(agentId: string): string;
  now?: () => number;
  log?: (line: Record<string, unknown>) => void;
}

/** 委派发给子会话的一条消息（按 clientTurnId 认）。 */
interface Tracked {
  clientTurnId: string;
  /** 归属的回合；还没对上为 null。 */
  turnId: string | null;
  /** 由子会话的 userMessage 条目证实（比发送回执可靠）。 */
  confirmed: boolean;
  /** 发送回执 / 出队记录给的回合：委派自己开的回合（与 turnId 相同才是它自己的，取消时才中断）。 */
  openedTurnId: string | null;
  /** 发送时子会话有回合在跑、运行时会把它并入那一轮（Codex）：回执给的回合 ID 不会出现。 */
  merging: boolean;
  /** 还在本机队列里时的队列项。 */
  queueItemId: string | null;
}

type Outcome = { status: DelegationStatus; error: string | null };

const FINISHED: ReadonlySet<DelegationStatus> = new Set(["completed", "failed", "cancelled", "interrupted"]);
const MODE_RANK: Record<RuntimeApprovalMode, number> = { readonly: 0, ask: 1, auto: 2, full: 3 };

export class DelegationService {
  private readonly watching = new Map<string, () => void>();
  private readonly waiters = new Map<string, Set<() => void>>();
  /**
   * 委派自己发给子会话的消息（按 clientTurnId）与它们开起来的回合：都结束了这一轮委派才算做完（排着的补充消息、
   * Claude / ACP 会话内排着的下一轮都算它的）。用户在子会话里自己发的消息不在这里，不影响委派。
   */
  private readonly pending = new Map<string, Tracked[]>();
  /** 子会话里开始 / 结束了、还没对上委派消息的回合（开始、终态先于发送回执到达时，回执来了再认）。 */
  private readonly unclaimed = new Map<string, Map<string, { ended: Outcome | null }>>();
  /** 委派这一轮已经结束的消息的结局（都结束时汇总：有做完的就算做完）。 */
  private readonly outcomes = new Map<string, Outcome[]>();
  /** 重启后要重新排队的委派消息（等本机服务开始监听、线程续接之后再发）。 */
  private requeueList: Array<{ id: string; childSessionId: string; content: MessageContent[] }> = [];

  constructor(private readonly deps: DelegationDependencies) {}

  /**
   * 本机服务启动时（技术设计 2.7）：排队中的委派重新排队——重启前排着、没发出的那几条（`closed`，按 clientTurnId 认出是
   * 委派发的）在 `requeueAfterRestart` 里重发；运行中的回合随进程没了，标「已中断」并告知发起会话。
   */
  recoverAfterRestart(closed: ReadonlyArray<{ sessionId: string; source: string; content: MessageContent[] | null }> = []): void {
    for (const record of this.deps.delegations.listUnfinished()) {
      // 重启前记下的消息都不作数了（队列与回合随进程没了），只认下面重发的。
      this.unwatch(record.id);
      const parent = this.deps.sessions.getById(record.parentSessionId);
      const text = messagesFor(parent?.locale ?? "zh-CN").delegation;
      const child = record.childSessionId === null ? null : this.deps.sessions.getById(record.childSessionId);
      const mine = child === null || child.state !== "active" ? [] : closed.filter((message) => message.sessionId === child.id && message.source === "delegate" && message.content !== null);
      if (record.status === "queued" && child !== null && mine.length > 0) {
        for (const message of mine) this.requeueList.push({ id: record.id, childSessionId: child.id, content: message.content! });
        continue;
      }
      this.update(record.id, { status: "interrupted", error: text.restartInterrupted, finishedAt: this.now() });
    }
  }

  /** 这个子会话里排着的委派消息重启后会不会重新排队（重启收尾据此不叫人重发）。 */
  willRequeue(childSessionId: string): boolean {
    const record = this.deps.delegations.getByChild(childSessionId);
    return record !== null && record.status === "queued";
  }

  /** 本机服务开始监听、已挂线程续接之后：把重启前排着的委派消息重发（重新排队）。 */
  async requeueAfterRestart(): Promise<void> {
    const list = this.requeueList;
    this.requeueList = [];
    for (const item of list) {
      const record = this.deps.delegations.getById(item.id);
      if (record === null || FINISHED.has(record.status)) continue;
      const parent = this.deps.sessions.getById(record.parentSessionId);
      await this.dispatch(record.id, item.childSessionId, item.content, `delegation:${record.id}:requeue:${randomUUID()}`, parent?.locale ?? "zh-CN", oneLine(record.task, 80)).catch(
        (error: unknown) => this.log({ event: "suduo.delegation.requeue_failed", id: record.id, message: String(error) }),
      );
    }
  }

  async start(input: {
    parentSessionId: string;
    agentId: string;
    task: string;
    files?: readonly string[];
    autoHandback?: boolean;
    approvalMode?: RuntimeApprovalMode;
    origin: "agent" | "user";
  }): Promise<DelegationDto> {
    const parent = this.deps.sessions.getById(input.parentSessionId);
    if (parent === null || parent.state === "deleted") throw new ApiError(404, "NOT_FOUND", (t) => t.session.notFound);
    // 子会话、评审会话、试做会话都不能委派（R2；试做各家各做一版，委派工具本来就不挂）。
    if (parent.kind !== "normal" || parent.relation === "delegate" || parent.relation === "review" || parent.relation === "trial") {
      throw new ApiError(400, "VALIDATION_ERROR", (t) => t.delegation.reply.notMain);
    }
    const problem = this.deps.agentProblem(input.agentId);
    if (problem !== null) throw new ApiError(400, "AGENT_NOT_READY", problem, { agentId: input.agentId });
    const task = input.task.trim();
    if (task === "") throw new ApiError(400, "VALIDATION_ERROR", (t) => t.delegation.reply.taskMissing);
    // 子权限不高于父（R3）：取发起会话当前生效的档与要求的档里低的那个。
    const parentMode = sessionRuntimeApprovalMode(parent);
    const approvalMode = input.approvalMode !== undefined && MODE_RANK[input.approvalMode] < MODE_RANK[parentMode] ? input.approvalMode : parentMode;
    const record = this.deps.delegations.create({
      parentSessionId: parent.id,
      agentId: input.agentId,
      task,
      origin: input.origin,
      autoHandback: input.autoHandback === true,
      now: this.now(),
    });
    this.emit(record);
    let child: SessionDto;
    try {
      child = await this.deps.createChild({ parent, agentId: input.agentId, approvalMode, locale: parent.locale, task });
    } catch (error) {
      this.update(record.id, { status: "failed", error: this.reason(error, parent.locale), finishedAt: this.now() });
      throw error;
    }
    // 建子会话要几秒（取远程需求、打水位线），这期间可能已经被叫停：记下子会话，不再发任务。
    const afterCreate = this.deps.delegations.update(record.id, { childSessionId: child.id }, this.now());
    if (FINISHED.has(afterCreate.status)) return this.dto(afterCreate);
    // 子会话与发起会话同一语言（建子会话时按发起会话的语言）。
    const text = messagesFor(parent.locale).delegation;
    return this.dispatch(
      record.id,
      child.id,
      [{ type: "text", text: text.firstMessage(task, input.files ?? []) }],
      `delegation:${record.id}:start`,
      parent.locale,
      oneLine(task, 80),
    );
  }

  /**
   * 把一条消息交给子会话：先记为运行中（排上队时子会话的 `turn.queued` 会改成排队中），发出去之后再看一眼——
   * 这期间被叫停了就把刚开的回合也停掉，不再改状态。
   */
  private async dispatch(id: string, childSessionId: string, content: MessageContent[], key: string, locale: Locale, label: string): Promise<DelegationDto> {
    this.update(id, { status: "running", delivered: false, error: null, finishedAt: null });
    this.watch(id, childSessionId);
    // 发出前就记下：排队、开始事件可能在发送返回前到达。
    const entry: Tracked = {
      clientTurnId: this.deps.clientTurnId(childSessionId, key),
      turnId: null,
      confirmed: false,
      openedTurnId: null,
      merging: this.deps.mergesIntoRunningTurn(childSessionId) && this.deps.scheduler.sessionRunning(childSessionId),
      queueItemId: null,
    };
    this.pending.set(id, [...(this.pending.get(id) ?? []), entry]);
    let accepted: Awaited<ReturnType<DelegationDependencies["messages"]["send"]>>;
    try {
      accepted = await this.deps.messages.send(childSessionId, { content }, key, { locale, source: "delegate", label });
    } catch (error) {
      const left = this.drop(id, [entry]);
      const current = this.require(id);
      if (FINISHED.has(current.status)) {
        if (left === 0) this.unwatch(id);
        return this.dto(current);
      }
      // 委派还有别的消息在做：状态不变，但要让调用方知道这条没发出去。
      if (left > 0) throw error;
      this.unwatch(id);
      return this.dto(this.update(id, { status: "failed", error: this.reason(error, locale), finishedAt: this.now() }));
    }
    if (accepted.queued !== undefined && entry.queueItemId === null && entry.turnId === null) entry.queueItemId = accepted.queued.itemId;
    if (accepted.turnRef !== null) this.bind(id, entry, accepted.turnRef.turnId, false);
    const current = this.deps.delegations.getById(id);
    if (current === null) return this.dto(this.require(id));
    if (current.status === "cancelled") {
      // 发出去的这期间被叫停了：排着的撤掉，开起来的停掉（还在开的，开起来时由出队记录停）。
      if (await this.stopEntry(id, childSessionId, entry)) this.settle(id, [entry], { status: "cancelled", error: null });
      return this.dto(this.require(id));
    }
    if (accepted.queued !== undefined && current.status === "running" && this.allQueued(id)) return this.dto(this.update(id, { status: "queued" }));
    return this.dto(current);
  }

  /** 委派的消息都还在本机队列里（没有在跑的）：卡片才显示「排队中」。 */
  private allQueued(id: string): boolean {
    const list = this.pending.get(id) ?? [];
    return list.length > 0 && list.every((entry) => entry.queueItemId !== null);
  }

  /**
   * 认定这条消息属于哪个回合。证据强弱：子会话的 userMessage 条目（clientId = clientTurnId，Codex 并入进行中一轮时
   * 只有它可信，回执给的回合 ID 不会出现在账本里）> 发送回执 / 排队开起来的出队记录。认定后看看这个回合是不是已经开始或结束了。
   */
  private bind(id: string, entry: Tracked, turnId: string, confirmed: boolean): void {
    if (!confirmed) entry.openedTurnId = turnId;
    if (entry.confirmed && !confirmed) return;
    entry.turnId = turnId;
    entry.confirmed = entry.confirmed || confirmed;
    entry.queueItemId = null;
    const seen = this.unclaimed.get(id)?.get(turnId);
    if (seen === undefined) return;
    if (seen.ended !== null) this.turnEnded(id, turnId, seen.ended);
    else this.turnStarted(id, turnId);
  }

  /** 去掉几条（没发出、开不起来、回合结束）；返回还剩几条。 */
  private drop(id: string, entries: readonly Tracked[]): number {
    const list = (this.pending.get(id) ?? []).filter((entry) => !entries.includes(entry));
    this.pending.set(id, list);
    return list.length;
  }

  /** 这条消息开的回合是委派自己的（不是并入了用户在子会话里正在跑的那一轮）。 */
  private own(entry: Tracked): boolean {
    return entry.turnId !== null && entry.turnId === entry.openedTurnId;
  }

  /**
   * 叫停委派的一条消息：排着的出队，委派自己开的回合中断；并入了别人回合的（用户在子会话里自己的那一轮）不中断、
   * 只是不再等它——返回 true 表示这条可以直接去掉。
   */
  private async stopEntry(id: string, childSessionId: string, entry: Tracked): Promise<boolean> {
    if (entry.queueItemId !== null) {
      this.deps.scheduler.cancel(entry.queueItemId);
      return false;
    }
    if (entry.merging && !entry.confirmed) return true;
    if (this.own(entry)) {
      await this.stopTurn(id, childSessionId, entry.turnId!);
      return false;
    }
    return entry.turnId !== null;
  }

  get(id: string): DelegationDto {
    return this.dto(this.require(id));
  }

  listByParent(parentSessionId: string): DelegationDto[] {
    return this.deps.delegations.listByParent(parentSessionId).map((record) => this.dto(record));
  }

  /** 还没结束的委派的子会话（发起会话的审批坞一并列出它们等确认的卡片，标明来源）。 */
  activeChildren(parentSessionId: string): Array<{ childSessionId: string; origin: { sessionId: string; sessionTitle: string; agentName: string; delegationId: string; task: string } }> {
    return this.deps.delegations
      .listByParent(parentSessionId)
      .filter((record) => record.childSessionId !== null && !FINISHED.has(record.status))
      .map((record) => ({
        childSessionId: record.childSessionId!,
        origin: {
          sessionId: record.childSessionId!,
          sessionTitle: this.deps.sessions.getById(record.childSessionId!)?.title ?? "",
          agentName: this.deps.agentName(record.agentId),
          delegationId: record.id,
          task: oneLine(record.task, 80),
        },
      }));
  }

  /** 发起会话里的委派（工具只能操作自己发起的）。 */
  ownedBy(parentSessionId: string, id: string): DelegationRecord | null {
    const record = this.deps.delegations.getById(id);
    return record !== null && record.parentSessionId === parentSessionId ? record : null;
  }

  /**
   * 等结果：做完了立即返回（并记为已交给发起会话）；没做完就等到做完、到点或调用方走了。
   * 到点返回时带进度，发起 Agent 可以再等。
   */
  async wait(id: string, maxMs: number, signal?: AbortSignal): Promise<{ delegation: DelegationDto; finished: boolean }> {
    let record = this.require(id);
    if (!FINISHED.has(record.status)) {
      const parentSessionId = record.parentSessionId;
      await new Promise<void>((resolve) => {
        const waiters = this.waiters.get(id) ?? new Set<() => void>();
        this.waiters.set(id, waiters);
        // 发起 Agent 挂在这里等、自己不干活：让出名额（子会话要的可能正是同一家的名额，不然两边互等）。
        const giveBack = this.deps.scheduler.lend(parentSessionId);
        // 发起回合停了（「只停这一轮」、出错）：Agent 已经不在等了，别把结果交给一个没人收的请求。
        // 本机调度在全局监听里还名额，排在会话监听之后，所以等这一轮事件分发完再看。
        const unsubscribe = this.deps.broker.subscribe(parentSessionId, (event) => {
          if (event.type !== "turn.completed" && event.type !== "turn.interrupted") return;
          queueMicrotask(() => {
            if (!this.deps.scheduler.sessionRunning(parentSessionId)) done();
          });
        });
        const done = () => {
          clearTimeout(timer);
          unsubscribe();
          giveBack();
          signal?.removeEventListener("abort", done);
          waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, Math.max(0, maxMs));
        signal?.addEventListener("abort", done, { once: true });
        waiters.add(done);
      });
      record = this.require(id);
    }
    const finished = FINISHED.has(record.status);
    // 只有发起回合还在跑、请求也还在时才算交到了发起 Agent 手上；否则留给自动交回或卡片上的「让原 Agent 继续」。
    const parentWaiting = signal?.aborted !== true && this.deps.scheduler.sessionRunning(record.parentSessionId);
    if (finished && !record.delivered && parentWaiting) record = this.update(id, { delivered: true });
    return { delegation: this.dto(record), finished };
  }

  /** 给子会话补一条消息（下一轮），委派回到运行中。 */
  async send(id: string, message: string): Promise<DelegationDto> {
    const record = this.require(id);
    const child = record.childSessionId === null ? null : this.deps.sessions.getById(record.childSessionId);
    if (child === null || child.state === "deleted") throw new ApiError(404, "NOT_FOUND", (t) => t.delegation.reply.childGone);
    const parent = this.deps.sessions.getById(record.parentSessionId);
    return this.dispatch(
      record.id,
      child.id,
      [{ type: "text", text: message }],
      `delegation:${record.id}:send:${randomUUID()}`,
      parent?.locale ?? child.locale,
      oneLine(record.task, 80),
    );
  }

  /** 取消：排队中的出队，运行中的中断子回合；记为已取消（发起者会收到「已取消」）。 */
  async cancel(id: string): Promise<DelegationDto> {
    const record = this.require(id);
    if (FINISHED.has(record.status)) return this.dto(record);
    const updated = this.update(id, { status: "cancelled", finishedAt: this.now() });
    // 只撤 / 停委派自己的消息；还在开、回合 ID 没对上的，对上时再停（`bind` → `turnStarted`）；
    // 并入了用户在子会话里那一轮的不中断用户的回合，直接不再等。
    if (record.childSessionId !== null) {
      const detached: Tracked[] = [];
      for (const entry of [...(this.pending.get(id) ?? [])]) if (await this.stopEntry(id, record.childSessionId, entry)) detached.push(entry);
      if (detached.length > 0) this.settle(id, detached, { status: "cancelled", error: null });
    }
    this.resolveWaiters(id);
    return this.dto(updated);
  }

  private async stopTurn(id: string, childSessionId: string, turnId: string): Promise<void> {
    await this.deps.interrupt(childSessionId, turnId).catch((error: unknown) => this.log({ event: "suduo.delegation.interrupt_failed", id, message: String(error) }));
  }

  /** 停止级联（需求 4.11）：发起会话停下时把它还没结束的委派一并取消。 */
  async cancelAllForParent(parentSessionId: string): Promise<DelegationDto[]> {
    const results: DelegationDto[] = [];
    for (const record of this.deps.delegations.listByParent(parentSessionId)) {
      if (!FINISHED.has(record.status)) results.push(await this.cancel(record.id));
    }
    return results;
  }

  /** 子会话要被删了：还没做完的委派先取消（不然删掉的会话还在跑）。 */
  async beforeSessionsDeleted(sessionIds: string[]): Promise<void> {
    for (const sessionId of sessionIds) {
      const record = this.deps.delegations.getByChild(sessionId);
      if (record !== null && !FINISHED.has(record.status)) await this.cancel(record.id);
    }
  }

  /** 子会话删了：发起会话的委派卡片改显示「子会话已删除」，结果摘要照留。 */
  afterSessionsDeleted(sessionIds: string[]): void {
    for (const sessionId of sessionIds) {
      const record = this.deps.delegations.getByChild(sessionId);
      if (record !== null) this.emit(record);
    }
  }

  /** 让原 Agent 继续：把结果作为一条消息交给发起会话（开新一轮，经本机调度）。 */
  async handback(id: string): Promise<DelegationDto> {
    const record = this.require(id);
    const parent = this.deps.sessions.getById(record.parentSessionId);
    if (parent === null || parent.state === "deleted") throw new ApiError(404, "NOT_FOUND", (t) => t.session.notFound);
    const t = messagesFor(parent.locale);
    const text = t.delegation.handback(
      this.deps.agentName(record.agentId),
      oneLine(record.task, 80),
      t.delegation.reply.status[record.status] ?? record.status,
      this.resultText(record, t),
      record.childSessionId,
    );
    await this.deps.messages.send(
      parent.id,
      { content: [{ type: "text", text }] },
      `delegation:${record.id}:handback:${String(record.updatedAt)}`,
      { locale: parent.locale, source: "user", label: oneLine(record.task, 80) },
    );
    return this.dto(this.update(id, { delivered: true }));
  }

  /** 工具回包与交回消息里的结果正文（按发起会话的语言）。 */
  resultText(record: DelegationRecord, t: ServerMessages): string {
    const r = t.delegation.reply;
    const lines: string[] = [];
    if (record.error !== null) lines.push(r.error(record.error));
    const result = record.result;
    if (result !== null) {
      lines.push(r.finalMessage, result.finalMessage ?? r.noFinalMessage);
      if (result.changedFiles.length > 0) {
        lines.push("", r.changedFiles(result.changedFiles.length, result.additions, result.deletions));
        for (const file of result.changedFiles.slice(0, 30)) lines.push(r.fileLine(file.path, r.fileKind[file.kind] ?? file.kind));
      }
    }
    return lines.join("\n");
  }

  /** 没做完时的进度说明（等待到点时给发起 Agent）。 */
  progressText(record: DelegationRecord, t: ServerMessages): string {
    const r = t.delegation.reply;
    const lines: string[] = [];
    if (record.childSessionId !== null) {
      const position = this.deps.scheduler.queuePosition(record.childSessionId);
      if (record.status === "queued" && position !== null) lines.push(r.queuePosition(position));
      const round = this.deps.rounds(record.childSessionId).at(-1);
      if (round !== undefined) {
        const steps = round.commands.length + round.tools.length + round.files.length;
        const last = round.files.at(-1)?.path ?? round.commands.at(-1)?.command ?? round.tools.at(-1)?.name ?? null;
        lines.push(r.progress(steps, last === null ? null : oneLine(last, 80)));
      }
      const pending = this.deps.approvals.countPendingBySession(record.childSessionId);
      if (pending > 0) lines.push(r.pendingApprovals(pending));
    }
    lines.push(r.stillRunning);
    return lines.join("\n");
  }

  dto(record: DelegationRecord): DelegationDto {
    const child = record.childSessionId === null ? null : this.deps.sessions.getById(record.childSessionId);
    return {
      id: record.id,
      parentSessionId: record.parentSessionId,
      childSessionId: child === null || child.state === "deleted" ? null : record.childSessionId,
      childTitle: child?.title ?? null,
      agentId: record.agentId,
      agentName: this.deps.agentName(record.agentId),
      task: record.task,
      origin: record.origin,
      status: record.status,
      autoHandback: record.autoHandback,
      delivered: record.delivered,
      pendingApprovals: record.childSessionId === null || FINISHED.has(record.status) ? 0 : this.deps.approvals.countPendingBySession(record.childSessionId),
      result: record.result,
      error: record.error,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      finishedAt: record.finishedAt,
    };
  }

  /** 跟着子会话的回合：开始 → 运行中；结束 → 结果与交回；审批变化 → 刷新卡片。委派的消息都处理完就不再跟。 */
  private watch(id: string, childSessionId: string): void {
    if (this.watching.has(id)) return;
    const unsubscribe = this.deps.broker.subscribe(childSessionId, (event) => this.onChildEvent(id, event));
    this.watching.set(id, unsubscribe);
  }

  private unwatch(id: string): void {
    this.watching.get(id)?.();
    this.watching.delete(id);
    this.pending.delete(id);
    this.unclaimed.delete(id);
    this.outcomes.delete(id);
  }

  /**
   * 只认委派自己发的消息（`pending`）：用户在子会话里直接接着聊（需求 4.3）的回合不改委派的状态与结果，也不触发交回。
   * 委派的消息全部结束（含排着的补充、会话内排着的下一轮、并入进行中一轮的）才算做完。停止子回合（卡片、运行面板、
   * 子会话页）记为已取消；叫停时还在开的回合，开起来就停掉。
   */
  private onChildEvent(id: string, event: EventEnvelope<string, JsonValue>): void {
    const record = this.deps.delegations.getById(id);
    const list = this.pending.get(id) ?? [];
    if (record === null || list.length === 0) return;
    const payload = objectOf(event.payload);
    const clientTurnId = typeof payload["clientTurnId"] === "string" ? payload["clientTurnId"] : null;
    const turnId = event.turnRef?.turnId ?? null;
    const byClient = clientTurnId === null ? undefined : list.find((entry) => entry.clientTurnId === clientTurnId);
    switch (event.type) {
      case "turn.queued":
        if (byClient === undefined) return;
        if (typeof payload["queueItemId"] === "string" && byClient.turnId === null) byClient.queueItemId = payload["queueItemId"];
        if (record.status === "running" && this.allQueued(id)) this.update(id, { status: "queued" });
        return;
      case "turn.dequeued": {
        if (byClient === undefined) return;
        // 排上的那条开起来了：记下回合 ID（这时会话里没有别的回合在跑，开的是新回合）。
        if (payload["reason"] === "started") {
          if (typeof payload["turnId"] === "string") {
            this.bind(id, byClient, payload["turnId"], false);
            this.turnStarted(id, payload["turnId"]);
          }
          return;
        }
        this.settle(id, [byClient], { status: "cancelled", error: null });
        return;
      }
      case "turn.start-failed": {
        if (byClient === undefined) return;
        const error = objectOf(payload["error"])["message"];
        this.settle(id, [byClient], { status: "failed", error: typeof error === "string" ? error : null });
        return;
      }
      case "item.started":
      case "item.completed": {
        // 归属证据：这条消息被哪一轮收下（Codex 并入进行中的一轮时不会开新回合）。
        const item = objectOf(payload["item"]);
        if (turnId === null || typeof item["type"] !== "string" || !/^usermessage$/iu.test(item["type"])) return;
        const mine = list.find((entry) => entry.clientTurnId === item["clientId"]);
        if (mine !== undefined) this.bind(id, mine, turnId, true);
        return;
      }
      case "turn.started":
        if (turnId === null) return;
        if (list.some((entry) => entry.turnId === turnId)) this.turnStarted(id, turnId);
        else this.remember(id, turnId, null);
        return;
      case "approval.requested":
      case "approval.resolved":
        if (!FINISHED.has(record.status)) this.emit(record);
        return;
      case "turn.completed":
      case "turn.interrupted": {
        if (turnId === null) return;
        const turn = objectOf(payload["turn"]);
        const status = turn["status"];
        const error = objectOf(turn["error"])["message"];
        const outcome =
          event.type === "turn.interrupted" || status === "interrupted"
            ? { status: "cancelled" as const, error: null }
            : { status: status === "failed" ? ("failed" as const) : ("completed" as const), error: typeof error === "string" ? error : null };
        if (list.some((entry) => entry.turnId === turnId)) this.turnEnded(id, turnId, outcome);
        else this.remember(id, turnId, outcome);
        // 兜底：并入了进行中一轮、却一直没等到证据的（那一轮被停掉时 Codex 会丢掉还没取的输入、不再记条目），
        // 子会话空下来后按这一轮的结局一起收掉，免得委派永远停在运行中。
        const childSessionId = event.sessionId;
        queueMicrotask(() => this.sweepMerged(id, childSessionId, outcome));
        return;
      }
      default:
        return;
    }
  }

  /** 委派的回合开始了：叫停过就停掉它（只停委派自己开的），排队中的改为运行中。 */
  private turnStarted(id: string, turnId: string): void {
    const record = this.deps.delegations.getById(id);
    if (record === null) return;
    const mine = (this.pending.get(id) ?? []).some((entry) => entry.turnId === turnId && this.own(entry));
    if (record.status === "cancelled") {
      if (mine) void this.stopTurn(id, record.childSessionId ?? "", turnId);
    } else if (record.status === "queued") this.update(id, { status: "running" });
  }

  /** 委派的回合结束了：属于它的条目一并去掉（并入同一轮的几条一起结束）。 */
  private turnEnded(id: string, turnId: string, outcome: Outcome): void {
    const ended = (this.pending.get(id) ?? []).filter((entry) => entry.turnId === turnId);
    if (ended.length > 0) this.settle(id, ended, outcome);
  }

  private sweepMerged(id: string, childSessionId: string, outcome: Outcome): void {
    if (this.deps.scheduler.sessionRunning(childSessionId)) return;
    const orphans = (this.pending.get(id) ?? []).filter((entry) => entry.merging && !entry.confirmed);
    if (orphans.length > 0) this.settle(id, orphans, outcome);
  }

  /** 这几条结束了：记下结局；委派的消息都结束了就汇总——有做完的算做完，否则有失败的算失败，否则已取消。 */
  private settle(id: string, entries: readonly Tracked[], outcome: Outcome): void {
    const outcomes = [...(this.outcomes.get(id) ?? []), outcome];
    this.outcomes.set(id, outcomes);
    if (this.drop(id, entries) > 0) return;
    const completed = outcomes.find((item) => item.status === "completed");
    const failed = [...outcomes].reverse().find((item) => item.status === "failed");
    const final = completed ?? failed ?? { status: "cancelled" as const, error: null };
    this.finish(id, final.status, final.error);
  }

  /** 还没对上的回合先记着（最多 50 个），回执或证据来了再认。 */
  private remember(id: string, turnId: string, ended: Outcome | null): void {
    const seen = this.unclaimed.get(id) ?? new Map<string, { ended: Outcome | null }>();
    seen.set(turnId, { ended: ended ?? seen.get(turnId)?.ended ?? null });
    if (seen.size > 50) seen.delete(seen.keys().next().value!);
    this.unclaimed.set(id, seen);
  }

  private finish(id: string, status: DelegationStatus, error: string | null): void {
    this.unwatch(id);
    const record = this.require(id);
    // 已取消的不再改回别的状态（中断事件晚到）。
    const finalStatus = record.status === "cancelled" ? "cancelled" : status;
    const result = record.childSessionId === null ? null : this.assemble(record.childSessionId);
    const updated = this.update(id, { status: finalStatus, result, error, finishedAt: this.now(), delivered: false });
    this.resolveWaiters(id);
    if (finalStatus === "cancelled") return;
    this.deliverLater(updated);
  }

  /** 没人在等：勾了自动交回就在发起会话空下来时交回；没勾就等用户在卡片上点。 */
  private deliverLater(record: DelegationRecord): void {
    if (!record.autoHandback) return;
    const deliver = () => {
      const current = this.deps.delegations.getById(record.id);
      if (current === null || current.delivered) return;
      void this.handback(record.id).catch((error: unknown) => this.log({ event: "suduo.delegation.handback_failed", id: record.id, message: String(error) }));
    };
    // 交给等待中的发起 Agent 后 delivered 会变真；等事件循环走一轮再看。
    setTimeout(() => {
      if (!this.deps.scheduler.sessionRunning(record.parentSessionId)) {
        deliver();
        return;
      }
      const unsubscribe = this.deps.broker.subscribe(record.parentSessionId, (event) => {
        if (event.type !== "turn.completed" && event.type !== "turn.interrupted") return;
        unsubscribe();
        setTimeout(deliver, 0);
      });
    }, 0);
  }

  private assemble(childSessionId: string): DelegationResultDto {
    const rounds = this.deps.rounds(childSessionId);
    const answer = [...rounds].reverse().find((round) => round.answer !== null)?.answer ?? null;
    let additions = 0;
    let deletions = 0;
    for (const file of rounds.flatMap((round) => round.files)) {
      const counted = countDiff(file.diff, file.kind);
      additions += counted.additions;
      deletions += counted.deletions;
    }
    return {
      finalMessage: answer,
      changedFiles: [...changedPaths(rounds)].map(([path, kind]) => ({ path, kind })),
      additions,
      deletions,
    };
  }

  private resolveWaiters(id: string): void {
    for (const waiter of [...(this.waiters.get(id) ?? [])]) waiter();
  }

  private update(id: string, patch: Parameters<DelegationRepository["update"]>[1]): DelegationRecord {
    const record = this.deps.delegations.update(id, patch, this.now());
    this.emit(record);
    return record;
  }

  /** 发起会话的时间线上记一条：委派卡片取同一委派最新的一条。 */
  private emit(record: DelegationRecord): void {
    const binding = this.deps.threads.getPrimary(record.parentSessionId);
    if (binding === null || binding === undefined) return;
    this.deps.ledger.append({
      sessionId: record.parentSessionId,
      sessionThreadId: binding.id,
      event: {
        source: "suduo:delegation",
        type: "delegation.updated",
        payload: this.dto(record) as unknown as JsonValue,
        threadRef: binding.threadRef,
        turnRef: null,
        ts: this.now(),
      },
    });
  }

  private require(id: string): DelegationRecord {
    const record = this.deps.delegations.getById(id);
    if (record === null) throw new ApiError(404, "NOT_FOUND", (t) => t.delegation.reply.notFound(id));
    return record;
  }

  private reason(error: unknown, locale: Locale): string {
    if (error instanceof ApiError) return error.render(messagesFor(locale));
    return error instanceof Error ? error.message : String(error);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private log(line: Record<string, unknown>): void {
    (this.deps.log ?? ((value) => console.info(JSON.stringify(value))))(line);
  }
}

/**
 * 增删行数，与界面的改动卡同一口径：统一 diff 按行首符号计（跳过文件头）；
 * 不是统一 diff 的（Agent 新建 / 删除文件时直接给全文）按整份计。
 */
export function countDiff(diff: string, kind: "add" | "delete" | "update"): { additions: number; deletions: number } {
  if (diff === "") return { additions: 0, deletions: 0 };
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (!lines.some((line) => line.startsWith("@@"))) {
    return kind === "delete" ? { additions: 0, deletions: lines.length } : { additions: lines.length, deletions: 0 };
  }
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

/** 时间线、队列里的一行说明。 */
export function oneLine(text: string, max: number): string {
  const flat = Array.from(text.replace(/\s+/gu, " ").trim());
  return flat.length <= max ? flat.join("") : `${flat.slice(0, max).join("")}…`;
}

function objectOf(value: JsonValue | undefined): Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, JsonValue>) : {};
}
