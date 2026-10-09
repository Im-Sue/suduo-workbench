import type { AgentDto, RuntimeApprovalMode } from "@suduo/client-contracts";
import { messagesFor } from "../../i18n/messages/index.js";
import type { DelegationRecord } from "../../infrastructure/db/repositories/delegation-repository.js";
import { ApiError } from "../api-error.js";
import { failure, textResult, type ToolResult } from "../session-tools/format.js";
import type { ToolSessionContext } from "../session-tools/requirement-tools.js";
import { oneLine, type DelegationService } from "./delegation-service.js";

/** 等待工具默认、最多等多久（秒）：比工具超时短，留出回包时间（技术设计 2.10「目标约 240 秒」）。 */
const DEFAULT_WAIT_SECONDS = 240;
const WAIT_MARGIN_SECONDS = 30;

/**
 * 委派工具（多 Agent 协作 S8）：agent_list / delegate_start / delegate_wait / delegate_send / delegate_cancel。
 * 回包按调用方会话的语言；只能操作自己发起的委派。
 */
export class DelegationTools {
  constructor(
    private readonly deps: {
      service: DelegationService;
      /** 本机 Agent 与状态（配置表 + 检测缓存，不等检测）。 */
      agents(): AgentDto[];
      /** 这家 Agent 在本机运行中 / 排队中的回合数与上限。 */
      usage(agentId: string): { running: number; queued: number; limit: number };
    },
  ) {}

  agentList(ctx: ToolSessionContext): ToolResult {
    const r = messagesFor(ctx.locale).delegation.reply;
    const usable = this.deps
      .agents()
      .filter((agent) => agent.runtimeAvailable && agent.enabled && (agent.status === "ready" || agent.status === "installed" || agent.status === "checking"));
    if (usable.length === 0) return textResult(r.noAgents);
    const lines = [r.agentsHeader];
    for (const agent of usable) {
      const usage = this.deps.usage(agent.id);
      lines.push(r.agentLine(agent.id, agent.displayName, r.agentStatus[agent.status] ?? r.agentStatus["unknown"]!, usage.running, usage.queued, usage.limit));
    }
    return textResult(lines.join("\n"));
  }

  async start(ctx: ToolSessionContext, args: Record<string, unknown>): Promise<ToolResult> {
    const t = messagesFor(ctx.locale);
    const r = t.delegation.reply;
    const agentId = typeof args["agentId"] === "string" ? args["agentId"].trim() : "";
    if (agentId === "") return failure(r.agentIdMissing);
    if (!this.deps.agents().some((agent) => agent.id === agentId)) return failure(r.unknownAgent(agentId));
    const task = typeof args["task"] === "string" ? args["task"] : "";
    if (task.trim() === "") return failure(r.taskMissing);
    const files = Array.isArray(args["files"]) ? args["files"].filter((file): file is string => typeof file === "string") : [];
    const mode = args["approvalMode"];
    try {
      const delegation = await this.deps.service.start({
        parentSessionId: ctx.sessionId,
        agentId,
        task,
        files,
        autoHandback: args["autoHandback"] === true,
        ...(mode === "readonly" || mode === "ask" || mode === "auto" || mode === "full" ? { approvalMode: mode as RuntimeApprovalMode } : {}),
        origin: "agent",
      });
      const lines = [r.started(delegation.id, delegation.agentName, r.status[delegation.status] ?? delegation.status)];
      if (delegation.error !== null) lines.push(r.error(delegation.error));
      if (delegation.childSessionId !== null) lines.push(r.childSession(delegation.childSessionId));
      return textResult(lines.join("\n"), delegation.status !== "failed");
    } catch (error) {
      return failure(error instanceof ApiError ? error.render(t) : String(error));
    }
  }

  async wait(ctx: ToolSessionContext, args: Record<string, unknown>, call: { signal?: AbortSignal; toolTimeoutSec?: number } = {}): Promise<ToolResult> {
    const t = messagesFor(ctx.locale);
    const r = t.delegation.reply;
    const record = this.owned(ctx, args);
    if ("contentItems" in record) return record;
    const cap = Math.max(5, (call.toolTimeoutSec ?? DEFAULT_WAIT_SECONDS + WAIT_MARGIN_SECONDS) - WAIT_MARGIN_SECONDS);
    const requested = typeof args["maxSeconds"] === "number" && args["maxSeconds"] > 0 ? args["maxSeconds"] : DEFAULT_WAIT_SECONDS;
    const seconds = Math.min(requested, cap, DEFAULT_WAIT_SECONDS);
    const { delegation, finished } = await this.deps.service.wait(record.id, seconds * 1000, call.signal);
    const current = this.deps.service.ownedBy(ctx.sessionId, record.id) ?? record;
    const lines = [r.header(delegation.agentName, oneLine(delegation.task, 80), r.status[delegation.status] ?? delegation.status)];
    if (delegation.childSessionId !== null) lines.push(r.childSession(delegation.childSessionId));
    lines.push("", finished ? this.deps.service.resultText(current, t) : this.deps.service.progressText(current, t));
    return textResult(lines.join("\n").trim());
  }

  async send(ctx: ToolSessionContext, args: Record<string, unknown>): Promise<ToolResult> {
    const t = messagesFor(ctx.locale);
    const r = t.delegation.reply;
    const record = this.owned(ctx, args);
    if ("contentItems" in record) return record;
    const message = typeof args["message"] === "string" ? args["message"].trim() : "";
    if (message === "") return failure(r.messageMissing);
    try {
      const delegation = await this.deps.service.send(record.id, message);
      return textResult(r.header(delegation.agentName, oneLine(delegation.task, 80), r.status[delegation.status] ?? delegation.status));
    } catch (error) {
      return failure(error instanceof ApiError ? error.render(t) : String(error));
    }
  }

  async cancel(ctx: ToolSessionContext, args: Record<string, unknown>): Promise<ToolResult> {
    const r = messagesFor(ctx.locale).delegation.reply;
    const record = this.owned(ctx, args);
    if ("contentItems" in record) return record;
    const delegation = await this.deps.service.cancel(record.id);
    return textResult([r.header(delegation.agentName, oneLine(delegation.task, 80), r.status[delegation.status] ?? delegation.status), r.cancelled].join("\n"));
  }

  private owned(ctx: ToolSessionContext, args: Record<string, unknown>): DelegationRecord | ToolResult {
    const r = messagesFor(ctx.locale).delegation.reply;
    const id = typeof args["delegationId"] === "string" ? args["delegationId"].trim() : "";
    if (id === "") return failure(r.delegationIdMissing);
    return this.deps.service.ownedBy(ctx.sessionId, id) ?? failure(r.notFound(id));
  }
}
