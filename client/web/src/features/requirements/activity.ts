import {
  REQUIREMENT_STATUS_LABELS,
  type RequirementActivityEntryDto,
  type RequirementStatus,
} from "@suduo/cloud-contracts";

/**
 * 活动时间线的文案（技术设计 §8）：主语是人，谓语写成完整的中文短句，
 * 不出现枚举原值、版本号 v12（写「第 12 版」）。
 */
export type ActivityKind = "created" | "edited" | "status" | "assignee" | "comment" | "material" | "artifact";

export interface ActivityPresentation {
  kind: ActivityKind;
  /** 「谁」之后的整句谓语。 */
  text: string;
  /** 评论正文、发布说明等需要展开显示的正文；没有时为 null。 */
  body: string | null;
  /** 状态变化：界面用状态图标展示前后两端。 */
  status?: { from: RequirementStatus; to: RequirementStatus };
}

export function presentActivity(entry: RequirementActivityEntryDto): ActivityPresentation {
  switch (entry.action) {
    case "requirement.created":
      return { kind: "created", text: "创建了需求", body: null };
    case "requirement.updated": {
      const parts = entry.changes.flatMap((change) => {
        if (change.field === "title") return [`把标题改为「${change.to}」`];
        if (change.field === "summary") return [change.from === "" ? "补充了描述" : "修改了描述"];
        return [];
      });
      return { kind: "edited", text: parts.length === 0 ? "修改了需求" : parts.join("，"), body: null };
    }
    case "requirement.status_changed": {
      const change = entry.changes.find((item) => item.field === "status");
      if (change === undefined || change.field !== "status") return { kind: "status", text: "修改了状态", body: null };
      return {
        kind: "status",
        text: `把状态从「${REQUIREMENT_STATUS_LABELS[change.from]}」改为「${REQUIREMENT_STATUS_LABELS[change.to]}」`,
        body: null,
        status: { from: change.from, to: change.to },
      };
    }
    case "requirement.assignee_changed": {
      const change = entry.changes.find((item) => item.field === "assignee");
      if (change === undefined || change.field !== "assignee") return { kind: "assignee", text: "修改了负责人", body: null };
      if (change.to === null) return { kind: "assignee", text: "取消了负责人", body: null };
      if (change.to.id === entry.actor.id) return { kind: "assignee", text: "认领了这条需求", body: null };
      return { kind: "assignee", text: `把负责人改为 ${change.to.displayName}`, body: null };
    }
    case "comment.created":
      return { kind: "comment", text: "发表了评论", body: entry.comment?.body ?? null };
    case "attachment.created":
      return { kind: "material", text: `上传了「${entry.attachment?.fileName ?? "材料"}」`, body: null };
    case "attachment.deleted":
      return { kind: "material", text: `删除了「${entry.attachment?.fileName ?? "材料"}」`, body: null };
    case "artifact_version.published": {
      const version = entry.artifactVersion;
      return {
        kind: "artifact",
        text:
          version === null
            ? "发布了确认版"
            : `发布了确认版 · 第 ${version.versionNumber} 版（${version.fileCount} 个文件）`,
        body: version?.note ?? null,
      };
    }
    default:
      // 服务端新增动作时不丢条目：宁可文案笼统，也要让人知道这里发生过事。
      return { kind: "edited", text: "更新了需求", body: null };
  }
}
