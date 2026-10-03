import {
  REQUIREMENT_STATUSES,
  REQUIREMENT_STATUS_LABELS,
  type AuditAction,
  type AuditEntryDto,
  type RequirementStatus,
} from "@suduo/cloud-contracts";

/**
 * 概览「最近动态」的纯逻辑：审计条目语义化、相邻同类归并、状态流转文案。
 * 渲染层（OverviewTimeline）只负责摆放。
 */

export type AuditTone = "created" | "updated" | "deleted" | "neutral";

export interface AuditPresentation {
  /** 时间线圆点用的语义色调。 */
  tone: AuditTone;
  /** 「谁」之后接的整句谓语，如「创建了需求」。 */
  text: string;
}

const RESOURCE_LABELS: Readonly<Record<string, string>> = {
  project: "项目",
  requirement: "需求",
  comment: "评论",
  attachment: "附件",
};

/**
 * 键是契约里的完整 `AuditAction`，写整句而不是「动作词 + 资源词」拼装（中文语序不是简单拼接）。
 * 类型标注为 `Record<AuditAction, string>`：契约新增动作时编译期即报缺键。
 */
const AUDIT_TEXTS: Readonly<Record<AuditAction, string>> = {
  "project.created": "创建了项目",
  "project.updated": "更新了项目",
  "project.archived": "归档了项目",
  "project.restored": "恢复了项目",
  "requirement.created": "创建了需求",
  "requirement.updated": "更新了需求",
  "requirement.status_changed": "变更了需求状态",
  "comment.created": "发表了评论",
  "attachment.created": "上传了附件",
  "attachment.downloaded": "下载了附件",
  "attachment.deleted": "删除了附件",
  "artifact_version.published": "发布了产物版本",
};

/** 未知取值一律回落为原文而不是丢弃：审计不能因为前端不认识就少显示一条。 */
export function presentAudit(entry: AuditEntryDto): AuditPresentation {
  const action = String(entry.action);
  const tone: AuditTone = action.includes("creat") || action.includes("restor")
    ? "created"
    : action.includes("delet")
      ? "deleted"
      : action.includes("updat") || action.includes("status") || action.includes("archiv")
        ? "updated"
        : "neutral";
  const known = AUDIT_TEXTS[entry.action] as string | undefined;
  if (known !== undefined) return { tone, text: known };
  const resourceLabel = RESOURCE_LABELS[String(entry.resourceType)] ?? String(entry.resourceType);
  return { tone, text: `对${resourceLabel}执行了 ${action}` };
}

const GROUP_VERBS: Readonly<Record<AuditAction, string>> = {
  "project.created": "创建了",
  "project.updated": "更新了",
  "project.archived": "归档了",
  "project.restored": "恢复了",
  "requirement.created": "创建了",
  "requirement.updated": "更新了",
  "requirement.status_changed": "变更了",
  "comment.created": "发表了",
  "attachment.created": "上传了",
  "attachment.downloaded": "下载了",
  "attachment.deleted": "删除了",
  "artifact_version.published": "发布了",
};

/** 归并组的一句话：「更新了 3 条记录」。 */
export function groupSummary(action: AuditAction, count: number): string {
  return `${GROUP_VERBS[action] ?? "处理了"} ${String(count)} 条记录`;
}

/** 状态流转写成「草稿 → 开发中」；取不到前后状态时给一句兜底。非状态变更返回 null。 */
export function statusTransitionOf(entry: AuditEntryDto): string | null {
  if (entry.action !== "requirement.status_changed") return null;
  const before = statusOf(entry.before?.["status"]);
  const after = statusOf(entry.after?.["status"]);
  return before !== null && after !== null
    ? `${REQUIREMENT_STATUS_LABELS[before]} → ${REQUIREMENT_STATUS_LABELS[after]}`
    : "状态已变更";
}

function statusOf(value: unknown): RequirementStatus | null {
  return typeof value === "string" && (REQUIREMENT_STATUSES as readonly string[]).includes(value)
    ? (value as RequirementStatus)
    : null;
}

/** 相邻审计允许归并的最大时间间隔。 */
export const AUDIT_GROUP_WINDOW_MS = 15 * 60 * 1_000;

export interface OverviewAuditGroup {
  /** 展示顺序保持服务端返回顺序；该时间是组内最早的一条。 */
  createdAt: string;
  actorId: string;
  actorName: string;
  action: AuditAction;
  entries: AuditEntryDto[];
}

/**
 * 时间线归约：只合并相邻的「同一人 + 同一 action + 15 分钟内」记录。
 * 状态流转永远独立，保证 before/after 不会被一条汇总文案吞掉。
 */
export function groupOverviewAudit(entries: readonly AuditEntryDto[]): OverviewAuditGroup[] {
  const groups: OverviewAuditGroup[] = [];
  for (const entry of entries) {
    const previous = groups.at(-1);
    if (previous !== undefined && canJoinOverviewAuditGroup(previous, entry)) {
      previous.entries.push(entry);
      if (Date.parse(entry.createdAt) < Date.parse(previous.createdAt)) previous.createdAt = entry.createdAt;
      continue;
    }
    groups.push({
      createdAt: entry.createdAt,
      actorId: entry.actor.id,
      actorName: entry.actor.displayName,
      action: entry.action,
      entries: [entry],
    });
  }
  return groups;
}

export function canJoinOverviewAuditGroup(group: OverviewAuditGroup, entry: AuditEntryDto): boolean {
  if (group.action === "requirement.status_changed" || entry.action === "requirement.status_changed") return false;
  const previous = group.entries.at(-1);
  if (previous === undefined) return false;
  return (
    group.actorId === entry.actor.id &&
    group.action === entry.action &&
    Math.abs(Date.parse(previous.createdAt) - Date.parse(entry.createdAt)) <= AUDIT_GROUP_WINDOW_MS
  );
}
