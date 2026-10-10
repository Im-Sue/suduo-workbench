import type { HandoffTools } from "../collab/handoff-tools.js";
import { randomUUID } from "node:crypto";
import {
  SUDUO_MCP_CONNECTION_ID,
  SUDUO_TOOL_NATIVE_METHOD,
  currentSuDuoToolName,
  isRetiredSuDuoToolName,
  type ApprovalDecision,
  type JsonValue,
  type Locale,
  type RuntimeEventDraft,
  type RuntimeRegistry,
  type RuntimeToolCallRequest,
  type SuDuoToolConfirmationDto,
} from "@suduo/client-contracts";
import type { SessionReaderService } from "../context/session-reader.js";
import type { DelegationTools } from "../collab/delegation-tools.js";
import type { ReviewTools } from "../collab/review-tools.js";
import type { ApprovalRecord, ApprovalRepository } from "../../infrastructure/db/repositories/approval-repository.js";
import type { SessionRepository } from "../../infrastructure/db/repositories/session-repository.js";
import type { SessionThreadRecord, SessionThreadRepository } from "../../infrastructure/db/repositories/session-thread-repository.js";
import type { ToolConfirmationHandler } from "../approval-service.js";
import type { EventLedger } from "../event-ledger.js";
import type { McpToolCallResult, McpToolContent, McpToolDefinition, McpToolHost } from "../../infrastructure/mcp/mcp-endpoint.js";
import type { ToolGrant } from "../../infrastructure/mcp/tool-tokens.js";
import { internalToolName, isDelegationToolName, isHandoffToolName, isReviewToolName, isWriteTool, mcpToolSpecsFor, mcpToolText, sessionToolNames, type SessionToolScope } from "./catalog.js";
import { failure, limitToolResult, textResult, toolFormat, type ToolResult } from "./format.js";
import type { RequirementTools, ToolSessionContext } from "./requirement-tools.js";
import type { RoomTools } from "./room-tools.js";
import type { SessionContextService } from "./session-context.js";

/**
 * 查不到会话记录时回给 Codex 的文字用的语言：与迁移 017 给存量会话记的语言一致。
 * 只有调用来自 SuDuo 不认识的线程时才会用到。
 */
const FALLBACK_LOCALE: Locale = "zh-CN";

/** 经 MCP 的写工具在 Agent 工具超时前多少秒转草稿（S0：Codex 超时既不断开也不取消，只能自己计时）。 */
const MCP_DRAFT_MARGIN_SEC = 30;

/** 只进日志的报错说明：开发者看的，固定英文。 */
function logReason(error: unknown): string {
  return toolFormat("en").reasonOf(error);
}

/**
 * 会话工具的调度（ADR-0008）：Codex 发来的 `item/tool/call` 经 runtime 变成
 * `tool.call-requested` 事件，这里异步执行并回包。只读工具直接执行；对外写工具
 * 生成确认卡（复用审批表），等用户在审批坞决定后由 `confirm` 执行并回包。
 */
export class SessionToolService implements ToolConfirmationHandler, McpToolHost {
  /** 模型上次读到的笔记哈希（会话 + 需求），用于「读后被改过」的告知。只在内存里。 */
  private readonly notesReads = new Map<string, string | null>();
  /** 准备阶段就被 Codex 撤回的调用：准备完成后不再建确认卡（否则会留下点了也回不到模型的孤儿卡）。 */
  private readonly cancelledCalls = new Set<string>();
  /**
   * 经 MCP 发起、正挂起等用户确认的写工具调用（ADR-0015）：callRef → 回包。用户的决定开始执行后
   * 记 executing：之后到点或 Agent 断开都不再回「已存为草稿」，等执行结果（免得告诉 Agent 没发、其实发了）。
   */
  private readonly mcpPending = new Map<string, { settle: (result: ToolResult) => void; executing: boolean; signal: AbortSignal }>();

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
      /** 跨会话读取（多 Agent 协作 S7）；不传时会话工具一律回「不可用」。 */
      sessionReader?: Pick<SessionReaderService, "list" | "read">;
      /** 委派（多 Agent 协作 S8）；不传时委派工具一律回「不可用」。 */
      delegationTools?: DelegationTools;
      /** 交叉评审（多 Agent 协作 S9）；不传时评审工具一律回「不可用」。 */
      reviewTools?: ReviewTools;
      /** 交接包（多 Agent 协作 S11）；不传时交接包工具一律回「不可用」。 */
      handoffTools?: HandoffTools;
      /**
       * 会话记录：会话没关联 SuDuo 项目（取不到工具上下文）时，按它记下的语言回包；
       * 会话记录也查不到时用 `FALLBACK_LOCALE`。必填，免得漏接时英文会话悄悄收到中文。
       */
      sessions: Pick<SessionRepository, "getById">;
      log?: (line: Record<string, unknown>) => void;
      /** 测试用：经 MCP 等确认等多久转草稿；默认比给 Agent 配的工具超时早 30 秒。 */
      mcpDraftAfterMs?: number;
    },
  ) {}

  /** 委派工具在本机服务组装的后段才建好（依赖发消息、调度）：建好后接上。 */
  setDelegationTools(tools: DelegationTools): void {
    this.deps.delegationTools = tools;
  }

  /** 评审工具同理（依赖发消息、调度）。 */
  setReviewTools(tools: ReviewTools): void {
    this.deps.reviewTools = tools;
  }

  /** 交接包工具同理（依赖草稿服务）。 */
  setHandoffTools(tools: HandoffTools): void {
    this.deps.handoffTools = tools;
  }

  /** MCP tools/list（ADR-0015）：给令牌授予的工具（建线程时定下），说明不用代码模式的写法。 */
  listTools(grant: ToolGrant): McpToolDefinition[] {
    return mcpToolSpecsFor(grant.toolNames, this.localeOf(grant.sessionId)).map((spec) => ({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.inputSchema,
    }));
  }

  /** MCP tools/call（ADR-0015）：只读工具直接执行；写工具建确认卡、挂起等用户决定，等太久转草稿。 */
  async callTool(
    grant: ToolGrant,
    name: string,
    args: Record<string, unknown>,
    call: { requestKey: string; signal: AbortSignal },
  ): Promise<McpToolCallResult> {
    const startedAt = Date.now();
    const sessionId = grant.sessionId;
    const internal = internalToolName(name);
    const context = this.deps.context.toolContext(sessionId);
    if (context === null) {
      return toMcpResult(failure(toolFormat(this.localeOf(sessionId)).t.toolReply.dispatch.noProject));
    }
    const f = toolFormat(context.locale);
    if (!grant.toolNames.includes(internal) || !scopeTools(context).includes(internal)) {
      // 范围外的调用（房间任务里调笔记 / 写工具等）：不执行（ADR-0009）。
      const reason = context.room !== undefined ? f.t.toolReply.dispatch.roomReadOnly(internal) : f.t.toolReply.dispatch.unknownTool(name);
      return toMcpResult(failure(reason));
    }
    const draftAt = startedAt + (this.deps.mcpDraftAfterMs ?? (grant.toolTimeoutSec - MCP_DRAFT_MARGIN_SEC) * 1000);
    const result = await (isWriteTool(internal)
      ? this.mcpWrite(context, internal, args, call, draftAt)
      : this.runReadTool(context, internal, args, { signal: call.signal, toolTimeoutSec: grant.toolTimeoutSec })
    ).catch((error: unknown) => failure(f.t.toolReply.dispatch.runFailed(f.reasonOf(error))));
    this.log({ event: "suduo.tool.mcp_call", sessionId, tool: internal, success: result.success, durationMs: Date.now() - startedAt });
    return toMcpResult(limitToolResult(result, f));
  }

  private async mcpWrite(
    context: ToolSessionContext,
    tool: string,
    args: Record<string, unknown>,
    call: { requestKey: string; signal: AbortSignal },
    /** 到这个时刻还没确认就转草稿：Agent 的工具超时减余量，从请求到达算起（准备阶段也算在内）。 */
    draftAt: number,
  ): Promise<ToolResult> {
    const text = toolFormat(context.locale).t.toolReply;
    const binding = this.deps.threads.getPrimary(context.sessionId);
    if (!binding) {
      return failure(text.dispatch.threadMissing);
    }
    const prepared = await this.deps.tools.prepareComment(context, args);
    if ("contentItems" in prepared) {
      return prepared;
    }
    if (call.signal.aborted) {
      // 准备期间 Agent 已经走了：不建卡，免得留下没人等的卡。
      return failure(text.write.incomplete);
    }
    const callRef = "mcp:" + randomUUID();
    const confirmation: SuDuoToolConfirmationDto = {
      ...prepared,
      duplicateOf: this.findDuplicate(context.sessionId, prepared),
    };
    this.deps.ledger.appendApprovalRequested({
      sessionId: context.sessionId,
      sessionThreadId: binding.id,
      kind: "other",
      runtimeConnectionId: SUDUO_MCP_CONNECTION_ID,
      runtimeRequestId: call.requestKey,
      runtimeApprovalRef: callRef,
      event: {
        source: "suduo:mcp",
        type: "approval.requested",
        payload: {
          kind: "other",
          approvalRef: callRef,
          connectionId: SUDUO_MCP_CONNECTION_ID,
          requestId: call.requestKey,
          nativeMethod: SUDUO_TOOL_NATIVE_METHOD,
          request: { threadId: binding.threadRef.threadId, turnId: null, callId: callRef, tool, arguments: args as JsonValue },
          suDuoTool: confirmation as unknown as JsonValue,
        },
        threadRef: binding.threadRef,
        turnRef: null,
        ts: Date.now(),
        dedupeKey: "tool-confirm:" + callRef,
      },
    });
    this.log({ event: "suduo.tool.awaiting_confirmation", sessionId: context.sessionId, tool, channel: "mcp" });
    return new Promise<ToolResult>((resolve) => {
      const settle = (result: ToolResult) => {
        if (!this.mcpPending.delete(callRef)) {
          return;
        }
        clearTimeout(timer);
        resolve(result);
      };
      const entry = { settle, executing: false, signal: call.signal };
      // 到点或 Agent 取消：确认卡留着当待发出草稿（不作废），先回 Agent「已存为草稿」（ADR-0015 第 4 条）。
      // 用户的决定已在执行时不转草稿，等执行结果。
      const draft = () => {
        if (!entry.executing) settle(textResult(text.dispatch.commentDraftSaved));
      };
      const timer = setTimeout(draft, Math.max(0, draftAt - Date.now()));
      timer.unref?.();
      this.mcpPending.set(callRef, entry);
      call.signal.addEventListener("abort", draft, { once: true });
    });
  }

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
      this.log({ event: "suduo.tool.dispatch_failed", tool: request.tool, message: logReason(error) });
      const f = toolFormat(this.safeLocaleOf(() => this.sessionOf(event).sessionId));
      void this.respond(event, request.callRef, failure(f.t.toolReply.dispatch.failed(f.reasonOf(error))));
    });
  }

  isToolConfirmation(approval: ApprovalRecord): boolean {
    return isToolConfirmation(approval);
  }

  /** 审批坞上的决定（ApprovalService 转来）。从不抛错：执行结果写进返回值。 */
  async confirm(approval: ApprovalRecord, decision: ApprovalDecision): Promise<JsonValue> {
    const pendingMcp = this.mcpPending.get(approval.runtimeApprovalRef);
    if (pendingMcp !== undefined) {
      pendingMcp.executing = true;
    }
    const confirmation = confirmationOf(approval);
    const accepted = decision === "accept" || decision === "acceptForSession";
    let result: ToolResult;
    let locale: Locale;
    if (confirmation === null || !accepted) {
      locale = this.safeLocaleOf(() => approval.sessionId);
      const text = toolFormat(locale).t.toolReply;
      result = failure(confirmation === null ? text.write.incomplete : text.dispatch.declinedComment);
    } else {
      const context = this.deps.context.toolContext(approval.sessionId);
      locale = this.safeLocaleOf(() => approval.sessionId, context);
      const f = toolFormat(locale);
      result =
        context === null
          ? failure(f.t.toolReply.dispatch.sessionUnlinked)
          : await this.deps.tools.executeWrite(context, confirmation).catch((error: unknown) =>
              failure(f.t.toolReply.dispatch.runFailed(f.reasonOf(error))),
            );
    }
    const binding = this.deps.threads.getById(approval.sessionThreadId);
    result = limitToolResult(result, toolFormat(locale));
    const delivered = binding
      ? await this.deliver(binding.threadRef.runtimeId, approval.runtimeApprovalRef, result)
      : { delivered: false };
    const message = textOf(result, toolFormat(locale).t.toolReply.dispatch.image);
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
    const { binding, sessionId } = this.sessionOf(event);
    const context = sessionId === null ? null : this.deps.context.toolContext(sessionId);
    if (context === null) {
      const text = toolFormat(this.localeOf(sessionId)).t.toolReply;
      await this.respond(event, request.callRef, failure(text.dispatch.noProject));
      return;
    }
    const text = toolFormat(context.locale).t.toolReply;
    const args = isRecord(request.arguments) ? request.arguments : {};
    if (isRetiredSuDuoToolName(request.tool)) {
      // 确认版已停用：旧会话续接时仍带着旧工具清单，模型可能还会调用。说清楚并指向附件工具；
      // 放在房间检查之前，免得房间里误说成「只能用只读工具」。
      await this.respond(event, request.callRef, failure(text.dispatch.retired(request.tool)));
      this.log({ event: "suduo.tool.retired", sessionId: context.sessionId, tool: request.tool });
      return;
    }
    if (context.room !== undefined && !context.room.allowedTools.includes(request.tool)) {
      // 房间任务会话只挂房间工具与需求只读工具（ADR-0009）：清单外的调用（笔记、写工具）一律不执行。
      await this.respond(event, request.callRef, failure(text.dispatch.roomReadOnly(request.tool)));
      this.log({ event: "suduo.tool.room_denied", sessionId: context.sessionId, tool: request.tool });
      return;
    }
    if (isWriteTool(request.tool)) {
      if (!binding) {
        await this.respond(event, request.callRef, failure(text.dispatch.threadMissing));
        return;
      }
      const prepared = await this.deps.tools.prepareComment(context, args);
      if ("contentItems" in prepared) {
        await this.respond(event, request.callRef, prepared);
        return;
      }
      // 准备期间（查远程最长十几秒）回合可能已被中断或连接已断：调用已失效就不建卡，只记日志。
      const runtime = event.threadRef ? this.deps.runtimes.get(event.threadRef.runtimeId) : null;
      if (this.cancelledCalls.delete(request.callRef) || runtime?.isToolCallPending?.(request.callRef) === false) {
        this.log({ event: "suduo.tool.confirmation_skipped", sessionId: binding.sessionId, tool: request.tool, reason: "call no longer valid" });
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

  private runReadTool(
    context: ToolSessionContext,
    tool: string,
    args: Record<string, unknown>,
    /** 调用方的连接与工具超时（委派的「等待」按它定最长等多久、调用方走了就不等）。 */
    call: { signal?: AbortSignal; toolTimeoutSec?: number } = {},
  ): Promise<ToolResult> {
    const tools = this.deps.tools;
    const text = toolFormat(context.locale).t.toolReply;
    if (isHandoffToolName(tool)) {
      const handoffs = this.deps.handoffTools;
      if (!handoffs) return Promise.resolve(failure(text.dispatch.handoffToolsUnavailable));
      return tool === "suduo_handoff_submit" ? Promise.resolve(handoffs.submit(context, args)) : handoffs.read(context, args);
    }
    if (isReviewToolName(tool)) {
      const reviews = this.deps.reviewTools;
      if (!reviews) return Promise.resolve(failure(text.dispatch.reviewToolsUnavailable));
      return tool === "suduo_review_submit" ? Promise.resolve(reviews.submit(context, args)) : reviews.request(context, args);
    }
    if (isDelegationToolName(tool)) {
      // 深度 1（R2）：委派出来的子会话、评审会话不能再委派（建线程时已经不挂，这里再拦一次）。
      if (context.delegateChild === true || context.reviewer === true || context.trial === true) return Promise.resolve(failure(toolFormat(context.locale).t.delegation.reply.notMain));
      const delegation = this.deps.delegationTools;
      if (!delegation) return Promise.resolve(failure(text.dispatch.delegationToolsUnavailable));
      switch (tool) {
        case "suduo_agent_list":
          return Promise.resolve(delegation.agentList(context));
        case "suduo_delegate_start":
          return delegation.start(context, args);
        case "suduo_delegate_wait":
          return delegation.wait(context, args, call);
        case "suduo_delegate_send":
          return delegation.send(context, args);
        case "suduo_delegate_cancel":
          return delegation.cancel(context, args);
      }
    }
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
      case "suduo_notes_read":
        return tools.notesRead(context, args, remember);
      case "suduo_notes_save":
        return tools.notesSave(context, args, lastRead, remember);
      case "suduo_room_history":
      case "suduo_room_search":
      case "suduo_room_file_view": {
        const roomTools = this.deps.roomTools;
        if (!roomTools) {
          return Promise.resolve(failure(text.dispatch.roomToolsUnavailable));
        }
        return tool === "suduo_room_history"
          ? roomTools.history(context, args)
          : tool === "suduo_room_search"
            ? roomTools.search(context, args)
            : roomTools.fileView(context, args);
      }
      case "suduo_session_list":
      case "suduo_session_read": {
        const reader = this.deps.sessionReader;
        if (!reader) {
          return Promise.resolve(failure(text.dispatch.sessionToolsUnavailable));
        }
        return tool === "suduo_session_list" ? Promise.resolve(reader.list(context, args)) : reader.read(context, args);
      }
      default:
        return Promise.resolve(failure(text.dispatch.unknownTool(tool)));
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
    const limited = limitToolResult(result, toolFormat(this.safeLocaleOf(() => this.sessionOf(event).sessionId)));
    const outcome = await this.deliver(event.threadRef.runtimeId, callRef, limited);
    if (!outcome.delivered) {
      this.log({ event: "suduo.tool.respond_dropped", reason: "call no longer valid (connection replaced or withdrawn by Codex)" });
    }
  }

  /** 回包；runtime 不存在或回包出错都只记日志，不抛错。经 MCP 的调用回给挂起的请求。 */
  private async deliver(runtimeId: string, callRef: string, result: ToolResult): Promise<{ delivered: boolean }> {
    const mcp = this.mcpPending.get(callRef);
    if (mcp !== undefined) {
      mcp.settle(result);
      return { delivered: !mcp.signal.aborted };
    }
    if (callRef.startsWith("mcp:")) {
      // 已经按草稿回过 Agent：这次决定只入账，不再回包。
      return { delivered: false };
    }
    try {
      const outcome = await this.deps.runtimes.get(runtimeId).respondToolCall?.({ callRef, ...result });
      return outcome ?? { delivered: false };
    } catch (error) {
      this.log({ event: "suduo.tool.respond_failed", message: logReason(error) });
      return { delivered: false };
    }
  }

  /** 调用所在的会话：先按线程找绑定，没有时用 runtime 给的会话提示。 */
  private sessionOf(event: RuntimeEventDraft): { binding: SessionThreadRecord | null; sessionId: string | null } {
    const binding = event.threadRef
      ? this.deps.threads.getByRuntimeThread(event.threadRef.runtimeId, event.threadRef.threadId)
      : null;
    return { binding, sessionId: binding?.sessionId ?? event.sessionHint ?? null };
  }

  /**
   * 兜底路径（调度出错、拒绝 / 卡片不完整）回包用的语言。查库本身也可能出错，而这些路径原来不查库、
   * 不会抛：出错就用 `FALLBACK_LOCALE`，不让兜底回包抛错。已经取到的工具上下文直接传进来。
   */
  private safeLocaleOf(sessionIdOf: () => string | null, context?: ToolSessionContext | null): Locale {
    try {
      const sessionId = sessionIdOf();
      return this.localeOf(
        sessionId,
        context !== undefined ? context : sessionId === null ? null : this.deps.context.toolContext(sessionId),
      );
    } catch {
      return FALLBACK_LOCALE;
    }
  }

  /** 回包用的语言：会话的语言（迁移 017）。取不到工具上下文时读会话记录，会话也查不到时用 `FALLBACK_LOCALE`。 */
  private localeOf(sessionId: string | null, context?: ToolSessionContext | null): Locale {
    if (context) {
      return context.locale;
    }
    return (sessionId === null ? null : this.deps.sessions.getById(sessionId)?.locale) ?? FALLBACK_LOCALE;
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

/** 撤回原因只记进账本（approval.orphaned），界面不显示，所以兜底写英文、不进字典。 */
function reasonText(payload: JsonValue): string {
  return isRecord(payload) && typeof payload["reason"] === "string"
    ? payload["reason"]
    : "the turn ended, so this confirmation is no longer valid";
}

/** 审批记录是不是工具确认卡；是的话取出卡片内容。 */
export function confirmationOf(approval: ApprovalRecord): SuDuoToolConfirmationDto | null {
  const payload = approval.requestPayload;
  if (!isRecord(payload) || payload["nativeMethod"] !== SUDUO_TOOL_NATIVE_METHOD) {
    return null;
  }
  const tool = payload["suDuoTool"];
  // 只认发评论：确认版停用前的发布确认卡不再执行（本机服务重启时挂起的卡都已作废）。
  return isRecord(tool) && tool["tool"] === "comment_submit" ? (tool as unknown as SuDuoToolConfirmationDto) : null;
}

export function isToolConfirmation(approval: ApprovalRecord): boolean {
  const payload = approval.requestPayload;
  return isRecord(payload) && payload["nativeMethod"] === SUDUO_TOOL_NATIVE_METHOD;
}

function fingerprintOf(confirmation: SuDuoToolConfirmationDto): string {
  return `comment:${confirmation.requirement.id}:${confirmation.comment?.body ?? ""}`;
}

function turnIdOf(approval: ApprovalRecord): string | null {
  const payload = approval.requestPayload;
  const request = isRecord(payload) ? payload["request"] : null;
  return isRecord(request) && typeof request["turnId"] === "string" ? request["turnId"] : null;
}

/** 回包的文字（记进审批结果）；图片换成 `image` 占位。 */
function textOf(result: ToolResult, image: string): string {
  return result.contentItems
    .map((item) => (item.type === "inputText" ? item.text : image))
    .join("\n");
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 这个会话能用的工具：scope 的工具，加上按会话角色另加的（评审会话的提交评审意见，S9）。 */
function scopeTools(context: ToolSessionContext): string[] {
  const names = sessionToolNames(scopeOf(context));
  return context.reviewer === true ? [...names, "suduo_review_submit"] : names;
}

/** 会话的工具范围（与建线程时 `sessionToolSpecs` 用的一致）。 */
function scopeOf(context: ToolSessionContext): SessionToolScope {
  if (context.room !== undefined) {
    return context.requirement === null ? "room" : "room_requirement";
  }
  return context.requirement === null ? "project" : "requirement";
}

/** 内部工具结果 → MCP 内容：文字里的工具名换成 MCP 名，data URL 图片拆成 base64 与类型。 */
function toMcpResult(result: ToolResult): McpToolCallResult {
  const content: McpToolContent[] = result.contentItems.map((item) => {
    if (item.type === "inputText") {
      return { type: "text", text: mcpToolText(item.text) };
    }
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(item.imageUrl);
    return match ? { type: "image", mimeType: match[1]!, data: match[2]! } : { type: "text", text: item.imageUrl };
  });
  return { content, isError: !result.success };
}
