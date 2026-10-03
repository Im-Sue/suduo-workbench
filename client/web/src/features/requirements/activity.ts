import {
  type CommentSystemContent,
  type RequirementActivityEntryDto,
  type RequirementStatus,
} from "@suduo/cloud-contracts";
import { currentLocale } from "../../i18n/locale.js";
import { messagesFor, type Messages } from "../../i18n/messages/index.js";
import { requirementStatusLabel } from "../../ui/requirement-status.js";

/**
 * 活动时间线的文案（技术设计 §8）：主语是人，谓语写成完整的短句（字典 requirementDetail.activity），
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

export function presentActivity(
  entry: RequirementActivityEntryDto,
  t: Messages = messagesFor(currentLocale()),
): ActivityPresentation {
  const text = t.requirementDetail.activity;
  switch (entry.action) {
    case "requirement.created":
      return { kind: "created", text: text.created, body: null };
    case "requirement.updated": {
      const parts = entry.changes.flatMap((change) => {
        if (change.field === "title") return [text.titleChanged(change.to)];
        if (change.field === "summary") return [change.from === "" ? text.descriptionAdded : text.descriptionEdited];
        return [];
      });
      return { kind: "edited", text: parts.length === 0 ? text.edited : text.joinChanges(parts), body: null };
    }
    case "requirement.status_changed": {
      const change = entry.changes.find((item) => item.field === "status");
      if (change === undefined || change.field !== "status") return { kind: "status", text: text.statusChanged, body: null };
      return {
        kind: "status",
        text: text.statusChangedFromTo(requirementStatusLabel(change.from, t), requirementStatusLabel(change.to, t)),
        body: null,
        status: { from: change.from, to: change.to },
      };
    }
    case "requirement.assignee_changed": {
      const change = entry.changes.find((item) => item.field === "assignee");
      if (change === undefined || change.field !== "assignee") return { kind: "assignee", text: text.assigneeChanged, body: null };
      if (change.to === null) return { kind: "assignee", text: text.assigneeRemoved, body: null };
      if (change.to.id === entry.actor.id) return { kind: "assignee", text: text.assigneeClaimed, body: null };
      return { kind: "assignee", text: text.assigneeChangedTo(change.to.displayName), body: null };
    }
    case "comment.created":
      return { kind: "comment", text: text.commented, body: entry.comment == null ? null : commentText(entry.comment, t) };
    case "attachment.created":
      return { kind: "material", text: text.uploaded(entry.attachment?.fileName ?? null), body: null };
    case "attachment.deleted":
      return { kind: "material", text: text.deleted(entry.attachment?.fileName ?? null), body: null };
    case "artifact_version.published": {
      const version = entry.artifactVersion;
      return {
        kind: "artifact",
        text: version === null ? text.published : text.publishedVersion(version.versionNumber, version.fileCount),
        body: version?.note ?? null,
      };
    }
    default:
      // 服务端新增动作时不丢条目：宁可文案笼统，也要让人知道这里发生过事。
      return { kind: "edited", text: text.updated, body: null };
  }
}

/**
 * 评论正文。系统代写的评论（契约 CommentDto.system）按类型用当前语言渲染，存下的 body 只是兜底；
 * 用户写的评论、以及不认识的系统类型照常显示 body（中英双语技术设计 §4.3）。
 */
export function commentText(
  comment: { body: string; system?: CommentSystemContent },
  t: Messages = messagesFor(currentLocale()),
): string {
  const system = comment.system;
  if (system?.kind === "artifact_published") {
    return t.requirementDetail.activity.systemComment.artifactPublished(system.params.versionNumber, system.params.fileCount);
  }
  return comment.body;
}
