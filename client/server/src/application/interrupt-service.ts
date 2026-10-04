import type {
  InterruptAccepted,
  InterruptRequest,
  RuntimeRegistry as RuntimeRegistryContract,
} from "@suduo/client-contracts";
import type { EventRepository } from "../infrastructure/db/repositories/event-repository.js";
import type { ProjectRepository } from "../infrastructure/db/repositories/project-repository.js";
import type { SessionRepository } from "../infrastructure/db/repositories/session-repository.js";
import type {
  SessionThreadRecord,
  SessionThreadRepository,
} from "../infrastructure/db/repositories/session-thread-repository.js";
import { ApiError, IndeterminateOperationError, errorTextOf } from "./api-error.js";
import type { EventLedger } from "./event-ledger.js";
import type { RuntimeSupervisor } from "./runtime-supervisor.js";
import { WorkspaceContextResolver } from "./workspace-context.js";

export class InterruptService {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly sessions: SessionRepository,
    private readonly threads: SessionThreadRepository,
    private readonly events: EventRepository,
    private readonly runtimes: RuntimeRegistryContract,
    private readonly supervisor: RuntimeSupervisor,
    private readonly ledger: EventLedger,
    private readonly workspaces: WorkspaceContextResolver = new WorkspaceContextResolver(),
  ) {}

  async interrupt(
    sessionId: string,
    input: InterruptRequest,
  ): Promise<InterruptAccepted> {
    const session = this.sessions.getById(sessionId);
    if (!session) {
      throw new ApiError(404, "NOT_FOUND", (t) => t.session.notFound);
    }
    const project = this.projects.getById(session.projectId);
    if (!project) {
      throw new ApiError(404, "NOT_FOUND", (t) => t.session.projectNotFound);
    }
    const binding = this.route(sessionId, input);
    const turnId = input.turnId ?? this.uniqueRunningTurn(sessionId, binding);
    await this.supervisor.ensureReady({
      session,
      workspace: this.workspaces.forSession(project, sessionId),
      binding,
    });
    let alreadyStopped = false;
    try {
      await this.runtimes.get(binding.threadRef.runtimeId).interrupt({
        sessionId,
        threadRef: binding.threadRef,
        turnId,
      });
    } catch (error) {
      // 回合已结束/连接已重建时 codex 找不到该 turn。目标状态已达成：
      // 按幂等处理，补终态事件收口本地状态，不打扰用户。
      if (!isTurnGoneError(error)) {
        const cause = errorTextOf(error);
        throw new IndeterminateOperationError(
          (t) => t.session.interruptIndeterminate(cause(t).slice(0, 200)),
          { cause: error },
        );
      }
      alreadyStopped = true;
    }
    const acceptedAt = Date.now();
    // 已停止且账本里已有该回合的终态（多半是自然完成）：什么都不补。
    // 否则一次对已完成回合的迟到中断会把 completed 改写成 interrupted，投影是后写覆盖语义。
    if (alreadyStopped && this.events.hasTurnTerminal(sessionId, turnId)) {
      return {
        sessionId,
        threadRef: binding.threadRef,
        turnId,
        acceptedAt,
      };
    }
    try {
      this.ledger.append({
        sessionId,
        sessionThreadId: binding.id,
        event: {
          source: "suduo:api",
          // 已停止但账本还没有终态（codex 找不到该 turn）：直接写终态，避免界面永远停在「运行中」。
          type: alreadyStopped ? "turn.interrupted" : "turn.interrupt-requested",
          payload: alreadyStopped
            ? { turnId, reason: "already-stopped" }
            : { turnId },
          threadRef: binding.threadRef,
          turnRef: { threadId: binding.threadRef.threadId, turnId },
          ts: acceptedAt,
          dedupeKey: "interrupt:" + sessionId + ":" + turnId,
        },
      });
    } catch (error) {
      throw new IndeterminateOperationError(
        (t) => t.session.interruptRecordWriteFailed,
        { cause: error },
      );
    }
    return {
      sessionId,
      threadRef: binding.threadRef,
      turnId,
      acceptedAt,
    };
  }

  private route(sessionId: string, input: InterruptRequest): SessionThreadRecord {
    if (input.threadRef) {
      const binding = this.threads.getBySessionAndThreadRef(
        sessionId,
        input.threadRef,
      );
      if (!binding || binding.state !== "attached") {
        throw new ApiError(404, "NOT_FOUND", (t) => t.session.interruptTargetThreadNotBound);
      }
      return binding;
    }
    const primary = this.threads
      .listBySession(sessionId)
      .filter((binding) => binding.primary && binding.state === "attached");
    if (primary.length === 0) {
      throw new ApiError(
        409,
        "SESSION_HAS_NO_PRIMARY_THREAD",
        (t) => t.session.noPrimaryThread,
      );
    }
    if (primary.length !== 1) {
      throw new ApiError(
        409,
        "SESSION_PRIMARY_THREAD_AMBIGUOUS",
        (t) => t.session.primaryThreadAmbiguous,
      );
    }
    return primary[0] as SessionThreadRecord;
  }

  private uniqueRunningTurn(
    sessionId: string,
    binding: SessionThreadRecord,
  ): string {
    const running = this.events
      .listRunningTurnRefs(sessionId)
      .filter((turn) => turn.threadId === binding.threadRef.threadId);
    if (running.length !== 1) {
      throw new ApiError(
        409,
        "VERSION_CONFLICT",
        (t) => t.session.runningTurnAmbiguous,
        { runningTurnCount: running.length },
      );
    }
    return (running[0] as (typeof running)[number]).turnId;
  }
}

function causeText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 200);
}

/**
 * codex 报「turn 不存在/未在运行」= 已经停了，中断视为成功（幂等）。
 * 0.143.0 实测的两种 -32600（技术设计 §三-1 F5 / F6）：
 * - F6 `no active turn to interrupt`（已被 `no active turn` 覆盖）；
 * - F5 `expected active turn id X but found Y`（目标已非活跃、另一轮在跑）——只认完整形态，
 *   缺 `but found` 段的相近文案不算，避免把真实故障吞成幂等。
 */
export function isTurnGoneError(error: unknown): boolean {
  const text = causeText(error).toLowerCase();
  return (
    text.includes("not found") ||
    text.includes("no active turn") ||
    text.includes("no such turn") ||
    text.includes("not running") ||
    text.includes("already completed") ||
    text.includes("unknown turn") ||
    /expected active turn id \S+ but found \S+/.test(text)
  );
}
