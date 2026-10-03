import type {
  SessionListItemDto,
  RequirementListItemDto,
  WorkbenchActionDto,
  WorkbenchRequirementDto,
} from "@suduo/client-contracts";
import type { RequirementStatus, UserSummaryDto } from "@suduo/cloud-contracts";
import { REQUIREMENT_STATUSES, staleLevel } from "@suduo/cloud-contracts";
import { rowStatus, lastActivity } from "../sessions/session-list.js";
import type { SessionUiStatus } from "../../ui/session-status.js";

/**
 * 我的工作（需求 §4.3）的数据整理：
 * - 需要你处理：等你确认 > 上一轮失败 > 我负责的需求有新评论 > 开工后需求有变化 > 我负责的需求停滞较久 > 代码目录失效；
 * - 我的需求：我负责的 + 我有会话在做的 + 我提的、还没人负责的，按状态分组；
 * - 最近动态：这些需求里别人最近的改动。
 */
export type AttentionItem =
  | { kind: "pending_approval"; key: string; action: Extract<WorkbenchActionDto, { kind: "pending_approval" }> }
  | { kind: "failed_turn"; key: string; action: Extract<WorkbenchActionDto, { kind: "failed_turn" }> }
  | { kind: "new_comments"; key: string; requirement: MyRequirement; count: number }
  | { kind: "drift"; key: string; requirement: WorkbenchRequirementDto }
  | { kind: "stale"; key: string; requirement: MyRequirement; days: number }
  | { kind: "invalid_mapping"; key: string; action: Extract<WorkbenchActionDto, { kind: "invalid_mapping" }> };

const URGENCY: Record<AttentionItem["kind"], number> = {
  pending_approval: 0,
  failed_turn: 1,
  new_comments: 2,
  drift: 3,
  stale: 4,
  invalid_mapping: 5,
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function daysSince(ts: number | null, now = Date.now()): number | null {
  return ts === null ? null : Math.max(0, Math.floor((now - ts) / DAY_MS));
}

export function attentionItems(
  actions: readonly WorkbenchActionDto[] | null,
  requirements: readonly WorkbenchRequirementDto[] | null,
  mine: readonly MyRequirement[] = [],
  now = Date.now(),
): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const action of actions ?? []) {
    if (action.kind === "invalid_mapping") items.push({ kind: action.kind, key: `mapping:${action.remoteProjectId}`, action });
    else if (action.kind === "pending_approval") items.push({ kind: action.kind, key: `approval:${action.sessionId}`, action });
    else items.push({ kind: action.kind, key: `failed:${action.sessionId}`, action });
  }
  for (const requirement of requirements ?? []) {
    if (requirement.drift && requirement.availability === "available") {
      items.push({ kind: "drift", key: `drift:${requirement.requirementId}`, requirement });
    }
  }
  // 只看我负责的：别人发了新评论（等我回），或按节奏已经停滞较久（该我推一把）。
  for (const requirement of mine) {
    if (!requirement.assignedToMe) continue;
    if (requirement.unreadComments > 0) {
      items.push({ kind: "new_comments", key: `comments:${requirement.id}`, requirement, count: requirement.unreadComments });
    }
    const days = daysSince(requirement.updatedAt, now);
    if (requirement.status !== null && days !== null && staleLevel(requirement.status, days) === "warning") {
      items.push({ kind: "stale", key: `stale:${requirement.id}`, requirement, days });
    }
  }
  return items.sort((left, right) => URGENCY[left.kind] - URGENCY[right.kind] || recency(right) - recency(left));
}

function recency(item: AttentionItem): number {
  if (item.kind === "invalid_mapping") return 0;
  if (item.kind === "drift") return item.requirement.lastActivityAt ?? 0;
  if (item.kind === "new_comments") return item.requirement.updatedAt ?? 0;
  // 停滞：越久越靠前。
  if (item.kind === "stale") return item.days;
  return item.action.lastActivityAt ?? 0;
}

/** 会话区块：运行中 / 等你确认 / 出了问题的在前，再按最近活动补齐，最多 limit 个（进行中的不截断）。 */
export function sessionsToShow(
  sessions: readonly SessionListItemDto[],
  limit = 6,
): { session: SessionListItemDto; status: SessionUiStatus }[] {
  const rows = sessions.map((session) => ({ session, status: rowStatus(session, null) }));
  const active = (row: (typeof rows)[number]) => row.status === "running" || row.status === "approval" || row.status === "error";
  const byActivity = (left: (typeof rows)[number], right: (typeof rows)[number]) => lastActivity(right.session) - lastActivity(left.session);
  const inProgress = rows.filter(active).sort(byActivity);
  const rest = rows.filter((row) => !active(row)).sort(byActivity);
  return [...inProgress, ...rest].slice(0, Math.max(limit, inProgress.length));
}

export interface MyRequirement {
  id: string;
  remoteProjectId: string;
  projectName: string | null;
  number: number | null;
  title: string | null;
  status: RequirementStatus | null;
  /** 负责人是我。 */
  assignedToMe: boolean;
  /** 我提的、还没人负责（提醒我去找人或自己接）。 */
  createdUnassigned: boolean;
  /** 别人发的、我还没看过的评论数。 */
  unreadComments: number;
  /** 我有会话在做它（来自工作台聚合）。 */
  working: WorkbenchRequirementDto | null;
  updatedAt: number | null;
  updatedBy: UserSummaryDto | null;
}

/** 合并「我负责的」「我提的、还没人负责的」（已完成的不算）与「我在做的」，同一需求只出现一次。 */
export function mergeMyRequirements(
  assigned: readonly (RequirementListItemDto & { projectName: string | null })[],
  working: readonly WorkbenchRequirementDto[],
  createdUnassigned: readonly (RequirementListItemDto & { projectName: string | null })[] = [],
): MyRequirement[] {
  const merged = new Map<string, MyRequirement>();
  const fromList = (item: RequirementListItemDto & { projectName: string | null }, mine: "assigned" | "created"): MyRequirement => ({
    id: item.id,
    remoteProjectId: item.projectId,
    projectName: item.projectName,
    number: item.number ?? null,
    title: item.title,
    status: item.status,
    assignedToMe: mine === "assigned",
    createdUnassigned: mine === "created",
    unreadComments: mine === "assigned" ? (item.unreadCommentCount ?? 0) : 0,
    working: null,
    updatedAt: Date.parse(item.updatedAt),
    updatedBy: item.updatedBy,
  });
  for (const item of assigned) merged.set(item.id, fromList(item, "assigned"));
  for (const item of createdUnassigned) {
    if (item.status === "completed" || merged.has(item.id)) continue;
    merged.set(item.id, fromList(item, "created"));
  }
  for (const item of working) {
    const existing = merged.get(item.requirementId);
    if (existing !== undefined) {
      existing.working = item;
      continue;
    }
    merged.set(item.requirementId, {
      id: item.requirementId,
      remoteProjectId: item.remoteProjectId,
      projectName: item.projectName,
      number: null,
      title: item.title,
      status: item.status,
      assignedToMe: false,
      createdUnassigned: false,
      unreadComments: 0,
      working: item,
      updatedAt: item.lastActivityAt,
      updatedBy: null,
    });
  }
  return [...merged.values()];
}

export interface StatusGroup {
  status: RequirementStatus | null;
  items: MyRequirement[];
}

/** 按流程顺序分组（已完成放最后，取不到状态的另起一组）；组内最近更新在前。 */
export function groupByStatus(items: readonly MyRequirement[]): StatusGroup[] {
  const order: (RequirementStatus | null)[] = [
    ...REQUIREMENT_STATUSES.filter((status) => status !== "completed" && status !== "on_hold"),
    "on_hold",
    "completed",
    null,
  ];
  return order
    .map((status) => ({
      status,
      items: items.filter((item) => item.status === status).sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0)),
    }))
    .filter((group) => group.items.length > 0);
}

/** 最近动态：这些需求里别人最近的改动（自己改的不算），最多 limit 条。 */
export function recentChanges(items: readonly MyRequirement[], meId: string | null, limit = 8): MyRequirement[] {
  return items
    .filter((item) => item.updatedAt !== null && item.updatedBy !== null && item.updatedBy.id !== meId)
    .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
    .slice(0, limit);
}
