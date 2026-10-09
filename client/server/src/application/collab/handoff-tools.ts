import type { HandoffContent, ListSharedItemsResponse, SharedItemDetailDto } from "@suduo/cloud-contracts";
import { failure, formatTime, textResult, toolFormat, type ToolResult } from "../session-tools/format.js";
import type { ToolSessionContext } from "../session-tools/requirement-tools.js";
import type { SharedDraftService } from "./shared-draft-service.js";

/**
 * 交接包工具（多 Agent 协作 S11，需求 4.7）：`handoff_submit` 交草稿（用户在界面上编辑确认后发布到需求），
 * `handoff_read` 读这条需求上同事发布的交接包（读全文时云端记一笔「读过」）。回包按调用方会话的语言。
 */
export class HandoffTools {
  constructor(
    private readonly deps: {
      drafts: SharedDraftService;
      remote: {
        listSharedItems(requirementId: string): Promise<ListSharedItemsResponse>;
        getSharedItem(itemId: string): Promise<SharedItemDetailDto>;
      };
      agentName(agentId: string): string;
    },
  ) {}

  submit(ctx: ToolSessionContext, args: Record<string, unknown>): ToolResult {
    const t = toolFormat(ctx.locale).t.sharedDraft;
    // 子会话、评审会话、试做会话不挂这个工具（建线程时已去掉），这里再拦一次。
    if (ctx.delegateChild === true || ctx.reviewer === true || ctx.trial === true) return failure(t.reply.notMain);
    if (ctx.requirement === null) return failure(t.notRequirementSession);
    const result = this.deps.drafts.submitHandoff(ctx.sessionId, args, ctx.locale);
    return result.ok ? textResult(t.reply.submitted(result.draft.title)) : failure(result.message);
  }

  async read(ctx: ToolSessionContext, args: Record<string, unknown>): Promise<ToolResult> {
    const f = toolFormat(ctx.locale);
    const t = f.t.sharedDraft;
    const requirement = ctx.requirement;
    if (requirement === null) return failure(t.notRequirementSession);
    const id = typeof args["id"] === "string" ? args["id"].trim() : "";
    try {
      const items = (await this.deps.remote.listSharedItems(requirement.remoteRequirementId)).items.filter((item) => item.kind === "handoff");
      if (id === "") {
        if (items.length === 0) return textResult(t.reply.none);
        // 标题也是同事写的：列表同样先标明是材料。
        return textResult(
          [t.reply.materialNote, "", t.reply.list, ...items.map((item) => t.reply.item(item.id, item.title, item.publishedBy.displayName, formatTime(item.publishedAt), item.retractedAt !== null))].join(
            "\n",
          ),
        );
      }
      // 只读这条需求上的交接包：先按列表确认（不信模型给的 ID 指向别处，也不替别的需求记「读过」）。
      if (!items.some((entry) => entry.id === id)) return failure(f.t.toolText.reason.notFound);
      const item = await this.deps.remote.getSharedItem(id);
      if (item.content === null) return textResult(t.reply.retracted(item.title));
      const content = item.content as HandoffContent;
      const agent = item.source.agentId === null ? null : this.deps.agentName(item.source.agentId);
      const section = (heading: string, lines: readonly string[]) => (lines.length === 0 ? [] : ["", heading, ...lines.map((line) => `- ${line}`)]);
      return textResult(
        [
          t.reply.materialNote,
          "",
          t.reply.header(item.title, item.publishedBy.displayName, formatTime(item.publishedAt), agent),
          "",
          t.reply.summary,
          content.summary,
          ...section(t.reply.decisions, content.decisions),
          ...section(t.reply.todo, content.todo),
          ...section(t.reply.risks, content.risks),
          ...(content.branch === null ? [] : ["", `${t.reply.branch}${content.branch}`]),
          ...section(t.reply.files, content.files),
        ].join("\n"),
      );
    } catch (error) {
      return failure(t.reply.unavailable(f.reasonOf(error)));
    }
  }
}
