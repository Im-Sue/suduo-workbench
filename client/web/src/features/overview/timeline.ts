import {
  REQUIREMENT_STATUSES,
  type AuditAction,
  type AuditEntryDto,
  type RequirementStatus,
} from "@suduo/cloud-contracts";
import { currentLocale } from "../../i18n/locale.js";
import { messagesFor, type Messages } from "../../i18n/messages/index.js";
import { requirementStatusLabel } from "../../ui/requirement-status.js";

/**
 * 概览「最近动态」的纯逻辑：审计条目语义化、相邻同类归并、状态流转文案。
 * 渲染层（OverviewTimeline）只负责摆放。文字在字典 overview.audit 里，按调用时的界面语言取，
 * 组件里可以传入 useT() 拿到的字典。
 */

export type AuditTone = "created" | "updated" | "deleted" | "neutral";

export interface AuditPresentation {
  /** 时间线圆点用的语义色调。 */
  tone: AuditTone;
  /** 「谁」之后接的整句谓语，如「创建了需求」。 */
  text: string;
}

/** 未知取值一律回落为原文而不是丢弃：审计不能因为前端不认识就少显示一条。 */
export function presentAudit(entry: AuditEntryDto, t: Messages = messagesFor(currentLocale())): AuditPresentation {
  const action = String(entry.action);
  const tone: AuditTone = action.includes("creat") || action.includes("restor")
    ? "created"
    : action.includes("delet")
      ? "deleted"
      : action.includes("updat") || action.includes("status") || action.includes("archiv")
        ? "updated"
        : "neutral";
  const text = t.overview.audit;
  const known = (text.actions as Readonly<Record<string, string>>)[action];
  if (known !== undefined) return { tone, text: known };
  const resourceLabel = (text.resources as Readonly<Record<string, string>>)[String(entry.resourceType)] ?? String(entry.resourceType);
  return { tone, text: text.unknown(resourceLabel, action) };
}

/** 归并组的一句话：「更新了 3 条记录」。 */
export function groupSummary(action: AuditAction, count: number, t: Messages = messagesFor(currentLocale())): string {
  const summary = (t.overview.audit.groups as Readonly<Record<string, (count: number) => string>>)[String(action)];
  return (summary ?? t.overview.audit.groupFallback)(count);
}

/** 状态流转写成「草稿 → 开发中」；取不到前后状态时给一句兜底。非状态变更返回 null。 */
export function statusTransitionOf(entry: AuditEntryDto, t: Messages = messagesFor(currentLocale())): string | null {
  if (entry.action !== "requirement.status_changed") return null;
  const before = statusOf(entry.before?.["status"]);
  const after = statusOf(entry.after?.["status"]);
  return before !== null && after !== null
    ? `${requirementStatusLabel(before, t)} → ${requirementStatusLabel(after, t)}`
    : t.overview.audit.statusChanged;
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
