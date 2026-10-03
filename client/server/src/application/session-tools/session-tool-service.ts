import {
  SUDUO_TOOL_NATIVE_METHOD,
  currentSuDuoToolName,
  type ApprovalDecision,
  type JsonValue,
  type RuntimeEventDraft,
  type RuntimeRegistry,
  type RuntimeToolCallRequest,
  type SuDuoToolConfirmationDto,
} from "@suduo/client-contracts";
import type { ApprovalRecord, ApprovalRepository } from "../../infrastructure/db/repositories/approval-repository.js";
import type { SessionThreadRepository } from "../../infrastructure/db/repositories/session-thread-repository.js";
import type { ToolConfirmationHandler } from "../approval-service.js";
import type { EventLedger } from "../event-ledger.js";
import { isWriteTool } from "./catalog.js";
import { failure, reasonOf, type ToolResult } from "./format.js";
import type { RequirementTools, ToolSessionContext } from "./requirement-tools.js";
import type { RoomTools } from "./room-tools.js";
import type { SessionContextService } from "./session-context.js";

/**
 * 会话工具的调度（ADR-0008）：Codex 发来的 `item/tool/call` 经 runtime 变成
 * `tool.call-requested` 事件，这里异步执行并回包。只读工具直接执行；对外写工具
 * 生成确认卡（复用审批表），等用户在审批坞决定后由 `confirm` 执行并回包。
 */
export class SessionToolService implements ToolConfirmationHandler {
  /** 模型上次读到的笔记哈希（会话 + 需求），用于「读后被改过」的告知。只在内存里。 */
  private readonly notesReads = new Map<string, string | null>();
  /** 准备阶段就被 Codex 撤回的调用：准备完成后不再建确认卡（否则会留下点了也回不到模型的孤儿卡）。 */
  private readonly cancelledCalls = new Set<string>();

  constructor(
    private readonly deps: {
      runtimes: RuntimeRegistry;
      threads: SessionThreadRepository;
      approvals: ApprovalRepository;
      ledger: EventLedger;
      context: SessionContextService;
      tools: RequirementTools;
      /** 房间工具（房间任务会话用）；不传时房间工具一律回「不可用」。 */
      roomTools?: RoomTools;
      log?: (line: Record<string, unknown>) => void;
    },
  ) {}

  /** runtime-consumer 的入口：不 await，避免卡住所有会话共用的订阅循环。 */
  handle(event: RuntimeEventDraft): void {
    const parsed = parseRequest(event.payload);
    if (parsed === null) {
      return;
    }
    // 品牌更名前建的线程续接后仍按旧名调用（ADR-0010）：一律按新名分派。
    const request = { ...parsed, tool: currentSuDuoToolName(parsed.tool) };
    if (event.type === "tool.call-cancelled") {
      this.cancel(request.callRef, reasonText(event.payload));
      return;
    }
    void this.dispatch(event, request).catch((error: unknown) => {
      this.log({ event: "suduo.tool.dispatch_failed", tool: request.tool, message: reasonOf(error) });
      void this.respond(event, request.callRef, failure(`SuDuo 执行工具时出错：${reasonOf(error)}`));
    });
  }

  isToolConfirmation(approval: ApprovalRecord): boolean {
    return isToolConfirmation(approval);
  }

  /** 审批坞上的决定（ApprovalService 转来）。从不抛错：执行结果写进返回值。 */
  async confirm(approval: ApprovalRecord, decision: ApprovalDecision): Promise<JsonValue> {
    const confirmation = confirmationOf(approval);
    const accepted = decision === "accept" || decision === "acceptForSession";
    let result: ToolResult;
    if (confirmation === null) {
      result = failure("确认卡内容不完整，没有执行。");
    } else if (!accepted) {
      result = failure(
        confirmation.tool === "comment_submit"
          ? "用户没有同意，评论没有发出。"
          : "用户没有同意，确认版没有发布。",
      );
    } else {
      const context = this.deps.context.toolContext(approval.sessionId);
      result =
        context === null
          ? failure("会话已经没有关联的 SuDuo 项目，没有执行。")
          : await this.deps.tools.executeWrite(context, confirmation, approval.id).catch((error: unknown) =>
              failure(`执行时出错：${reasonOf(error)}`),
            );
    }
    const binding = this.deps.threads.getById(approval.sessionThreadId);
    const delivered = binding
      ? await this.deliver(binding.threadRef.runtimeId, approval.runtimeApprovalRef, result)
      : { delivered: false };
    const message = textOf(result);
    this.log({
      event: "suduo.tool.confirmed",
      sessionId: approval.sessionId,
      tool: confirmation?.tool ?? "unknown",
      accepted,
      success: result.success,
      delivered: delivered?.delivered ?? false,
    });
    return { executed: accepted && confirmation !== null, success: result.success, message, delivered: delivered?.delivered ?? false };
  }

  private async dispatch(event: RuntimeEventDraft, request: RuntimeToolCallRequest): Promise<void> {
    const startedAt = Date.now();
    const binding = event.threadRef
      ? this.deps.threads.getByRuntimeThread(event.threadRef.runtimeId, event.threadRef.threadId)
      : null;
    const sessionId = binding?.sessionId ?? event.sessionHint ?? null;
    const context = sessionId === null ? null : this.deps.context.toolContext(sessionId);
    if (context === null) {
      await this.respond(event, request.callRef, failure("这个会话没有关联 SuDuo 项目，不能使用 suduo 工具。"));
      return;
    }
    const args = isRecord(request.arguments) ? request.arguments : {};
    if (context.room !== undefined && !context.room.allowedTools.includes(request.tool)) {
      // 房间任务会话只挂房间工具与需求只读工具（ADR-0009）：清单外的调用（笔记、写工具）一律不执行。
      await this.respond(
        event,
        request.callRef,
        failure(`房间里的共享 Agent 只能用只读工具，不能调用 ${request.tool}。`),
      );
      this.log({ event: "suduo.tool.room_denied", sessionId: context.sessionId, tool: request.tool });
      return;
    }
    if (isWriteTool(request.tool)) {
      if (!binding) {
        await this.respond(event, request.callRef, failure("找不到会话线程，没有执行。"));
        return;
      }
      const prepared =
        request.tool === "suduo_comment_submit"
          ? await this.deps.tools.prepareComment(context, args)
          : await this.deps.tools.preparePublish(context, args);
      if ("contentItems" in prepared) {
        await this.respond(event, request.callRef, prepared);
        return;
      }
      // 准备期间（查远程最长十几秒）回合可能已被中断或连接已断：调用已失效就不建卡，只记日志。
      const runtime = event.threadRef ? this.deps.runtimes.get(event.threadRef.runtimeId) : null;
      if (this.cancelledCalls.delete(request.callRef) || runtime?.isToolCallPending?.(request.callRef) === false) {
        this.log({ event: "suduo.tool.confirmation_skipped", sessionId: binding.sessionId, tool: request.tool, reason: "调用已失效" });
        return;
      }
      const confirmation: SuDuoToolConfirmationDto = {
        ...prepared,
        duplicateOf: this.findDuplicate(binding.sessionId, prepared),
      };
      this.deps.ledger.appendApprovalRequested({
        sessionId: binding.sessionId,
        sessionThreadId: binding.id,
        kind: "other",
        runtimeConnectionId: request.connectionId,
        runtimeRequestId: request.requestId,
        runtimeApprovalRef: request.callRef,
        event: {
          source: event.source,
          type: "approval.requested",
          payload: {
            kind: "other",
            approvalRef: request.callRef,
            connectionId: request.connectionId,
            requestId: request.requestId,
            nativeMethod: SUDUO_TOOL_NATIVE_METHOD,
            request: {
              threadId: event.threadRef?.threadId ?? null,
              turnId: request.turnId,
              callId: request.callId,
              tool: request.tool,
              arguments: request.arguments,
            },
            suDuoTool: confirmation as unknown as JsonValue,
          },
          threadRef: event.threadRef,
          turnRef: event.turnRef,
          ts: Date.now(),
          dedupeKey: "tool-confirm:" + request.callRef,
        },
      });
      this.log({ event: "suduo.tool.awaiting_confirmation", sessionId: context.sessionId, tool: request.tool });
      return;
    }
    const result = await this.runReadTool(context, request.tool, args);
    await this.respond(event, request.callRef, result);
    this.log({
      event: "suduo.tool.call",
      sessionId: context.sessionId,
      tool: request.tool,
      success: result.success,
      durationMs: Date.now() - startedAt,
    });
  }

  private runReadTool(context: ToolSessionContext, tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tools = this.deps.tools;
    const key = (requirementId: string) => context.sessionId + ":" + requirementId;
    const remember = (requirementId: string, sha256: string | null) => {
      this.notesReads.set(key(requirementId), sha256);
    };
    const lastRead = (requirementId: string) =>
      this.notesReads.has(key(requirementId)) ? this.notesReads.get(key(requirementId)) : undefined;
    switch (tool) {
      case "suduo_requirement_get":
        return tools.requirementGet(context, args);
      case "suduo_requirement_comments":
        return tools.requirementComments(context, args);
      case "suduo_requirement_attachments":
        return tools.requirementAttachments(context, args);
      case "suduo_attachment_view":
        return tools.attachmentView(context, args);
      case "suduo_artifact_versions":
        return tools.artifactVersions(context, args);
      case "suduo_artifact_fetch":
        return tools.artifactFetch(context, args);
      case "suduo_notes_read":
        return tools.notesRead(context, args, remember);
      case "suduo_notes_save":
        return tools.notesSave(context, args, lastRead, remember);
      case "suduo_room_history":
      case "suduo_room_search":
      case "suduo_room_file_view": {
        const roomTools = this.deps.roomTools;
        if (!roomTools) {
          return Promise.resolve(failure("房间工具暂时不可用。"));
        }
        return tool === "suduo_room_history"
          ? roomTools.history(context, args)
          : tool === "suduo_room_search"
            ? roomTools.search(context, args)
            : roomTools.fileView(context, args);
      }
      default:
        return Promise.resolve(failure(`SuDuo 没有工具 ${tool}。`));
    }
  }

  /** 本会话里已经成功发过、或还有一张待确认的相同内容：只告知（ADR-0004），不拒绝。 */
  private findDuplicate(sessionId: string, candidate: SuDuoToolConfirmationDto): { at: number; pending?: boolean } | null {
    const fingerprint = fingerprintOf(candidate);
    for (const approval of this.deps.approvals.listBySession(sessionId)) {
      if (approval.status === "pending" || approval.status === "deciding") {
        const waiting = confirmationOf(approval);
        if (waiting !== null && fingerprintOf(waiting) === fingerprint) {
          return { at: approval.requestedAt, pending: true };
        }
        continue;
      }
      if (approval.status !== "resolved" || approval.decidedAt === null) {
        continue;
      }
      const previous = confirmationOf(approval);
      const outcome = isRecord(approval.decisionPayload) ? approval.decisionPayload["outcome"] : null;
      const succeeded = isRecord(outcome) && outcome["success"] === true;
      if (previous !== null && succeeded && fingerprintOf(previous) === fingerprint) {
        return { at: approval.decidedAt };
      }
    }
    return null;
  }

  /**
   * Codex 撤回了调用（回合被中断）：对应的、还没决定的确认卡作废。
   * 已经在 deciding 的不动：用户已点了「发出」、对外写可能已执行，结果由进行中的 decide 照实入账；
   * 这里若改成 orphaned，decide 的 resolve 会丢掉 CAS 而抛错，已发出的评论就没有记录了。
   */
  private cancel(callRef: string, reason: string): void {
    let found = false;
    for (const approval of this.deps.approvals.listPendingOrDeciding()) {
      if (approval.runtimeApprovalRef === callRef) {
        found = true;
      }
      if (approval.runtimeApprovalRef !== callRef || approval.status !== "pending") {
        continue;
      }
      const binding = this.deps.threads.getById(approval.sessionThreadId);
      const turnId = turnIdOf(approval);
      this.deps.ledger.orphanApproval({
        approval,
        reason,
        threadRef: binding?.threadRef ?? null,
        turnRef: binding && turnId ? { threadId: binding.threadRef.threadId, turnId } : null,
      });
    }
    if (!found) {
      // 卡还没建（还在准备阶段）：记下来，准备完成后不再建卡。只留最近的一批，防止无限增长。
      this.cancelledCalls.add(callRef);
      if (this.cancelledCalls.size > 500) {
        const oldest = this.cancelledCalls.values().next().value;
        if (oldest !== undefined) this.cancelledCalls.delete(oldest);
      }
    }
  }

  private async respond(event: RuntimeEventDraft, callRef: string, result: ToolResult): Promise<void> {
    if (!event.threadRef) {
      return;
    }
    const outcome = await this.deliver(event.threadRef.runtimeId, callRef, result);
    if (!outcome.delivered) {
      this.log({ event: "suduo.tool.respond_dropped", reason: "调用已失效（连接换代或 Codex 已撤回）" });
    }
  }

  /** 回包；runtime 不存在或回包出错都只记日志，不抛错。 */
  private async deliver(runtimeId: string, callRef: string, result: ToolResult): Promise<{ delivered: boolean }> {
    try {
      const outcome = await this.deps.runtimes.get(runtimeId).respondToolCall?.({ callRef, ...result });
      return outcome ?? { delivered: false };
    } catch (error) {
      this.log({ event: "suduo.tool.respond_failed", message: reasonOf(error) });
      return { delivered: false };
    }
  }

  private log(line: Record<string, unknown>): void {
    (this.deps.log ?? ((value) => console.info(JSON.stringify(value))))(line);
  }
}

function parseRequest(payload: JsonValue): RuntimeToolCallRequest | null {
  if (!isRecord(payload) || typeof payload["callRef"] !== "string") {
    return null;
  }
  return {
    callRef: payload["callRef"],
    connectionId: typeof payload["connectionId"] === "string" ? payload["connectionId"] : "",
    requestId: typeof payload["requestId"] === "string" ? payload["requestId"] : "",
    callId: typeof payload["callId"] === "string" ? payload["callId"] : payload["callRef"],
    turnId: typeof payload["turnId"] === "string" ? payload["turnId"] : null,
    tool: typeof payload["tool"] === "string" ? payload["tool"] : "",
    arguments: (payload["arguments"] ?? null) as JsonValue,
  };
}

function reasonText(payload: JsonValue): string {
  return isRecord(payload) && typeof payload["reason"] === "string"
    ? payload["reason"]
    : "回合已结束，这次确认已失效";
}

/** 审批记录是不是工具确认卡；是的话取出卡片内容。 */
export function confirmationOf(approval: ApprovalRecord): SuDuoToolConfirmationDto | null {
  const payload = approval.requestPayload;
  if (!isRecord(payload) || payload["nativeMethod"] !== SUDUO_TOOL_NATIVE_METHOD) {
    return null;
  }
  const tool = payload["suDuoTool"];
  return isRecord(tool) && (tool["tool"] === "comment_submit" || tool["tool"] === "artifact_publish")
    ? (tool as unknown as SuDuoToolConfirmationDto)
    : null;
}

export function isToolConfirmation(approval: ApprovalRecord): boolean {
  const payload = approval.requestPayload;
  return isRecord(payload) && payload["nativeMethod"] === SUDUO_TOOL_NATIVE_METHOD;
}

function fingerprintOf(confirmation: SuDuoToolConfirmationDto): string {
  if (confirmation.tool === "comment_submit") {
    return `comment:${confirmation.requirement.id}:${confirmation.comment?.body ?? ""}`;
  }
  const files = (confirmation.publish?.files ?? []).map((file) => `${file.source}:${file.ref}`).sort();
  return `publish:${confirmation.requirement.id}:${files.join("|")}`;
}

function turnIdOf(approval: ApprovalRecord): string | null {
  const payload = approval.requestPayload;
  const request = isRecord(payload) ? payload["request"] : null;
  return isRecord(request) && typeof request["turnId"] === "string" ? request["turnId"] : null;
}

function textOf(result: ToolResult): string {
  return result.contentItems
    .map((item) => (item.type === "inputText" ? item.text : "（图片）"))
    .join("\n");
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
