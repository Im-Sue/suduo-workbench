import type { RequirementSort, RequirementStatus } from "@suduo/cloud-contracts";

/**
 * 需求模块的查询键。按前缀组织，实时事件可以精确失效：
 * - ["req", "project", projectId, …] 该项目下的看板列、列表、搜索；
 * - ["req", "item", requirementId, …] 单条需求及其附件、产物、活动、评论。
 */
export interface RequirementListFilters {
  search?: string;
  assignee?: string;
  /** 优先级筛选，逗号分隔（`urgent,none`），原样作为查询参数。 */
  priority?: string;
  /** 列内排序；缺省按最近更新（与需求服务的缺省一致）。 */
  sort?: RequirementSort;
}

export const requirementKeys = {
  all: ["req"] as const,
  project: (projectId: string) => ["req", "project", projectId] as const,
  column: (projectId: string, status: RequirementStatus, filters: RequirementListFilters) =>
    ["req", "project", projectId, "column", status, filters] as const,
  search: (projectId: string, search: string) => ["req", "project", projectId, "search", search] as const,
  /** 编号 → 需求：编号创建后不变，只用来找到 id；需求本体仍以 detail(id) 为准。 */
  byNumber: (projectId: string, number: number) => ["req", "number", projectId, number] as const,
  item: (requirementId: string) => ["req", "item", requirementId] as const,
  detail: (requirementId: string) => ["req", "item", requirementId, "detail"] as const,
  attachments: (requirementId: string) => ["req", "item", requirementId, "attachments"] as const,
  artifacts: (requirementId: string) => ["req", "item", requirementId, "artifacts"] as const,
  activity: (requirementId: string) => ["req", "item", requirementId, "activity"] as const,
  comments: (requirementId: string) => ["req", "item", requirementId, "comments"] as const,
  /** AI 协作（多 Agent 协作 S11）：需求上的共享对象与协作记录。 */
  sharedItems: (requirementId: string) => ["req", "item", requirementId, "shared-items"] as const,
  aiActivity: (requirementId: string) => ["req", "item", requirementId, "ai-activity"] as const,
  /** 项目 AI 规范（当前版本与历史）。 */
  aiRules: (projectId: string) => ["req", "project", projectId, "ai-rules"] as const,
  sessions: (projectId: string) => ["req", "project", projectId, "local-sessions"] as const,
  /** 概览：统计（状态分布 / 流转 / 停滞）与项目动态。挂在项目键下，需求变化时随列表一起失效。 */
  overview: (projectId: string) => ["req", "project", projectId, "overview"] as const,
  overviewStats: (projectId: string, window: string, timeZone: string) =>
    ["req", "project", projectId, "overview", "stats", window, timeZone] as const,
  overviewAudit: (projectId: string) => ["req", "project", projectId, "overview", "audit"] as const,
  users: ["req", "users"] as const,
  /** 本机：远程项目 ↔ 本机代码目录的关联。 */
  mappings: ["req", "mappings"] as const,
};
