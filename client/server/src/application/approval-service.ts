import { SUDUO_MCP_CONNECTION_ID } from "@suduo/client-contracts";
import type {
  ApprovalDecision,
  ApprovalOption,
  ApprovalDto,
  DecideApprovalRequest,
  JsonValue,
  ListApprovalsQuery,
  RuntimeRegistry as RuntimeRegistryContract,
  ThreadRef,
  TurnRef,
} from "@suduo/client-contracts";
import type {
  ApprovalRecord,
  ApprovalRepository,
} from "../infrastructure/db/repositories/approval-repository.js";
import type { SessionThreadRepository } from "../infrastructure/db/repositories/session-thread-repository.js";
import {
  ApiError,
  IndeterminateOperationError,
  asJsonError,
} from "./api-error.js";
import { approvalDto } from "./dto.js";
import type { EventLedger } from "./event-ledger.js";
import { paginate } from "./pagination.js";

/**
 * SuDuo 会话工具的确认卡（ADR-0008）：决定不交给 Codex 的审批回包，而是由工具服务
 * 执行对外写操作并回复那次工具调用。
 */
export interface ToolConfirmationHandler {
  isToolConfirmation(approval: ApprovalRecord): boolean;
  /** 从不抛错：执行结果（成功、失败、未同意）写进返回值，随审批一起入账。 */
  confirm(approval: ApprovalRecord, decision: ApprovalDecision): Promise<JsonValue>;
}

export class ApprovalService {
  private toolConfirmations: ToolConfirmationHandler | null = null;

  constructor(
    private readonly approvals: ApprovalRepository,
    private readonly threads: SessionThreadRepository,
    private readonly runtimes: RuntimeRegistryContract,
    private readonly ledger: EventLedger,
  ) {}

  /** 工具服务依赖账本与本服务的仓库，构造顺序上晚于本服务，所以用 setter 接上。 */
  setToolConfirmationHandler(handler: ToolConfirmationHandler): void {
    this.toolConfirmations = handler;
  }

  list(sessionId: string, query: ListApprovalsQuery) {
    const view = query.status ?? "pending";
    const items = this.approvals
      .listBySession(sessionId)
      .filter((approval) => matchesView(approval.status, view))
      .map((approval) => this.toDto(approval));
    return paginate(items, query.cursor, query.limit);
  }

  get(id: string): ApprovalDto {
    const approval = this.approvals.getById(id);
    if (!approval) {
      throw new ApiError(404, "NOT_FOUND", (t) => t.session.approvalNotFound);
    }
    return this.toDto(approval);
  }

  async decide(
    id: string,
    input: DecideApprovalRequest,
  ): Promise<ApprovalDto> {
    const approval = this.approvals.getById(id);
    if (!approval) {
      throw new ApiError(404, "NOT_FOUND", (t) => t.session.approvalNotFound);
    }
    if (approval.status === "resolved") {
      throw new ApiError(
        409,
        "APPROVAL_ALREADY_DECIDED",
        (t) => t.session.approvalAlreadyDecided,
        { decision: approval.decision },
      );
    }
    if (approval.status !== "pending") {
      throw new ApiError(
        409,
        "APPROVAL_NOT_PENDING",
        (t) => t.session.approvalNotPending,
        { status: approval.status },
      );
    }
    // 卡上声明了可选决策（ADR-0014）：所选决策必须是其中之一，并带上 Agent 原生的选项 id。
    const option = resolveApprovalOption(approval.requestPayload, input);
    if (!this.approvals.markDeciding(id, approval.version, input.decision)) {
      throw new ApiError(
        409,
        "APPROVAL_NOT_PENDING",
        (t) => t.session.approvalConcurrentUpdate,
      );
    }
    const deciding = requireApproval(this.approvals.getById(id));
    const binding = this.threads.getById(deciding.sessionThreadId);
    if (!binding) {
      throw new ApiError(409, "APPROVAL_NOT_PENDING", (t) => t.session.approvalThreadLost);
    }
    const toolConfirmations = this.toolConfirmations;
    if (toolConfirmations?.isToolConfirmation(deciding)) {
      // 工具确认卡：执行（或不执行）对外写操作并回复工具调用，结果随审批入账。
      const outcome = await toolConfirmations.confirm(deciding, input.decision);
      this.ledger.resolveApproval({
        approval: deciding,
        decision: input.decision,
        decisionPayload: { decision: input.decision, outcome },
        decidedBy: "local-user",
        event: {
          source: "suduo:api",
          type: "approval.resolved",
          payload: { decision: input.decision, acknowledged: true, outcome },
          threadRef: binding.threadRef,
          turnRef: approvalTurnRef(deciding.requestPayload, binding.threadRef.threadId),
          ts: Date.now(),
          dedupeKey: "approval-resolved:" + deciding.id + ":" + String(deciding.version),
        },
      });
      return this.get(id);
    }
    try {
      await this.runtimes.get(binding.threadRef.runtimeId).approve({
        sessionId: deciding.sessionId,
        threadRef: binding.threadRef,
        approvalRef: deciding.runtimeApprovalRef,
        decision: input.decision,
        ...(option === null ? {} : { optionId: option.id }),
      });
    } catch (error) {
      this.ledger.failApprovalDelivery({
        approval: deciding,
        error: asJsonError(error),
        threadRef: binding.threadRef,
        turnRef: approvalTurnRef(
          deciding.requestPayload,
          binding.threadRef.threadId,
        ),
      });
      throw new IndeterminateOperationError((t) => t.session.approvalDeliveryIndeterminate, {
        cause: error,
      });
    }
    try {
      this.ledger.resolveApproval({
        approval: deciding,
        decision: input.decision,
        decisionPayload: { decision: input.decision },
        decidedBy: "local-user",
        event: {
          source: "suduo:api",
          type: "approval.resolved",
          payload: {
            decision: input.decision,
            acknowledged: true,
          },
          threadRef: binding.threadRef,
          turnRef: approvalTurnRef(
            deciding.requestPayload,
            binding.threadRef.threadId,
          ),
          ts: Date.now(),
          dedupeKey:
            "approval-resolved:" + deciding.id + ":" + String(deciding.version),
        },
      });
    } catch (error) {
      throw new IndeterminateOperationError(
        (t) => t.session.approvalResolveWriteFailed,
        { cause: error },
      );
    }
    return this.get(id);
  }

  /**
   * 进程内连接断开时（`options.inProcess`）跳过「正在执行」的工具确认卡：用户已点「发出」、
   * 远程写正在进行，由进行中的 decide 照实入账（否则评论已发出却记成作废）。
   * 本机服务重启时没有进行中的 decide，全部作废。
   * `options.runtimeId`：只作废这个运行时的线程上的审批——多 Agent 时一家 Agent 的连接断开
   * 不能连带作废别家会话里的确认卡（ADR-0017 故障隔离）。
   */
  orphanPersistedPending(
    reason = "runtime process is no longer available",
    options: { inProcess?: boolean; runtimeId?: string } = {},
  ): number {
    let count = 0;
    for (const approval of this.approvals.listPendingOrDeciding()) {
      // 经 MCP 的确认卡不属于任何运行时连接（ADR-0015）：待确认的留着当待发出草稿；正在执行的，
      // 本进程还在跑就留着，重启后结果未知，按下面「结果未确认」作废，免得卡在执行中谁也动不了。
      if (approval.runtimeConnectionId === SUDUO_MCP_CONNECTION_ID && (approval.status === "pending" || options.inProcess === true)) {
        continue;
      }
      if (options.runtimeId !== undefined && this.threads.getById(approval.sessionThreadId)?.threadRef.runtimeId !== options.runtimeId) {
        continue;
      }
      const deciding = approval.status === "deciding" && this.toolConfirmations?.isToolConfirmation(approval) === true;
      if (options.inProcess === true && deciding) {
        continue;
      }
      this.ledger.orphanApproval({
        approval,
        // 重启时还在执行的工具确认卡：对外写可能已经发出，说清楚让人去核对，不要直接重发。
        // 原因只记进账本（approval.orphaned），界面不显示，所以写英文、不进字典。
        reason: deciding
          ? "result unconfirmed (the local service restarted while it was running); check on the requirement page whether it was sent before sending it again"
          : reason,
        ...this.approvalRefs(approval),
      });
      count += 1;
    }
    return count;
  }

  orphanConnection(connectionId: string): number {
    let count = 0;
    for (const approval of this.approvals.listPendingOrDeciding()) {
      if (approval.runtimeConnectionId === connectionId) {
        this.ledger.orphanApproval({
          approval,
          reason: "runtime connection closed",
          ...this.approvalRefs(approval),
        });
        count += 1;
      }
    }
    return count;
  }

  /** Agent 撤回了还没决定的审批请求（回合被中断等，如 Claude 的 canUseTool 被取消）：卡片作废。 */
  orphanWithdrawn(runtimeApprovalRef: string, reason: string): number {
    let count = 0;
    for (const approval of this.approvals.listPendingOrDeciding()) {
      if (approval.runtimeApprovalRef === runtimeApprovalRef && approval.status === "pending") {
        this.ledger.orphanApproval({ approval, reason, ...this.approvalRefs(approval) });
        count += 1;
      }
    }
    return count;
  }

  /** 与 approval.resolved 同一套推导：线程取绑定，回合取审批请求里的 turnId。 */
  private approvalRefs(approval: ApprovalRecord): {
    threadRef: ThreadRef | null;
    turnRef: TurnRef | null;
  } {
    const binding = this.threads.getById(approval.sessionThreadId);
    if (!binding) {
      return { threadRef: null, turnRef: null };
    }
    return {
      threadRef: binding.threadRef,
      turnRef: approvalTurnRef(approval.requestPayload, binding.threadRef.threadId),
    };
  }

  private toDto(approval: ApprovalRecord): ApprovalDto {
    const binding = this.threads.getById(approval.sessionThreadId);
    if (!binding) {
      throw new ApiError(409, "APPROVAL_NOT_PENDING", (t) => t.session.approvalThreadLost);
    }
    return approvalDto(approval, binding);
  }
}

function matchesView(
  status: string,
  view: "pending" | "history" | "all",
): boolean {
  if (view === "all") {
    return true;
  }
  if (view === "pending") {
    return status === "pending" || status === "deciding";
  }
  return status !== "pending" && status !== "deciding";
}

function requireApproval<T>(approval: T | null): T {
  if (!approval) {
    throw new Error("Approval record missing");
  }
  return approval;
}

function approvalTurnRef(
  payload: unknown,
  threadId: string,
): { threadId: string; turnId: string } | null {
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    const request = (payload as Record<string, unknown>)["request"];
    if (request !== null && typeof request === "object" && !Array.isArray(request)) {
      const turnId = (request as Record<string, unknown>)["turnId"];
      if (typeof turnId === "string") {
        return { threadId, turnId };
      }
    }
  }
  return null;
}

const LEGACY_DECISIONS: readonly ApprovalDecision[] = ["accept", "acceptForSession", "decline", "cancel"];

/**
 * 找出这次决定对应的选项。卡上有 options（ADR-0014 中立字段）时，optionId 优先，否则按 decision 找第一个；
 * 找不到报 400。没有 options 的老卡与 SuDuo 工具确认卡只认原来的四种决策。
 */
export function resolveApprovalOption(
  requestPayload: JsonValue,
  input: DecideApprovalRequest,
): ApprovalOption | null {
  const options = optionsOf(requestPayload);
  if (options === null) {
    if (!LEGACY_DECISIONS.includes(input.decision)) {
      throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.approvalOptionInvalid);
    }
    return null;
  }
  const match = input.optionId !== undefined
    ? options.find((option) => option.id === input.optionId && option.decision === input.decision)
    : options.find((option) => option.decision === input.decision);
  if (!match) {
    throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.approvalOptionInvalid);
  }
  return match;
}

function optionsOf(payload: JsonValue): ApprovalOption[] | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const raw = payload["options"];
  if (!Array.isArray(raw)) {
    return null;
  }
  const options: ApprovalOption[] = [];
  for (const entry of raw) {
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry) && typeof entry["id"] === "string" && typeof entry["decision"] === "string") {
      options.push({ id: entry["id"], decision: entry["decision"] as ApprovalDecision });
    }
  }
  return options;
}
