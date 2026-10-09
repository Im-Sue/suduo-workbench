import { messagesFor } from "../../i18n/messages/index.js";
import { ApiError } from "../api-error.js";
import { failure, textResult, type ToolResult } from "../session-tools/format.js";
import type { ToolSessionContext } from "../session-tools/requirement-tools.js";
import type { ReviewService } from "./review-service.js";

/**
 * 交叉评审工具（多 Agent 协作 S9）：review_request（主会话请另一个 Agent 评审自己的改动）与
 * review_submit（评审会话交回结构化意见）。回包按调用方会话的语言。
 */
export class ReviewTools {
  constructor(private readonly deps: { service: ReviewService }) {}

  async request(ctx: ToolSessionContext, args: Record<string, unknown>): Promise<ToolResult> {
    const t = messagesFor(ctx.locale);
    const r = t.review.reply;
    // 子会话、评审会话不挂这个工具（建线程时已去掉），这里再拦一次。
    if (ctx.delegateChild === true || ctx.reviewer === true || ctx.trial === true) return failure(r.notMain);
    const agentId = typeof args["agentId"] === "string" ? args["agentId"].trim() : "";
    if (agentId === "") return failure(r.agentIdMissing);
    const focus = Array.isArray(args["focus"]) ? args["focus"].filter((item): item is string => typeof item === "string") : undefined;
    try {
      const review = await this.deps.service.start({
        targetSessionId: ctx.sessionId,
        agentId,
        ...(focus === undefined ? {} : { focus }),
        note: typeof args["note"] === "string" ? args["note"] : null,
        origin: "agent",
      });
      return textResult(r.started(review.id, review.agentName, r.status[review.status] ?? review.status));
    } catch (error) {
      return failure(error instanceof ApiError ? error.render(t) : String(error));
    }
  }

  submit(ctx: ToolSessionContext, args: Record<string, unknown>): ToolResult {
    const r = messagesFor(ctx.locale).review.reply;
    if (ctx.reviewer !== true) return failure(r.notReviewer);
    const result = this.deps.service.submit(ctx.sessionId, args, ctx.locale);
    return result.ok ? textResult(r.submitted(result.count)) : failure(result.message);
  }
}
